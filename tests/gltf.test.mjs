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

/**
 * A .glb as game code uses it: a named node with a mesh, scaled and moved, an empty child node as an anchor, and UVs
 * on a material without a texture, for a texture the game assigns at runtime.
 */
async function untexturedModel() {
  const { Document, NodeIO } = await import('@gltf-transform/core');
  const doc = new Document();
  const buffer = doc.createBuffer();
  const accessor = (type, array) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
  const primitive = doc
    .createPrimitive()
    .setAttribute('POSITION', accessor('VEC3', new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0])))
    .setAttribute('TEXCOORD_0', accessor('VEC2', new Float32Array([0, 0, 1, 0, 0, 1])))
    .setMaterial(doc.createMaterial('paint'));
  const body = doc
    .createNode('body')
    .setMesh(doc.createMesh('body').addPrimitive(primitive))
    .setTranslation([5, 0, 0])
    .setScale([2, 2, 2])
    .addChild(doc.createNode('hand_socket').setTranslation([0, 1, 0]));
  doc.createScene().addChild(body);
  return Buffer.from(await new NodeIO().writeBinary(doc));
}

describe('gltf: forms and companions', () => {
  it('a .gltf keeps its form: JSON, .bin and texture under their source names, the JSON naming both', async () => {
    const { result, outputs, read } = await run({ actions: [{ action: 'gltf', source: 'models/crate' }] });
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.deepEqual(await outputs(), ['models/crate/crate.bin', 'models/crate/crate.gltf', 'models/crate/crate.png']);
    const json = modelJson(await read('models/crate/crate.gltf'));
    assert.deepEqual(
      json.buffers.map((buffer) => buffer.uri),
      ['crate.bin']
    );
    assert.deepEqual(
      json.images.map((image) => image.uri),
      ['crate.png']
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
    const png = named(/crate\.[0-9a-f]{8}\.png$/);
    const json = modelJson(await read(named(/crate\.[0-9a-f]{8}\.gltf$/)));
    assert.equal(json.buffers[0].uri, bin.split('/').pop());
    assert.equal(json.images[0].uri, png.split('/').pop());
  });
});

describe('gltf: cleanup and removals', () => {
  it('cleans up unused parts and shares duplicate geometry, keeping named parts; quantizes only when asked', async () => {
    const { read } = await run({ actions: [{ action: 'gltf', source: 'models/crate.glb' }] });
    const json = modelJson(await read('models/crate.glb'));
    assert.deepEqual(
      json.materials.map((material) => material.name),
      ['wood-0', 'wood-1'],
      'the unused material is gone, the named copies stay'
    );
    assert.equal(json.meshes.length, 2, 'the named meshes stay');
    const positions = json.meshes.map((mesh) => mesh.primitives[0].attributes.POSITION);
    assert.equal(positions[0], positions[1], 'the identical meshes share one copy of their geometry');
    assert.equal(json.extensionsUsed, undefined);

    const quantized = await run({ actions: [{ action: 'gltf', source: 'models/crate.glb', quantize: true }] });
    assert.deepEqual(modelJson(await quantized.read('models/crate.glb')).extensionsUsed, ['KHR_mesh_quantization']);
  });

  it('by default changes nothing game code relies on: nodes, names, UVs, empty nodes, float positions', async () => {
    const json = modelJson((await gltf.optimizeGltf({ data: await untexturedModel() })).data);
    assert.equal(json.extensionsRequired, undefined, 'no KHR_mesh_quantization');
    assert.equal(
      json.accessors[json.meshes[0].primitives[0].attributes.POSITION].componentType,
      5126,
      'positions stay float'
    );
    assert.ok('TEXCOORD_0' in json.meshes[0].primitives[0].attributes, 'UVs stay without a texture');
    assert.deepEqual(
      json.nodes
        .map(({ name, translation, scale, mesh }) => ({ name, translation, scale, mesh }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      [
        { name: 'body', translation: [5, 0, 0], scale: [2, 2, 2], mesh: 0 },
        { name: 'hand_socket', translation: [0, 1, 0], scale: undefined, mesh: undefined }
      ],
      'no node added, moved or dropped; the empty one stays'
    );
    assert.equal(json.meshes[0].name, 'body');
  });

  it('removeUnusedAttributes drops UVs no texture uses, but keeps those of textures being extracted', async () => {
    const untextured = modelJson(
      (await gltf.optimizeGltf({ data: await untexturedModel() }, { removeUnusedAttributes: true })).data
    );
    assert.deepEqual(attributes(untextured), ['POSITION']);

    const { read } = await run({
      actions: [{ action: 'gltf', source: 'models/crate.glb', removeUnusedAttributes: true, textures: { extract: true } }]
    });
    assert.ok(attributes(modelJson(await read('models/crate.glb'))).includes('TEXCOORD_0'));
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

describe('gltf: keepSmaller', () => {
  it('a model cleanup cannot shrink comes back byte for byte, reported as kept', async () => {
    const assets = await scratchAssets();
    const cleaned = await gltf.optimizeGltf({ data: await readFile(path.join(ASSETS, 'models/crate.glb')) });
    await assets.write('models/crate.glb', cleaned.data);

    const { result, read } = await run({ source: assets.dir, actions: [{ action: 'gltf', source: 'models/crate.glb' }] });
    assert.equal(result.actions[0].files[0].keptOriginal, true);
    assert.deepEqual(await read('models/crate.glb'), cleaned.data);
  });

  it('options that cannot touch a model, like texture settings without textures, do not stop keepSmaller', async () => {
    const sphere = (await gltf.optimizeGltf({ data: await readFile(path.join(ASSETS, 'models/sphere.glb')) })).data;
    // the sphere has positions only: no textures, normals or UVs for these options to work on
    const playable = { normals: false, uvs: false, textures: { extract: true, format: 'webp', maxWidth: 2048 } };
    assert.equal((await gltf.optimizeGltf({ data: sphere }, playable)).keptOriginal, true);
  });

  it('an option set to a change, a new format or keepSmaller false always writes the new result', async () => {
    const cleaned = (await gltf.optimizeGltf({ data: await readFile(path.join(ASSETS, 'models/crate.glb')) })).data;
    assert.equal(
      (await gltf.optimizeGltf({ data: cleaned }, { normals: true })).keptOriginal,
      true,
      'a default is no change'
    );
    assert.equal((await gltf.optimizeGltf({ data: cleaned }, { keepSmaller: false })).keptOriginal, false);
    const embedded = await gltf.optimizeGltf({ data: cleaned }, { format: 'gltf-embedded' });
    assert.equal(embedded.keptOriginal, false);
    assert.equal(embedded.format, 'gltf-embedded');
  });
});

describe('gltf: when, cache and failures', () => {
  it('readGltfMeta gives the same facts from a path, reading only the JSON part, as from the bytes', async () => {
    for (const file of ['models/crate.glb', 'models/sphere.glb', 'models/crate/crate.gltf']) {
      const absolute = path.join(ASSETS, file);
      assert.deepEqual(await gltf.readGltfMeta(absolute), await gltf.readGltfMeta(await readFile(absolute)), file);
    }
  });

  it('reads a meshopt-compressed model and writes it uncompressed', async () => {
    const compressed = await run({ actions: [{ action: 'meshopt', source: 'models/sphere.glb' }] });
    const { result, read } = await run({
      source: compressed.destination,
      actions: [{ action: 'gltf', source: 'models' }]
    });
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.deepEqual(modelJson(await read('models/sphere.glb')).extensionsUsed, ['KHR_mesh_quantization']);
    assert.equal(result.actions[0].outputs[0].meta.triangles, 1152);
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

  it('a .gltf missing its .bin is copied as it is, with its texture and a warning', async () => {
    const assets = await scratchAssets();
    await assets.remove('models/crate/crate.bin');
    const { result, outputs, read } = await run({
      source: assets.dir,
      actions: [{ action: 'gltf', source: 'models/crate' }]
    });
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.match(result.warnings.join('\n'), /crate\.gltf: a file it refers to is missing; copied as it is/);
    assert.deepEqual(await outputs(), ['models/crate/crate.gltf', 'models/crate/crate.png']);
    assert.deepEqual(await read('models/crate/crate.gltf'), await readFile(path.join(ASSETS, 'models/crate/crate.gltf')));
  });

  it('a corrupt .glb fails the build, named, and nothing is written', async () => {
    const assets = await scratchAssets();
    await assets.write('models/broken.glb', 'this is not a model');
    const { result, outputs } = await run({ source: assets.dir, actions: [{ action: 'gltf', source: 'models' }] });
    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some((e) => e.includes('broken.glb')),
      result.errors.join('\n')
    );
    assert.deepEqual(await outputs(), []);
  });
});
