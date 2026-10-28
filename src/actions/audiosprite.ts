// Joins sounds into one file with silence between them, and writes a JSON that tells a player where each one is.
// Every sound is decoded to 16-bit PCM in one shared channel count and sample rate, the PCM is joined, and the joined
// sound is encoded once by the audio action.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findFfmpeg, runFfmpeg } from '@smoud/ffmpeg';
import { destinationPath } from '../files.js';
import type { ActionDefinition, AssetFile, OptionTable } from '../types.js';
import { contentHash } from '../utils/fs.js';
import { audio } from './audio.js';
import { resolveOptions } from './index.js';

type Format = 'mp3' | 'ogg' | 'opus' | 'm4a' | 'wav';
type DataFormat = 'howler' | 'howler1' | 'phaser' | 'pixi' | 'json';
const SAMPLE_RATES = [8000, 11025, 16000, 22050, 24000, 32000, 44100, 48000];

export interface AudioSpriteOptions extends Record<string, unknown> {
  format: Format;
  quality: number;
  bitrate?: number;
  channels?: 1 | 2;
  sampleRate?: number;
  gap: number;
  data: DataFormat;
}

/** A sound going into `packAudioSprite`. */
export interface AudioSpriteSound {
  /** The key the sound gets in the JSON, like `ui/click`. */
  name: string;
  data: Buffer;
}

/** Where one sound sits in the joined file. */
export interface AudioSpriteEntry {
  name: string;
  /** Milliseconds from the start of the file. */
  start: number;
  /** Milliseconds. */
  duration: number;
}

/** What `packAudioSprite` returns: the joined sound, what it is, and where each sound sits in it. */
export interface PackedAudioSprite {
  data: Buffer;
  format: Format;
  /** Seconds. */
  duration: number;
  channels: number;
  sampleRate: number;
  /** kbps, measured from the bytes. */
  bitrate: number;
  /** Sorted by name. */
  sounds: AudioSpriteEntry[];
}

export interface AudioSpriteAction extends ActionDefinition<AudioSpriteOptions> {
  /**
   * Join sounds into one encoded file, sorted by name, with `gap` seconds of silence between them. Channels and
   * sample rate are the highest among the sounds, lowered by the options, never raised. Throws on two sounds with the
   * same name or a sound ffmpeg cannot read.
   */
  packAudioSprite(sounds: AudioSpriteSound[], options?: Partial<AudioSpriteOptions>): Promise<PackedAudioSprite>;
}

const options: OptionTable = {
  format: { kind: 'enum', values: ['mp3', 'ogg', 'opus', 'm4a', 'wav'], description: 'Output format', default: 'mp3' },
  quality: {
    kind: 'number',
    description: 'Quality for mp3, ogg, opus and m4a, as in the audio action',
    min: 1,
    max: 100,
    default: 80
  },
  bitrate: { kind: 'number', description: 'Bitrate in kbps, wins over quality', min: 8, max: 320 },
  channels: {
    kind: 'enum',
    values: [1, 2],
    description: 'Channels of the joined file; never more than the sounds have. Default: the most any sound has'
  },
  sampleRate: {
    kind: 'enum',
    values: SAMPLE_RATES,
    description: 'Sample rate in Hz; never above the sounds. Default: the highest any sound has'
  },
  gap: {
    kind: 'number',
    description: 'Seconds of silence between sounds, so the end of one never bleeds into the next',
    min: 0,
    max: 10,
    default: 0.25
  },
  data: {
    kind: 'enum',
    values: ['howler', 'howler1', 'phaser', 'pixi', 'json'],
    description: 'JSON layout: Howler 2, Howler 1, Phaser 3, PixiJS Sound, or plain start and duration',
    default: 'howler'
  }
};

