// Packs sprites into pages and writes a TexturePacker-style JSON (hash format) next to each page.
// Sharp only decodes the sprites and encodes the pages; trimming, extruding and placing are plain buffer
// copies, so a frame cut back out of a page is pixel-identical to its trimmed source.

import sharp from 'sharp';
import type { ActionDefinition, AssetFile, OptionTable } from '../types.js';
import { resolveOptions } from './index.js';
import { destinationPath } from '../files.js';
import { contentHash } from '../utils/fs.js';

type PageFormat = 'png' | 'jpeg' | 'webp' | 'avif';
const EXTENSIONS: Record<PageFormat, string> = { png: '.png', jpeg: '.jpg', webp: '.webp', avif: '.avif' };

export interface AtlasOptions extends Record<string, unknown> {
  name?: string;
  maxWidth: number;
  maxHeight: number;
  padding: number;
  extrude: number;
  trim: boolean;
  powerOfTwo: boolean;
  format: PageFormat;
  quality?: number;
}

/** Page quality when `quality` is not set, matching the image action's defaults. png pages stay lossless instead. */
const QUALITY_WHEN_UNSET = { jpeg: 80, webp: 80, avif: 50 };

export interface AtlasSprite {
  /** Frame name, e.g. `hero/idle_01`. */
  name: string;
  data: Buffer;
}

/** One frame of the TexturePacker JSON hash format. */
export interface AtlasFrame {
  frame: { x: number; y: number; w: number; h: number };
  rotated: false;
  trimmed: boolean;
  spriteSourceSize: { x: number; y: number; w: number; h: number };
  sourceSize: { w: number; h: number };
}

export interface AtlasPage {
  /** The encoded page. */
  image: Buffer;
  width: number;
  height: number;
  /** Frames by name, sorted by name for stable output. */
  frames: Record<string, AtlasFrame>;
}

export interface PackedAtlas {
  pages: AtlasPage[];
  warnings: string[];
  /** Sprites that could not be packed, with the reason. */
  errors: Array<{ sprite: string; message: string }>;
}

export interface AtlasAction extends ActionDefinition<AtlasOptions> {
  /**
   * Packs sprites into as few pages as fit. Sprites go in largest first, so the same input always gives the
   * same pages. A sprite that fails to decode or does not fit a page is reported in `errors` and left out.
   */
  packAtlas(sprites: AtlasSprite[], options?: Partial<AtlasOptions>): Promise<PackedAtlas>;
}

const options: OptionTable = {
  name: { kind: 'string', description: 'Atlas name. Default: the folder the sprites were selected from' },
  maxWidth: {
    kind: 'number',
    description: 'Widest page in px; sprites that do not fit go to a second page',
    min: 1,
    default: 2048
  },
  maxHeight: { kind: 'number', description: 'Tallest page in px', min: 1, default: 2048 },
  padding: { kind: 'number', description: 'Empty px between sprites and to the page edge', min: 0, default: 2 },
  extrude: {
    kind: 'number',
    description: 'Repeat the edge pixels of every sprite this many px outwards, against bleeding',
    min: 0,
    default: 0
  },
  trim: {
    kind: 'boolean',
    description: 'Cut transparent borders; frames remember the original size and offset',
    default: true
  },
  powerOfTwo: { kind: 'boolean', description: 'Round page sizes up to a power of two', default: false },
  format: { kind: 'enum', description: 'Page format', values: ['png', 'jpeg', 'webp', 'avif'], default: 'png' },
  quality: {
    kind: 'number',
    description:
      'Page quality. For png pages, setting it switches from lossless to a palette; unset, jpeg and webp use 80 and avif 50',
    min: 1,
    max: 100
  }
};

