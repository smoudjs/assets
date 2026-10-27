// One Sharp pipeline per file, always in this order: trim → resize → flatten → encode.

import sharp, { type Metadata, type OutputInfo, type Sharp } from 'sharp';
import type { ActionDefinition, AssetMeta, OptionTable } from '../types.js';
import { resolveOptions, transformFiles } from './index.js';
import { extension } from '../utils/fs.js';

type Format = 'png' | 'jpeg' | 'webp' | 'avif' | 'gif';
const FORMATS: Format[] = ['png', 'jpeg', 'webp', 'avif', 'gif'];
const EXTENSIONS: Record<Format, string> = { png: '.png', jpeg: '.jpg', webp: '.webp', avif: '.avif', gif: '.gif' };
const ANIMATED_FORMATS: Format[] = ['gif', 'webp'];

export interface ResizeOptions {
  width?: number;
  height?: number;
  scale?: number;
  fit?: 'cover' | 'contain' | 'fill' | 'inside' | 'outside';
  upscale?: boolean;
  kernel?: 'nearest' | 'cubic' | 'mitchell' | 'lanczos2' | 'lanczos3';
  position?: (typeof POSITIONS)[number];
}

/** Which part of the image `cover` and `contain` keep: a side or corner, or a strategy that looks at the content. */
const POSITIONS = [
  'center',
  'top',
  'right',
  'bottom',
  'left',
  'right top',
  'right bottom',
  'left bottom',
  'left top',
  'entropy',
  'attention'
] as const;

export interface ImageOptions extends Record<string, unknown> {
  maxWidth?: number;
  maxHeight?: number;
  resize?: ResizeOptions;
  trim?: boolean | { threshold?: number };
  flatten?: string;
  format?: Format | Format[];
  quality: number;
  lossless: boolean;
  keepSmaller: boolean;
  metadata: boolean;
  animated: boolean;
  density: number;
  png: { palette: boolean; colors: number; dither: number; effort: number };
  jpeg: { quality?: number; progressive: boolean; mozjpeg: boolean; chromaSubsampling: '4:2:0' | '4:4:4' };
  webp: {
    quality?: number;
    preset: 'default' | 'photo' | 'picture' | 'drawing' | 'icon' | 'text';
    alphaQuality: number;
    nearLossless: boolean;
    smartSubsample: boolean;
    effort: number;
  };
  avif: { quality: number; chromaSubsampling: '4:2:0' | '4:4:4'; effort: number };
  gif: { colors: number; dither: number; effort: number; interFrameMaxError: number };
}

/** What `optimizeImage` returns: the encoded bytes and what they are. */
export interface OptimizedImage {
  data: Buffer;
  format: Format;
  width: number;
  height: number;
  alpha: boolean;
  animated: boolean;
  /** The original bytes were kept because re-encoding would have grown the file. */
  keptOriginal: boolean;
  warnings: string[];
}

export interface ImageAction extends ActionDefinition<ImageOptions> {
  /**
   * Format, width, height, alpha and animated of an image, from its bytes or its path. All come from the header except
   * `alpha` of an image with an alpha channel, which decodes every pixel; `'cheap'`, or a list without `alpha`, skips
   * that. Default: all. Facts in `known` are not read again. Also the probe for `when`.
   */
  readImageMeta(input: Buffer | string, needs?: 'cheap' | string[], known?: Partial<AssetMeta>): Promise<Partial<AssetMeta>>;
  /**
   * Trim, resize, flatten and encode one image. Returns null when the source format cannot be kept (svg and
   * other vector sources) and no raster `format` was asked for.
   */
  optimizeImage(data: Buffer, options?: Partial<ImageOptions>): Promise<OptimizedImage | null>;
}

const formatValues = { kind: 'enum', values: FORMATS, description: 'Output format' } as const;

