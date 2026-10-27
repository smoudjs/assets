import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { run, scratchAssets } from './helpers.mjs';

/** The JSON of a model: the first chunk of a .glb, or the .gltf itself. */
function modelJson(data) {
  const isGlb = data.readUInt32LE(0) === 0x46546c67;
  return JSON.parse((isGlb ? data.subarray(20, 20 + data.readUInt32LE(12)) : data).toString());
}

describe('meshopt', () => {
  it('compresses a .glb, declares EXT_meshopt_compression and keeps the counts', async () => {
    const { result, read } = await run({ actions: [{ action: 'meshopt', source: 'models/sphere.glb' }] });
    assert.equal(result.ok, true, result.errors.join('\n'));
    const [file] = result.actions[0].files;
    assert.ok(file.bytesOut < file.bytesIn / 2, `${file.bytesIn} -> ${file.bytesOut}`);
    assert.deepEqual(modelJson(await read('models/sphere.glb')).extensionsRequired.sort(), [
      'EXT_meshopt_compression',
      'KHR_mesh_quantization'
    ]);
    assert.equal(result.actions[0].outputs[0].meta.triangles, 1152);
  });

  it('level high comes out smaller than medium on a model with normals', async () => {
    const size = async (level) => {
      const { result } = await run({ actions: [{ action: 'meshopt', source: 'models/crate.glb', level }] });
      return result.actions[0].files[0].bytesOut;
    };
    const medium = await size('medium');
    const high = await size('high');
    assert.ok(high < medium, `high ${high} vs medium ${medium}`);
  });

  it('a .gltf keeps its .bin and texture, the JSON naming both', async () => {
    const { result, outputs, read } = await run({ actions: [{ action: 'meshopt', source: 'models/crate' }] });
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.deepEqual(await outputs(), [
      'models/crate/crate.bin',
      'models/crate/crate.gltf',
      'models/crate/crate_wood-0_baseColor.png'
    ]);
    const json = modelJson(await read('models/crate/crate.gltf'));
    assert.ok(json.extensionsUsed.includes('EXT_meshopt_compression'));
    assert.deepEqual(
      json.images.map((image) => image.uri),
      ['crate_wood-0_baseColor.png']
    );
  });

  it('chains after gltf through a virtual folder', async () => {
    const { result, outputs, read } = await run({
      actions: [
        { action: 'gltf', source: 'models/crate.glb', destination: '#models' },
        { action: 'meshopt', source: '#models' }
      ]
    });
    assert.equal(result.ok, true, result.errors.join('\n'));
    const files = await outputs();
    assert.equal(files.length, 1, files.join(', '));
    const json = modelJson(await read(files[0]));
    assert.equal(json.meshes.length, 1, 'gltf merged the meshes first');
    assert.ok(json.extensionsUsed.includes('EXT_meshopt_compression'));
  });

  it('a second build comes from the cache', async () => {
    const assets = await scratchAssets();
    const config = { source: assets.dir, actions: [{ action: 'meshopt', source: 'models/crate.glb' }] };
    await run(config);
    assert.equal((await run(config)).result.actions[0].fromCache, 1);
  });
});
