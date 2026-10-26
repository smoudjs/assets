import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import sharp from 'sharp';
import { ASSETS, run } from './helpers.mjs';

const parse = (buffer) => JSON.parse(buffer.toString());
const size = async (buffer) => {
  const { width, height, format } = await sharp(buffer).metadata();
  return { width, height, format };
};
/** RGBA pixels of a region, so frames can be compared byte by byte. */
const pixels = (buffer, { x, y, w, h }) =>
  sharp(buffer).extract({ left: x, top: y, width: w, height: h }).ensureAlpha().raw().toBuffer();
const isPowerOfTwo = (n) => Number.isInteger(Math.log2(n));

describe('atlas', () => {
  it('packs a folder into one page named after it, and every frame cuts back out pixel-identical', async () => {
    const { result, outputs, read } = await run({ actions: [{ action: 'atlas', source: 'sprites' }] });
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(await outputs(), ['sprites.json', 'sprites.png']);

    const page = await read('sprites.png');
    const data = parse(await read('sprites.json'));
    assert.deepEqual(Object.keys(data.frames), ['coin/coin_01', 'coin/coin_02', 'hero/idle_01', 'hero/idle_02']);
    assert.equal(data.meta.image, 'sprites.png');
    assert.equal(data.meta.related_multi_packs, undefined);
    const { width, height } = await size(page);
    assert.deepEqual(data.meta.size, { w: width, h: height });

    for (const [name, frame] of Object.entries(data.frames)) {
      const source = await readFile(path.join(ASSETS, 'sprites', `${name}.png`));
      assert.equal(frame.trimmed, true, `${name} has transparent borders to trim`);
      assert.equal(frame.rotated, false);
      assert.deepEqual([frame.spriteSourceSize.w, frame.spriteSourceSize.h], [frame.frame.w, frame.frame.h]);
      const fromPage = await pixels(page, frame.frame);
      const fromSource = await pixels(source, frame.spriteSourceSize);
      assert.ok(fromPage.equals(fromSource), `${name}: pixels on the page differ from the source`);
    }
  });

  it('splits into numbered pages when sprites do not fit, links them, and warns', async () => {
    const { result, outputs, read } = await run({
      actions: [{ action: 'atlas', source: 'sprites', maxWidth: 80, maxHeight: 80 }]
    });
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.deepEqual(await outputs(), ['sprites_1.json', 'sprites_1.png', 'sprites_2.json', 'sprites_2.png']);
    assert.ok(
      result.warnings.some((w) => w.includes('2 pages')),
      result.warnings.join('\n')
    );
    for (const page of [1, 2]) {
      const data = parse(await read(`sprites_${page}.json`));
      assert.equal(data.meta.image, `sprites_${page}.png`);
      assert.deepEqual(data.meta.related_multi_packs, [`sprites_${3 - page}.json`]);
      const { width, height } = await size(await read(`sprites_${page}.png`));
      assert.ok(width <= 80 && height <= 80, `${width}x${height}`);
    }
  });

  it('trim: false keeps whole frames; extrude repeats the edge pixels outwards', async () => {
    const { read } = await run({ actions: [{ action: 'atlas', source: 'tiles', trim: false, extrude: 2, padding: 0 }] });
    const page = await read('tiles.png');
    const data = parse(await read('tiles.json'));
    assert.deepEqual(Object.keys(data.frames), ['ground/dirt', 'ground/grass', 'walls/brick']);
    for (const frame of Object.values(data.frames)) {
      assert.equal(frame.trimmed, false);
      assert.deepEqual(frame.sourceSize, { w: 32, h: 32 });
      assert.deepEqual([frame.frame.w, frame.frame.h], [32, 32]);
      const { x, y } = frame.frame;
      const edge = await pixels(page, { x, y: y + 5, w: 1, h: 1 });
      const extruded = await pixels(page, { x: x - 2, y: y + 5, w: 1, h: 1 });
      assert.ok(edge.equals(extruded), 'the extruded pixel copies the edge');
      const corner = await pixels(page, { x: x - 2, y: y - 2, w: 1, h: 1 });
      assert.ok(corner.equals(await pixels(page, { x, y, w: 1, h: 1 })), 'corners are filled too');
    }
  });

  it('powerOfTwo rounds pages up, name and format pick the output files', async () => {
    const { outputs, read } = await run({
      actions: [{ action: 'atlas', source: 'tiles', powerOfTwo: true, format: 'webp', name: 'world' }]
    });
    assert.deepEqual(await outputs(), ['world.json', 'world.webp']);
    const { width, height, format } = await size(await read('world.webp'));
    assert.equal(format, 'webp');
    assert.ok(isPowerOfTwo(width) && isPowerOfTwo(height), `${width}x${height}`);
    assert.equal(parse(await read('world.json')).meta.image, 'world.webp');
  });

  it('png pages are lossless by default, and a quality turns on a palette', async () => {
    const lossless = await run({ actions: [{ action: 'atlas', source: 'tiles' }] });
    const palette = await run({ actions: [{ action: 'atlas', source: 'tiles', quality: 60 }] });
    const plain = await lossless.read('tiles.png');
    const quantized = await palette.read('tiles.png');
    assert.equal((await sharp(plain).metadata()).isPalette, false, 'lossless page has no palette');
    assert.equal((await sharp(quantized).metadata()).isPalette, true, 'quality gives a palette page');
    assert.ok(quantized.length < plain.length, `${quantized.length} >= ${plain.length}`);
  });

  it('a filename template with a hash names the page and its JSON alike', async () => {
    const { outputs, read } = await run({
      actions: [{ action: 'atlas', source: 'tiles', destination: { folder: 'atlases', filename: '[name].[hash:6][ext]' } }]
    });
    const files = await outputs();
    const [json, png] = files;
    assert.match(json, /^atlases\/tiles\.[0-9a-f]{6}\.json$/);
    assert.equal(png, json.replace(/json$/, 'png'));
    assert.equal(parse(await read(json)).meta.image, path.basename(png));
  });

  it('the same input gives identical bytes', async () => {
    const first = await run({ actions: [{ action: 'atlas', source: 'sprites' }] });
    const second = await run({ actions: [{ action: 'atlas', source: 'sprites' }] });
    assert.ok((await first.read('sprites.png')).equals(await second.read('sprites.png')));
    assert.ok((await first.read('sprites.json')).equals(await second.read('sprites.json')));
  });

  it('a sprite larger than the page fails the build and nothing is written', async () => {
    const { result, outputs } = await run({
      actions: [{ action: 'atlas', source: 'sprites', maxWidth: 40, maxHeight: 40 }]
    });
    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some((e) => e.includes('hero/idle_01.png') && e.includes('does not fit')),
      result.errors.join('\n')
    );
    assert.deepEqual(await outputs(), []);
  });

  it('rasterized svg icons chained through a virtual folder become an atlas named after it', async () => {
    const { result, outputs, read } = await run({
      actions: [
        { action: 'image', source: 'images/ui/icons', format: 'png', destination: '#icons' },
        { action: 'atlas', source: '#icons' }
      ]
    });
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.deepEqual(await outputs(), ['icons.json', 'icons.png']);
    assert.deepEqual(Object.keys(parse(await read('icons.json')).frames), ['check', 'star']);
  });
});
