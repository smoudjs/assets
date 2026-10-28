// One ffmpeg run per file, through a temporary folder: mp4 can only be read and written where ffmpeg can seek.
// mp4 is H.264 with AAC sound and webm is VP9 with Opus, the pairs every browser plays. webp and gif are animated
// images without sound, for short loops.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { findFfmpeg, runFfmpeg } from '@smoud/ffmpeg';
import sharp from 'sharp';
import type { ActionDefinition, AssetMeta, OptionTable } from '../types.js';
import { resolveOptions, transformFiles } from './index.js';
import { extension, withTemporaryFolder } from '../utils/fs.js';

type Format = 'mp4' | 'webm' | 'webp' | 'gif';
const ENCODERS: Record<Format, string> = { mp4: 'libx264', webm: 'libvpx-vp9', webp: 'libwebp_anim', gif: 'gif' };

export interface VideoOptions extends Record<string, unknown> {
  format?: Format;
  quality: number;
  maxWidth?: number;
  maxHeight?: number;
  fps?: number;
  audio: boolean;
  gif: { colors: number; dither: boolean };
  keepSmaller: boolean;
}

/** What `encodeVideo` returns: the encoded bytes and what they are. */
export interface EncodedVideo {
  data: Buffer;
  format: Format;
  width: number;
  height: number;
  /** Seconds. */
  duration: number;
  fps: number;
  /** Has a sound track. */
  audio: boolean;
  /** Has transparency. */
  alpha: boolean;
  /** The original bytes were kept because encoding would not have made them smaller. */
  keptOriginal: boolean;
  warnings: string[];
}

export interface VideoAction extends ActionDefinition<VideoOptions> {
  /**
   * Width, height, duration (seconds), fps, and whether it has sound and transparency, from its bytes or its path.
   * Also the probe for `when`.
   */
  readVideoMeta(input: Buffer | string): Promise<Partial<AssetMeta>>;
  /** Encode one video, shrunk as asked. Size and frame rate never go above the source's. */
  encodeVideo(data: Buffer, options?: Partial<VideoOptions>): Promise<EncodedVideo>;
}

const options: OptionTable = {
  format: {
    kind: 'enum',
    values: ['mp4', 'webm', 'webp', 'gif'],
    description:
      'mp4 (H.264), webm (VP9), or an animated webp or gif without sound. Omitted: VP8 and VP9 become webm, the rest mp4'
  },
  quality: {
    kind: 'number',
    description: "Picture quality for mp4, webm and webp; 80 is the video encoders' own default",
    min: 1,
    max: 100,
    default: 80
  },
  maxWidth: { kind: 'number', description: 'Shrink videos wider than this, keeping the aspect ratio', min: 2 },
  maxHeight: { kind: 'number', description: 'Shrink videos taller than this, keeping the aspect ratio', min: 2 },
  fps: { kind: 'number', description: "Frames per second; never above the source's", min: 1, max: 120 },
  audio: { kind: 'boolean', description: 'Keep the sound track of mp4 and webm; false removes it', default: true },
  gif: {
    kind: 'object',
    description: 'gif settings',
    properties: {
      colors: {
        kind: 'number',
        description: 'Colours in the palette, made from the clip itself',
        min: 2,
        max: 256,
        default: 256
      },
      dither: { kind: 'boolean', description: 'Dither to hide banding; false gives smaller files', default: true }
    }
  },
  keepSmaller: {
    kind: 'boolean',
    description: 'Emit the original when re-encoding would not make it smaller and nothing was asked to shrink',
    default: true
  }
};

