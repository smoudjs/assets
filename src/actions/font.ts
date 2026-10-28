// Subsets and converts fonts. HarfBuzz, as WebAssembly from harfbuzzjs, keeps the glyphs of the given characters
// together with the layout rules that use them; wawoff2 reads and writes WOFF2; WOFF is plain zlib, done here.

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { deflateSync, inflateSync } from 'node:zlib';
import type { ActionDefinition, OptionTable } from '../types.js';
import { resolveOptions, transformFiles } from './index.js';
import { extension } from '../utils/fs.js';

type Format = 'woff2' | 'woff' | 'ttf' | 'otf';

export interface FontOptions extends Record<string, unknown> {
  format?: Format;
  subset?: string | { text?: string; ranges?: string[] };
  removeHinting: boolean;
  keepSmaller: boolean;
}

/** What `optimizeFont` returns. */
export interface OptimizedFont {
  data: Buffer;
  format: Format;
  /** The original bytes were kept because converting would not have made them smaller. */
  keptOriginal: boolean;
}

export interface FontAction extends ActionDefinition<FontOptions> {
  /** Subset and convert one font: `.ttf`, `.otf`, `.woff` or `.woff2`. */
  optimizeFont(data: Buffer, options?: Partial<FontOptions>): Promise<OptimizedFont>;
}

const options: OptionTable = {
  format: {
    kind: 'enum',
    values: ['woff2', 'woff', 'ttf', 'otf'],
    description: 'woff2 (smallest), woff, or a plain ttf or otf with the outlines the font has. Omitted: as the source'
  },
  subset: {
    kind: 'oneOf',
    description: 'Keep only the glyphs these characters need, with the ligatures and kerning between them',
    oneOf: [
      { kind: 'string', description: 'The characters to keep' },
      {
        kind: 'object',
        description: 'Characters to keep',
        properties: {
          text: { kind: 'string', description: 'The characters to keep' },
          ranges: {
            kind: 'list',
            description: 'Unicode ranges to keep, like U+0020-007E or U+00E9',
            items: { kind: 'string', description: 'A range' }
          }
        }
      }
    ]
  },
  removeHinting: {
    kind: 'boolean',
    description: 'Remove hinting, which only sharpens small text on low-resolution screens',
    default: false
  },
  keepSmaller: {
    kind: 'boolean',
    description: 'With nothing to subset or remove, keep the original when converting would not make it smaller',
    default: true
  }
};

/** Subset fonts to the characters a game uses, and convert them to WOFF2, WOFF, TTF or OTF. */
export const font: FontAction = {
  name: 'font',
  // bump whenever a code change alters the output: cached results of older versions stop matching
  version: 1,
  cache: true,
  accepts: ['ttf', 'otf', 'woff', 'woff2'],
  options,

  async optimizeFont(data, input = {}) {
    const options = resolveOptions<FontOptions>(font.options, input);
    const signature = data.toString('latin1', 0, 4);
    let sfnt = data;
    if (signature === 'wOF2') sfnt = Buffer.from(await (await import('wawoff2')).decompress(data));
    if (signature === 'wOFF') sfnt = woffToSfnt(data);
    const outlines = sfnt.toString('latin1', 0, 4) === 'OTTO' ? 'otf' : 'ttf';
    let sourceFormat: Format = outlines;
    if (signature === 'wOF2') sourceFormat = 'woff2';
    if (signature === 'wOFF') sourceFormat = 'woff';
    const format = options.format ?? sourceFormat;
    if ((format === 'ttf' || format === 'otf') && format !== outlines) {
      throw new Error(`its outlines are ${outlines}, so it can be written as ${outlines}, woff or woff2, not ${format}`);
    }

    // null keeps every glyph, for removeHinting alone
    let codePoints: Set<number> | null = null;
    if (options.subset !== undefined) {
      const { text = '', ranges = [] } = typeof options.subset === 'string' ? { text: options.subset } : options.subset;
      codePoints = new Set<number>();
      for (const character of text) codePoints.add(character.codePointAt(0) as number);
      for (const range of ranges) {
        const match = /^U\+([0-9A-F]+)(?:-([0-9A-F]+))?$/i.exec(range.trim());
        if (!match) throw new Error(`"${range}" is not a Unicode range like U+0020-007E`);
        const last = parseInt(match[2] ?? (match[1] as string), 16);
        for (let codePoint = parseInt(match[1] as string, 16); codePoint <= last; codePoint++) codePoints.add(codePoint);
      }
    }
    const changes = options.subset !== undefined || options.removeHinting;
    if (changes) sfnt = subsetSfnt(await loadHarfbuzz(), sfnt, codePoints, options.removeHinting);
    let encoded = sfnt;
    if (format === 'woff2') encoded = Buffer.from(await (await import('wawoff2')).compress(sfnt));
    if (format === 'woff') encoded = sfntToWoff(sfnt);

    if (options.keepSmaller && !changes && format === sourceFormat && encoded.length >= data.length) {
      return { data, format, keptOriginal: true };
    }
    return { data: encoded, format, keptOriginal: false };
  },

  async transform(files, options) {
    return transformFiles(files, async (file) => {
      const { data, format, keptOriginal } = await font.optimizeFont(file.data, options);
      const path =
        keptOriginal || extension(file.path) === format ? file.path : file.path.replace(/\.[^./]+$/, '') + `.${format}`;
      return { ...file, path, data, meta: { ...file.meta, format }, keptOriginal };
    });
  }
};

