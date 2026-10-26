import type { ActionDefinition, AssetFile } from '../types.js';

export interface JsonAction extends ActionDefinition {
  /** Parses and re-serializes JSON without spaces or line breaks. Invalid JSON throws. */
  minifyJson(data: Buffer): Buffer;
}

/** Minifies JSON files. */
export const json: JsonAction = {
  name: 'json',
  accepts: ['json'],
  options: {},

  minifyJson(data) {
    try {
      return Buffer.from(JSON.stringify(JSON.parse(data.toString('utf8'))));
    } catch (error) {
      throw new Error(`invalid JSON: ${(error as Error).message}`);
    }
  },

  // a plain loop on purpose: the simplest shape a transform can have
  async transform(files) {
    const outputs: AssetFile[] = [];
    const errors: string[] = [];
    for (const file of files) {
      try {
        outputs.push({ ...file, data: json.minifyJson(file.data) });
      } catch (error) {
        errors.push(`${file.origin ?? file.path}: ${(error as Error).message}`);
      }
    }
    return { outputs, errors };
  }
};
