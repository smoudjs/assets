// One Sharp pipeline per file, always in this order: trim → resize → flatten → encode.

import sharp, { type Metadata, type OutputInfo, type Sharp } from 'sharp';
import type { ActionType, AssetFile, AssetMeta, OptionTable, ProcessContext } from '../types.js';

type Format = 'png' | 'jpeg' | 'webp' | 'avif' | 'gif';
const FORMATS: Format[] = ['png', 'jpeg', 'webp', 'avif', 'gif'];
const EXTENSIONS: Record<Format, string> = { png: '.png', jpeg: '.jpg', webp: '.webp', avif: '.avif', gif: '.gif' };
const ANIMATED: Format[] = ['gif', 'webp'];

export interface ResizeOptions {
  width?: number;
  height?: number;
  scale?: number;
  fit?: 'cover' | 'contain' | 'fill' | 'inside' | 'outside';
  upscale?: boolean;
  kernel?: 'nearest' | 'cubic' | 'mitchell' | 'lanczos2' | 'lanczos3';
}

export interface ImageOptions extends Record<string, unknown> {
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
  jpeg: { progressive: boolean; mozjpeg: boolean; chromaSubsampling: '4:2:0' | '4:4:4' };
  webp: { alphaQuality: number; nearLossless: boolean; smartSubsample: boolean; effort: number };
  avif: { chromaSubsampling: '4:2:0' | '4:4:4'; effort: number };
  gif: { colors: number; dither: number; effort: number };
}

const formatValues = { kind: 'enum', values: FORMATS, description: 'Output format' } as const;

const options: OptionTable = {
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
    description: 'Quality for lossy encoders and png palette quantization',
    min: 1,
    max: 100,
    default: 85
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
      progressive: { kind: 'boolean', description: 'Progressive scan', default: false },
      mozjpeg: { kind: 'boolean', description: 'mozjpeg optimizations', default: true },
      chromaSubsampling: { kind: 'enum', description: 'Chroma subsampling', values: ['4:2:0', '4:4:4'], default: '4:2:0' }
    }
  },
  webp: {
    kind: 'object',
    description: 'WebP encoder',
    properties: {
      alphaQuality: { kind: 'number', description: 'Alpha channel quality', min: 0, max: 100, default: 100 },
      nearLossless: { kind: 'boolean', description: 'Near-lossless mode', default: false },
      smartSubsample: { kind: 'boolean', description: 'High-quality chroma subsampling', default: false },
      effort: { kind: 'number', description: 'CPU effort 0-6', min: 0, max: 6, default: 4 }
    }
  },
  avif: {
    kind: 'object',
    description: 'AVIF encoder',
    properties: {
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
      effort: { kind: 'number', description: 'CPU effort 1-10', min: 1, max: 10, default: 7 }
    }
  }
};

export const image: ActionType<ImageOptions> = {
  name: 'image',
  version: '1',
  accepts: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'tif', 'tiff', 'svg'],
  options,

  async probe(file) {
    return facts(await sharp(file.data).metadata());
  },

  async process(files, options, context) {
    const results: AssetFile[] = [];
    let next = 0;
    const worker = async () => {
      while (next < files.length) {
        const file = files[next++] as AssetFile;
        try {
          const output = await processOne(file, options, context);
          if (output) results.push(output);
        } catch (error) {
          context.fail(file, (error as Error).message);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(context.concurrency, files.length) }, worker));
    return results;
  }
};

