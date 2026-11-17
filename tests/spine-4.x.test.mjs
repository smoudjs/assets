// The spine action with Spine 4.1 and 4.2 skeletons, the versions converted between .json and .skel: the skeleton
// option, skins, and trimming a .skel. They use the knight fixture, Spine 4.2, and the same rig marked 4.1; the hero
// is a small Spine 4.1 skeleton.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { spine } from '../dist/index.js';
import { ASSETS, run, scratchAssets } from './helpers.mjs';

// blue's scarf is a linked mesh taking its mesh from the shared skin, which a deform in idle animates
const knightJson = await readFile(path.join(ASSETS, 'spine/knight/knight.json'));
const knight = () => JSON.parse(knightJson);
const knightSkel = spine.toSkel(knightJson);

const SKELETON = /\.(json|skel)$/;
const skinNames = (json) => json.skins.map((skin) => skin.name);

// the knight with its skeleton as a .json, a .skel, or both
async function runKnight({ json = true, skel = false } = {}, options = {}) {
  const assets = await scratchAssets();
  if (!json) await assets.remove('spine/knight/knight.json');
  if (skel) await assets.write('spine/knight/knight.skel', knightSkel);
  const built = await run({ source: assets.dir, actions: [{ action: 'spine', source: 'spine/knight', ...options }] });
  assert.equal(built.result.ok, true, built.result.errors.join('\n'));
  const skeletonFiles = (await built.outputs()).filter((file) => SKELETON.test(file));
  const readJson = async () => JSON.parse(await built.read('spine/knight/knight.json'));
  const readSkel = async () => JSON.parse(spine.toJson(await built.read('spine/knight/knight.skel')));
  return { ...built, skeletonFiles, readJson, readSkel };
}

describe('spine 4.2: skeleton format', () => {
  it('skeleton: "skel" writes a .json as a .skel, and nothing else', async () => {
    const { skeletonFiles, readSkel } = await runKnight({ json: true }, { skeleton: 'skel' });
    assert.deepEqual(skeletonFiles, ['spine/knight/knight.skel']);
    const back = await readSkel();
    assert.equal(back.skeleton.hash, knight().skeleton.hash);
    assert.deepEqual(Object.keys(back.animations), ['idle', 'attack', 'debug/pose']);
    assert.deepEqual(skinNames(back), ['default', 'shared', 'blue', 'red']);
  });

  it('skeleton: "json" writes a .skel as a .json, its numbers rounded to precision', async () => {
    const { skeletonFiles, readJson } = await runKnight({ json: false, skel: true }, { skeleton: 'json', precision: 2 });
    assert.deepEqual(skeletonFiles, ['spine/knight/knight.json']);
    const json = await readJson();
    assert.equal(json.bones[1].y, 16.33);
    assert.deepEqual(json.animations.attack.bones.body.translate[0], { x: 1.23, curve: 'stepped' });
  });

  it('a .skel in the format asked for, with nothing to trim, is kept byte for byte', async () => {
    for (const options of [{}, { skeleton: 'skel' }]) {
      const { skeletonFiles, read } = await runKnight({ json: false, skel: true }, options);
      assert.deepEqual(skeletonFiles, ['spine/knight/knight.skel']);
      assert.equal(Buffer.compare(await read('spine/knight/knight.skel'), knightSkel), 0);
    }
  });

  it('with a .json and a .skel, skeleton picks one of them', async () => {
    const json = await runKnight({ json: true, skel: true }, { skeleton: 'json' });
    assert.deepEqual(json.skeletonFiles, ['spine/knight/knight.json']);
    const skel = await runKnight({ json: true, skel: true }, { skeleton: 'skel' });
    assert.deepEqual(skel.skeletonFiles, ['spine/knight/knight.skel']);
  });
});

describe('spine 4.2: trimming', () => {
  it('a .skel alone is trimmed when animations are set', async () => {
    const { skeletonFiles, readSkel } = await runKnight(
      { json: false, skel: true },
      { animations: { exclude: ['debug/*'] } }
    );
    assert.deepEqual(skeletonFiles, ['spine/knight/knight.skel']);
    assert.deepEqual(Object.keys((await readSkel()).animations), ['idle', 'attack']);
  });

  it('with a .json and a .skel, both are trimmed, the .skel written from the trimmed .json', async () => {
    const { skeletonFiles, readJson, readSkel } = await runKnight(
      { json: true, skel: true },
      { animations: { include: ['attack'] } }
    );
    assert.deepEqual(skeletonFiles, ['spine/knight/knight.json', 'spine/knight/knight.skel']);
    assert.deepEqual(Object.keys((await readJson()).animations), ['attack']);
    assert.deepEqual(Object.keys((await readSkel()).animations), ['attack']);
  });

  it('skins keeps the default skin, and the skin a kept linked mesh takes its mesh from', async () => {
    const red = await (await runKnight({ json: true }, { skins: ['red'] })).readJson();
    assert.deepEqual(skinNames(red), ['default', 'red']);
    assert.deepEqual(red.animations.idle.attachments, {}, 'the deform of a removed skin goes with it');

    const blue = await (await runKnight({ json: false, skel: true }, { skins: { include: ['blue'] } })).readSkel();
    assert.deepEqual(skinNames(blue), ['default', 'shared', 'blue']);
  });

  it('skins exclude takes patterns; a pattern matching nothing warns', async () => {
    const { result, readJson } = await runKnight({ json: true }, { skins: { exclude: ['b*', 'green'] } });
    assert.match(result.warnings.join('\n'), /skins pattern "green" matches nothing/);
    assert.deepEqual(skinNames(await readJson()), ['default', 'shared', 'red']);
  });
});