/** Packs sprites into texture atlas pages with a TexturePacker-style JSON per page. */
export const atlas: AtlasAction = {
  name: 'atlas',
  // bump whenever a code change alters the output: cached results of older versions stop matching
  version: 1,
  cache: 'together',
  accepts: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'tif', 'tiff'],
  options,

  async packAtlas(sprites, input = {}) {
    const options = resolveOptions<AtlasOptions>(atlas.options, input);
    const warnings: string[] = [];
    const errors: Array<{ sprite: string; message: string }> = [];

    const decoded: Sprite[] = [];
    const names = new Set<string>();
    for (const sprite of sprites) {
      if (names.has(sprite.name)) {
        errors.push({ sprite: sprite.name, message: `frame "${sprite.name}" exists twice (same name, other extension)` });
        continue;
      }
      names.add(sprite.name);
      try {
        decoded.push(await decodeSprite(sprite, options.trim, warnings));
      } catch (error) {
        errors.push({ sprite: sprite.name, message: (error as Error).message });
      }
    }

    const pages = packPages(decoded, options, errors);
    if (pages.length > 1) {
      warnings.push(
        `${decoded.length} sprites do not fit one ${options.maxWidth}×${options.maxHeight} page; ${pages.length} pages`
      );
    }
    const encoded: AtlasPage[] = [];
    for (const page of pages) {
      encoded.push({
        image: await encodePage(composePage(page, options), page, options),
        width: page.width,
        height: page.height,
        frames: describeFrames(page, options.extrude)
      });
    }
    return { pages: encoded, warnings, errors };
  },

  async transform(files, options, { folderName, filenameTemplate }) {
    const spriteName = (file: AssetFile) => file.path.replace(/\.[^./]+$/, '');
    const packed = await atlas.packAtlas(
      files.map((file) => ({ name: spriteName(file), data: file.data })),
      options
    );
    const fileOf = new Map(files.map((file) => [spriteName(file), file]));
    const errors = packed.errors.map(({ sprite, message }) => `${fileOf.get(sprite)?.origin ?? sprite}: ${message}`);

    const name = options.name ?? (folderName || 'atlas');
    const pages = packed.pages.map((page, index) => {
      const stem = packed.pages.length > 1 ? `${name}_${index + 1}` : name;
      const image: AssetFile = {
        path: stem + EXTENSIONS[options.format],
        data: page.image,
        meta: {
          size: 0,
          format: options.format,
          width: page.width,
          height: page.height,
          alpha: options.format !== 'jpeg',
          animated: false
        }
      };
      // the JSON borrows the image's hash, so both get the same name under a [hash] filename template
      const json: AssetFile = {
        path: `${stem}.json`,
        data: Buffer.alloc(0),
        meta: { size: 0 },
        filenameTokens: { hash: contentHash(page.image) }
      };
      return { page, image, json };
    });
    const outputs: AssetFile[] = [];
    for (const { page, image, json } of pages) {
      const others = pages
        .filter((other) => other.json !== json)
        .map((other) => destinationPath(other.json, filenameTemplate));
      const meta: Record<string, unknown> = {
        image: destinationPath(image, filenameTemplate),
        format: 'RGBA8888',
        size: { w: page.width, h: page.height },
        scale: '1'
      };
      if (others.length) meta['related_multi_packs'] = others;
      json.data = Buffer.from(JSON.stringify({ frames: page.frames, meta }));
      outputs.push(image, json);
    }
    return { outputs, warnings: packed.warnings, errors };
  }
};

