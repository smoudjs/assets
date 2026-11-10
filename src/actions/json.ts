import type { ActionDefinition, AssetFile } from '../types.js';
import { packJson } from '../utils/json/pack-json.js';

export interface JsonOptions extends Record<string, unknown> {
  pack: boolean;
}

export interface JsonAction extends ActionDefinition<JsonOptions> {
  /** Parses and re-serializes JSON without spaces or line breaks. Invalid JSON throws. */
  minifyJson(data: Buffer): Buffer;
  /** Minifies JSON and packs it when that makes it smaller; unpackJson from @smoud/assets/runtime reads it. Invalid JSON throws. */
  packJson(data: Buffer): Buffer;
}

function parse(data: Buffer): unknown {
  try {
    return JSON.parse(data.toString('utf8'));
  } catch (error) {
    throw new Error(`invalid JSON: ${(error as Error).message}`);
  }
}

/** Minifies JSON files, and packs them with `pack`. */
export const json: JsonAction = {
  name: 'json',
  accepts: ['json'],
  options: {
    pack: {
      kind: 'boolean',
      description: 'Pack keys and repeated strings for a smaller raw size; the game reads it with unpackJson from @smoud/assets/runtime',
      default: false
    }
  },

  minifyJson(data) {
    return Buffer.from(JSON.stringify(parse(data)));
  },

  packJson(data) {
    return Buffer.from(packJson(parse(data)));
  },

  // a plain loop on purpose: the simplest shape a transform can have
  async transform(files, options) {
    const outputs: AssetFile[] = [];
    const errors: string[] = [];
    for (const file of files) {
      try {
        outputs.push({ ...file, data: options.pack ? json.packJson(file.data) : json.minifyJson(file.data) });
      } catch (error) {
        errors.push(`${file.origin ?? file.path}: ${(error as Error).message}`);
      }
    }
    return { outputs, errors };
  }
};
