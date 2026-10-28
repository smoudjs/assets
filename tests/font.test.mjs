import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { font } from '../dist/index.js';
import { ASSETS, run } from './helpers.mjs';

const ttf = await readFile(path.join(ASSETS, 'fonts/NotoSans-Regular.ttf'));
const otf = await readFile(path.join(ASSETS, 'fonts/NotoSansCFF-Regular.otf'));

/** Every table of a plain font, by tag. */
function tables(sfnt) {
  const result = {};
  for (let index = 0; index < sfnt.readUInt16BE(4); index++) {
    const record = 12 + 16 * index;
    const offset = sfnt.readUInt32BE(record + 8);
    result[sfnt.toString('latin1', record, record + 4)] = sfnt.subarray(offset, offset + sfnt.readUInt32BE(record + 12));
  }
  return result;
}
/** Glyphs in a font of any format, from its maxp table. */
const glyphs = async (data) => {
  const plain = (await font.optimizeFont(data, { format: data === otf ? 'otf' : 'ttf', keepSmaller: false })).data;
  return tables(plain)['maxp'].readUInt16BE(4);
};

describe('font', () => {
  it('subsets to the given characters and converts to woff2', async () => {
    const { result, outputs, read } = await run({
      actions: [{ action: 'font', source: 'fonts/NotoSans-Regular.ttf', subset: 'Play', format: 'woff2' }]
    });
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.deepEqual(await outputs(), ['fonts/NotoSans-Regular.woff2']);
    const woff2 = await read('fonts/NotoSans-Regular.woff2');
    assert.equal(woff2.toString('latin1', 0, 4), 'wOF2');
    assert.ok(woff2.length < ttf.length / 4, `${woff2.length} bytes`);
    assert.ok((await glyphs(woff2)) < (await glyphs(ttf)));
  });

  it('woff keeps every table byte for byte', async () => {
    const woff = (await font.optimizeFont(ttf, { format: 'woff' })).data;
    assert.equal(woff.toString('latin1', 0, 4), 'wOFF');
    const back = tables((await font.optimizeFont(woff, { format: 'ttf' })).data);
    for (const [tag, table] of Object.entries(tables(ttf))) assert.ok(back[tag]?.equals(table), tag);
  });

  it('ranges pick characters, and removeHinting drops the hinting tables', async () => {
    const cyrillic = (await font.optimizeFont(ttf, { subset: { ranges: ['U+0400-04FF'] } })).data;
    assert.ok((await glyphs(cyrillic)) < (await glyphs(ttf)));
    assert.ok('fpgm' in tables(ttf) && 'prep' in tables(ttf));
    const unhinted = tables((await font.optimizeFont(ttf, { removeHinting: true })).data);
    assert.ok(!('fpgm' in unhinted) && !('prep' in unhinted), Object.keys(unhinted).join(' '));
  });

  it('an otf keeps its outlines: woff2 works, ttf is refused', async () => {
    const woff2 = await font.optimizeFont(otf, { subset: 'Play', format: 'woff2' });
    assert.equal(woff2.data.toString('latin1', 0, 4), 'wOF2');
    const plain = await font.optimizeFont(woff2.data, { format: 'otf' });
    assert.equal(plain.data.toString('latin1', 0, 4), 'OTTO');
    await assert.rejects(font.optimizeFont(otf, { format: 'ttf' }), /outlines are otf/);
  });

  it('with nothing to do, the original is kept', async () => {
    const same = await font.optimizeFont(ttf, {});
    assert.equal(same.keptOriginal, true);
    assert.ok(same.data.equals(ttf));
  });
});