interface Region {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Sprite {
  name: string;
  /** RGBA pixels of the kept region. */
  pixels: Buffer;
  width: number;
  height: number;
  /** Size of the source image and where the kept region sits in it. */
  sourceWidth: number;
  sourceHeight: number;
  offsetX: number;
  offsetY: number;
}

async function decodeSprite(sprite: AtlasSprite, trim: boolean, warnings: string[]): Promise<Sprite> {
  const { data, info } = await sharp(sprite.data).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let region: Region = { left: 0, top: 0, width: info.width, height: info.height };
  if (trim) {
    const visible = visibleRegion(data, info.width, info.height);
    if (!visible) warnings.push(`${sprite.name} is fully transparent; kept as a 1×1 frame`);
    region = visible ?? { left: 0, top: 0, width: 1, height: 1 };
  }
  return {
    name: sprite.name,
    pixels: cropPixels(data, info.width, region),
    width: region.width,
    height: region.height,
    sourceWidth: info.width,
    sourceHeight: info.height,
    offsetX: region.left,
    offsetY: region.top
  };
}

/** The smallest box around every pixel with alpha above zero; null when the image is fully transparent. */
function visibleRegion(pixels: Buffer, width: number, height: number): Region | null {
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (pixels[(y * width + x) * 4 + 3] === 0) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  return right < 0 ? null : { left, top, width: right - left + 1, height: bottom - top + 1 };
}

function cropPixels(pixels: Buffer, width: number, region: Region): Buffer {
  const cropped = Buffer.alloc(region.width * region.height * 4);
  for (let row = 0; row < region.height; row++) {
    const start = ((region.top + row) * width + region.left) * 4;
    pixels.copy(cropped, row * region.width * 4, start, start + region.width * 4);
  }
  return cropped;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A sprite's cell on a page: its pixels start `extrude` px inside the cell's top-left corner. */
interface Placement {
  sprite: Sprite;
  x: number;
  y: number;
}

interface Page {
  placements: Placement[];
  free: Rect[];
  /** Grows with the content, up to the limits. */
  width: number;
  height: number;
}

const byName = (a: Sprite, b: Sprite) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

// MaxRects with best short side fit, no rotation. Sprites go in largest first, so the result only depends on
// the input; a sprite that fits no open page opens a new one.
function packPages(sprites: Sprite[], options: AtlasOptions, errors: Array<{ sprite: string; message: string }>): Page[] {
  const { padding, extrude } = options;
  // with powerOfTwo the pages are rounded up afterwards, so they must be packed within the power of two below the limit
  const limitWidth = options.powerOfTwo ? 2 ** Math.floor(Math.log2(options.maxWidth)) : options.maxWidth;
  const limitHeight = options.powerOfTwo ? 2 ** Math.floor(Math.log2(options.maxHeight)) : options.maxHeight;
  const sorted = [...sprites].sort((a, b) => Math.max(b.width, b.height) - Math.max(a.width, a.height) || byName(a, b));

  const pages: Page[] = [];
  for (const sprite of sorted) {
    // a cell: the extruded edges around the pixels, then the gap to the next sprite
    const cell = { width: sprite.width + 2 * extrude + padding, height: sprite.height + 2 * extrude + padding };
    if (cell.width > limitWidth - padding || cell.height > limitHeight - padding) {
      errors.push({
        sprite: sprite.name,
        message: `${sprite.width}×${sprite.height} px does not fit a ${options.maxWidth}×${options.maxHeight} page with this padding and extrude`
      });
      continue;
    }
    if (pages.some((page) => placeOnPage(page, sprite, cell))) continue;
    const page: Page = {
      placements: [],
      free: [{ x: padding, y: padding, width: limitWidth - padding, height: limitHeight - padding }],
      width: 0,
      height: 0
    };
    placeOnPage(page, sprite, cell);
    pages.push(page);
  }

  if (options.powerOfTwo) {
    for (const page of pages) {
      page.width = 2 ** Math.ceil(Math.log2(page.width));
      page.height = 2 ** Math.ceil(Math.log2(page.height));
    }
  }
  return pages;
}

/** Put the cell into the free rectangle where it leaves the smallest gap on its short side. False when none fits. */
function placeOnPage(page: Page, sprite: Sprite, cell: { width: number; height: number }): boolean {
  let best: Rect | undefined;
  let bestShort = Infinity;
  let bestLong = Infinity;
  for (const free of page.free) {
    const gapX = free.width - cell.width;
    const gapY = free.height - cell.height;
    if (gapX < 0 || gapY < 0) continue;
    const short = Math.min(gapX, gapY);
    const long = Math.max(gapX, gapY);
    if (short < bestShort || (short === bestShort && long < bestLong)) {
      best = free;
      bestShort = short;
      bestLong = long;
    }
  }
  if (!best) return false;
  const placed = { x: best.x, y: best.y, width: cell.width, height: cell.height };
  page.placements.push({ sprite, x: placed.x, y: placed.y });
  page.width = Math.max(page.width, placed.x + placed.width);
  page.height = Math.max(page.height, placed.y + placed.height);
  page.free = cutFreeRects(page.free, placed);
  return true;
}

/** Cut `placed` out of every free rectangle it overlaps, then drop rectangles contained in another. */
function cutFreeRects(free: Rect[], placed: Rect): Rect[] {
  const next: Rect[] = [];
  for (const rect of free) {
    const apart =
      placed.x >= rect.x + rect.width ||
      placed.x + placed.width <= rect.x ||
      placed.y >= rect.y + rect.height ||
      placed.y + placed.height <= rect.y;
    if (apart) {
      next.push(rect);
      continue;
    }
    const right = rect.x + rect.width;
    const bottom = rect.y + rect.height;
    if (placed.x > rect.x) next.push({ ...rect, width: placed.x - rect.x });
    if (placed.x + placed.width < right)
      next.push({ ...rect, x: placed.x + placed.width, width: right - placed.x - placed.width });
    if (placed.y > rect.y) next.push({ ...rect, height: placed.y - rect.y });
    if (placed.y + placed.height < bottom)
      next.push({ ...rect, y: placed.y + placed.height, height: bottom - placed.y - placed.height });
  }
  // of two identical rectangles the first survives
  return next.filter(
    (rect, i) => !next.some((other, j) => j !== i && contains(other, rect) && (j < i || !contains(rect, other)))
  );
}

const contains = (outer: Rect, inner: Rect) =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height;

/** Blit every sprite onto a transparent RGBA page, with `extrude` copies of its edge pixels around it. */
function composePage(page: Page, options: AtlasOptions): Buffer {
  const { extrude } = options;
  const pixels = Buffer.alloc(page.width * page.height * 4);
  for (const { sprite, x, y } of page.placements) {
    const rowBytes = sprite.width * 4;
    for (let row = -extrude; row < sprite.height + extrude; row++) {
      const from = Math.min(Math.max(row, 0), sprite.height - 1) * rowBytes;
      const to = ((y + extrude + row) * page.width + x + extrude) * 4;
      sprite.pixels.copy(pixels, to, from, from + rowBytes);
      for (let step = 1; step <= extrude; step++) {
        sprite.pixels.copy(pixels, to - step * 4, from, from + 4);
        sprite.pixels.copy(pixels, to + (sprite.width - 1 + step) * 4, from + rowBytes - 4, from + rowBytes);
      }
    }
  }
  return pixels;
}

// png pages stay lossless unless a quality is given; then they are quantized to a palette like the image action does
function encodePage(pixels: Buffer, page: Page, options: AtlasOptions): Promise<Buffer> {
  const pipeline = sharp(pixels, { raw: { width: page.width, height: page.height, channels: 4 } });
  const { quality } = options;
  switch (options.format) {
    case 'png':
      return quality === undefined
        ? pipeline.png({ compressionLevel: 9 }).toBuffer()
        : pipeline.png({ compressionLevel: 9, palette: true, quality, colors: 256, dither: 1, effort: 7 }).toBuffer();
    case 'jpeg':
      return pipeline
        .flatten({ background: '#000000' })
        .jpeg({ quality: quality ?? QUALITY_WHEN_UNSET.jpeg, mozjpeg: true })
        .toBuffer();
    case 'webp':
      return pipeline.webp({ quality: quality ?? QUALITY_WHEN_UNSET.webp }).toBuffer();
    case 'avif':
      return pipeline.avif({ quality: quality ?? QUALITY_WHEN_UNSET.avif }).toBuffer();
  }
}

/** The frames of a page in TexturePacker JSON hash form, sorted by name for stable output. */
function describeFrames(page: Page, extrude: number): Record<string, AtlasFrame> {
  const frames: Record<string, AtlasFrame> = {};
  for (const { sprite, x, y } of [...page.placements].sort((a, b) => byName(a.sprite, b.sprite))) {
    frames[sprite.name] = {
      frame: { x: x + extrude, y: y + extrude, w: sprite.width, h: sprite.height },
      rotated: false,
      trimmed: sprite.width !== sprite.sourceWidth || sprite.height !== sprite.sourceHeight,
      spriteSourceSize: { x: sprite.offsetX, y: sprite.offsetY, w: sprite.width, h: sprite.height },
      sourceSize: { w: sprite.sourceWidth, h: sprite.sourceHeight }
    };
  }
  return frames;
}
