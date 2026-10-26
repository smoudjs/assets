import type { ActionDefinition } from '../types.js';
import { finishAction, resolveOptions, transformFiles } from './index.js';
import { selectFiles } from '../files.js';

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

  async process({ source, destination, ...options }) {
    const started = performance.now();
    resolveOptions(json.options, options);
    const { files, warnings } = await selectFiles(source, { accepts: json.accepts });
    const errors: string[] = [];
    const outputs = await transformFiles(files, async (file) => ({ ...file, data: json.minifyJson(file.data) }), errors);
    return finishAction({ action: json.name, source, destination, inputs: files, outputs, warnings, errors, started });
  }
};
