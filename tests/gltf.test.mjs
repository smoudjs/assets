import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { describe, it } from 'node:test';
import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { gltf } from '../dist/index.js';
import { ASSETS, run, scratchAssets } from './helpers.mjs';

/** The JSON of a model: the first chunk of a .glb, or the .gltf itself. */
function modelJson(data) {
  const isGlb = data.readUInt32LE(0) === 0x46546c67;
  return JSON.parse((isGlb ? data.subarray(20, 20 + data.readUInt32LE(12)) : data).toString());
}
const attributes = (json) => Object.keys(json.meshes[0].primitives[0].attributes).sort();

describe('gltf: forms and companions', () => {
  it('a .gltf keeps its form: JSON, .bin and texture, the JSON naming both', async () => {
    const { result, outputs, read } = await run({ actions: [{ action: 'gltf', source: 'models/crate' }] });
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.deepEqual(await outputs(), [
      'models/crate/crate.bin',
      'models/crate/crate.gltf',
      'models/crate/crate_wood-0_baseColor.png'
    ]);
    const json = modelJson(await read('models/crate/crate.gltf'));
    assert.deepEqual(
      json.buffers.map((buffer) => buffer.uri),
      ['crate.bin']
    );
    assert.deepEqual(
      json.images.map((image) => image.uri),
      ['crate_wood-0_baseColor.png']
    );
  });

  it('format glb packs a .gltf into one file, and gltf-embedded holds only data: uris', async () => {
    const glb = await run({ actions: [{ action: 'gltf', source: 'models/crate', format: 'glb' }] });
    assert.deepEqual(await glb.outputs(), ['models/crate/crate.glb']);
    assert.equal(modelJson(await glb.read('models/crate/crate.glb')).images.length, 1);

    const embedded = await run({ actions: [{ action: 'gltf', source: 'models/crate.glb', format: 'gltf-embedded' }] });
    assert.deepEqual(await embedded.outputs(), ['models/crate.gltf']);
    const json = modelJson(await embedded.read('models/crate.gltf'));
    for (const { uri } of [...json.buffers, ...json.images]) assert.match(uri, /^data:/);
  });

  it('the .bin and texture a .gltf refers to are used up with it: no later action takes them', async () => {
    const { result, outputs } = await run({
      actions: [
        { action: 'gltf', source: 'models/crate/crate.gltf' },
        { action: 'image', source: 'models/**/*.png' },
        { action: 'copy', source: { include: '#rest', exclude: ['audio', 'images', 'sprites', 'tiles', 'spine', 'data'] } }
      ]
    });
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.deepEqual(result.actions[1].files, [], 'not even an explicit pattern takes the texture');
    assert.deepEqual(
      result.actions[2].files.map((file) => file.source),
      ['models/crate.glb', 'models/sphere.glb']
    );
    assert.ok((await outputs()).includes('models/crate/crate.gltf'));
    assert.equal(result.actions[0].files[0].bytesIn, 4432 + 2508 + 547, 'the report counts the .bin and texture as input');
  });

  it('a filename template names the .bin and texture, and the JSON refers to those names', async () => {
    const { outputs, read } = await run({
      actions: [{ action: 'gltf', source: 'models/crate', destination: { filename: '[name].[hash][ext]' } }]
    });
    const files = await outputs();
    const named = (pattern) => files.find((file) => pattern.test(file));
    const bin = named(/crate\.[0-9a-f]{8}\.bin$/);
    const png = named(/crate_wood-0_baseColor\.[0-9a-f]{8}\.png$/);
    const json = modelJson(await read(named(/crate\.[0-9a-f]{8}\.gltf$/)));
    assert.equal(json.buffers[0].uri, bin.split('/').pop());
    assert.equal(json.images[0].uri, png.split('/').pop());
  });
});

describe('gltf: cleanup and removals', () => {
  it('cleans up duplicates and unused parts and quantizes, unless quantize is off', async () => {
    const { read } = await run({ actions: [{ action: 'gltf', source: 'models/crate.glb' }] });
    const json = modelJson(await read('models/crate.glb'));
    assert.equal(json.materials.length, 1, 'the identical and the unused material are gone');
    assert.equal(json.meshes.length, 1, 'the identical meshes are merged');
    assert.deepEqual(json.extensionsUsed, ['KHR_mesh_quantization']);

    const plain = await run({ actions: [{ action: 'gltf', source: 'models/crate.glb', quantize: false }] });
    assert.equal(modelJson(await plain.read('models/crate.glb')).extensionsUsed, undefined);
  });

  it('normals, vertexColors, animations, uvs and materials go when turned off', async () => {
    const config = (options) => ({ actions: [{ action: 'gltf', source: 'models/crate.glb', ...options }] });
    const read = async (options) => modelJson(await (await run(config(options))).read('models/crate.glb'));

    assert.deepEqual(attributes(await read({})), ['COLOR_0', 'NORMAL', 'POSITION', 'TEXCOORD_0']);
    const stripped = await read({ normals: false, vertexColors: false, animations: false });
    assert.deepEqual(attributes(stripped), ['POSITION', 'TEXCOORD_0']);
    assert.equal(stripped.animations, undefined);

    const noUvs = await read({ uvs: false });
    assert.deepEqual(attributes(noUvs), ['COLOR_0', 'NORMAL', 'POSITION']);
    assert.equal(noUvs.images, undefined, 'textures cannot stay without UVs');

    const noMaterials = await read({ materials: false });
    assert.equal(noMaterials.materials, undefined);
    assert.equal(noMaterials.images, undefined);
  });
});