const options: OptionTable = {
  maxWidth: {
    kind: 'number',
    description: 'Shrink images wider than this, keeping the aspect ratio; narrower images are untouched. Runs first',
    min: 1
  },
  maxHeight: {
    kind: 'number',
    description: 'Shrink images taller than this, keeping the aspect ratio; shorter images are untouched. Runs first',
    min: 1
  },
  resize: {
    kind: 'object',
    description: 'Resize to width / height (with fit, upscale and kernel), or by scale',
    properties: {
      width: { kind: 'number', description: 'Target width in px', min: 1 },
      height: { kind: 'number', description: 'Target height in px', min: 1 },
      scale: { kind: 'number', description: 'Multiply both dimensions, e.g. 0.5', min: 0.01 },
      fit: {
        kind: 'enum',
        description: 'How to fit width and height',
        values: ['cover', 'contain', 'fill', 'inside', 'outside']
      },
      upscale: { kind: 'boolean', description: 'Allow enlarging', default: false },
      kernel: {
        kind: 'enum',
        description: 'Resampling kernel',
        values: ['nearest', 'cubic', 'mitchell', 'lanczos2', 'lanczos3']
      },
      position: {
        kind: 'enum',
        description: 'Part of the image cover and contain keep: a side, a corner, "entropy" or "attention"',
        values: POSITIONS,
        default: 'center'
      }
    }
  },
  trim: {
    kind: 'oneOf',
    description: 'Remove transparent or same-colour borders',
    oneOf: [
      { kind: 'boolean', description: 'Trim with the default threshold' },
      {
        kind: 'object',
        description: 'Trim settings',
        properties: { threshold: { kind: 'number', description: 'Colour distance tolerance', min: 0 } }
      }
    ]
  },
  flatten: { kind: 'string', description: 'Background colour used when alpha must go, e.g. "#000000"' },
  format: {
    kind: 'oneOf',
    description: 'Output format, or a list to try; the smallest wins. Omitted: keep the source format',
    oneOf: [formatValues, { kind: 'list', description: 'Candidates', items: formatValues }]
  },
  quality: {
    kind: 'number',
    description: "Quality for png palettes, jpeg and webp; a format's own quality wins. avif uses its own",
    min: 1,
    max: 100,
    default: 80
  },
  lossless: { kind: 'boolean', description: 'Lossless encoding where the format supports it', default: false },
  keepSmaller: { kind: 'boolean', description: 'Emit the original when a pure re-encode would grow it', default: true },
  metadata: { kind: 'boolean', description: 'Keep EXIF / ICC metadata (orientation is always applied)', default: false },
  animated: { kind: 'boolean', description: 'Keep gif / webp animation; false takes the first frame', default: true },
  density: { kind: 'number', description: 'DPI used to rasterize svg sources', min: 1, default: 72 },
  png: {
    kind: 'object',
    description: 'PNG encoder',
    properties: {
      palette: { kind: 'boolean', description: 'Quantize to a palette (like pngquant)', default: true },
      colors: { kind: 'number', description: 'Palette size', min: 2, max: 256, default: 256 },
      dither: { kind: 'number', description: 'Dithering level', min: 0, max: 1, default: 1 },
      effort: { kind: 'number', description: 'CPU effort 1-10', min: 1, max: 10, default: 7 }
    }
  },
  jpeg: {
    kind: 'object',
    description: 'JPEG encoder',
    properties: {
      quality: { kind: 'number', description: 'JPEG quality, wins over the top-level quality', min: 1, max: 100 },
      progressive: { kind: 'boolean', description: 'Progressive scan', default: false },
      mozjpeg: { kind: 'boolean', description: 'mozjpeg optimizations', default: true },
      chromaSubsampling: { kind: 'enum', description: 'Chroma subsampling', values: ['4:2:0', '4:4:4'], default: '4:2:0' }
    }
  },
  webp: {
    kind: 'object',
    description: 'WebP encoder',
    properties: {
      quality: { kind: 'number', description: 'WebP quality, wins over the top-level quality', min: 1, max: 100 },
      preset: {
        kind: 'enum',
        description: 'Tune the encoder for the content',
        values: ['default', 'photo', 'picture', 'drawing', 'icon', 'text'],
        default: 'default'
      },
      alphaQuality: { kind: 'number', description: 'Alpha channel quality', min: 0, max: 100, default: 100 },
      nearLossless: { kind: 'boolean', description: 'Near-lossless mode', default: false },
      smartSubsample: { kind: 'boolean', description: 'High-quality chroma subsampling', default: false },
      effort: { kind: 'number', description: 'CPU effort 0-6', min: 0, max: 6, default: 6 }
    }
  },
  avif: {
    kind: 'object',
    description: 'AVIF encoder',
    properties: {
      quality: {
        kind: 'number',
        description: 'AVIF quality; the top-level quality does not apply to avif',
        min: 1,
        max: 100,
        default: 50
      },
      chromaSubsampling: { kind: 'enum', description: 'Chroma subsampling', values: ['4:2:0', '4:4:4'], default: '4:4:4' },
      effort: { kind: 'number', description: 'CPU effort 0-9', min: 0, max: 9, default: 4 }
    }
  },
  gif: {
    kind: 'object',
    description: 'GIF encoder',
    properties: {
      colors: { kind: 'number', description: 'Palette size', min: 2, max: 256, default: 256 },
      dither: { kind: 'number', description: 'Dithering level', min: 0, max: 1, default: 1 },
      effort: { kind: 'number', description: 'CPU effort 1-10', min: 1, max: 10, default: 7 },
      interFrameMaxError: {
        kind: 'number',
        description: 'Colour error allowed to reuse pixels of the previous frame; higher makes animations smaller',
        min: 0,
        max: 32,
        default: 0
      }
    }
  }
};

