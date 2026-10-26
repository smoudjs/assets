import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { actions } from '../dist/index.js';
import { run, scratchAssets } from './helpers.mjs';

// the cache lives in node_modules/.cache of the working directory: a fresh one for this file. Not a helpers
// tempDir: Windows cannot delete the folder a process is in, and helpers clean up before this file steps out
const startDir = process.cwd();
let workDir;
before(async () => {
  workDir = await mkdtemp(path.join(os.tmpdir(), 'smoud-assets-cache-'));
  process.chdir(workDir);
});
after(async () => {
  process.chdir(startDir);
  await rm(workDir, { recursive: true, force: true, maxRetries: 3 });
});

const cachedCount = (result) => Object.fromEntries(result.actions.map((action) => [action.label, action.fromCache]));

async function cacheFiles() {
  const root = path.resolve('node_modules/.cache/smoud-assets');
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.name.endsWith('.bin')).map((entry) => path.join(entry.parentPath, entry.name));
}

const config = (source) => ({
  ...(source ? { source } : {}),
  actions: [
    { action: 'atlas', source: 'sprites' },
    { action: 'image', source: 'images', format: 'webp' }
  ]
});

describe('cache', () => {
  it('reuses results on the next build, byte for byte', async () => {
    const assets = await scratchAssets();
    const first = await run(config(assets.dir), { cache: true });
    const second = await run(config(assets.dir), { cache: true });
    assert.equal(first.result.ok, true, first.result.errors.join('\n'));
    assert.deepEqual(Object.values(cachedCount(first.result)), [0, 0]);
    for (const action of second.result.actions) assert.equal(action.fromCache, action.selected, action.label);
    for (const file of await first.outputs()) {
      assert.ok((await first.read(file)).equals(await second.read(file)), `${file} differs`);
    }
  });

  it('is off unless asked for', async () => {
    const assets = await scratchAssets();
    await run(config(assets.dir), { cache: true });
    const plain = await run(config(assets.dir));
    assert.deepEqual(Object.values(cachedCount(plain.result)), [0, 0]);
    const fromConfig = await run({ ...config(assets.dir), cache: true });
    assert.ok(fromConfig.result.actions.every((action) => action.fromCache === action.selected));
  });

  it('a changed image is processed alone; a changed sprite repacks its whole atlas', async () => {
    const assets = await scratchAssets();
    await run(config(assets.dir), { cache: true });
    const sky = path.join(assets.dir, 'images/backgrounds/sky.jpg');
    await writeFile(sky, Buffer.concat([await readFile(sky), Buffer.from([0])]));
    const sprites = (await readdir(path.join(assets.dir, 'sprites'), { recursive: true })).filter((f) => f.endsWith('.png'));
    const sprite = path.join(assets.dir, 'sprites', sprites[0]);
    await writeFile(sprite, Buffer.concat([await readFile(sprite), Buffer.from([0])]));

    const { result } = await run(config(assets.dir), { cache: true });
    const [atlas, image] = result.actions;
    assert.equal(atlas.fromCache, 0);
    assert.equal(image.fromCache, image.selected - 1);
  });

  it('a changed option misses; the same options in another order hit', async () => {
    const assets = await scratchAssets();
    await run(config(assets.dir), { cache: true });
    const changed = await run(
      { source: assets.dir, actions: [{ action: 'image', source: 'images', format: 'webp', quality: 50 }] },
      { cache: true }
    );
    assert.equal(changed.result.actions[0].fromCache, 0);
    const reordered = await run(
      { source: assets.dir, actions: [{ format: 'webp', source: 'images', action: 'image' }] },
      { cache: true }
    );
    assert.equal(reordered.result.actions[0].fromCache, reordered.result.actions[0].selected);
  });

  it('replays warnings from the cache', async () => {
    const jpeg = { actions: [{ action: 'image', source: 'images/ui/logo.png', format: 'jpeg' }] };
    const first = await run(jpeg, { cache: true });
    const second = await run(jpeg, { cache: true });
    assert.equal(second.result.actions[0].fromCache, 1);
    assert.ok(second.result.warnings.some((warning) => warning.includes('flatten')));
    assert.deepEqual(second.result.warnings, first.result.warnings);
  });

  it('a broken cache file is a miss, never an error', async () => {
    const assets = await scratchAssets();
    await run(config(assets.dir), { cache: true });
    for (const file of await cacheFiles()) {
      const bytes = await readFile(file);
      await writeFile(file, bytes.subarray(0, bytes.length - 3));
    }
    const broken = await run(config(assets.dir), { cache: true });
    assert.equal(broken.result.ok, true, broken.result.errors.join('\n'));
    assert.deepEqual(Object.values(cachedCount(broken.result)), [0, 0]);
    const healed = await run(config(assets.dir), { cache: true });
    assert.ok(
      healed.result.actions.every((action) => action.fromCache === action.selected),
      'entries are rewritten'
    );
  });
});

describe('cache: your own actions', () => {
  const transform = async (files) =>
    files.map((file) => ({ ...file, data: Buffer.from(file.data.toString().toUpperCase()) }));

  it('cache needs a version and a transform', () => {
    assert.throws(
      () => actions.register({ name: 'noVersion', accepts: '*', options: {}, cache: true, transform }),
      /needs a version/
    );
    assert.throws(
      () => actions.register({ name: 'ownProcess', accepts: '*', options: {}, cache: true, version: 1, async process() {} }),
      /works only with a transform/
    );
  });

  it('an action with cache and version is cached; one without cache never is', async () => {
    actions.register({ name: 'upperCached', version: 1, cache: true, accepts: ['xml'], options: {}, transform });
    actions.register({ name: 'upperPlain', accepts: ['xml'], options: {}, transform });
    const cached = { actions: [{ action: 'upperCached', source: 'data' }] };
    await run(cached, { cache: true });
    assert.equal((await run(cached, { cache: true })).result.actions[0].fromCache, 1);
    const plain = { actions: [{ action: 'upperPlain', source: 'data' }] };
    await run(plain, { cache: true });
    const second = await run(plain, { cache: true });
    assert.equal(second.result.ok, true);
    assert.equal(second.result.actions[0].fromCache, 0);
  });
});
