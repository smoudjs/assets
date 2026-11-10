import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { describe, it } from 'node:test';
import sharp from 'sharp';
import { run, scratchAssets } from './helpers.mjs';

const spineOnly = (options = {}) => ({ actions: [{ action: 'spine', source: 'spine/hero', ...options }] });
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

  it('scale follows a Spine 4 atlas, whose region keys are not indented, page by page', async () => {
    const assets = await scratchAssets();
    const blank = (size) =>
      sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.5 } } })
        .png()
        .toBuffer();
    await assets.write('spine/hero/second.png', await blank(32));
    await assets.write(
      'spine/hero/hero.atlas',
      'hero.png\nsize:64,64\nfilter:Linear,Linear\npma:true\nscale:0.5\n' +
        'head\nbounds:0,0,30,20\noffsets:1,1,32,22\nrotate:90\n' +
        'body\nbounds:33,1,29,29\nsplit:3,3,3,3\n' +
        '\nsecond.png\nsize:32,32\nfilter:Linear,Linear\narm\nbounds:0,0,15,15\n'
    );
    const { result, read } = await run({ source: assets.dir, ...spineOnly({ scale: 0.5 }) });
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.equal(
      (await read('spine/hero/hero.atlas')).toString(),
      'hero.png\nsize:32,32\nfilter:Linear,Linear\npma:true\nscale:0.5\n' +
        // rotated: 30 by 20 as unrotated, 20 by 30 on the page
        'head\nbounds:0,0,15,10\noffsets:1,1,16,11\nrotate:90\n' +
        // rounded at its edges: 16.5 to 31 makes 17 to 31, 14 wide, where rounding the width alone gives 15
        'body\nbounds:17,1,14,14\nsplit:2,2,2,2\n' +
        '\nsecond.png\nsize:16,16\nfilter:Linear,Linear\narm\nbounds:0,0,8,8\n'
    );
    assert.equal((await sharp(await read('spine/hero/second.png')).metadata()).width, 16);
  });

  it('scale follows a Spine 3 atlas: xy and size round at their edges, rotate: true turns them', async () => {
    const assets = await scratchAssets();
    await assets.write(
      'spine/hero/hero.atlas',
      '\nhero.png\nsize: 64,64\nformat: RGBA8888\nfilter: Linear,Linear\nrepeat: none\n' +
        'head\n  rotate: true\n  xy: 33, 1\n  size: 20, 29\n  orig: 22, 30\n  offset: 1, 1\n  index: -1\n'
    );
    const { result, read } = await run({ source: assets.dir, ...spineOnly({ scale: 0.5 }) });
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.equal(
      (await read('spine/hero/hero.atlas')).toString(),
      '\nhero.png\nsize: 32,32\nformat: RGBA8888\nfilter: Linear,Linear\nrepeat: none\n' +
        'head\n  rotate: true\n  xy: 17, 1\n  size: 10, 14\n  orig: 11, 15\n  offset: 1, 1\n  index: -1\n'
    );
  });

  it('webp takes the image action encoder settings for webp pages', async () => {
    // alpha with detail, which a lower alpha quality can save on; the fixture page has only two flat alphas
    const assets = await scratchAssets();
    const pixels = Buffer.alloc(64 * 64 * 4);
    for (let i = 0; i < 64 * 64; i++) pixels.set([200, 120, 40, Math.round(127 + 127 * Math.sin(i * 0.37) * Math.cos(i * 0.11))], i * 4);
    await assets.write('spine/hero/hero.png', await sharp(pixels, { raw: { width: 64, height: 64, channels: 4 } }).png().toBuffer());
    const pageSize = async (options) => {
      const { read } = await run({ source: assets.dir, ...spineOnly({ format: 'webp', ...options }) });
      return (await read('spine/hero/hero.webp')).length;
    };
    assert.ok((await pageSize({ webp: { alphaQuality: 10 } })) < (await pageSize({})), 'a lower alpha quality makes a smaller page');
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

  it('animations false removes them all; include and exclude take names and patterns', async () => {
    const none = await run(spineOnly({ animations: false }));
    assert.equal(JSON.parse(await none.read('spine/hero/hero.json')).animations, undefined);
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

  it('a .skel alone of a version other than 4.2 is kept as it is, with a warning when animations are set', async () => {
    const assets = await scratchAssets();
    await assets.remove('spine/hero/hero.json');
    const { result, read } = await run({ source: assets.dir, ...spineOnly({ animations: { exclude: ['idle'] } }) });
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.match(result.warnings.join('\n'), /only 4\.2; animations and skins work on a \.json only; the \.skel is kept as it is/);
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
