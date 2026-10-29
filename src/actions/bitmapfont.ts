// Makes bitmap fonts: a BMFont .fnt and its pages. From a .ttf, .otf, .woff or .woff2 each character is drawn from its
// outline, with HarfBuzz for the shapes, advances and kerning and sharp for the pixels, and the glyphs are packed like
// an atlas. From an existing .fnt its pages are re-encoded with the .fnt rewritten to match; its glyphs are cut out and
// packed again only when `characters` drops some.

import sharp from 'sharp';
import { destinationPath } from '../files.js';
import type { ActionDefinition, AssetFile, OptionTable } from '../types.js';
import { basename, dirname, extension, join } from '../utils/fs.js';
import { atlas, type AtlasSprite } from './atlas.js';
import { font } from './font.js';
import { image, type ImageOptions } from './image.js';
import { resolveOptions, transformFiles } from './index.js';

type PageFormat = 'png' | 'webp' | 'avif';
type DataFormat = 'xml' | 'text';
const EXTENSIONS: Record<string, string> = { png: 'png', jpeg: 'jpg', webp: 'webp', avif: 'avif' };
const ASCII = String.fromCharCode(...Array.from({ length: 95 }, (_, i) => 32 + i));
// keys the text format writes in quotes
const QUOTED = ['face', 'charset', 'file'];

export interface BitmapFontOptions extends Record<string, unknown> {
  characters?: string;
  size: number;
  color: string;
  outline: { width: number; color: string };
  shadow: { x: number; y: number; color: string };
  padding: number;
  maxWidth: number;
  maxHeight: number;
  powerOfTwo: boolean;
  format?: PageFormat;
  quality?: number;
  data?: DataFormat;
}

/** A font or a .fnt going into `makeBitmapFont`. */
export interface BitmapFontInput {
  /** The bytes of a .ttf, .otf, .woff or .woff2, or of a .fnt. */
  data: Buffer;
  /** Its file name, like `game.ttf`; new pages are named after it, like `game.png`. */
  path: string;
  /** The pages of a .fnt by the name it gives them, like `{ "game_0.png": buffer }`. */
  files?: Record<string, Buffer>;
  /** The name the .fnt refers to a page by, from its plain name and bytes. Default: the plain name. */
  fileName?: (plainName: string, data: Buffer) => string;
}

/** A page of a bitmap font. */
export interface BitmapFontPage {
  /** Plain name, like `game.png`. */
  name: string;
  data: Buffer;
}

/** What `makeBitmapFont` returns: the .fnt, its pages, and what to know about them. */
export interface MadeBitmapFont {
  fnt: Buffer;
  pages: BitmapFontPage[];
  warnings: string[];
}

export interface BitmapFontAction extends ActionDefinition<BitmapFontOptions> {
  /** Draw a bitmap font from a font, or optimize an existing text or XML .fnt with its pages. */
  makeBitmapFont(input: BitmapFontInput, options?: Partial<BitmapFontOptions>): Promise<MadeBitmapFont>;
}

const options: OptionTable = {
  characters: {
    kind: 'string',
    description: 'The characters to draw or keep. Omitted: printable ASCII from a font, every glyph of a .fnt'
  },
  size: { kind: 'number', description: 'Font size in px, when drawing from a font', min: 1, default: 32 },
  color: {
    kind: 'string',
    description: 'Glyph colour, when drawing from a font; white can be tinted in the game',
    default: '#ffffff'
  },
  outline: {
    kind: 'object',
    description: 'Outline around each glyph, when drawing from a font',
    properties: {
      width: { kind: 'number', description: 'Outline width in px; 0 for none', min: 0, default: 0 },
      color: { kind: 'string', description: 'Outline colour', default: '#000000' }
    }
  },
  shadow: {
    kind: 'object',
    description: 'Hard shadow under each glyph, when drawing from a font',
    properties: {
      x: { kind: 'number', description: 'Offset to the right in px; 0 for none', default: 0 },
      y: { kind: 'number', description: 'Offset down in px; 0 for none', default: 0 },
      color: { kind: 'string', description: 'Shadow colour', default: '#000000' }
    }
  },
  padding: { kind: 'number', description: 'Empty px between packed glyphs and to the page edge', min: 0, default: 2 },
  maxWidth: {
    kind: 'number',
    description: 'Widest page in px when glyphs are packed; glyphs that do not fit go to a second page',
    min: 1,
    default: 2048
  },
  maxHeight: { kind: 'number', description: 'Tallest page in px when glyphs are packed', min: 1, default: 2048 },
  powerOfTwo: { kind: 'boolean', description: 'Round packed page sizes up to a power of two', default: false },
  format: {
    kind: 'enum',
    values: ['png', 'webp', 'avif'],
    description: 'Page format; page names in the .fnt follow. Omitted: png from a font, as the source from a .fnt'
  },
  quality: {
    kind: 'number',
    description: 'Page quality, as in the image action. For png pages, setting it switches from lossless to a palette',
    min: 1,
    max: 100
  },
  data: {
    kind: 'enum',
    values: ['xml', 'text'],
    description:
      'The .fnt as XML, which Phaser and Pixi read, or as text. Omitted: xml from a font, as the source from a .fnt'
  }
};

