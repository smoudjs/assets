import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { copy } from '../dist/index.js';
import { ASSETS, listFiles, tempDir } from './helpers.mjs';

describe('copy.action', () => {
  it('writes to a destination folder', async () => {
    const out = await tempDir();
    const result = await copy.process({ source: 'tests/assets/data', destination: out });
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.deepEqual(await listFiles(out), ['config.xml', 'levels/level_01.json', 'levels/level_02.json']);
  });

  it('leaves other files in its destination alone, and takes absolute paths', async () => {
    const out = await tempDir();
    await copy.process({ source: `${ASSETS}/data/levels`, destination: out });
    await copy.process({ source: `${ASSETS}/data/config.xml`, destination: out });
    assert.deepEqual(await listFiles(out), ['config.xml', 'level_01.json', 'level_02.json']);
  });

  it('returns files in memory when no destination is given', async () => {
    const result = await copy.process({ source: 'tests/assets/data' });
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.equal(result.destination, null);
    assert.deepEqual(result.outputs.map((file) => file.path).sort(), [
      'config.xml',
      'levels/level_01.json',
      'levels/level_02.json'
    ]);
    assert.ok(result.outputs[0].data.length > 0);
    assert.deepEqual(result.warnings, []);
  });
});