// --- HarfBuzz -----------------------------------------------------------------------------------------------------

// Node runs WebAssembly, but the Node types in use do not declare it
declare const WebAssembly: { instantiate(bytes: Buffer): Promise<{ instance: { exports: unknown } }> };

/** The functions of harfbuzz-subset.wasm used here. Pointers and handles are plain numbers. */
interface Harfbuzz {
  memory: { buffer: ArrayBuffer };
  _initialize(): void;
  malloc(size: number): number;
  free(pointer: number): void;
  hb_blob_create(data: number, length: number, mode: number, userData: number, destroy: number): number;
  hb_blob_destroy(blob: number): void;
  hb_blob_get_data(blob: number, length: number): number;
  hb_blob_get_length(blob: number): number;
  hb_face_create(blob: number, index: number): number;
  hb_face_destroy(face: number): void;
  hb_face_reference_blob(face: number): number;
  hb_set_add(set: number, value: number): void;
  hb_set_clear(set: number): void;
  hb_set_invert(set: number): void;
  hb_subset_input_create_or_fail(): number;
  hb_subset_input_destroy(input: number): void;
  hb_subset_input_get_flags(input: number): number;
  hb_subset_input_set_flags(input: number, flags: number): void;
  hb_subset_input_set(input: number, which: number): number;
  hb_subset_input_unicode_set(input: number): number;
  hb_subset_or_fail(face: number, input: number): number;
}

const HB_MEMORY_MODE_WRITABLE = 2;
const HB_SUBSET_SETS_LAYOUT_FEATURE_TAG = 6;
const HB_SUBSET_FLAGS_NO_HINTING = 0x00000001;

let harfbuzz: Promise<Harfbuzz> | undefined;

function loadHarfbuzz(): Promise<Harfbuzz> {
  harfbuzz ??= instantiateHarfbuzz();
  return harfbuzz;
}

async function instantiateHarfbuzz(): Promise<Harfbuzz> {
  const file = createRequire(import.meta.url).resolve('harfbuzzjs/dist/harfbuzz-subset.wasm');
  const { instance } = await WebAssembly.instantiate(await readFile(file));
  const exports = instance.exports as Harfbuzz;
  exports._initialize();
  return exports;
}

/**
 * The font with the glyphs of `codePoints` only, or every glyph when null. Every layout feature stays, so ligatures
 * and kerning between the kept glyphs keep working. Synchronous from start to end, so calls never share the memory.
 */
function subsetSfnt(hb: Harfbuzz, sfnt: Buffer, codePoints: Set<number> | null, removeHinting: boolean): Buffer {
  const input = hb.hb_subset_input_create_or_fail();
  if (input === 0) throw new Error('HarfBuzz could not start subsetting');
  const fontPointer = hb.malloc(sfnt.length);
  // the memory can grow while subsetting, which detaches views made before; each use takes a fresh one
  new Uint8Array(hb.memory.buffer).set(sfnt, fontPointer);
  const blob = hb.hb_blob_create(fontPointer, sfnt.length, HB_MEMORY_MODE_WRITABLE, 0, 0);
  const face = hb.hb_face_create(blob, 0);
  hb.hb_blob_destroy(blob);
  try {
    // every layout feature, like hb-subset --layout-features=*
    const features = hb.hb_subset_input_set(input, HB_SUBSET_SETS_LAYOUT_FEATURE_TAG);
    hb.hb_set_clear(features);
    hb.hb_set_invert(features);
    if (removeHinting) {
      hb.hb_subset_input_set_flags(input, hb.hb_subset_input_get_flags(input) | HB_SUBSET_FLAGS_NO_HINTING);
    }
    const unicodes = hb.hb_subset_input_unicode_set(input);
    if (codePoints) {
      for (const codePoint of codePoints) hb.hb_set_add(unicodes, codePoint);
    } else {
      hb.hb_set_clear(unicodes);
      hb.hb_set_invert(unicodes);
    }

    const subset = hb.hb_subset_or_fail(face, input);
    if (subset === 0) throw new Error('HarfBuzz could not subset it; the font may be broken');
    const result = hb.hb_face_reference_blob(subset);
    const offset = hb.hb_blob_get_data(result, 0);
    const length = hb.hb_blob_get_length(result);
    const data = Buffer.from(new Uint8Array(hb.memory.buffer).subarray(offset, offset + length));
    hb.hb_blob_destroy(result);
    hb.hb_face_destroy(subset);
    if (length === 0) throw new Error('HarfBuzz gave an empty font; the font may be broken');
    return data;
  } finally {
    hb.hb_subset_input_destroy(input);
    hb.hb_face_destroy(face);
    hb.free(fontPointer);
  }
}

