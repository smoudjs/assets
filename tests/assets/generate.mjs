/**
 * Generates the shared test resources deterministically. Run once; the output is committed.
 *
 *   node tests/assets/generate.mjs
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document, NodeIO } from '@gltf-transform/core';
import { runFfmpeg } from '@smoud/ffmpeg';
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

await write('data/config.xml', Buffer.from('<?xml version="1.0"?>\n<game>\n  <title>Test</title>\n  <fps>60</fps>\n</game>\n'));

// --- audio: sine tones, each under 20kb so size filters still see noise.png alone --------------------
// music is longer and stereo, sfx short and mostly mono; every codec the audio action reads appears once

/** A sine tone encoded by ffmpeg; `bitexact` keeps encoder names and random stream ids out of the bytes. */
async function tone(relative, frequency, seconds, args) {
  const output = path.join(os.tmpdir(), `smoud-tone${path.extname(relative)}`);
  await runFfmpeg([
    ...['-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=${seconds}`],
    ...['-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact', ...args, '-y', output]
  ]);
  await write(relative, await readFile(output));
  await rm(output, { force: true });
}

await tone('audio/music/theme.ogg', 330, 3, ['-ac', '2', '-ar', '44100', '-c:a', 'libvorbis', '-b:a', '48k']);
await tone('audio/music/intro.mp3', 262, 2, ['-ac', '2', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '64k']);
await tone('audio/sfx/click.wav', 1200, 0.2, ['-ac', '1', '-ar', '22050']);
await tone('audio/sfx/coin.wav', 990, 0.1, ['-ac', '2', '-ar', '44100']);
await tone('audio/sfx/jump.m4a', 520, 0.5, ['-ac', '1', '-ar', '44100', '-c:a', 'aac', '-b:a', '64k']);
await tone('audio/sfx/hit.flac', 110, 0.3, ['-ac', '1', '-ar', '44100']);
await tone('audio/sfx/laser.opus', 1760, 0.5, ['-ac', '1', '-c:a', 'libopus', '-b:a', '32k']);

// --- models: glTF built with glTF Transform, each under 20kb -----------------------------------------
// crate: a textured box with vertex colors and an animation, plus a copy with an identical material and an unused
// material for the cleanup to find; sphere: 1152 positions-only triangles for simplify

/** A unit box with four vertices per face, so each face has its own normal and UVs. Faces are [normal, u, v]. */
function boxGeometry() {
  const faces = [
    [[1, 0, 0], [0, 0, -1], [0, 1, 0]],
    [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [1, 0, 0], [0, 0, -1]],
    [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
    [[0, 0, -1], [-1, 0, 0], [0, 1, 0]]
  ];
  const geometry = { position: [], normal: [], uv: [], color: [], index: [] };
  faces.forEach(([normal, u, v], face) => {
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      geometry.position.push(...normal.map((n, i) => (n + a * u[i] + b * v[i]) / 2));
      geometry.normal.push(...normal);
      geometry.uv.push((a + 1) / 2, (1 - b) / 2);
      geometry.color.push(face / 5, 1 - face / 5, 0.5, 1);
    }
    geometry.index.push(face * 4, face * 4 + 1, face * 4 + 2, face * 4, face * 4 + 2, face * 4 + 3);
  });
  return geometry;
}

async function crateDocument() {
  const doc = new Document();
  const buffer = doc.createBuffer('crate').setURI('crate.bin');
  const accessor = (type, array) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
  const wood = await png(paint(32, 32, (x, y) => [150 + ((x * 7) % 40), 100 + ((y * 5) % 30), 50, 255]));
  const texture = doc.createTexture('wood').setImage(wood).setMimeType('image/png').setURI('crate.png');
  doc.createMaterial('unused');
  const box = boxGeometry();
  const scene = doc.createScene('scene');
  const nodes = ['crate', 'crate-copy'].map((name, i) => {
    const primitive = doc
      .createPrimitive()
      .setAttribute('POSITION', accessor('VEC3', new Float32Array(box.position)))
      .setAttribute('NORMAL', accessor('VEC3', new Float32Array(box.normal)))
      .setAttribute('TEXCOORD_0', accessor('VEC2', new Float32Array(box.uv)))
      .setAttribute('COLOR_0', accessor('VEC4', new Float32Array(box.color)))
      .setIndices(accessor('SCALAR', new Uint16Array(box.index)))
      .setMaterial(doc.createMaterial(`wood-${i}`).setBaseColorTexture(texture));
    const node = doc.createNode(name).setMesh(doc.createMesh(name).addPrimitive(primitive)).setTranslation([i * 2, 0, 0]);
    scene.addChild(node);
    return node;
  });
  const sampler = doc
    .createAnimationSampler()
    .setInput(accessor('SCALAR', new Float32Array([0, 1, 2])))
    .setOutput(accessor('VEC4', new Float32Array([0, 0, 0, 1, 0, Math.SQRT1_2, 0, Math.SQRT1_2, 0, 1, 0, 0])))
    .setInterpolation('LINEAR');
  const channel = doc.createAnimationChannel().setTargetNode(nodes[0]).setTargetPath('rotation').setSampler(sampler);
  doc.createAnimation('spin').addSampler(sampler).addChannel(channel);
  return doc;
}

function sphereDocument() {
  const doc = new Document();
  const buffer = doc.createBuffer('sphere').setURI('sphere.bin');
  const steps = 24;
  const position = [];
  const index = [];
  for (let ring = 0; ring <= steps; ring++) {
    for (let segment = 0; segment <= steps; segment++) {
      const [theta, phi] = [(ring / steps) * Math.PI, (segment / steps) * 2 * Math.PI];
      position.push(Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi));
    }
  }
  for (let ring = 0; ring < steps; ring++) {
    for (let segment = 0; segment < steps; segment++) {
      const [a, b] = [ring * (steps + 1) + segment, (ring + 1) * (steps + 1) + segment];
      index.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const accessor = (type, array) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
  const primitive = doc
    .createPrimitive()
    .setAttribute('POSITION', accessor('VEC3', new Float32Array(position)))
    .setIndices(accessor('SCALAR', new Uint16Array(index)));
  const node = doc.createNode('sphere').setMesh(doc.createMesh('sphere').addPrimitive(primitive));
  doc.createScene('scene').addChild(node);
  return doc;
}

const io = new NodeIO();
await write('models/crate.glb', Buffer.from(await io.writeBinary(await crateDocument())));
{
  const { json, resources } = await io.writeJSON(await crateDocument());
  await write('models/crate/crate.gltf', Buffer.from(`${JSON.stringify(json, null, 2)}\n`));
  for (const [uri, data] of Object.entries(resources)) await write(`models/crate/${uri}`, Buffer.from(data));
}
await write('models/sphere.glb', Buffer.from(await io.writeBinary(sphereDocument())));