/** Draw bitmap fonts from fonts, or optimize existing .fnt bitmap fonts with their pages. */
export const bitmapfont: BitmapFontAction = {
  name: 'bitmapfont',
  // bump whenever a code change alters the output: cached results of older versions stop matching
  version: 2,
  cache: true,
  accepts: ['ttf', 'otf', 'woff', 'woff2', 'fnt'],
  options,

  findCompanions(file) {
    if (extension(file.path) !== 'fnt') return [];
    return parseFnt(file.data.toString('utf8')).pages.map((page) => String(page.file));
  },

  async makeBitmapFont(input, given = {}) {
    const options = resolveOptions<BitmapFontOptions>(bitmapfont.options, given);
    if (input.data.toString('latin1', 0, 3) === 'BMF') {
      throw new Error('a binary .fnt is not supported; export it as text or XML');
    }
    const text = input.data.toString('utf8');
    const fromFnt = /^\s*(<|info\s)/.test(text);
    const fnt = fromFnt ? parseFnt(text) : { info: {}, common: {}, pages: [], chars: [], kernings: [] };
    const warnings: string[] = [];
    const fileName = input.fileName ?? ((plainName: string) => plainName);
    const stem = basename(input.path).replace(/\.[^.]+$/, '');
    const sprites: AtlasSprite[] = [];
    // where the top-left corner of each sprite sits from the pen position at the top of the line, by sprite name
    const origins = new Map<string, { x: number; y: number }>();
    let format = options.format ?? 'png';

    if (!fromFnt) {
      const signature = input.data.toString('latin1', 0, 4);
      const flavor = signature === 'wOFF' || signature === 'wOF2' ? input.data.toString('latin1', 4, 8) : signature;
      const characters = options.characters ?? ASCII;
      const subset = await font.optimizeFont(input.data, { format: flavor === 'OTTO' ? 'otf' : 'ttf', subset: characters });
      const hb = await import('harfbuzzjs');
      const face = new hb.Face(new hb.Blob(subset.data), 0);
      const hbFont = new hb.Font(face);
      const scale = options.size / face.upem;
      const { ascender, descender, lineGap } = hbFont.hExtents();
      const base = Math.round(ascender * scale);
      fnt.info = {
        face: face.getName(1, 'en') || stem,
        size: options.size,
        bold: 0,
        italic: 0,
        charset: '',
        unicode: 1,
        stretchH: 100,
        smooth: 1,
        aa: 1,
        padding: '0,0,0,0',
        spacing: `${options.padding},${options.padding}`,
        outline: options.outline.width
      };
      fnt.common = {
        lineHeight: Math.round((ascender - descender + lineGap) * scale),
        base,
        scaleW: 0,
        scaleH: 0,
        pages: 0,
        packed: 0
      };

      const { outline, shadow } = options;
      const color = escapeXml(options.color);
      const outlineColor = escapeXml(outline.color);
      const shadowColor = escapeXml(shadow.color);
      const grow = Math.ceil(outline.width) + 1;
      const glyphs = new Map<number, number>();
      const missing: string[] = [];
      for (const character of new Set(characters)) {
        const codePoint = character.codePointAt(0) as number;
        const glyph = hbFont.glyph(codePoint);
        if (glyph === undefined) {
          missing.push(character);
          continue;
        }
        glyphs.set(codePoint, glyph);
        const advance = Math.round(hbFont.glyphHAdvance(glyph) * scale);
        fnt.chars.push({
          id: codePoint,
          x: 0,
          y: 0,
          width: 0,
          height: 0,
          xoffset: 0,
          yoffset: 0,
          xadvance: advance,
          page: 0,
          chnl: 15
        });
        const path = hbFont.glyphToPath(glyph);
        const extents = hbFont.glyphExtents(glyph);
        // a space has an advance and nothing to draw
        if (!path || !extents || !extents.width || !extents.height) continue;
        // font units point up and px point down; the box takes the outline, the shadow and a px of antialiasing
        const left = Math.floor(extents.xBearing * scale) - grow - Math.ceil(Math.max(0, -shadow.x));
        const top = Math.floor(-extents.yBearing * scale) - grow - Math.ceil(Math.max(0, -shadow.y));
        const right = Math.ceil((extents.xBearing + extents.width) * scale) + grow + Math.ceil(Math.max(0, shadow.x));
        const bottom = Math.ceil(-(extents.yBearing + extents.height) * scale) + grow + Math.ceil(Math.max(0, shadow.y));
        let layers = '';
        if (shadow.x || shadow.y)
          layers += svgLayer(path, shadowColor, outline.width, scale, shadow.x - left, shadow.y - top);
        if (outline.width) layers += svgLayer(path, outlineColor, outline.width, scale, -left, -top);
        layers += svgLayer(path, color, 0, scale, -left, -top);
        const width = right - left;
        const height = bottom - top;
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${layers}</svg>`;
        sprites.push({ name: String(codePoint), data: Buffer.from(svg) });
        origins.set(String(codePoint), { x: left, y: base + top });
      }
      if (missing.length) warnings.push(`the font has no glyph for ${JSON.stringify(missing.join(''))}; left out`);
      if (!fnt.chars.length) throw new Error('the font has none of the characters');

      // kerning between two characters is what shaping them together moves the first one by
      const buffer = new hb.Buffer();
      for (const [first, firstGlyph] of glyphs) {
        for (const second of glyphs.keys()) {
          buffer.clearContents();
          buffer.addCodePoints([first, second]);
          buffer.guessSegmentProperties();
          hb.shape(hbFont, buffer);
          const shaped = buffer.getGlyphInfos();
          // a ligature or a right-to-left pair is not plain kerning
          if (shaped.length !== 2 || shaped[0]?.codepoint !== firstGlyph) continue;
          const moved = (buffer.getGlyphPositions()[0]?.xAdvance ?? 0) - hbFont.glyphHAdvance(firstGlyph);
          const amount = Math.round(moved * scale);
          if (amount) fnt.kernings.push({ first, second, amount });
        }
      }
    }

    const keep =
      options.characters === undefined ? undefined : new Set(Array.from(options.characters, (c) => c.codePointAt(0)));
    const dropped = fromFnt && keep ? fnt.chars.filter((char) => !keep.has(Number(char.id))) : [];
    if (fromFnt && keep) {
      const ids = new Set(fnt.chars.map((char) => Number(char.id)));
      const missing = [...keep].filter((id) => !ids.has(id as number));
      if (missing.length) {
        warnings.push(`the .fnt has no glyph for ${JSON.stringify(String.fromCodePoint(...(missing as number[])))}`);
      }
    }

    if (fromFnt && !dropped.length) {
      const pages: BitmapFontPage[] = [];
      for (const page of fnt.pages) {
        const name = String(page.file);
        const data = input.files?.[name];
        if (!data) throw new Error(`${name} is missing; it has to sit next to the .fnt`);
        const imageOptions: Partial<ImageOptions> = {
          png: { palette: options.quality !== undefined, colors: 256, dither: 1, effort: 7 }
        };
        if (options.format) imageOptions.format = options.format;
        if (options.quality !== undefined) imageOptions.quality = options.quality;
        const encoded = await image.optimizeImage(data, imageOptions);
        if (!encoded) throw new Error(`${name}: not a raster image`);
        const ext = EXTENSIONS[encoded.format] ?? encoded.format;
        const keepsName = extension(name) === ext || (ext === 'jpg' && extension(name) === 'jpeg');
        const newName = keepsName ? name : `${name.replace(/\.[^./]*$/, '')}.${ext}`;
        pages.push({ name: newName, data: encoded.data });
        page.file = fileName(newName, encoded.data);
      }
      const data = options.data ?? (text.trimStart().startsWith('<') ? 'xml' : 'text');
      return { fnt: Buffer.from(writeFnt(fnt, data)), pages, warnings };
    }

    if (fromFnt) {
      if (Number(fnt.common.packed)) {
        throw new Error('its glyphs share pixels across colour channels (packed), so characters cannot drop glyphs from it');
      }
      const decoded = [];
      for (const page of fnt.pages) {
        const name = String(page.file);
        const data = input.files?.[name];
        if (!data) throw new Error(`${name} is missing; it has to sit next to the .fnt`);
        decoded[Number(page.id)] = await sharp(data).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      }
      fnt.chars = fnt.chars.filter((char) => keep?.has(Number(char.id)));
      fnt.kernings = fnt.kernings.filter((pair) => keep?.has(Number(pair.first)) && keep.has(Number(pair.second)));
      for (const char of fnt.chars) {
        const width = Number(char.width);
        const height = Number(char.height);
        if (!width || !height) continue;
        const page = decoded[Number(char.page)];
        if (!page) throw new Error(`character ${char.id} is on page ${char.page}, which the .fnt does not list`);
        const raw = { width: page.info.width, height: page.info.height, channels: 4 as const };
        const pixels = await sharp(page.data, { raw })
          .extract({ left: Number(char.x), top: Number(char.y), width, height })
          .png({ compressionLevel: 0 })
          .toBuffer();
        sprites.push({ name: String(char.id), data: pixels });
        origins.set(String(char.id), { x: Number(char.xoffset), y: Number(char.yoffset) });
      }
      const first = extension(String(fnt.pages[0]?.file ?? ''));
      if (!options.format && (first === 'webp' || first === 'avif')) format = first;
    }

    const packed = await atlas.packAtlas(sprites, {
      padding: options.padding,
      maxWidth: options.maxWidth,
      maxHeight: options.maxHeight,
      powerOfTwo: options.powerOfTwo,
      format,
      quality: options.quality,
      trim: true,
      extrude: 0,
      scale: 1
    });
    if (packed.errors.length) throw new Error(packed.errors.map((error) => error.message).join('; '));
    if (packed.pages.length > 1) warnings.push(`the glyphs do not fit one page; ${packed.pages.length} pages`);

    const charsById = new Map(fnt.chars.map((char) => [String(char.id), char]));
    const pages: BitmapFontPage[] = [];
    fnt.pages = [];
    for (const [index, page] of packed.pages.entries()) {
      const name = `${packed.pages.length > 1 ? `${stem}_${index + 1}` : stem}.${EXTENSIONS[format]}`;
      pages.push({ name, data: page.image });
      fnt.pages.push({ id: index, file: fileName(name, page.image) });
      for (const [spriteName, { frame, spriteSourceSize }] of Object.entries(page.frames)) {
        const char = charsById.get(spriteName) as Values;
        const origin = origins.get(spriteName) as { x: number; y: number };
        char.x = frame.x;
        char.y = frame.y;
        char.width = frame.w;
        char.height = frame.h;
        char.xoffset = origin.x + spriteSourceSize.x;
        char.yoffset = origin.y + spriteSourceSize.y;
        char.page = index;
      }
    }
    // BMFont gives every page one size; a smaller last page still reads right, as glyphs are placed in px
    fnt.common.scaleW = packed.pages[0]?.width ?? 0;
    fnt.common.scaleH = packed.pages[0]?.height ?? 0;
    fnt.common.pages = packed.pages.length;
    const data = options.data ?? (fromFnt && !text.trimStart().startsWith('<') ? 'text' : 'xml');
    return { fnt: Buffer.from(writeFnt(fnt, data)), pages, warnings };
  },

  async transform(files, options, { filenameTemplate }) {
    const warnings: string[] = [];
    // transformFiles keeps one output per input, so the pages of each .fnt wait here and follow it
    const nextToFnt = new Map<AssetFile, AssetFile[]>();
    const { outputs, errors } = await transformFiles(files, async (file) => {
      const made = await bitmapfont.makeBitmapFont(
        {
          data: file.data,
          path: file.path,
          files: Object.fromEntries((file.companions ?? []).map((companion) => [companion.path, companion.data])),
          // the .fnt refers to each page by the name the filename template gives it, as an atlas JSON does
          fileName: (plainName, data) => destinationPath({ path: plainName, data, meta: { size: 0 } }, filenameTemplate)
        },
        options
      );
      for (const warning of made.warnings) warnings.push(`${file.origin ?? file.path}: ${warning}`);
      const fntFile: AssetFile = {
        ...file,
        companions: undefined,
        path: `${file.path.replace(/\.[^./]+$/, '')}.fnt`,
        data: made.fnt,
        meta: { size: 0 }
      };
      nextToFnt.set(
        fntFile,
        made.pages.map((page) => ({
          ...file,
          companions: undefined,
          path: join(dirname(file.path), page.name),
          data: page.data,
          meta: { size: 0 }
        }))
      );
      return fntFile;
    });
    return { outputs: outputs.flatMap((fnt) => [fnt, ...(nextToFnt.get(fnt) ?? [])]), warnings, errors };
  }
};

type Values = Record<string, string | number>;

/** The tags of a .fnt; each keeps its keys in the order they were read. */
interface Fnt {
  info: Values;
  common: Values;
  pages: Values[];
  chars: Values[];
  kernings: Values[];
}

// both formats are one tag per line or element with key=value pairs; the chars and kernings counts are written anew
function parseFnt(text: string): Fnt {
  const fnt: Fnt = { info: {}, common: {}, pages: [], chars: [], kernings: [] };
  const xml = text.trimStart().startsWith('<');
  const tags = xml ? text.matchAll(/<(\w+)\s+([^>]*?)\/?>/g) : text.matchAll(/^\s*(\w+)\s+(.*)$/gm);
  for (const [, tag, rest] of tags) {
    const values: Values = {};
    for (const [, key, double, single, plain] of (rest as string).matchAll(/(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g)) {
      const value = double ?? single ?? plain ?? '';
      values[key as string] = xml
        ? value.replace(/&(#x?[0-9a-f]+|lt|gt|quot|apos|amp);/gi, (entity, name: string) => {
            if (name[0] === '#') return String.fromCodePoint(Number(name[1] === 'x' ? `0${name.slice(1)}` : name.slice(1)));
            return { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' }[name] ?? entity;
          })
        : value;
    }
    if (tag === 'info' || tag === 'common') fnt[tag] = values;
    if (tag === 'page') fnt.pages.push(values);
    if (tag === 'char') fnt.chars.push(values);
    if (tag === 'kerning') fnt.kernings.push(values);
  }
  return fnt;
}

function writeFnt(fnt: Fnt, data: DataFormat): string {
  if (data === 'text') {
    const line = (tag: string, values: Values) =>
      [
        tag,
        ...Object.entries(values).map(([key, value]) => (QUOTED.includes(key) ? `${key}="${value}"` : `${key}=${value}`))
      ].join(' ');
    const lines = [line('info', fnt.info), line('common', fnt.common), ...fnt.pages.map((page) => line('page', page))];
    lines.push(`chars count=${fnt.chars.length}`, ...fnt.chars.map((char) => line('char', char)));
    if (fnt.kernings.length) {
      lines.push(`kernings count=${fnt.kernings.length}`, ...fnt.kernings.map((pair) => line('kerning', pair)));
    }
    return `${lines.join('\n')}\n`;
  }
  const element = (tag: string, values: Values) =>
    `<${tag} ${Object.entries(values)
      .map(([key, value]) => `${key}="${escapeXml(String(value))}"`)
      .join(' ')}/>`;
  // whitespace between tags means nothing in XML, so the elements follow each other on one line
  const parts = ['<?xml version="1.0"?>', '<font>', element('info', fnt.info), element('common', fnt.common)];
  parts.push('<pages>', ...fnt.pages.map((page) => element('page', page)), '</pages>');
  parts.push(`<chars count="${fnt.chars.length}">`, ...fnt.chars.map((char) => element('char', char)), '</chars>');
  if (fnt.kernings.length) {
    parts.push(`<kernings count="${fnt.kernings.length}">`);
    parts.push(...fnt.kernings.map((pair) => element('kerning', pair)), '</kernings>');
  }
  parts.push('</font>');
  return parts.join('');
}

const escapeXml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// a glyph outline in font units, flipped and scaled into px with the pen position at (x, y); a stroke of twice `grow`
// widens it by `grow` px on each side
function svgLayer(path: string, color: string, grow: number, scale: number, x: number, y: number): string {
  const stroke = grow ? ` stroke="${color}" stroke-width="${(2 * grow) / scale}" stroke-linejoin="round"` : '';
  return `<path transform="matrix(${scale} 0 0 ${-scale} ${x} ${y})" d="${path}" fill="${color}"${stroke}/>`;
}