/** Resize, trim, convert and compress images with Sharp. */
export const image: ImageAction = {
  name: 'image',
  // bump whenever a code change alters the output: cached results of older versions stop matching
  version: 1,
  cache: true,
  accepts: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'tif', 'tiff', 'svg'],
  options,

  async readImageMeta(input, needs, known = {}) {
    const result: Partial<AssetMeta> = {};
    if (known.width === undefined) {
      const meta = await sharp(input).metadata();
      result.format = normalizeFormat(meta.format) ?? meta.format;
      result.width = meta.width;
      result.height = meta.pageHeight ?? meta.height;
      result.animated = (meta.pages ?? 1) > 1;
      // no alpha channel: no transparency. Many tools give every png a channel, so only the pixels can tell then
      if (!meta.hasAlpha) result.alpha = false;
    }
    const wantsAlpha = needs === undefined || (needs !== 'cheap' && needs.includes('alpha'));
    if (wantsAlpha && result.alpha === undefined && known.alpha === undefined) {
      result.alpha = !(await sharp(input).stats()).isOpaque;
    }
    return result;
  },

  probe(input, needs, known) {
    return image.readImageMeta(input, needs, known);
  },

  async optimizeImage(data, input = {}) {
    const options = resolveOptions<ImageOptions>(image.options, input);
    const warnings: string[] = [];
    const original = await sharp(data).metadata();
    const source = normalizeFormat(original.format);
    const animated = options.animated && (original.pages ?? 1) > 1;

    // maxWidth / maxHeight shrink first, into a lossless intermediate the rest of the pipeline reads
    const limited = exceedsLimit(original, options);
    const pixels = limited ? await shrinkToLimit(data, options, animated) : data;
    const meta = limited ? await sharp(pixels).metadata() : original;

    let candidates: Format[];
    if (options.format === undefined) {
      if (!source) return null;
      candidates = [source];
    } else {
      candidates = Array.isArray(options.format) ? options.format : [options.format];
    }
    const transparent = await isTransparent(pixels, meta);
    if (transparent && !options.flatten && candidates.length > 1)
      candidates = candidates.filter((format) => format !== 'jpeg');
    if (transparent && !options.flatten && candidates.length === 1 && candidates[0] === 'jpeg') {
      warnings.push('jpeg cannot hold alpha; flattened onto black (set "flatten" to choose the colour)');
    }

    // Pure re-encode: same format, no pixel change. Only then can the original stand in for the result.
    const pureReencode =
      !limited &&
      !hasResize(options) &&
      !options.trim &&
      !options.flatten &&
      source !== null &&
      !(animated && !options.animated);

    let best: EncodedCandidate | undefined;
    for (const format of candidates) {
      const keepFrames = animated && ANIMATED_FORMATS.includes(format);
      let pipeline = sharp(pixels, { animated: keepFrames, density: options.density }).rotate();
      pipeline = applyTrim(pipeline, options);
      pipeline = applyResize(pipeline, options, meta);
      if (options.flatten || format === 'jpeg') pipeline = pipeline.flatten({ background: options.flatten ?? '#000000' });
      if (options.metadata) pipeline = pipeline.withMetadata();
      pipeline = encode(pipeline, format, options);

      const encoded = await pipeline.toBuffer({ resolveWithObject: true });
      let candidate: EncodedCandidate = { format, data: encoded.data, info: encoded.info, kept: false };
      if (options.keepSmaller && pureReencode && format === source && data.length <= encoded.data.length) {
        candidate = { format, data, info: { ...encoded.info, size: data.length }, kept: true };
      }
      if (!best || candidate.data.length < best.data.length) best = candidate;
    }
    if (!best) return null;

    return {
      data: best.data,
      format: best.format,
      width: best.info.width,
      height: best.kept ? (meta.height as number) : (best.info.pageHeight ?? best.info.height),
      alpha: transparent && !options.flatten && best.format !== 'jpeg',
      animated: best.kept ? animated : (best.info.pages ?? 1) > 1,
      keptOriginal: best.kept,
      warnings
    };
  },

  async transform(files, options) {
    const warnings: string[] = [];
    const { outputs, errors } = await transformFiles(files, async (file) => {
      const name = file.origin ?? file.path;
      const optimized = await image.optimizeImage(file.data, options);
      if (!optimized) {
        warnings.push(`${name}: svg and other vector sources need a raster "format"; skipped`);
        return null;
      }
      for (const warning of optimized.warnings) warnings.push(`${name}: ${warning}`);
      const { data, format, width, height, alpha, animated, keptOriginal } = optimized;
      const path =
        format === formatOfExtension(file.path) ? file.path : file.path.replace(/\.[^./]+$/, '') + EXTENSIONS[format];
      return { ...file, path, data, meta: { ...file.meta, format, width, height, alpha, animated }, keptOriginal };
    });
    return { outputs, warnings, errors };
  }
};

