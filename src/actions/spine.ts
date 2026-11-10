// Optimizes Spine exports. The .atlas is the anchor: its page images and the skeleton with the same name come with it,
// so no other action converts a page and breaks the name written in the .atlas. Pages are re-encoded or scaled with
// the .atlas rewritten to match; the skeleton is trimmed and written as .json or .skel by optimizeSkeleton.

import { destinationPath } from '../files.js';
import type { ActionDefinition, AssetFile, OptionDescriptor, OptionTable } from '../types.js';
import { basename, dirname, extension, join } from '../utils/fs.js';
import { jsonToSkel } from '../utils/spine/4.2/json-to-skel.js';
import { skelToJson } from '../utils/spine/4.2/skel-to-json.js';
import { type NamePatterns, optimizeSkeleton, type SkeletonFormat } from '../utils/spine/optimize-skeleton.js';
import { image, type ImageOptions } from './image.js';
import { resolveOptions, transformFiles } from './index.js';

type PageFormat = 'png' | 'jpeg' | 'webp' | 'avif';
const EXTENSIONS: Record<string, string> = { png: 'png', jpeg: 'jpg', webp: 'webp', avif: 'avif' };
// pixel coordinates of a region: Spine 4 writes bounds and offsets, Spine 3 xy, size, orig and offset; split and pad
// are nine-patch borders
const COORDINATE_KEYS = ['bounds', 'offsets', 'xy', 'size', 'orig', 'offset', 'split', 'pad'];
// keys a page has right after its name; Spine 4.2 adds scale
const PAGE_KEYS = ['size', 'format', 'filter', 'repeat', 'pma', 'scale'];
const PAGE_KEY = new RegExp(`^(${PAGE_KEYS.join('|')})\\s*:`);
const NUMBER = /-?\d+(\.\d+)?/g;

export interface SpineOptions extends Record<string, unknown> {
  format?: PageFormat;
  quality?: number;
  webp: ImageOptions['webp'];
  scale: number;
  maxWidth?: number;
  maxHeight?: number;
  precision: number;
  animations: boolean | { include?: string[]; exclude?: string[] };
  skins?: NamePatterns;
  skeleton?: SkeletonFormat;
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
  /** A Spine 4.2 skeleton .json as a .skel. Throws on another version. */
  toSkel(json: Buffer): Buffer;
  /** A Spine 4.2 .skel as its skeleton .json, minified. Throws on another version. */
  toJson(skel: Buffer): Buffer;
}

const patterns = (what: string) =>
  ({
    kind: 'list',
    description: `${what} names or patterns`,
    items: { kind: 'string', description: 'A name or pattern' }
  }) as const;

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
  // the image action's own webp encoder settings, for webp pages
  webp: { ...(image.options.webp as OptionDescriptor), description: 'WebP encoder for webp pages, as in the image action' },
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
    kind: 'oneOf',
    description: 'Animations the skeleton keeps: true, false, or by name or pattern with include or exclude, not both',
    oneOf: [
      { kind: 'boolean', description: 'Keep all, or remove all' },
      {
        kind: 'object',
        description: 'Animations to keep or remove, by name or pattern',
        properties: { include: patterns('Animation'), exclude: patterns('Animation') }
      }
    ],
    default: true
  },
  skins: {
    kind: 'oneOf',
    description: 'Skins the skeleton keeps, by name or pattern; the default skin always stays. Omitted: all',
    oneOf: [
      patterns('Skin'),
      {
        kind: 'object',
        description: 'Skins to keep or remove, by name or pattern',
        properties: { include: patterns('Skin'), exclude: patterns('Skin') }
      }
    ]
  },
  skeleton: {
    kind: 'enum',
    values: ['json', 'skel'],
    description: 'Skeleton format: json or a binary skel, converted for Spine 4.2 only. Omitted: as the source'
  }
};

