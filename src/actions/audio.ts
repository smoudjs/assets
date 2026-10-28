// One ffmpeg run per file. Files go through a temporary folder, not pipes: mp4 (m4a) can only be read and written
// where ffmpeg can seek.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findFfmpeg, runFfmpeg } from '@smoud/ffmpeg';
import type { ActionDefinition, AssetMeta, OptionTable } from '../types.js';
import { resolveOptions, transformFiles } from './index.js';
import { extension } from '../utils/fs.js';

type Format = 'mp3' | 'ogg' | 'opus' | 'm4a' | 'wav' | 'flac';
const FORMATS: Format[] = ['mp3', 'ogg', 'opus', 'm4a', 'wav', 'flac'];
const CODECS: Record<Format, string> = {
  mp3: 'libmp3lame',
  ogg: 'libvorbis',
  opus: 'libopus',
  m4a: 'aac',
  wav: 'pcm_s16le',
  flac: 'flac'
};
const LOSSY_FORMATS: Format[] = ['mp3', 'ogg', 'opus', 'm4a'];
// kbps of stereo mp3 at quality 0, 10, 20 ... 100; other formats need fewer bits for the same sound, mono half
const MP3_STEREO_KBPS = [16, 24, 32, 48, 64, 80, 96, 112, 128, 192, 320];
const QUALITY_BITRATE_FACTOR: Record<string, number> = { mp3: 1, ogg: 0.85, m4a: 0.8, opus: 0.6 };
// kbps libvorbis accepts by sample rate: [mono min, mono max, stereo min, stereo max]; it refuses anything outside
const VORBIS_LIMITS: Array<[number, [number, number, number, number]]> = [
  [8000, [8, 40, 12, 80]],
  [11025, [12, 48, 16, 96]],
  [16000, [16, 96, 24, 192]],
  [22050, [16, 80, 32, 160]],
  [32000, [32, 160, 36, 320]],
  [44100, [32, 224, 48, 320]]
];
const SAMPLE_RATES = [8000, 11025, 16000, 22050, 24000, 32000, 44100, 48000];
const CHANNELS_OF_LAYOUT: Record<string, number> = {
  mono: 1,
  stereo: 2,
  '2.1': 3,
  '3.0': 3,
  quad: 4,
  '4.0': 4,
  '5.0': 5,
  '5.1': 6,
  '6.1': 7,
  '7.1': 8
};

export interface AudioOptions extends Record<string, unknown> {
  format?: Format;
  quality: number;
  bitrate?: number;
  channels?: 1 | 2;
  sampleRate?: number;
  keepSmaller: boolean;
}

/** What `encodeAudio` returns: the encoded bytes and what they are. */
export interface EncodedAudio {
  data: Buffer;
  format: Format;
  /** Seconds. */
  duration: number;
  channels: number;
  sampleRate: number;
  /** kbps, measured from the bytes. */
  bitrate: number;
  /** The original bytes were kept because encoding would not have made them smaller. */
  keptOriginal: boolean;
}

export interface AudioAction extends ActionDefinition<AudioOptions> {
  /**
   * Format, duration (seconds), channels, sampleRate (Hz) and bitrate (kbps) of a sound, from its bytes or its path.
   * Also the probe for `when`.
   */
  readAudioMeta(input: Buffer | string): Promise<Partial<AssetMeta>>;
  /**
   * Encode one sound, downmixed and resampled as asked. Channels, sample rate and bitrate never go above the
   * source's. Returns null when the source codec has no matching format and no `format` was asked for.
   */
  encodeAudio(data: Buffer, options?: Partial<AudioOptions>): Promise<EncodedAudio | null>;
}

const options: OptionTable = {
  format: { kind: 'enum', values: FORMATS, description: 'Output format. Omitted: keep the source format' },
  quality: {
    kind: 'number',
    description: 'Quality for mp3, ogg, opus and m4a; picks a bitrate that sounds about the same in every format',
    min: 1,
    max: 100,
    default: 80
  },
  bitrate: {
    kind: 'number',
    description: "Bitrate in kbps for mp3, ogg, opus and m4a, wins over quality; never above the source's",
    min: 8,
    max: 320
  },
  channels: { kind: 'enum', values: [1, 2], description: "1 for mono, 2 for stereo; never more than the source's" },
  sampleRate: {
    kind: 'enum',
    values: SAMPLE_RATES,
    description: "Sample rate in Hz; never above the source's. opus always plays at 48000 and ignores it"
  },
  keepSmaller: {
    kind: 'boolean',
    description:
      'Emit the original when encoding would not make it smaller: same format and nothing to reduce, or a bigger result',
    default: true
  }
};

