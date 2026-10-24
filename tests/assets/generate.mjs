/**
 * Generates the shared test resources deterministically. Run once; the output is committed.
 *
 *   node tests/assets/generate.mjs
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.dirname(fileURLToPath(import.meta.url));

/** Seeded random numbers so every machine produces the same bytes. */
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An image from a function of (x, y) → [r, g, b, a]. */
function paint(width, height, pixel) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.set(pixel(x, y), (y * width + x) * 4);
  }
  return sharp(data, { raw: { width, height, channels: 4 } });
}

async function write(relative, buffer) {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, buffer);
  console.log(`${relative.padEnd(36)} ${buffer.length} bytes`);
}

const png = (image) => image.png().toBuffer();
const jpeg = (image) => image.jpeg({ quality: 92 }).toBuffer();

// --- backgrounds: opaque, photo-like gradients with soft blobs --------------------------------

function background(seed, width, height, hue) {
  const rand = random(seed);
  const blobs = Array.from({ length: 10 }, () => [rand() * width, rand() * height, 40 + rand() * 120, rand() * 255]);
  return paint(width, height, (x, y) => {
    let r = (x / width) * 255 * hue[0];
    let g = (y / height) * 255 * hue[1];
    let b = 128 + 127 * Math.sin((x + y) / 60) * hue[2];
    for (const [cx, cy, radius, tint] of blobs) {
      const d = Math.hypot(x - cx, y - cy);
      if (d < radius) {
        const k = 1 - d / radius;
        r = r * (1 - k) + tint * k;
        g = g * (1 - k) + (255 - tint) * k;
      }
    }
    return [r, g, b, 255];
  });
}

await write('images/backgrounds/sky.jpg', await jpeg(background(1, 320, 240, [0.6, 0.8, 1])));
await write('images/backgrounds/forest/night.jpg', await jpeg(background(2, 256, 192, [0.2, 0.5, 0.4])));

// --- ui: alpha shapes ------------------------------------------------------------------------

function disc(size, color, inner = 0) {
  const c = size / 2;
  return paint(size, size, (x, y) => {
    const d = Math.hypot(x - c, y - c);
    if (d > c - 2 || d < inner) return [0, 0, 0, 0];
    const edge = Math.min(c - 2 - d, inner ? d - inner : 99) / 3;
    return [...color, Math.round(255 * Math.min(1, edge))];
  });
}

await write('images/ui/buttons/play.png', await png(disc(48, [60, 200, 90])));
await write('images/ui/buttons/pause.png', await png(disc(48, [230, 120, 60])));
await write('images/ui/logo.png', await png(disc(128, [40, 90, 220], 35)));

const svg = (body) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">\n${body}\n</svg>\n`);
await write(
  'images/ui/icons/check.svg',
  svg('  <circle cx="32" cy="32" r="28" fill="#3366ff"/>\n  <path d="M20 34 L29 43 L45 24" stroke="#fff" stroke-width="6" fill="none" stroke-linecap="round"/>')
);
await write(
  'images/ui/icons/star.svg',
  svg('  <polygon points="32,4 40,24 62,26 45,40 50,62 32,50 14,62 19,40 2,26 24,24" fill="#ffcc00" stroke="#996600" stroke-width="2"/>')
);

// --- textures: 16×16 pixel art, nearest-neighbour territory -------------------------------------

const checker = (a, b) => paint(16, 16, (x, y) => (((x >> 2) + (y >> 2)) % 2 ? a : b));
await write('images/textures/grass.png', await png(checker([40, 160, 60, 255], [60, 200, 90, 255])));
await write('images/textures/water.png', await png(checker([30, 90, 200, 255], [60, 140, 240, 200])));

// --- effects: a two-frame animated GIF ----------------------------------------------------------

{
  const frames = Buffer.alloc(32 * 64 * 4);
  for (let frame = 0; frame < 2; frame++) {
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) {
        const on = frame === 0 ? x < 16 : x >= 16;
        frames.set(on ? [255, 200, 0, 255] : [30, 30, 60, 255], ((frame * 32 + y) * 32 + x) * 4);
      }
    }
  }
  const image = sharp(frames, { raw: { width: 32, height: 64, channels: 4, pageHeight: 32 } });
  await write('images/effects/spark.gif', await image.gif({ loop: 0 }).toBuffer());
}

// --- photos: noise, about 30 KB and incompressible, for size filters (">20kb") and "never grow" ----

{
  const rand = random(3);
  const image = paint(96, 96, () => [rand() * 255, rand() * 255, rand() * 255, 255]);
  await write('images/photos/noise.png', await image.png({ compressionLevel: 9 }).toBuffer());
}

// --- tiles and sprites: small opaque / alpha squares, future atlas input --------------------------

const tile = (seed, base) => {
  const rand = random(seed);
  return paint(32, 32, () => [base[0] + rand() * 40, base[1] + rand() * 40, base[2] + rand() * 40, 255]);
};
await write('tiles/ground/dirt.png', await png(tile(10, [120, 80, 40])));
await write('tiles/ground/grass.png', await png(tile(11, [50, 150, 60])));
await write('tiles/walls/brick.png', await png(tile(12, [160, 60, 50])));

const frame = (size, color, phase) =>
  paint(size, size, (x, y) => {
    const c = size / 2;
    const d = Math.hypot(x - c, (y - c) * (1 + 0.3 * phase));
    return d < c - 4 ? [...color, 255] : [0, 0, 0, 0];
  });
await write('sprites/hero/idle_01.png', await png(frame(64, [200, 160, 120], 0)));
await write('sprites/hero/idle_02.png', await png(frame(64, [200, 160, 120], 1)));
await write('sprites/coin/coin_01.png', await png(frame(24, [250, 210, 40], 0)));
await write('sprites/coin/coin_02.png', await png(frame(24, [250, 210, 40], 1)));

// --- spine: a linked group that must travel together untouched ------------------------------------

await write('spine/hero/hero.png', await png(paint(64, 64, (x, y) => [x * 4, y * 4, 128, x < 32 ? 255 : 128])));
await write(
  'spine/hero/hero.atlas',
  Buffer.from('hero.png\nsize: 64, 64\nformat: RGBA8888\nfilter: Linear, Linear\nrepeat: none\nhead\n  bounds: 0, 0, 32, 32\nbody\n  bounds: 32, 0, 32, 32\n')
);
await write(
  'spine/hero/hero.json',
  Buffer.from(JSON.stringify({ skeleton: { spine: '4.1.00', hash: 'test' }, bones: [{ name: 'root' }], slots: [], skins: [] }, null, 2))
);
await write('spine/hero/hero.skel', Buffer.from([0x53, 0x4b, 0x45, 0x4c, 0x00, 0x04, 0x01, 0x00]));

// --- data: non-image files for copy and #rest ------------------------------------------------------

await write('data/levels/level_01.json', Buffer.from(JSON.stringify({ width: 10, height: 8, tiles: [1, 2, 3] })));
await write('data/levels/level_02.json', Buffer.from(JSON.stringify({ width: 12, height: 9, tiles: [3, 2, 1] })));
await write('data/config.xml', Buffer.from('<?xml version="1.0"?>\n<game>\n  <title>Test</title>\n  <fps>60</fps>\n</game>\n'));
