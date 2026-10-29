import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import sharp from 'sharp';
import { bitmapfont, font } from '../dist/index.js';
import { ASSETS, run } from './helpers.mjs';

const ttf = await readFile(path.join(ASSETS, 'fonts/NotoSans-Regular.ttf'));
const otf = await readFile(path.join(ASSETS, 'fonts/NotoSansCFF-Regular.otf'));

/** The tags of a text or XML .fnt: info and common, and pages, chars and kernings as lists, numbers as numbers. */
function parse(fnt) {
  const text = fnt.toString('utf8');
  const result = { pages: [], chars: [], kernings: [] };
  const tags = text.startsWith('<') ? text.matchAll(/<(\w+) ([^>]*?)\/>/g) : text.matchAll(/^(\w+) (.*)$/gm);
  for (const [, tag, rest] of tags) {
    const values = {};
    for (const [, key, quoted, plain] of rest.matchAll(/(\w+)=(?:"([^"]*)"|(\S+))/g)) {
      const value = quoted ?? plain;
      values[key] = /^-?\d+$/.test(value) ? Number(value) : value;
    }
    if (tag === 'info' || tag === 'common') result[tag] = values;
    if (tag === 'page' || tag === 'char' || tag === 'kerning') result[`${tag}s`].push(values);
  }
  return result;
}
const char = (fnt, character) => fnt.chars.find((c) => c.id === character.codePointAt(0));

describe('bitmapfont', () => {
  it('draws a font into a .fnt and a page, referring to the page by its written name', async () => {
    const { result, outputs, read } = await run({
      actions: [
        {
          action: 'bitmapfont',
          source: 'fonts/NotoSans-Regular.ttf',
          destination: { filename: '[name].[hash][ext]' },
          size: 40
        }
      ]
    });
    assert.equal(result.ok, true, result.errors.join('\n'));
    const files = await outputs();
    assert.equal(files.length, 2, files.join(' '));
    const fntFile = files.find((file) => file.endsWith('.fnt'));
    const pageFile = files.find((file) => file.endsWith('.png'));
    const fnt = parse(await read(fntFile));
    assert.equal(fnt.info.face, 'Noto Sans');
    assert.equal(fnt.info.size, 40);
    assert.deepEqual(fnt.pages, [{ id: 0, file: path.posix.basename(pageFile) }]);
    const meta = await sharp(await read(pageFile)).metadata();
    assert.deepEqual([meta.width, meta.height], [fnt.common.scaleW, fnt.common.scaleH]);
    // the test font has only some characters; the rest are reported
    assert.ok(char(fnt, 'P') && char(fnt, ' ') && !char(fnt, 'B'));
    assert.ok(
      result.warnings.some((warning) => /no glyph for/.test(warning)),
      result.warnings.join('\n')
    );
  });

  it('places glyphs on the baseline, with kerning, outline and shadow', async () => {
    const made = await bitmapfont.makeBitmapFont({ data: ttf, path: 'game.ttf' }, { size: 48 });
    const fnt = parse(made.fnt);
    const { base } = fnt.common;
    const l = char(fnt, 'l');
    const g = char(fnt, 'g');
    assert.ok(Math.abs(l.yoffset + l.height - base) <= 1, `l ends at ${l.yoffset + l.height}, base ${base}`);
    assert.ok(g.yoffset + g.height > base + 5, 'g reaches below the baseline');
    const space = char(fnt, ' ');
    assert.equal(space.width, 0);
    assert.ok(space.xadvance > 0);
    assert.ok(fnt.kernings.length > 0);
    assert.equal(made.pages[0].name, 'game.png');

    const outlined = parse(
      (
        await bitmapfont.makeBitmapFont(
          { data: ttf, path: 'game.ttf' },
          { size: 48, outline: { width: 3 }, shadow: { x: 2, y: 2 } }
        )
      ).fnt
    );
    const big = char(outlined, 'l');
    assert.ok(big.width >= l.width + 6 + 2 && big.height >= l.height + 6 + 2, `${big.width}×${big.height}`);
    assert.equal(char(outlined, 'l').xadvance, l.xadvance);
  });

  it('reads woff2 and otf outlines', async () => {
    const woff2 = (await font.optimizeFont(otf, { format: 'woff2' })).data;
    const made = await bitmapfont.makeBitmapFont({ data: woff2, path: 'noto.woff2' }, { format: 'webp', data: 'text' });
    const fnt = parse(made.fnt);
    assert.equal(made.fnt.toString('utf8').slice(0, 5), 'info ');
    assert.deepEqual(fnt.pages, [{ id: 0, file: 'noto.webp' }]);
    assert.ok(char(fnt, 'a').width > 0);
  });

  it('converts a .fnt and its pages without moving a glyph', async () => {
    const made = await bitmapfont.makeBitmapFont({ data: ttf, path: 'game.ttf' });
    const source = parse(made.fnt);
    const converted = await bitmapfont.makeBitmapFont(
      { data: made.fnt, path: 'game.fnt', files: { 'game.png': made.pages[0].data } },
      { format: 'webp', data: 'text' }
    );
    const fnt = parse(converted.fnt);
    assert.equal(converted.fnt.toString('utf8').slice(0, 5), 'info ');
    assert.deepEqual(fnt.pages, [{ id: 0, file: 'game.webp' }]);
    assert.equal((await sharp(converted.pages[0].data).metadata()).format, 'webp');
    assert.deepEqual(fnt.chars, source.chars);
    assert.deepEqual(fnt.kernings, source.kernings);
    assert.deepEqual(fnt.common, source.common);
  });

  it('characters that drop glyphs from a .fnt repack it smaller', async () => {
    const made = await bitmapfont.makeBitmapFont({ data: ttf, path: 'game.ttf' });
    const source = parse(made.fnt);
    const kept = await bitmapfont.makeBitmapFont(
      { data: made.fnt, path: 'game.fnt', files: { 'game.png': made.pages[0].data } },
      { characters: '0123456789' }
    );
    const fnt = parse(kept.fnt);
    assert.deepEqual(
      fnt.chars.map((c) => c.id).sort((a, b) => a - b),
      [...'0123456789'].map((c) => c.codePointAt(0))
    );
    assert.ok(fnt.common.scaleW * fnt.common.scaleH < source.common.scaleW * source.common.scaleH);
    assert.ok(fnt.kernings.every((pair) => fnt.chars.some((c) => c.id === pair.first)));
    // a glyph keeps where it is drawn from the pen
    for (const digit of '0123456789') {
      const before = char(source, digit);
      const after = char(fnt, digit);
      assert.deepEqual(
        [after.xoffset, after.yoffset, after.width, after.height, after.xadvance],
        [before.xoffset, before.yoffset, before.width, before.height, before.xadvance],
        digit
      );
    }
  });

  it('refuses a binary .fnt and a .fnt without its page', async () => {
    await assert.rejects(bitmapfont.makeBitmapFont({ data: Buffer.from('BMF\x03'), path: 'x.fnt' }), /binary/);
    const made = await bitmapfont.makeBitmapFont({ data: ttf, path: 'game.ttf' });
    await assert.rejects(bitmapfont.makeBitmapFont({ data: made.fnt, path: 'game.fnt' }), /game\.png is missing/);
  });
});