// the knight as Spine 4.1 exports it: a bone's inherit mode is called transform, and there is no reference scale.
// Its numbers are rounded as the 32-bit floats a .skel holds, so a round trip gives them back the same
function knight41() {
  const json = JSON.parse(knightJson, (_key, value) => (typeof value === 'number' ? Math.fround(value) : value));
  json.skeleton.spine = '4.1.24';
  json.bones[1].transform = 'noScale';
  return json;
}

describe('spine 4.1', () => {
  it('toSkel and toJson convert both ways, keeping skins, linked meshes and deforms', () => {
    const json = knight41();
    const back = JSON.parse(spine.toJson(spine.toSkel(Buffer.from(JSON.stringify(json)))));
    assert.equal(back.skeleton.spine, '4.1.24');
    assert.equal(back.skeleton.referenceScale, undefined);
    assert.deepEqual(back.bones, json.bones);
    assert.deepEqual(back.slots, json.slots);
    assert.deepEqual(skinNames(back), ['default', 'shared', 'blue', 'red']);
    // a linked mesh's width and height are editor data, which a .skel leaves out
    const { width, height, ...scarf } = json.skins[2].attachments.scarf.scarf;
    assert.deepEqual(back.skins[2].attachments.scarf.scarf, scarf);
    assert.deepEqual(back.skins[3].attachments, json.skins[3].attachments);
    assert.deepEqual(back.animations.idle.attachments, json.animations.idle.attachments);
    assert.deepEqual(back.animations.attack, json.animations.attack);
  });

  it('a downgraded export: its version number is written alone, and a deform keyed as in 4.0 is kept', () => {
    const json = knight41();
    json.skeleton.spine = '4.1-from-4.2.43';
    const { idle } = json.animations;
    idle.deform = { shared: { scarf: { scarf: idle.attachments.shared.scarf.scarf.deform } } };
    delete idle.attachments;
    const back = JSON.parse(spine.toJson(spine.toSkel(Buffer.from(JSON.stringify(json)))));
    assert.equal(back.skeleton.spine, '4.1');
    assert.deepEqual(back.animations.idle.attachments, knight().animations.idle.attachments);
  });

  it('physics, which 4.1 does not have, is refused', () => {
    const json = knight41();
    json.physics = [{ name: 'sway', bone: 'body' }];
    assert.throws(() => spine.toSkel(Buffer.from(JSON.stringify(json))), /Spine 4\.1 has no physics/);
  });

  it('skeleton: "skel" writes the 4.1 hero .json as a .skel, trimmed', async () => {
    const assets = await scratchAssets();
    await assets.remove('spine/hero/hero.skel');
    const { result, outputs, read } = await run({
      source: assets.dir,
      actions: [{ action: 'spine', source: 'spine/hero', skeleton: 'skel', animations: { exclude: ['debug/*'] } }]
    });
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.deepEqual(
      (await outputs()).filter((file) => SKELETON.test(file)),
      ['spine/hero/hero.skel']
    );
    const back = JSON.parse(spine.toJson(await read('spine/hero/hero.skel')));
    assert.equal(back.skeleton.spine, '4.1.00');
    assert.deepEqual(Object.keys(back.animations), ['idle', 'run_fast', 'run_slow']);
  });
});

describe('spine 4.x: other versions and the API', () => {
  it('another version is not converted: it keeps its format, with a warning', async () => {
    // the hero's .json alone, marked 4.0; next to it, its .skel would be kept as the .skel asked for
    const assets = await scratchAssets();
    await assets.remove('spine/hero/hero.skel');
    const hero = JSON.parse(await readFile(path.join(ASSETS, 'spine/hero/hero.json')));
    hero.skeleton.spine = '4.0.64';
    await assets.write('spine/hero/hero.json', JSON.stringify(hero));
    const { result, outputs } = await run({
      source: assets.dir,
      actions: [{ action: 'spine', source: 'spine/hero', skeleton: 'skel' }]
    });
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.deepEqual(
      (await outputs()).filter((file) => SKELETON.test(file)),
      ['spine/hero/hero.json']
    );
    assert.match(result.warnings.join('\n'), /Spine 4\.0\.64 is not converted, only 4\.1 and 4\.2/);
  });

  it('toSkel and toJson convert both ways and refuse another version', () => {
    const json = knight();
    const back = JSON.parse(spine.toJson(knightSkel));
    assert.deepEqual(back.slots, json.slots);
    // a linked mesh's width and height are editor data, which a .skel leaves out
    const { width, height, ...scarf } = json.skins[2].attachments.scarf.scarf;
    assert.deepEqual(back.skins[2].attachments.scarf.scarf, scarf);
    assert.deepEqual(back.animations.idle.attachments, json.animations.idle.attachments);
    json.skeleton.spine = '4.0.64';
    assert.throws(
      () => spine.toSkel(Buffer.from(JSON.stringify(json))),
      /Spine 4\.0\.64 is not converted, only 4\.1 and 4\.2/
    );
  });
});
