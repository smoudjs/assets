import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import sharp from 'sharp';
import { image } from '../dist/index.js';
import { run, scratchAssets } from './helpers.mjs';

const facts = async (buffer) => {
  const meta = await sharp(buffer).metadata();
  return { format: meta.format, width: meta.width, height: meta.pageHeight ?? meta.height, alpha: meta.hasAlpha, pages: meta.pages ?? 1 };
};

describe('image: encode', () => {
  it('optimizes in place, keeps the format, never grows a file', async () => {
    const { result, outputs, read } = await run({ actions: [{ action: 'image', source: 'images' }] });
    assert.equal(result.ok, true, result.errors.join('\n'));
    const files = await outputs();
    assert.ok(files.includes('images/ui/buttons/play.png'));
    assert.ok(files.includes('images/backgrounds/sky.jpg'));
    assert.ok(!files.some((f) => f.endsWith('.svg')), 'svg without a raster format is skipped');
    for (const file of result.actions[0].files) assert.ok(file.bytesOut <= file.bytesIn, `${file.source} grew`);
    assert.equal((await facts(await read('images/ui/buttons/play.png'))).format, 'png');
  });

  it('keeps the original bytes when a pure re-encode would grow the file', async () => {
    const { result } = await run({ actions: [{ action: 'image', source: 'images/photos', lossless: true }] });
    const [noise] = result.actions[0].files;
    assert.equal(noise.keptOriginal, true);
    assert.equal(noise.bytesOut, noise.bytesIn);
  });

  it('converts to webp and keeps alpha', async () => {
    const { outputs, read } = await run({ actions: [{ action: 'image', source: 'images/ui/buttons', format: 'webp' }] });
    assert.deepEqual(await outputs(), ['images/ui/buttons/pause.webp', 'images/ui/buttons/play.webp']);
    const info = await facts(await read('images/ui/buttons/play.webp'));
    assert.equal(info.format, 'webp');
    assert.equal(info.alpha, true);
  });

  it('a format list keeps the smallest and skips jpeg for alpha images', async () => {
    const { result, outputs, read } = await run({
      actions: [{ action: 'image', source: ['images/ui/logo.png', 'images/backgrounds/sky.jpg'], format: ['jpeg', 'png'] }]
    });
    assert.equal(result.ok, true, result.errors.join('\n'));
    const files = await outputs();
    assert.ok(files.includes('images/ui/logo.png'), 'alpha image stays png');
    assert.ok(files.includes('images/backgrounds/sky.jpg'), 'opaque photo stays jpeg');
    assert.equal((await facts(await read('images/backgrounds/sky.jpg'))).format, 'jpeg');
  });

  it('flattens alpha onto a colour for jpeg and warns when no colour is given', async () => {
    const warned = await run({ actions: [{ action: 'image', source: 'images/ui/logo.png', format: 'jpeg' }] });
    assert.ok(warned.result.warnings.some((w) => w.includes('flatten')), warned.result.warnings.join('\n'));
    const flat = await run({ actions: [{ action: 'image', source: 'images/ui/logo.png', format: 'jpeg', flatten: '#ffffff' }] });
    assert.deepEqual(flat.result.warnings, []);
    const info = await facts(await flat.read('images/ui/logo.jpg'));
    assert.equal(info.format, 'jpeg');
    assert.equal(info.alpha, false);
  });
});

describe('image: geometry', () => {
  it('resize to width and height with fit "inside" bounds the size and never upscales', async () => {
    const { read } = await run({
      actions: [
        {
          action: 'image',
          source: ['images/backgrounds/sky.jpg', 'images/ui/buttons/play.png'],
          resize: { width: 100, height: 100, fit: 'inside' }
        }
      ]
    });
    const sky = await facts(await read('images/backgrounds/sky.jpg'));
    assert.deepEqual([sky.width, sky.height], [100, 75]);
    const button = await facts(await read('images/ui/buttons/play.png'));
    assert.deepEqual([button.width, button.height], [48, 48]);
  });

  it('scale and exact width/height', async () => {
    const half = await run({ actions: [{ action: 'image', source: 'images/backgrounds/sky.jpg', resize: { scale: 0.5 } }] });
    assert.deepEqual((({ width, height }) => [width, height])(await facts(await half.read('images/backgrounds/sky.jpg'))), [160, 120]);
    const exact = await run({ actions: [{ action: 'image', source: 'images/textures/grass.png', resize: { width: 8, height: 8, kernel: 'nearest' } }] });
    const grass = await facts(await exact.read('images/textures/grass.png'));
    assert.deepEqual([grass.width, grass.height], [8, 8]);
  });

  it('trim removes transparent borders', async () => {
    const { read } = await run({ actions: [{ action: 'image', source: 'images/ui/buttons/play.png', trim: true }] });
    const info = await facts(await read('images/ui/buttons/play.png'));
    assert.ok(info.width < 48 && info.height < 48, `${info.width}x${info.height}`);
  });

  it('rasterizes svg at the given density', async () => {
    const low = await run({ actions: [{ action: 'image', source: 'images/ui/icons/check.svg', format: 'png' }] });
    assert.equal((await facts(await low.read('images/ui/icons/check.png'))).width, 64);
    const high = await run({ actions: [{ action: 'image', source: 'images/ui/icons/check.svg', format: 'png', density: 144 }] });
    assert.equal((await facts(await high.read('images/ui/icons/check.png'))).width, 128);
  });
});

describe('image: animation', () => {
  it('keeps gif animation, or takes the first frame when asked', async () => {
    const kept = await run({ actions: [{ action: 'image', source: 'images/effects' }] });
    assert.equal((await facts(await kept.read('images/effects/spark.gif'))).pages, 2);
    const still = await run({ actions: [{ action: 'image', source: 'images/effects', animated: false }] });
    const info = await facts(await still.read('images/effects/spark.gif'));
    assert.equal(info.pages, 1);
    assert.equal(info.height, 32);
  });

  it('animation survives webp and collapses to one frame for png', async () => {
    const webp = await run({ actions: [{ action: 'image', source: 'images/effects', format: 'webp' }] });
    assert.equal((await facts(await webp.read('images/effects/spark.webp'))).pages, 2);
    const png = await run({ actions: [{ action: 'image', source: 'images/effects', format: 'png' }] });
    const info = await facts(await png.read('images/effects/spark.png'));
    assert.deepEqual([info.pages, info.height], [1, 32]);
  });
});

describe('image: when and failures', () => {
  it('when.alpha uses the probe', async () => {
    const { result } = await run({
      actions: [{ action: 'image', source: { include: ['images/ui/buttons', 'images/backgrounds'], when: { alpha: false } } }]
    });
    assert.deepEqual(
      result.actions[0].files.map((f) => f.source).sort(),
      ['images/backgrounds/forest/night.jpg', 'images/backgrounds/sky.jpg']
    );
  });

  it('a corrupt image fails the build and nothing is written', async () => {
    const assets = await scratchAssets();
    await assets.write('images/ui/broken.png', 'this is not a png');
    const { result, outputs } = await run({ source: assets.dir, actions: [{ action: 'image', source: 'images/ui' }] });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('broken.png')), result.errors.join('\n'));
    assert.deepEqual(await outputs(), []);
  });
});

describe('image()', () => {
  it('returns converted files in memory', async () => {
    const result = await image({ source: 'tests/assets/images/ui/buttons', format: 'webp', quality: 70 });
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.deepEqual(result.outputs.map((f) => f.path).sort(), ['pause.webp', 'play.webp']);
    assert.equal((await facts(result.outputs[0].data)).format, 'webp');
  });
});
