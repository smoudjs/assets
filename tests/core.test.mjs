import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ASSETS, bundle, run, scratchAssets, tag } from './helpers.mjs';

describe('core', () => {
  it('writes an explicit destination folder relative to the pattern folder', async () => {
    const { result, outputs } = await run({ actions: [{ action: 'copy', source: 'images/ui', destination: 'interface' }] });
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.deepEqual(await outputs(), [
      'interface/buttons/pause.png',
      'interface/buttons/play.png',
      'interface/icons/check.svg',
      'interface/icons/star.svg',
      'interface/logo.png'
    ]);
  });

  it('mirrors the source tree when destination is omitted', async () => {
    const { outputs } = await run({ actions: [{ action: 'copy', source: 'spine' }, { action: 'copy', source: 'data/**/*.json' }] });
    assert.deepEqual(await outputs(), [
      'data/levels/level_01.json',
      'data/levels/level_02.json',
      'spine/hero/hero.atlas',
      'spine/hero/hero.json',
      'spine/hero/hero.png',
      'spine/hero/hero.skel'
    ]);
  });

  it('#rest takes what no other action selected, and when filters by size', async () => {
    const { result, outputs } = await run({
      actions: [{ action: 'copy', source: 'spine' }, { action: 'copy', source: { include: '#rest', when: { size: '<20kb' } } }]
    });
    assert.equal(result.ok, true);
    const files = await outputs();
    assert.ok(files.includes('spine/hero/hero.png'));
    assert.ok(files.includes('tiles/ground/dirt.png'));
    assert.ok(!files.includes('images/photos/noise.png'), 'noise.png is above 20kb');
    assert.deepEqual(result.unselected, ['images/photos/noise.png']);
  });

  it('#rest takes what the actions above left, in list order', async () => {
    const { result } = await run({
      actions: [
        { action: 'copy', source: 'tiles' },
        { action: 'copy', source: { include: '#rest', when: { size: '>20kb' } }, destination: 'big' },
        { action: 'copy', source: 'images/photos' },
        { action: 'copy', source: '#rest' }
      ]
    });
    assert.equal(result.ok, true, result.errors.join('\n'));
    const sources = (index) => result.actions[index].files.map((file) => file.source);
    assert.deepEqual(sources(1), ['images/photos/noise.png'], 'still free when the #rest above action 3 runs');
    assert.deepEqual(sources(2), ['images/photos/noise.png'], 'an explicit source selects whatever #rest took');
    assert.ok(!sources(3).includes('images/photos/noise.png') && !sources(3).some((s) => s.startsWith('tiles/')));
    assert.ok(sources(3).includes('data/config.xml'));
  });

  it('a pattern without a slash matches file names at any depth', async () => {
    const { outputs } = await run({ actions: [{ action: 'copy', source: { include: 'spine', exclude: '*.json' } }] });
    assert.deepEqual(await outputs(), ['spine/hero/hero.atlas', 'spine/hero/hero.png', 'spine/hero/hero.skel']);
    const pngs = await run({ actions: [{ action: 'copy', source: '*.png', destination: 'flat' }] });
    assert.ok((await pngs.outputs()).includes('flat/tiles/ground/dirt.png'));
  });

  it('two actions aiming at the same path is a collision and nothing is written', async () => {
    const { result, outputs } = await run({ actions: ['copy', { action: 'copy', source: 'images/ui' }] });
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /produced twice/);
    assert.match(result.errors[0], /#rest/);
    assert.deepEqual(await outputs(), []);
  });

  it('a failed build leaves the previous output untouched', async () => {
    const first = await run({ actions: [{ action: 'copy', source: 'data' }] });
    const before = await first.outputs();
    const second = await run({ destination: first.destination, actions: ['copy', { action: 'copy', source: 'data' }] });
    assert.equal(second.result.ok, false);
    assert.deepEqual(await second.outputs(), before);
    assert.equal(await second.exists('.staging'), false);
  });

  it('removes stale output after a source file disappears', async () => {
    const assets = await scratchAssets();
    const first = await run({ source: assets.dir, actions: [{ action: 'copy', source: 'data' }] });
    assert.ok((await first.outputs()).includes('data/levels/level_02.json'));
    await assets.remove('data/levels/level_02.json');
    const second = await run({ source: assets.dir, destination: first.destination, actions: [{ action: 'copy', source: 'data' }] });
    assert.deepEqual(await second.outputs(), ['data/config.xml', 'data/levels/level_01.json']);
  });

  it('keeps stale output with clean: false', async () => {
    const assets = await scratchAssets();
    const config = { source: assets.dir, clean: false, actions: [{ action: 'copy', source: 'data' }] };
    const first = await run(config);
    await assets.remove('data/config.xml');
    const second = await run({ ...config, destination: first.destination });
    assert.ok((await second.outputs()).includes('data/config.xml'));
  });

  it('passes files through a virtual folder and warns when one is never read', async () => {
    const { result, outputs } = await run({
      actions: [
        { action: 'copy', source: 'tiles', destination: '#tiles' },
        { action: 'copy', source: '#tiles/ground/**', destination: 'ground' },
        { action: 'copy', source: 'data', destination: '#unused' }
      ]
    });
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.deepEqual(await outputs(), ['ground/dirt.png', 'ground/grass.png']);
    assert.ok(result.warnings.some((w) => w.includes('#unused')), result.warnings.join('\n'));
  });

  it('reading a virtual folder before it exists is an error', async () => {
    const { result } = await run({ actions: [{ action: 'copy', source: '#later' }, { action: 'copy', source: 'data', destination: '#later' }] });
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /#later/);
  });

  it('dry run processes everything and writes nothing', async () => {
    const { result, outputs } = await run({ actions: ['copy'] }, { dryRun: true });
    assert.equal(result.ok, true);
    assert.ok(result.actions[0].files.length > 20);
    assert.deepEqual(await outputs(), []);
  });

  it('strict turns warnings into failure', async () => {
    const relaxed = await run({ actions: [{ action: 'copy', source: 'nothing-here' }] });
    assert.equal(relaxed.result.ok, true);
    assert.match(relaxed.result.warnings[0], /selected no files/);
    const strict = await run({ actions: [{ action: 'copy', source: 'nothing-here' }] }, { strict: true });
    assert.equal(strict.result.ok, false);
  });

  it('warns when a catch-all overlaps another action', async () => {
    const { result, outputs } = await run({ actions: ['tag', { action: 'copy', source: 'data' }] }, { types: { tag } });
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.ok(result.warnings.some((w) => w.includes('also selected') && w.includes('#rest')), result.warnings.join('\n'));
    const files = await outputs();
    assert.ok(files.includes('data/config-tagged.xml'));
    assert.ok(files.includes('data/config.xml'));
  });

  it('group outputs land at the root, named after the selected folder, and know their final filename', async () => {
    const { result, outputs, read } = await run(
      {
        actions: [
          { action: 'bundle', source: 'tiles' },
          { action: 'bundle', source: ['data', 'spine'], destination: { folder: 'misc', filename: '[name].[hash:4][ext]' } }
        ]
      },
      { types: { bundle } }
    );
    assert.equal(result.ok, true, result.errors.join('\n'));
    const files = await outputs();
    assert.ok(files.includes('tiles.txt') && files.includes('tiles.ref'), files.join('\n'));
    assert.equal((await read('tiles.txt')).toString(), 'ground/dirt.png\nground/grass.png\nwalls/brick.png');
    const ref = files.find((file) => /^misc\/all\.[0-9a-f]{4}\.ref$/.test(file));
    assert.ok(ref, files.join('\n'));
    assert.ok(files.includes(`misc/${(await read(ref)).toString()}`), 'the .ref names the .txt as written');
  });

  it('applies filename templates with name, ext and hash', async () => {
    const { outputs } = await run({
      actions: [{ action: 'copy', source: 'data/config.xml', destination: { folder: 'cfg', filename: '[name].[hash:6][ext]' } }]
    });
    const [output] = await outputs();
    assert.match(output, /^cfg\/config\.[0-9a-f]{6}\.xml$/);
  });

  it('reports unknown keys with a hint and still builds', async () => {
    const { result } = await run({ actions: [{ action: 'copy', sourse: 'data' }] });
    assert.equal(result.ok, true);
    assert.ok(result.warnings.some((w) => w.includes('"sourse"') && w.includes('"source"')), result.warnings.join('\n'));
  });

  it('refuses unsafe folder layouts', async () => {
    await assert.rejects(run({ destination: ASSETS, actions: ['copy'] }), /same folder/);
    await assert.rejects(run({ source: `${ASSETS}/data`, destination: ASSETS, actions: ['copy'] }), /contain/);
    await assert.rejects(run({ destination: process.cwd(), actions: ['copy'] }), /project root/);
  });
});