/** Optimize Spine exports: pages compressed, converted or scaled with the .atlas rewritten, skeleton .json trimmed. */
export const spine: SpineAction = {
  name: 'spine',
  // bump whenever a code change alters the output: cached results of older versions stop matching
  version: 4,
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
    const { animations } = options;
    if (typeof animations === 'object' && animations.include && animations.exclude) {
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

    // a .skel next to a .json is the same skeleton exported twice
    const skeleton = Object.entries(input.files).filter(([name]) => !pages.includes(name));
    const source = (ext: string) => {
      const found = skeleton.find(([name]) => extension(name) === ext);
      return found && { name: found[0], data: found[1] };
    };
    files.push(...optimizeSkeleton({ json: source('json'), skel: source('skel') }, options, warnings));
    return { atlas: Buffer.from(rewriteAtlas(text, pagesOut)), files, warnings };
  },

  toSkel(json) {
    return jsonToSkel(JSON.parse(json.toString('utf8')));
  },

  toJson(skel) {
    return Buffer.from(JSON.stringify(skelToJson(skel)));
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
    png: { palette: options.quality !== undefined, colors: 256, dither: 1, effort: 7 },
    webp: options.webp
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

/** A region of a page: the line each of its keys sits on. */
interface Region {
  page: PageOut;
  keys: Map<string, number>;
}

const KEY_LINE = /^(\s*)(\w+)(\s*:\s*)(.*)$/;

// page names and sizes follow the encoded pages; region coordinates scale with their page. Every other line stays as written.
// A page's own keys come right after its name; the first other line names a region, and the keys after it are the
// region's: indented in Spine 3, not in Spine 4, so indentation alone cannot tell a page's size from a region's
function rewriteAtlas(text: string, pages: Map<string, PageOut>) {
  const lines = text.split(/\r?\n/);
  const out = [...lines];
  const regions: Region[] = [];
  let page: PageOut | undefined;
  let region: Region | undefined;
  let inHeader = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const startsBlock = i === 0 || (lines[i - 1] as string).trim() === '';
    const next = startsBlock ? pages.get(line.trim()) : undefined;
    if (next) {
      page = next;
      region = undefined;
      inHeader = true;
      out[i] = next.name;
      continue;
    }
    const match = KEY_LINE.exec(line);
    const [, indent, key, separator, value] = (match ?? []) as unknown as [string, string, string, string, string];
    if (inHeader && !(match && !indent && PAGE_KEYS.includes(key))) inHeader = false;
    if (inHeader) {
      if (key === 'size' && page) {
        const size = [page.width, page.height];
        out[i] = `${key}${separator}${value.replace(NUMBER, () => String(size.shift()))}`;
      }
      continue;
    }
    if (!match) {
      // a blank line ends the page; any other line names a region
      region = line.trim() && page ? { page, keys: new Map() } : undefined;
      if (region) regions.push(region);
      continue;
    }
    region?.keys.set(key, i);
  }
  for (const each of regions) if (each.page.factor !== 1) scaleRegion(out, each);
  return out.join('\n');
}

// Coordinates scale with the page. A region's place on the page is rounded at its edges, not at its size, so neighbouring
// regions stay as far apart as on the bigger page: Spine 4 writes it as bounds, Spine 3 as xy and size. Its width and
// height are as unrotated, so a region rotated by 90 or 270 takes height by width on the page
function scaleRegion(lines: string[], { page, keys }: Region) {
  const { factor } = page;
  const read = (key: string) => {
    const at = keys.get(key);
    if (at === undefined) return undefined;
    return ((lines[at] as string).split(':').slice(1).join(':').match(NUMBER) ?? []).map(Number);
  };
  const write = (key: string, numbers: number[]) => {
    const at = keys.get(key) as number;
    const [, indent, name, separator, value] = KEY_LINE.exec(lines[at] as string) as unknown as string[];
    const queue = [...numbers];
    lines[at] = `${indent}${name}${separator}${(value as string).replace(NUMBER, () => String(queue.shift()))}`;
  };
  // Spine 3 writes rotate: true for 90 degrees, Spine 4 the degrees
  const rotateAt = keys.get('rotate');
  const rotate = rotateAt === undefined ? '' : (KEY_LINE.exec(lines[rotateAt] as string)?.[4] ?? '').trim();
  const turned = rotate === 'true' || rotate === '90' || rotate === '270';
  const place = ([x, y, width, height]: number[]) => {
    const [across, down] = turned ? [height as number, width as number] : [width as number, height as number];
    const left = Math.round((x as number) * factor);
    const top = Math.round((y as number) * factor);
    const right = Math.round(((x as number) + across) * factor);
    const bottom = Math.round(((y as number) + down) * factor);
    return turned ? [left, top, bottom - top, right - left] : [left, top, right - left, bottom - top];
  };

  const handled = new Set<string>();
  const bounds = read('bounds');
  if (bounds && bounds.length === 4) {
    write('bounds', place(bounds));
    handled.add('bounds');
  }
  const xy = read('xy');
  const size = read('size');
  if (xy?.length === 2 && size?.length === 2) {
    const [left, top, width, height] = place([...xy, ...size]);
    write('xy', [left as number, top as number]);
    write('size', [width as number, height as number]);
    handled.add('xy').add('size');
  }
  for (const key of keys.keys()) {
    if (handled.has(key) || !COORDINATE_KEYS.includes(key)) continue;
    write(key, (read(key) ?? []).map((n) => Math.round(n * factor)));
  }
}