/** One format tried for an image: the encoded bytes, or the original when it was smaller. */
interface EncodedCandidate {
  format: Format;
  data: Buffer;
  info: OutputInfo;
  kept: boolean;
}

function applyTrim(pipeline: Sharp, options: ImageOptions): Sharp {
  if (!options.trim) return pipeline;
  return typeof options.trim === 'object' && options.trim.threshold !== undefined
    ? pipeline.trim({ threshold: options.trim.threshold })
    : pipeline.trim();
}

/** Whether the image, as it will be rasterized, is wider than `maxWidth` or taller than `maxHeight`. */
function exceedsLimit(meta: Metadata, options: ImageOptions): boolean {
  if (options.maxWidth === undefined && options.maxHeight === undefined) return false;
  // svg is rasterized at `density`, 72 being its own size; EXIF orientations 5 to 8 swap width and height
  const scale = meta.format === 'svg' ? options.density / 72 : 1;
  const [width, height] = [(meta.width ?? 0) * scale, (meta.pageHeight ?? meta.height ?? 0) * scale];
  const [shownWidth, shownHeight] = (meta.orientation ?? 1) >= 5 ? [height, width] : [width, height];
  return shownWidth > (options.maxWidth ?? Infinity) || shownHeight > (options.maxHeight ?? Infinity);
}