/** Shrink, convert and compress videos with ffmpeg. */
export const video: VideoAction = {
  name: 'video',
  // bump whenever a code change alters the output: cached results of older versions stop matching
  version: 1,
  cache: true,
  accepts: ['mp4', 'webm', 'mov', 'm4v', 'mkv', 'avi', 'ogv'],
  options,

  async readVideoMeta(input) {
    // a file on disk is read where it is; bytes in memory go through a temporary file
    const source =
      typeof input === 'string'
        ? await readFileInfo(input)
        : await withTemporaryFolder(async (folder) => {
            const file = path.join(folder, 'input');
            await fs.writeFile(file, input);
            return readFileInfo(file);
          });
    const { width, height, duration, fps, audio, alpha } = source;
    return { width, height, duration, fps, audio, alpha };
  },

  // every fact comes from one quick ffmpeg read, so `'cheap'` already gets them all
  probe(input) {
    return video.readVideoMeta(input);
  },

  async encodeVideo(data, input = {}) {
    const options = resolveOptions<VideoOptions>(video.options, input);
    return withTemporaryFolder(async (folder) => {
      const warnings: string[] = [];
      const inputPath = path.join(folder, 'input');
      await fs.writeFile(inputPath, data);
      const source = await readFileInfo(inputPath);
      const format = options.format ?? (source.codec === 'vp9' || source.codec === 'vp8' ? 'webm' : 'mp4');
      const animation = format === 'webp' || format === 'gif';
      const fps = Math.min(options.fps ?? source.fps, source.fps);
      if (source.alpha && format === 'mp4')
        warnings.push('mp4 cannot hold transparency; it is lost (webm, webp and gif keep it)');
      const alpha = source.alpha && format !== 'mp4';

      // only ever shrinks; both sides stay even, which 4:2:0 colour needs
      let filters =
        `scale='min(iw,${options.maxWidth ?? 'iw'})':'min(ih,${options.maxHeight ?? 'ih'})'` +
        ':force_original_aspect_ratio=decrease:force_divisible_by=2';
      if (fps < source.fps) filters += `,fps=${fps}`;
      let codec: string[];
      switch (format) {
        case 'mp4':
          // quality 80 gives x264's own default of 23
          codec = ['-c:v', 'libx264', '-preset', 'slow', '-crf', String(Math.round(51 - options.quality * 0.35))];
          codec.push('-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart');
          break;
        case 'webm':
          // quality 80 gives the 31 VP9 recommends
          codec = ['-c:v', 'libvpx-vp9', '-crf', String(Math.round(63 - options.quality * 0.4)), '-b:v', '0'];
          codec.push('-deadline', 'good', '-cpu-used', '2', '-pix_fmt', alpha ? 'yuva420p' : 'yuv420p');
          codec.push('-c:a', 'libopus', '-b:a', '64k');
          break;
        case 'webp':
          codec = ['-c:v', 'libwebp_anim', '-quality', String(options.quality), '-compression_level', '6', '-loop', '0'];
          codec.push('-pix_fmt', alpha ? 'yuva420p' : 'yuv420p');
          break;
        default:
          // gif: a palette made from the clip itself, which keeps a slot for transparent pixels
          filters +=
            `,split[frames][copy];[copy]palettegen=max_colors=${options.gif.colors}:stats_mode=diff[palette]` +
            `;[frames][palette]paletteuse=dither=${options.gif.dither ? 'sierra2_4a' : 'none'}`;
          codec = ['-loop', '0'];
      }
      const outputPath = path.join(folder, `output.${format}`);
      const args = ['-loglevel', 'error'];
      // ffmpeg's own VP8 and VP9 decoders drop the alpha of a webm; libvpx keeps it
      if (source.alpha && source.codec === 'vp9') args.push('-c:v', 'libvpx-vp9');
      if (source.alpha && source.codec === 'vp8') args.push('-c:v', 'libvpx');
      args.push('-i', inputPath, '-map', '0:v:0');
      if (options.audio && !animation) args.push('-map', '0:a:0?');
      else args.push('-an');
      args.push('-map_metadata', '-1', '-sn', '-dn', '-vf', filters, ...codec);
      // the same input always gives the same bytes: no encoder name tags
      args.push('-fflags', '+bitexact', '-flags:v', '+bitexact', '-flags:a', '+bitexact', '-y', outputPath);
      await runFfmpeg(args).catch((error: Error) => {
        if (!/Unknown encoder/i.test(error.message)) throw error;
        throw new Error(`this ffmpeg has no ${ENCODERS[format]} encoder; set FFMPEG_PATH to a full build`);
      });
      const encoded = await fs.readFile(outputPath);

      // only a plain re-encode may fall back to the original: a smaller size, fewer frames or no sound asked for must stay
      const shrinks =
        (options.maxWidth !== undefined && source.width > options.maxWidth) ||
        (options.maxHeight !== undefined && source.height > options.maxHeight) ||
        fps < source.fps ||
        (!options.audio && source.audio);
      const sameKind =
        (format === 'mp4' && source.codec === 'h264' && source.container.includes('mp4')) ||
        (format === 'webm' && source.codec === 'vp9' && source.container.includes('webm'));
      if (options.keepSmaller && sameKind && !shrinks && encoded.length >= data.length) {
        const { width, height, duration, audio } = source;
        return { data, format, width, height, duration, fps: source.fps, audio, alpha, keptOriginal: true, warnings };
      }

      // ffmpeg cannot read an animated webp back, so animations are measured by sharp
      if (animation) {
        const meta = await sharp(encoded, { animated: true }).metadata();
        const height = meta.pageHeight ?? meta.height;
        const { duration } = source;
        return {
          data: encoded,
          format,
          width: meta.width,
          height,
          duration,
          fps,
          audio: false,
          alpha,
          keptOriginal: false,
          warnings
        };
      }
      const result = await readFileInfo(outputPath);
      const { width, height, duration, audio } = result;
      return {
        data: encoded,
        format,
        width,
        height,
        duration,
        fps: result.fps,
        audio,
        alpha,
        keptOriginal: false,
        warnings
      };
    });
  },

  async transform(files, options) {
    const warnings: string[] = [];
    const { outputs, errors } = await transformFiles(files, async (file) => {
      const encoded = await video.encodeVideo(file.data, options);
      for (const warning of encoded.warnings) warnings.push(`${file.origin ?? file.path}: ${warning}`);
      const { data, format, width, height, duration, fps, audio, alpha, keptOriginal } = encoded;
      const path =
        keptOriginal || extension(file.path) === format ? file.path : file.path.replace(/\.[^./]+$/, '') + `.${format}`;
      const meta = { ...file.meta, format, width, height, duration, fps, audio, alpha };
      return { ...file, path, data, meta, keptOriginal };
    });
    return { outputs, warnings, errors };
  }
};

