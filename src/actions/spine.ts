// Optimizes Spine exports. The .atlas is the anchor: its page images and the skeleton with the same name come with it,
// so no other action converts a page and breaks the name written in the .atlas. Pages are re-encoded or scaled with
// the .atlas rewritten to match; a skeleton .json gets its numbers rounded and can lose animations; a binary .skel is
// kept as it is, because its format changes between Spine versions.

import picomatch from 'picomatch';
import { destinationPath } from '../files.js';
import type { ActionDefinition, AssetFile, OptionTable } from '../types.js';
import { basename, dirname, extension, join } from '../utils/fs.js';
import { image, type ImageOptions } from './image.js';
import { resolveOptions, transformFiles } from './index.js';

type PageFormat = 'png' | 'jpeg' | 'webp' | 'avif';
const EXTENSIONS: Record<string, string> = { png: 'png', jpeg: 'jpg', webp: 'webp', avif: 'avif' };
// pixel coordinates of a region: Spine 4 writes bounds and offsets, Spine 3 xy, size, orig and offset; split and pad
// are nine-patch borders
const COORDINATE_KEYS = ['bounds', 'offsets', 'xy', 'size', 'orig', 'offset', 'split', 'pad'];
const PAGE_KEY = /^(size|format|filter|repeat|pma)\s*:/;
const NUMBER = /-?\d+(\.\d+)?/g;

export interface SpineOptions extends Record<string, unknown> {
  format?: PageFormat;
  quality?: number;
  scale: number;
  maxWidth?: number;
  maxHeight?: number;
  precision: number;
  animations: { include?: string[]; exclude?: string[] };
}

/** A Spine export going into `optimizeSpine`. */
export interface SpineInput {
  /** The .atlas text. */
  atlas: Buffer;
  /** Its page images and skeleton by name, like `{ "hero.png": buffer, "hero.json": buffer }`. */
  files: Record<string, Buffer>;
  /** The name the .atlas refers to a page by, from its plain name and bytes. Default: the plain name. */
  fileName?: (plainName: string, data: Buffer) => string;
}

/** A page or the skeleton, returned with the .atlas. */
export interface SpineFile {
  /** Plain name, like `hero.webp` or `hero.json`. */
  name: string;
  data: Buffer;
}

/** What `optimizeSpine` returns: the .atlas, the pages and skeleton by name, and what to know about them. */
export interface OptimizedSpine {
  atlas: Buffer;
  files: SpineFile[];
  warnings: string[];
}

export interface SpineAction extends ActionDefinition<SpineOptions> {
  /** Optimize one Spine export. Throws when a page the .atlas names is not among `files`. */
  optimizeSpine(input: SpineInput, options?: Partial<SpineOptions>): Promise<OptimizedSpine>;
}

const patterns = {
  kind: 'list',
  description: 'Animation names or patterns',
  items: { kind: 'string', description: 'A name or pattern' }
} as const;

const options: OptionTable = {
  format: {
    kind: 'enum',
    values: ['png', 'jpeg', 'webp', 'avif'],
    description: 'Page format; page names in the .atlas follow. Omitted: as the source'
  },
  quality: {
    kind: 'number',
    description: 'Page quality, as in the image action. For png pages, setting it switches from lossless to a palette',
    min: 1,
    max: 100
  },
  scale: {
    kind: 'number',
    description: 'Shrink the pages; every coordinate in the .atlas scales with them',
    min: 0.01,
    max: 1,
    default: 1
  },
  maxWidth: { kind: 'number', description: 'Shrink pages wider than this; their coordinates follow', min: 1 },
  maxHeight: { kind: 'number', description: 'Shrink pages taller than this; their coordinates follow', min: 1 },
  precision: { kind: 'number', description: 'Decimals kept for numbers in a skeleton .json', min: 0, max: 6, default: 3 },
  animations: {
    kind: 'object',
    description: 'Animations a skeleton .json keeps, by name or pattern: include or exclude, not both',
    properties: { include: patterns, exclude: patterns }
  }
};