// --- WOFF ---------------------------------------------------------------------------------------------------------
// A 44-byte header, a 20-byte entry per table, then each table zlib-compressed, or as it is when that is not smaller,
// starting on a 4-byte boundary. https://www.w3.org/TR/WOFF/

const align4 = (n: number) => (n + 3) & ~3;

function sfntToWoff(sfnt: Buffer): Buffer {
  const numTables = sfnt.readUInt16BE(4);
  const tables: Array<{ tag: number; checksum: number; length: number; data: Buffer; offset: number }> = [];
  let sfntSize = 12 + 16 * numTables;
  let offset = 44 + 20 * numTables;
  for (let index = 0; index < numTables; index++) {
    const record = 12 + 16 * index;
    const start = sfnt.readUInt32BE(record + 8);
    const length = sfnt.readUInt32BE(record + 12);
    const original = sfnt.subarray(start, start + length);
    const compressed = deflateSync(original);
    const data = compressed.length < length ? compressed : original;
    tables.push({ tag: sfnt.readUInt32BE(record), checksum: sfnt.readUInt32BE(record + 4), length, data, offset });
    sfntSize += align4(length);
    offset = align4(offset + data.length);
  }

  const woff = Buffer.alloc(offset);
  woff.write('wOFF', 0, 'latin1');
  woff.writeUInt32BE(sfnt.readUInt32BE(0), 4);
  woff.writeUInt32BE(offset, 8);
  woff.writeUInt16BE(numTables, 12);
  woff.writeUInt32BE(sfntSize, 16);
  woff.writeUInt16BE(1, 20);
  for (const [index, table] of tables.entries()) {
    const entry = 44 + 20 * index;
    woff.writeUInt32BE(table.tag, entry);
    woff.writeUInt32BE(table.offset, entry + 4);
    woff.writeUInt32BE(table.data.length, entry + 8);
    woff.writeUInt32BE(table.length, entry + 12);
    woff.writeUInt32BE(table.checksum, entry + 16);
    table.data.copy(woff, table.offset);
  }
  return woff;
}

function woffToSfnt(woff: Buffer): Buffer {
  const numTables = woff.readUInt16BE(12);
  const sfnt = Buffer.alloc(woff.readUInt32BE(16));
  const power = 2 ** Math.floor(Math.log2(numTables));
  sfnt.writeUInt32BE(woff.readUInt32BE(4), 0);
  sfnt.writeUInt16BE(numTables, 4);
  sfnt.writeUInt16BE(power * 16, 6);
  sfnt.writeUInt16BE(Math.log2(power), 8);
  sfnt.writeUInt16BE(numTables * 16 - power * 16, 10);
  let offset = 12 + 16 * numTables;
  for (let index = 0; index < numTables; index++) {
    const entry = 44 + 20 * index;
    const start = woff.readUInt32BE(entry + 4);
    const compressedLength = woff.readUInt32BE(entry + 8);
    const length = woff.readUInt32BE(entry + 12);
    const stored = woff.subarray(start, start + compressedLength);
    const data = compressedLength < length ? inflateSync(stored) : stored;
    const record = 12 + 16 * index;
    sfnt.writeUInt32BE(woff.readUInt32BE(entry), record);
    sfnt.writeUInt32BE(woff.readUInt32BE(entry + 16), record + 4);
    sfnt.writeUInt32BE(offset, record + 8);
    sfnt.writeUInt32BE(length, record + 12);
    data.copy(sfnt, offset);
    offset = align4(offset + length);
  }
  return sfnt;
}