/** What ffmpeg reports about a video and its first video stream. */
interface SourceInfo {
  /** ffmpeg's container names, like `mov,mp4,m4a,3gp,3g2,mj2` or `matroska,webm`. */
  container: string;
  codec: string;
  width: number;
  height: number;
  duration: number;
  fps: number;
  audio: boolean;
  alpha: boolean;
}

async function readFileInfo(file: string): Promise<SourceInfo> {
  // a missing ffmpeg fails here with its own message, not as an unreadable file
  await findFfmpeg();
  // ffmpeg prints what it found about its input while starting; `-t 0` stops it before decoding anything
  const { stderr } = await runFfmpeg(['-i', file, '-t', '0', '-f', 'null', '-']).catch(() => {
    throw new Error('not a video file ffmpeg can read');
  });
  const inputSection = stderr.split(/\n(?:Stream mapping|Output #0)/)[0] ?? stderr;
  const stream = inputSection.split('\n').find((line) => /Stream #0:\d+.*: Video: /.test(line));
  if (!stream) throw new Error('no video stream found');

  const size = /, (\d+)x(\d+)/.exec(stream);
  const duration = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(inputSection);
  return {
    container: /Input #0, (.+?), from/.exec(inputSection)?.[1] ?? '',
    codec: /Video: (\w+)/.exec(stream)?.[1] ?? 'unknown',
    width: Number(size?.[1] ?? 0),
    height: Number(size?.[2] ?? 0),
    duration: duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : 0,
    fps: Number(/([\d.]+) fps/.exec(stream)?.[1] ?? 30),
    audio: /Stream #0:\d+.*: Audio: /.test(inputSection),
    // a pixel format with alpha, like yuva420p or rgba, or a VP8/VP9 webm marked as having it
    alpha: /, (yuva|rgba|argb|bgra|abgr|gbrap|ya\d)/.test(stream) || /alpha_mode\s*: 1/.test(inputSection)
  };
}