async function processOne(file: AssetFile, options: ImageOptions, context: ProcessContext): Promise<AssetFile | null> {
  const meta = await sharp(file.data).metadata();
  const source = normalizeFormat(meta.format);
  const animated = options.animated && (meta.pages ?? 1) > 1;

  let candidates: Format[];
  if (options.format === undefined) {
    if (!source) {
      context.warn(`${file.path}: svg and other vector sources need a raster "format"; skipped`);
      return null;
    }
    candidates = [source];
  } else {
    candidates = Array.isArray(options.format) ? options.format : [options.format];
  }
  if (meta.hasAlpha && !options.flatten && candidates.length > 1)
    candidates = candidates.filter((format) => format !== 'jpeg');
  if (meta.hasAlpha && !options.flatten && candidates.length === 1 && candidates[0] === 'jpeg') {
    context.warn(`${file.path}: jpeg cannot hold alpha; flattened onto black (set "flatten" to choose the colour)`);
  }

  // Pure re-encode: same format, no pixel change. Only then can the original stand in for the result.
  const pureReencode =
    !resizes(options) && !options.trim && !options.flatten && source !== null && !(animated && !options.animated);

  let best: Candidate | undefined;
  for (const format of candidates) {
    const keepFrames = animated && ANIMATED.includes(format);
    let pipeline = sharp(file.data, { animated: keepFrames, density: options.density }).rotate();
    pipeline = applyTrim(pipeline, options);
    pipeline = applyResize(pipeline, options, meta);
    if (options.flatten || format === 'jpeg') pipeline = pipeline.flatten({ background: options.flatten ?? '#000000' });
    if (options.metadata) pipeline = pipeline.withMetadata();
    pipeline = encode(pipeline, format, options);

    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
    let candidate: Candidate = { format, data, info, kept: false };
    if (options.keepSmaller && pureReencode && format === source && file.data.length <= data.length) {
      candidate = { format, data: file.data, info: { ...info, size: file.data.length }, kept: true };
    }
    if (!best || candidate.data.length < best.data.length) best = candidate;
  }
  if (!best) return null;

  const path = best.format === source ? file.path : file.path.replace(/\.[^./]+$/, '') + EXTENSIONS[best.format];
  const outMeta: AssetMeta = {
    size: best.data.length,
    format: best.format,
    width: best.info.width,
    height: best.kept ? meta.height : (best.info.pageHeight ?? best.info.height),
    alpha: best.kept ? meta.hasAlpha : best.info.channels === 4,
    animated: best.kept ? animated : (best.info.pages ?? 1) > 1
  };
  return { ...file, path, data: best.data, meta: outMeta, keptOriginal: best.kept };
}

interface Candidate {
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

// The engine fills `resize` with its defaults even when the config never mentions it, so "no resize" means no dimension given.
function resizes(options: ImageOptions): boolean {
  const resize = options.resize;
  return resize !== undefined && (resize.width ?? resize.height ?? resize.scale) !== undefined;
}

function applyResize(pipeline: Sharp, options: ImageOptions, meta: Metadata): Sharp {
  if (!resizes(options)) return pipeline;
  const resize = options.resize as ResizeOptions;
  const common = { withoutEnlargement: !resize.upscale, kernel: resize.kernel };

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
        quality: options.quality,
        progressive: options.jpeg.progressive,
        mozjpeg: options.jpeg.mozjpeg,
        chromaSubsampling: options.jpeg.chromaSubsampling
      });
    case 'webp':
      return pipeline.webp({
        quality: options.quality,
        lossless: options.lossless,
        alphaQuality: options.webp.alphaQuality,
        nearLossless: options.webp.nearLossless,
        smartSubsample: options.webp.smartSubsample,
        effort: options.webp.effort
      });
    case 'avif':
      return pipeline.avif({
        quality: options.quality,
        lossless: options.lossless,
        chromaSubsampling: options.avif.chromaSubsampling,
        effort: options.avif.effort
      });
    case 'gif':
      return pipeline.gif({ colors: options.gif.colors, dither: options.gif.dither, effort: options.gif.effort });
  }
}

function normalizeFormat(format: string | undefined): Format | null {
  if (format === 'jpg') return 'jpeg';
  return FORMATS.includes(format as Format) ? (format as Format) : null;
}

function facts(meta: Metadata): Partial<AssetMeta> {
  return {
    format: normalizeFormat(meta.format) ?? meta.format,
    width: meta.width,
    height: meta.pageHeight ?? meta.height,
    alpha: meta.hasAlpha ?? false,
    animated: (meta.pages ?? 1) > 1
  };
}