/** Optimize Spine exports: pages compressed, converted or scaled with the .atlas rewritten, skeleton .json trimmed. */
export const spine: SpineAction = {
  name: 'spine',
  // bump whenever a code change alters the output: cached results of older versions stop matching
  version: 1,
  cache: true,
  accepts: ['atlas'],
  options,

  findCompanions(file) {
    const pages = pageNames(file.data.toString('utf8'));
    if (!pages.length) return [];
    const name = basename(file.path).replace(/\.atlas$/, '');
    return [...pages, `${name}.json`, `${name}.skel`];
  },

  async optimizeSpine(input, given = {}) {
    const options = resolveOptions<SpineOptions>(spine.options, given);
    if (options.animations.include && options.animations.exclude) {
      throw new Error('animations takes include or exclude, not both');
    }
    const text = input.atlas.toString('utf8');
    const pages = pageNames(text);
    if (!pages.length) throw new Error('not a Spine atlas: no page found');

    const warnings: string[] = [];
    const files: SpineFile[] = [];
    const pagesOut = new Map<string, PageOut>();
    for (const page of pages) {
      const data = input.files[page];
      if (!data) throw new Error(`${page} is missing; it has to sit next to the .atlas`);
      const encoded = await encodePage(page, data, options, warnings);
      const ext = EXTENSIONS[encoded.format] ?? encoded.format;
      const keepsName = extension(page) === ext || (ext === 'jpg' && extension(page) === 'jpeg');
      const name = keepsName ? page : `${page.replace(/\.[^./]*$/, '')}.${ext}`;
      files.push({ name, data: encoded.data });
      const referred = input.fileName ? input.fileName(name, encoded.data) : name;
      pagesOut.set(page, { name: referred, width: encoded.width, height: encoded.height, factor: encoded.factor });
    }

    // a .skel next to a .json is the same skeleton exported twice; only a .skel alone is worth a warning
    const hasJson = Object.keys(input.files).some((name) => extension(name) === 'json');
    for (const [name, data] of Object.entries(input.files)) {
      if (pages.includes(name)) continue;
      if (extension(name) === 'json') {
        files.push({ name, data: trimSkeleton(name, data, options, warnings) });
        continue;
      }
      if (!hasJson && (options.animations.include || options.animations.exclude)) {
        warnings.push(`${name}: animations work on a skeleton .json only; a binary .skel is kept as it is`);
      }
      files.push({ name, data });
    }
    return { atlas: Buffer.from(rewriteAtlas(text, pagesOut)), files, warnings };
  },

  async transform(files, options, { filenameTemplate }) {
    const warnings: string[] = [];
    // transformFiles keeps one output per input, so the pages and skeleton of each .atlas wait here and follow it
    const nextToAtlas = new Map<AssetFile, AssetFile[]>();
    const { outputs, errors } = await transformFiles(files, async (file) => {
      const where = file.origin ?? file.path;
      if (!pageNames(file.data.toString('utf8')).length) {
        warnings.push(`${where}: not a Spine atlas; kept as it is`);
        return file;
      }
      const optimized = await spine.optimizeSpine(
        {
          atlas: file.data,
          files: Object.fromEntries((file.companions ?? []).map((companion) => [companion.path, companion.data])),
          // the .atlas refers to each page by the name the filename template gives it, as an atlas JSON does
          fileName: (plainName, data) => destinationPath({ path: plainName, data, meta: { size: 0 } }, filenameTemplate)
        },
        options
      );
      for (const warning of optimized.warnings) warnings.push(`${where}: ${warning}`);
      const atlasFile: AssetFile = { ...file, companions: undefined, data: optimized.atlas };
      nextToAtlas.set(
        atlasFile,
        optimized.files.map((extra) => ({
          ...file,
          companions: undefined,
          path: join(dirname(file.path), extra.name),
          data: extra.data,
          meta: { size: 0 }
        }))
      );
      return atlasFile;
    });
    return { outputs: outputs.flatMap((atlas) => [atlas, ...(nextToAtlas.get(atlas) ?? [])]), warnings, errors };
  }
};

// a page starts a block, at the top of the file or after an empty line, and page keys like size: follow its name;
// a region name is followed by indented keys instead
function pageNames(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const names: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const startsBlock = i === 0 || (lines[i - 1] as string).trim() === '';
    const name = (lines[i] as string).trim();
    if (startsBlock && name && PAGE_KEY.test(lines[i + 1] ?? '')) names.push(name);
  }
  return names;
}