/** Convert, downmix, resample and compress sounds with ffmpeg. */
export const audio: AudioAction = {
  name: 'audio',
  // bump whenever a code change alters the output: cached results of older versions stop matching
  version: 4,
  cache: true,
  accepts: ['mp3', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'wav', 'flac', 'webm'],
  options,

  async readAudioMeta(input) {
    // a file on disk is read where it is; bytes in memory go through a temporary file
    const source =
      typeof input === 'string'
        ? await readFileInfo(input)
        : await withTemporaryFolder((folder) => readSourceInfo(input, folder));
    return {
      format: formatOfCodec(source.codec) ?? source.codec,
      duration: source.duration,
      channels: source.channels,
      sampleRate: source.sampleRate,
      bitrate: source.bitrate
    };
  },

  // every fact comes from one quick ffmpeg read, so `'cheap'` already gets them all
  probe(input) {
    return audio.readAudioMeta(input);
  },

  async encodeAudio(data, input = {}) {
    const options = resolveOptions<AudioOptions>(audio.options, input);
    return withTemporaryFolder(async (folder) => {
      const source = await readSourceInfo(data, folder);
      const sourceFormat = formatOfCodec(source.codec);
      const format = options.format ?? sourceFormat;
      if (!format) return null;

      const lossy = LOSSY_FORMATS.includes(format);
      const channels = Math.min(options.channels ?? source.channels, source.channels);
      const sampleRate = format === 'opus' ? 48000 : Math.min(options.sampleRate ?? source.sampleRate, source.sampleRate);
      const sourceIsLossy = sourceFormat !== null && LOSSY_FORMATS.includes(sourceFormat);
      const wantedBitrate = options.bitrate ?? bitrateForQuality(options.quality, format, channels);
      // a lossy source's bitrate is the most worth keeping per channel: downmixed to mono, half of it carries the sound
      const sourceLimit = source.bitrate ? Math.round((source.bitrate * channels) / source.channels) : undefined;
      const cappedBitrate = sourceIsLossy && sourceLimit ? Math.min(wantedBitrate, sourceLimit) : wantedBitrate;
      const bitrate = format === 'ogg' ? withinVorbisLimits(cappedBitrate, channels, sampleRate) : cappedBitrate;
      const original: EncodedAudio = {
        data,
        format,
        duration: source.duration,
        channels: source.channels,
        sampleRate: source.sampleRate,
        bitrate: measuredBitrate(data, source.duration, source.bitrate ?? 0),
        keptOriginal: true
      };

      // re-encoding a lossy file at its own bitrate only loses quality
      const nothingToReduce =
        format === sourceFormat &&
        channels === source.channels &&
        sampleRate === source.sampleRate &&
        (!lossy || (source.bitrate !== undefined && source.bitrate <= wantedBitrate));
      if (options.keepSmaller && nothingToReduce) return original;

      const outputPath = path.join(folder, `output.${format}`);
      await runFfmpeg([
        '-loglevel',
        'error',
        '-i',
        path.join(folder, 'input'),
        '-map',
        '0:a:0',
        '-map_metadata',
        '-1',
        // the same input always gives the same bytes: no random ogg stream ids, no encoder name tags
        '-fflags',
        '+bitexact',
        '-flags:a',
        '+bitexact',
        '-c:a',
        CODECS[format],
        '-ac',
        String(channels),
        ...(format === 'opus' ? [] : ['-ar', String(sampleRate)]),
        ...(lossy ? ['-b:a', `${bitrate}k`] : []),
        ...(format === 'm4a' ? ['-movflags', '+faststart'] : []),
        '-y',
        outputPath
      ]);
      const encoded = await fs.readFile(outputPath);
      // only a plain re-encode may fall back to the original: fewer channels or a lower rate asked for must be kept
      const sameShape = format === sourceFormat && channels === source.channels && sampleRate === source.sampleRate;
      if (options.keepSmaller && sameShape && encoded.length >= data.length) return original;

      return {
        data: encoded,
        format,
        duration: source.duration,
        channels,
        sampleRate,
        bitrate: measuredBitrate(encoded, source.duration, bitrate),
        keptOriginal: false
      };
    });
  },

  async transform(files, options) {
    const warnings: string[] = [];
    const { outputs, errors } = await transformFiles(files, async (file) => {
      const encoded = await audio.encodeAudio(file.data, options);
      if (!encoded) {
        warnings.push(`${file.origin ?? file.path}: its codec has no matching output format, so it needs "format"; skipped`);
        return null;
      }
      const { data, format, duration, channels, sampleRate, bitrate, keptOriginal } = encoded;
      const path =
        keptOriginal || extension(file.path) === format ? file.path : file.path.replace(/\.[^./]+$/, '') + `.${format}`;
      return { ...file, path, data, meta: { ...file.meta, format, duration, channels, sampleRate, bitrate }, keptOriginal };
    });
    return { outputs, warnings, errors };
  }
};

