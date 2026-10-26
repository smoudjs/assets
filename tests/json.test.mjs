import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { run, scratchAssets } from './helpers.mjs';

describe('json', () => {
  it('minifies and keeps the data', async () => {
    const { result, outputs, read } = await run({ actions: [{ action: 'json', source: 'data' }] });
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.deepEqual(await outputs(), ['data/levels/level_01.json', 'data/levels/level_02.json']);
    const text = (await read('data/levels/level_01.json')).toString();
    assert.equal(text, '{"width":10,"height":8,"tiles":[1,2,3]}');
  });

  it('an invalid file fails the build', async () => {
    const assets = await scratchAssets();
    await assets.write('data/levels/broken.json', '{ "width": 10, ');
    const { result, outputs } = await run({ source: assets.dir, actions: [{ action: 'json', source: 'data' }] });
    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some((e) => e.includes('broken.json') && e.includes('invalid JSON')),
      result.errors.join('\n')
    );
    assert.deepEqual(await outputs(), []);
  });
});