/** A page as the rewritten .atlas names it: its new name and size, and the factor its coordinates scale by. */
interface PageOut {
  name: string;
  width: number;
  height: number;
  factor: number;
}

// png pages stay lossless unless a quality is given, as atlas pages do; jpeg cannot hold the transparency pages need.
// Each page shrinks by its own factor: scale, or less when it is bigger than maxWidth or maxHeight
async function encodePage(page: string, data: Buffer, options: SpineOptions, warnings: string[]) {
  const meta = await image.readImageMeta(data, options.format === 'jpeg' ? ['alpha'] : 'cheap');
  const imageOptions: Partial<ImageOptions> = {
    png: { palette: options.quality !== undefined, colors: 256, dither: 1, effort: 7 }
  };
  if (options.format === 'jpeg' && meta.alpha) {
    warnings.push(`${page}: has transparency, which jpeg cannot hold; kept as ${extension(page)}`);
  } else if (options.format) {
    imageOptions.format = options.format;
  }
  if (options.quality !== undefined) imageOptions.quality = options.quality;
  let factor = options.scale;
  if (options.maxWidth !== undefined) factor = Math.min(factor, options.maxWidth / (meta.width as number));
  if (options.maxHeight !== undefined) factor = Math.min(factor, options.maxHeight / (meta.height as number));
  if (factor < 1) imageOptions.resize = { scale: factor };
  const encoded = await image.optimizeImage(data, imageOptions);
  if (!encoded) throw new Error(`${page}: not a raster image`);
  return { ...encoded, factor: Math.min(factor, 1) };
}

// page names and sizes follow the encoded pages; region coordinates scale with their page. Every other line stays as written
function rewriteAtlas(text: string, pages: Map<string, PageOut>) {
  const lines = text.split(/\r?\n/);
  let page: PageOut | undefined;
  return lines
    .map((line, i) => {
      const startsBlock = i === 0 || (lines[i - 1] as string).trim() === '';
      const next = startsBlock ? pages.get(line.trim()) : undefined;
      if (next) {
        page = next;
        return next.name;
      }
      const match = /^(\s*)(\w+)(\s*:\s*)(.*)$/.exec(line);
      if (!match) return line;
      const [, indent, key, separator, value] = match as unknown as [string, string, string, string, string];
      if (!indent && key === 'size' && page) {
        const size = [page.width, page.height];
        return `${key}${separator}${value.replace(NUMBER, () => String(size.shift()))}`;
      }
      if (indent && page && page.factor !== 1 && COORDINATE_KEYS.includes(key)) {
        const factor = page.factor;
        return `${indent}${key}${separator}${value.replace(NUMBER, (n) => String(Math.round(Number(n) * factor)))}`;
      }
      return line;
    })
    .join('\n');
}

// a .json with the atlas's name that is not a Spine skeleton stays as it is
function trimSkeleton(name: string, data: Buffer, options: SpineOptions, warnings: string[]): Buffer {
  let json: { skeleton?: { spine?: string }; animations?: Record<string, unknown> };
  try {
    json = JSON.parse(data.toString('utf8'));
  } catch {
    return data;
  }
  if (!json?.skeleton?.spine) return data;

  const { include, exclude } = options.animations;
  const wanted = include ?? exclude;
  if (wanted) {
    const animations = json.animations ?? {};
    const names = Object.keys(animations);
    for (const pattern of wanted) {
      if (!names.some((animation) => picomatch.isMatch(animation, pattern))) {
        warnings.push(`${name}: animation pattern "${pattern}" matches nothing`);
      }
    }
    for (const animation of names) {
      if (picomatch.isMatch(animation, wanted) === Boolean(exclude)) delete animations[animation];
    }
    if (include && !Object.keys(animations).length) throw new Error(`${name}: animations.include keeps no animation`);
  }
  const factor = 10 ** options.precision;
  return Buffer.from(
    JSON.stringify(json, (_key, value: unknown) => (typeof value === 'number' ? Math.round(value * factor) / factor : value))
  );
}