/** Join sounds into one file with a JSON of where each sound starts, for Howler, Phaser or PixiJS Sound. */
export const audiosprite: AudioSpriteAction = {
  name: 'audiosprite',
  // bump whenever a code change alters the output: cached results of older versions stop matching
  version: 2,
  cache: 'together',
  accepts: audio.accepts,
  options,

  probe(input) {
    return audio.readAudioMeta(input);
  },

  async packAudioSprite(sounds, input = {}) {
    const options = resolveOptions<AudioSpriteOptions>(audiosprite.options, input);
    if (!sounds.length) throw new Error('no sounds to join');
    // a missing ffmpeg fails here with its own message, not under the name of the first sound
    await findFfmpeg();
    const sorted = [...sounds].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i]?.name === sorted[i - 1]?.name) throw new Error(`two sounds are named "${sorted[i]?.name}"`);
    }

    const metas = [];
    for (const sound of sorted) metas.push(await withSoundName(sound.name, audio.readAudioMeta(sound.data)));
    const mostChannels = Math.min(2, Math.max(...metas.map((meta) => Number(meta.channels ?? 2))));
    const highestRate = Math.max(...metas.map((meta) => Number(meta.sampleRate ?? 44100)));
    const channels = Math.min(options.channels ?? mostChannels, mostChannels);
    const sampleRate = Math.min(options.sampleRate ?? highestRate, highestRate);

    const bytesPerSecond = sampleRate * channels * 2;
    const silence = Buffer.alloc(Math.round(options.gap * sampleRate) * channels * 2);
    const parts: Buffer[] = [];
    const entries: AudioSpriteEntry[] = [];
    let offset = 0;
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'smoud-audiosprite-'));
    try {
      for (const [index, sound] of sorted.entries()) {
        if (index > 0) {
          parts.push(silence);
          offset += silence.length;
        }
        const pcm = await withSoundName(
          sound.name,
          decodeToPcm(sound.data, path.join(folder, `${index}`), channels, sampleRate)
        );
        parts.push(pcm);
        entries.push({
          name: sound.name,
          start: Math.round((offset / bytesPerSecond) * 1000),
          duration: Math.round((pcm.length / bytesPerSecond) * 1000)
        });
        offset += pcm.length;
      }
    } finally {
      await fs.rm(folder, { recursive: true, force: true });
    }

    const encoded = await audio.encodeAudio(wavFile(Buffer.concat(parts), channels, sampleRate), {
      format: options.format,
      quality: options.quality,
      bitrate: options.bitrate,
      channels: channels as 1 | 2,
      sampleRate
    });
    if (!encoded) throw new Error('the joined sound could not be encoded');
    const { data, format, duration, bitrate } = encoded;
    return {
      data,
      format: format as Format,
      duration,
      channels: encoded.channels,
      sampleRate: encoded.sampleRate,
      bitrate,
      sounds: entries
    };
  },

  async transform(files, options, { folderName, filenameTemplate }) {
    if (!files.length) return [];
    const soundName = (file: AssetFile) => file.path.replace(/\.[^./]+$/, '');
    const packed = await audiosprite.packAudioSprite(
      files.map((file) => ({ name: soundName(file), data: file.data })),
      options
    );
    // named after the folder; the destination's filename template renames it
    const name = folderName || 'audiosprite';
    const { data, format, duration, channels, sampleRate, bitrate } = packed;
    const sound: AssetFile = {
      path: `${name}.${format}`,
      data,
      meta: { size: 0, format, duration, channels, sampleRate, bitrate }
    };
    const json: AssetFile = {
      path: `${name}.json`,
      data: Buffer.from(JSON.stringify(spriteJson(options.data, destinationPath(sound, filenameTemplate), packed.sounds))),
      meta: { size: 0 },
      // the JSON borrows the sound's hash, so both get the same name under a [hash] filename template
      filenameTokens: { hash: contentHash(data) }
    };
    return [sound, json];
  }
};

// a failure names the sound it happened on
async function withSoundName<T>(name: string, work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    throw new Error(`${name}: ${(error as Error).message}`);
  }
}

// written to a file first: mp4 (m4a) can only be read where ffmpeg can seek
async function decodeToPcm(data: Buffer, file: string, channels: number, sampleRate: number): Promise<Buffer> {
  await fs.writeFile(file, data);
  const { stdout } = await runFfmpeg([
    ...['-loglevel', 'error', '-i', file, '-map', '0:a:0'],
    ...['-f', 's16le', '-c:a', 'pcm_s16le', '-ac', String(channels), '-ar', String(sampleRate), 'pipe:1']
  ]);
  return stdout;
}

/** 16-bit PCM wrapped in the 44-byte header of a wav file. */
function wavFile(pcm: Buffer, channels: number, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// Howler and plain json count in milliseconds; Phaser and PixiJS Sound in seconds
function spriteJson(layout: DataFormat, file: string, sounds: AudioSpriteEntry[]): unknown {
  const byName = <T>(value: (sound: AudioSpriteEntry) => T) =>
    Object.fromEntries(sounds.map((sound) => [sound.name, value(sound)]));
  const seconds = (ms: number) => ms / 1000;
  switch (layout) {
    case 'howler':
      return { src: [file], sprite: byName((sound) => [sound.start, sound.duration]) };
    case 'howler1':
      return { urls: [file], sprite: byName((sound) => [sound.start, sound.duration]) };
    case 'phaser':
      return {
        resources: [file],
        spritemap: byName((sound) => ({
          start: seconds(sound.start),
          end: seconds(sound.start + sound.duration),
          loop: false
        }))
      };
    case 'pixi':
      return {
        url: file,
        sprites: byName((sound) => ({ start: seconds(sound.start), end: seconds(sound.start + sound.duration) }))
      };
    case 'json':
      return sounds.map(({ name, start, duration }) => ({ name, start, duration }));
  }
}