/** What ffmpeg reports about the first audio stream of a source. */
interface SourceInfo {
  codec: string;
  duration: number;
  channels: number;
  sampleRate: number;
  /** kbps; the stream's own, or the whole file's when the stream has none (opus). */
  bitrate?: number;
}

// writes the source to `folder/input`, where encodeAudio reads it again
async function readSourceInfo(data: Buffer, folder: string): Promise<SourceInfo> {
  const input = path.join(folder, 'input');
  await fs.writeFile(input, data);
  return readFileInfo(input);
}

async function readFileInfo(file: string): Promise<SourceInfo> {
  // a missing ffmpeg fails here with its own message, not as an unreadable file
  await findFfmpeg();
  // ffmpeg prints what it found about its input while starting; `-t 0` stops it before decoding anything
  const { stderr } = await runFfmpeg(['-i', file, '-t', '0', '-f', 'null', '-']).catch(() => {
    throw new Error('not an audio file ffmpeg can read');
  });
  const inputSection = stderr.split(/\n(?:Stream mapping|Output #0)/)[0] ?? stderr;
  const stream = inputSection.split('\n').find((line) => /Stream #0:\d+.*: Audio: /.test(line));
  if (!stream) throw new Error('no audio stream found');

  const layout = (/\d+ Hz, ([^,]+)/.exec(stream)?.[1] ?? '').replace(/\(.*\)/, '').trim();
  const duration = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(inputSection);
  const bitrate = /(\d+) kb\/s/.exec(stream)?.[1] ?? /bitrate: (\d+) kb\/s/.exec(inputSection)?.[1];
  return {
    codec: /Audio: (\w+)/.exec(stream)?.[1] ?? 'unknown',
    duration: duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : 0,
    // an unusual layout name counts as stereo
    channels: Number(/(\d+) channels/.exec(layout)?.[1] ?? CHANNELS_OF_LAYOUT[layout] ?? 2),
    sampleRate: Number(/(\d+) Hz/.exec(stream)?.[1] ?? 44100),
    bitrate: bitrate === undefined ? undefined : Number(bitrate)
  };
}

function formatOfCodec(codec: string): Format | null {
  if (codec.startsWith('pcm_')) return 'wav';
  if (codec === 'vorbis') return 'ogg';
  if (codec === 'aac') return 'm4a';
  return codec === 'mp3' || codec === 'opus' || codec === 'flac' ? codec : null;
}

// a point between the curve's steps of 10 is interpolated
function bitrateForQuality(quality: number, format: Format, channels: number): number {
  const step = Math.floor(quality / 10);
  const stereoMp3 =
    (MP3_STEREO_KBPS[step] as number) +
    ((MP3_STEREO_KBPS[Math.min(step + 1, 10)] as number) - (MP3_STEREO_KBPS[step] as number)) * (quality / 10 - step);
  const kbps = stereoMp3 * (QUALITY_BITRATE_FACTOR[format] ?? 1) * (channels === 1 ? 0.5 : 1);
  return Math.max(8, Math.round(kbps));
}

// a sample rate between the listed ones takes the limits of the one below it
function withinVorbisLimits(bitrate: number, channels: number, sampleRate: number): number {
  const limits = [...VORBIS_LIMITS].reverse().find(([rate]) => sampleRate >= rate)?.[1] ?? VORBIS_LIMITS[0]![1];
  const [min, max] = channels === 1 ? [limits[0], limits[1]] : [limits[2], limits[3]];
  return Math.min(Math.max(bitrate, min), max);
}

// kbps of the whole file, so container overhead counts; `fallback` when the duration is unknown
function measuredBitrate(data: Buffer, duration: number, fallback: number): number {
  return duration ? Math.round((data.length * 8) / duration / 1000) : fallback;
}

async function withTemporaryFolder<T>(work: (folder: string) => Promise<T>): Promise<T> {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'smoud-audio-'));
  try {
    return await work(folder);
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
}