describe('gltf: textures and simplify', () => {
  it('extract writes the textures next to the model and leaves none in it, UVs kept', async () => {
    const { outputs, read } = await run({
      actions: [{ action: 'gltf', source: 'models/crate.glb', textures: { extract: true } }]
    });
    assert.deepEqual(await outputs(), ['models/crate.glb', 'models/crate_wood-0_baseColor.png']);
    const json = modelJson(await read('models/crate.glb'));
    assert.equal(json.images, undefined);
    assert.equal(json.textures, undefined);
    assert.ok(attributes(json).includes('TEXCOORD_0'), 'the game puts the texture back on these UVs');
    assert.equal((await sharp(await read('models/crate_wood-0_baseColor.png')).metadata()).format, 'png');
  });

  it('textures re-encoded to webp declare EXT_texture_webp', async () => {
    const { read } = await run({ actions: [{ action: 'gltf', source: 'models/crate.glb', textures: { format: 'webp' } }] });
    const json = modelJson(await read('models/crate.glb'));
    assert.ok(json.extensionsRequired.includes('EXT_texture_webp'), JSON.stringify(json.extensionsRequired));
  });

  it('simplify lowers the triangle count, both methods, and a strict error stops it early', async () => {
    const triangles = async (simplify) => {
      const { result } = await run({ actions: [{ action: 'gltf', source: 'models/sphere.glb', simplify }] });
      return result.actions[0].outputs[0].meta.triangles;
    };
    assert.equal(await triangles(undefined), 1152);
    const collapse = await triangles({ ratio: 0.25 });
    const sloppy = await triangles({ ratio: 0.25, method: 'sloppy', error: 1 });
    const strict = await triangles({ ratio: 0.25, error: 0.0001 });
    assert.ok(collapse < 600, `collapse kept ${collapse}`);
    assert.ok(sloppy <= 300, `sloppy kept ${sloppy}`);
    assert.ok(strict > collapse, `a strict error stops earlier: ${strict} vs ${collapse}`);
  });
});

describe('gltf: when, cache and failures', () => {
  it('readGltfMeta gives the same facts from a path, reading only the JSON part, as from the bytes', async () => {
    for (const file of ['models/crate.glb', 'models/sphere.glb', 'models/crate/crate.gltf']) {
      const absolute = path.join(ASSETS, file);
      assert.deepEqual(await gltf.readGltfMeta(absolute), await gltf.readGltfMeta(await readFile(absolute)), file);
    }
  });

  it('when.triangles uses the probe', async () => {
    const { result } = await run({
      actions: [{ action: 'gltf', source: { include: 'models', when: { triangles: '>100' } } }]
    });
    assert.deepEqual(
      result.actions[0].files.map((file) => file.source),
      ['models/sphere.glb']
    );
  });

  it('a second build comes from the cache, and a changed texture of a .gltf does not', async () => {
    const assets = await scratchAssets();
    const config = { source: assets.dir, actions: [{ action: 'gltf', source: 'models/crate' }] };
    await run(config);
    assert.equal((await run(config)).result.actions[0].fromCache, 1);

    const color = { r: randomInt(256), g: randomInt(256), b: 0 };
    await assets.write(
      'models/crate/crate.png',
      await sharp({ create: { width: 8, height: 8, channels: 3, background: color } })
        .png()
        .toBuffer()
    );
    const changed = await run(config);
    assert.equal(changed.result.ok, true, changed.result.errors.join('\n'));
    assert.equal(changed.result.actions[0].fromCache, 0);
  });

  it('a missing .bin and a corrupt .glb fail the build, named, and nothing is written', async () => {
    const assets = await scratchAssets();
    await assets.remove('models/crate/crate.bin');
    await assets.write('models/broken.glb', 'this is not a model');
    const { result, outputs } = await run({ source: assets.dir, actions: [{ action: 'gltf', source: 'models' }] });
    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some((e) => e.includes('crate.gltf') && e.includes('crate.bin is missing')),
      result.errors.join('\n')
    );
    assert.ok(
      result.errors.some((e) => e.includes('broken.glb')),
      result.errors.join('\n')
    );
    assert.deepEqual(await outputs(), []);
  });
});
