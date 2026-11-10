import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { json } from '../dist/index.js';
import { unpackJson } from '../dist/runtime.js';
import { ASSETS, run, scratchAssets } from './helpers.mjs';

describe('json', () => {
  it('minifies and keeps the data', async () => {
    const { result, outputs, read } = await run({ actions: [{ action: 'json', source: 'data' }] });
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.deepEqual(await outputs(), ['data/levels/level_01.json', 'data/levels/level_02.json', 'data/world.json']);
    const text = (await read('data/levels/level_01.json')).toString();
    assert.equal(text, '{"width":10,"height":8,"tiles":[1,2,3]}');
  });

  it('an invalid file fails the build', async () => {
    const assets = await scratchAssets();
    await assets.write('data/levels/broken.json', '{ "width": 10, ');
    for (const pack of [false, true]) {
      const { result, outputs } = await run({ source: assets.dir, actions: [{ action: 'json', source: 'data', pack }] });
      assert.equal(result.ok, false);
      assert.ok(
        result.errors.some((e) => e.includes('broken.json') && e.includes('invalid JSON')),
        result.errors.join('\n')
      );
      assert.deepEqual(await outputs(), []);
    }
  });
});

describe('json: pack', () => {
  it('packs keys and repeated strings smaller, and unpackJson gives the same data back', async () => {
    // a world as a level editor saves it: many records with the same keys, and strings that repeat
    const world = JSON.parse(await readFile(path.join(ASSETS, 'data/world.json'), 'utf8'));
    const { result, read } = await run({ actions: [{ action: 'json', source: 'data/world.json', pack: true }] });
    assert.equal(result.ok, true, result.errors.join('\n'));
    const packed = (await read('data/world.json')).toString();
    const minified = JSON.stringify(world).length;
    assert.ok(packed.length < minified * 0.8, `${packed.length} bytes, minified ${minified}`);
    assert.equal(JSON.parse(packed).$pack, 1);
    assert.deepEqual(unpackJson(packed), world);
    assert.deepEqual(unpackJson(JSON.parse(packed)), world, 'takes the parsed JSON too');
  });

  it('a file packing would not shrink stays minified, and unpackJson returns it as it is', async () => {
    const { result, read } = await run({ actions: [{ action: 'json', source: 'data', pack: true }] });
    assert.equal(result.ok, true, result.errors.join('\n'));
    const text = (await read('data/levels/level_01.json')).toString();
    assert.equal(text, '{"width":10,"height":8,"tiles":[1,2,3]}');
    assert.deepEqual(unpackJson(text), { width: 10, height: 8, tiles: [1, 2, 3] });
  });

  it('a key used twice with one short value gets no table', () => {
    const data = { tool: 'x', other: { tool: 'x' } };
    assert.equal(json.packJson(Buffer.from(JSON.stringify(data))).toString(), JSON.stringify(data));
  });

  it('awkward keys and values come back the same', () => {
    const awkward = JSON.parse(
      '{"$pack":"mine","__proto__":{"x":1},"constructor":"c","":0,"list":[{"toString":"t"},{"toString":"t"}],"deep":[[[{"a":null}]]]}'
    );
    const back = unpackJson(json.packJson(Buffer.from(JSON.stringify(awkward))).toString());
    assert.deepEqual(back, awkward);
    assert.equal(Object.getPrototypeOf(back), Object.prototype, '__proto__ stays a plain key');
    for (const value of [[1, 'a'], 'text', 3.5, true, null, {}, []]) {
      assert.deepEqual(unpackJson(json.packJson(Buffer.from(JSON.stringify(value))).toString()), value);
    }
  });

  it('unpackJson throws on invalid JSON, a newer format, and a damaged pack, and passes anything else through', () => {
    assert.throws(() => unpackJson('{"a": 1'), SyntaxError);
    assert.throws(() => unpackJson({ $pack: 2, k: [], data: {} }), /packed in format 2, this version reads format 1/);
    assert.throws(() => unpackJson({ $pack: 1, k: 'tool', data: {} }), /malformed packed JSON/);
    assert.throws(() => unpackJson({ $pack: 1, k: ['tool'], data: { z: 1 } }), /unknown key z/);
    assert.throws(() => unpackJson({ $pack: 1, k: ['tool'], v: { a: ['paint'] }, data: { a: 5 } }), /tool has no value 5/);
    for (const value of [42, [1, 2], null, { a: 1 }]) assert.deepEqual(unpackJson(value), value);
    // a string is always JSON text
    assert.equal(unpackJson('"text"'), 'text');
    assert.throws(() => unpackJson('text'), SyntaxError);
  });

  it('the runtime imports nothing, so it bundles into a browser game', async () => {
    for (const file of ['../dist/runtime.js', '../dist/runtime.cjs']) {
      const code = await readFile(new URL(file, import.meta.url), 'utf8');
      assert.doesNotMatch(code, /\bimport\s|require\(/, file);
    }
  });
});
