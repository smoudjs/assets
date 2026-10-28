import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { describe, it } from 'node:test';
import sharp from 'sharp';
import { run, scratchAssets } from './helpers.mjs';

const spineOnly = (options = {}) => ({ actions: [{ action: 'spine', source: 'spine', ...options }] });
const animationsOf = async (read) => Object.keys(JSON.parse(await read('spine/hero/hero.json')).animations);

describe('spine: pages and atlas', () => {
  it('a page in a new format is renamed, and the .atlas names it', async () => {
    const { result, outputs, read } = await run(spineOnly({ format: 'webp' }));
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.deepEqual(await outputs(), [
      'spine/hero/hero.atlas',
      'spine/hero/hero.json',
      'spine/hero/hero.skel',
      'spine/hero/hero.webp'
    ]);
    assert.equal((await read('spine/hero/hero.atlas')).toString().split('\n')[0], 'hero.webp');
    assert.equal((await sharp(await read('spine/hero/hero.webp')).metadata()).format, 'webp');
  });

  it('scale shrinks the page and every coordinate in the .atlas', async () => {
    const { read } = await run(spineOnly({ scale: 0.5 }));
    const atlas = (await read('spine/hero/hero.atlas')).toString();
    assert.match(atlas, /^size: 32, 32$/m);
    assert.match(atlas, /^ {2}bounds: 0, 0, 16, 16$/m);
    assert.match(atlas, /^ {2}offsets: 1, 1, 18, 18$/m);
    assert.match(atlas, /^ {2}bounds: 16, 0, 16, 16$/m);
    const page = await sharp(await read('spine/hero/hero.png')).metadata();
    assert.deepEqual([page.width, page.height], [32, 32]);
  });

  it('maxWidth shrinks only a page bigger than it, and its coordinates follow', async () => {
    const { read } = await run(spineOnly({ maxWidth: 40 }));
    const atlas = (await read('spine/hero/hero.atlas')).toString();
    assert.match(atlas, /^size: 40, 40$/m);
    assert.match(atlas, /^ {2}bounds: 0, 0, 20, 20$/m);
    assert.equal((await sharp(await read('spine/hero/hero.png')).metadata()).width, 40);

    const roomy = await run(spineOnly({ maxWidth: 2048, maxHeight: 2048 }));
    assert.match((await roomy.read('spine/hero/hero.atlas')).toString(), /^ {2}bounds: 0, 0, 32, 32$/m);
  });

  it('jpeg is refused for a page with transparency, with a warning', async () => {
    const { result, outputs } = await run(spineOnly({ format: 'jpeg' }));
    assert.ok((await outputs()).includes('spine/hero/hero.png'));
    assert.ok(
      result.warnings.some((warning) => warning.includes('transparency')),
      result.warnings.join('\n')
    );
  });

  it('a filename template names the page, and the .atlas refers to that name', async () => {
    const { outputs, read } = await run(spineOnly({ destination: { filename: '[name].[hash][ext]' } }));
    const page = (await outputs()).find((file) => /hero\.[0-9a-f]{8}\.png$/.test(file));
    const atlas = (await outputs()).find((file) => file.endsWith('.atlas'));
    assert.equal((await read(atlas)).toString().split('\n')[0], page.split('/').pop());
  });

  it('pages are used up with the .atlas: a later image action never converts them', async () => {
    const { result, read } = await run({
      actions: [
        { action: 'spine', source: 'spine' },
        { action: 'image', source: '**/*.png', format: 'webp' }
      ]
    });
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.ok(!result.actions[1].files.some((file) => file.source.startsWith('spine/')));
    assert.equal((await read('spine/hero/hero.atlas')).toString().split('\n')[0], 'hero.png');
  });

  it('playable-max keeps Spine working: the page becomes webp and the .atlas says so', async () => {
    const { result, outputs, read } = await run({ preset: 'playable-max' });
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.ok((await outputs()).includes('spine/hero/hero.webp'));
    assert.equal((await read('spine/hero/hero.atlas')).toString().split('\n')[0], 'hero.webp');
  });
});

describe('spine: skeleton', () => {
  it('numbers keep precision decimals, and the .json is minified', async () => {
    const standard = JSON.parse(await (await run(spineOnly())).read('spine/hero/hero.json'));
    assert.deepEqual([standard.bones[1].x, standard.bones[1].y], [1.235, -2.988]);
    const { read } = await run(spineOnly({ precision: 1 }));
    const text = (await read('spine/hero/hero.json')).toString();
    assert.ok(!text.includes('\n'));
    assert.equal(JSON.parse(text).animations.idle.bones.head.rotate[0].time, 0.3);
  });

  it('animations include and exclude take names and patterns', async () => {
    assert.deepEqual(await animationsOf((await run(spineOnly({ animations: { include: ['run*'] } }))).read), [
      'run_fast',
      'run_slow'
    ]);
    assert.deepEqual(await animationsOf((await run(spineOnly({ animations: { exclude: ['debug/*', 'idle'] } }))).read), [
      'run_fast',
      'run_slow'
    ]);
  });

  it('include and exclude together, or an include that keeps nothing, fail; a pattern matching nothing warns', async () => {
    const both = await run(spineOnly({ animations: { include: ['idle'], exclude: ['run*'] } }));
    assert.equal(both.result.ok, false);
    assert.match(both.result.errors.join('\n'), /include or exclude, not both/);

    const nothing = await run(spineOnly({ animations: { include: ['jump'] } }));
    assert.equal(nothing.result.ok, false);
    assert.match(nothing.result.errors.join('\n'), /keeps no animation/);

    const typo = await run(spineOnly({ animations: { include: ['idle', 'jump'] } }));
    assert.equal(typo.result.ok, true, typo.result.errors.join('\n'));
    assert.match(typo.result.warnings.join('\n'), /"jump" matches nothing/);
  });

  it('a .skel alone is kept as it is, with a warning when animations are set', async () => {
    const assets = await scratchAssets();
    await assets.remove('spine/hero/hero.json');
    const { result, read } = await run({ source: assets.dir, ...spineOnly({ animations: { exclude: ['idle'] } }) });
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.match(result.warnings.join('\n'), /binary \.skel is kept as it is/);
    assert.deepEqual([...(await read('spine/hero/hero.skel'))], [0x53, 0x4b, 0x45, 0x4c, 0x00, 0x04, 0x01, 0x00]);
  });
});

describe('spine: cache and failures', () => {
  it('a second build comes from the cache, and a changed page does not', async () => {
    const assets = await scratchAssets();
    const config = { source: assets.dir, ...spineOnly() };
    await run(config);
    assert.equal((await run(config)).result.actions[0].fromCache, 1);
    const background = { r: randomInt(256), g: randomInt(256), b: 0, alpha: 0.5 };
    await assets.write(
      'spine/hero/hero.png',
      await sharp({ create: { width: 64, height: 64, channels: 4, background } })
        .png()
        .toBuffer()
    );
    assert.equal((await run(config)).result.actions[0].fromCache, 0);
  });

  it('a missing page fails the build, named, and nothing is written', async () => {
    const assets = await scratchAssets();
    await assets.remove('spine/hero/hero.png');
    const { result, outputs } = await run({ source: assets.dir, ...spineOnly() });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /hero\.png is missing/);
    assert.deepEqual(await outputs(), []);
  });
});