// lossless webp keeps alpha and animation, so nothing is lost before the real encode
function shrinkToLimit(data: Buffer, options: ImageOptions, animated: boolean): Promise<Buffer> {
  return sharp(data, { animated, density: options.density })
    .rotate()
    .resize({ width: options.maxWidth, height: options.maxHeight, fit: 'inside', withoutEnlargement: true })
    .webp({ lossless: true })
    .toBuffer();
}

// `resize` is filled with its defaults even when never mentioned, so "no resize" means no dimension given.
function hasResize(options: ImageOptions): boolean {
  const resize = options.resize;
  return resize !== undefined && (resize.width ?? resize.height ?? resize.scale) !== undefined;
}

function applyResize(pipeline: Sharp, options: ImageOptions, meta: Metadata): Sharp {
  if (!hasResize(options)) return pipeline;
  const resize = options.resize as ResizeOptions;
  const common = { withoutEnlargement: !resize.upscale, kernel: resize.kernel, position: resize.position };

  if (resize.scale !== undefined && meta.width && meta.height) {
    const height = meta.pageHeight ?? meta.height;
    return pipeline.resize(
      Math.max(1, Math.round(meta.width * resize.scale)),
      Math.max(1, Math.round(height * resize.scale)),
      {
        fit: 'fill',
        kernel: resize.kernel,
        withoutEnlargement: resize.upscale === undefined ? resize.scale <= 1 : !resize.upscale
      }
    );
  }
  return pipeline.resize(resize.width, resize.height, {
    fit: resize.fit ?? (resize.width && resize.height ? 'cover' : 'inside'),
    ...common
  });
}

function encode(pipeline: Sharp, format: Format, options: ImageOptions): Sharp {
  switch (format) {
    case 'png':
      return pipeline.png({
        palette: options.png.palette && !options.lossless,
        quality: options.quality,
        colors: options.png.colors,
        dither: options.png.dither,
        effort: options.png.effort,
        compressionLevel: 9
      });
    case 'jpeg':
      return pipeline.jpeg({
        quality: options.jpeg.quality ?? options.quality,
        progressive: options.jpeg.progressive,
        mozjpeg: options.jpeg.mozjpeg,
        chromaSubsampling: options.jpeg.chromaSubsampling
      });
    case 'webp':
      return pipeline.webp({
        quality: options.webp.quality ?? options.quality,
        preset: options.webp.preset,
        lossless: options.lossless,
        alphaQuality: options.webp.alphaQuality,
        nearLossless: options.webp.nearLossless,
        smartSubsample: options.webp.smartSubsample,
        effort: options.webp.effort
      });
    case 'avif':
      return pipeline.avif({
        quality: options.avif.quality ?? options.quality,
        lossless: options.lossless,
        chromaSubsampling: options.avif.chromaSubsampling,
        effort: options.avif.effort
      });
    case 'gif':
      return pipeline.gif({
        colors: options.gif.colors,
        dither: options.gif.dither,
        effort: options.gif.effort,
        interFrameMaxError: options.gif.interFrameMaxError
      });
  }
}

function normalizeFormat(format: string | undefined): Format | null {
  if (format === 'jpg') return 'jpeg';
  return FORMATS.includes(format as Format) ? (format as Format) : null;
}

/** The format a file name claims, so a kept format keeps its own extension (`.jpg` stays `.jpg`). */
function formatOfExtension(filePath: string): Format | null {
  return normalizeFormat(extension(filePath));
}

// many tools save every png with an alpha channel; only a pixel that is not fully opaque counts as transparency
async function isTransparent(data: Buffer, meta: Metadata): Promise<boolean> {
  if (!meta.hasAlpha) return false;
  return !(await sharp(data).stats()).isOpaque;
}
