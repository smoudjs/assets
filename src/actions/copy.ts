import type { ActionDefinition } from '../types.js';
import { finishAction, resolveOptions } from './index.js';
import { selectFiles } from '../files.js';

/** Copies files unchanged. Accepts everything, has no options. */
export const copy: ActionDefinition = {
  name: 'copy',
  accepts: '*',
  options: {},

  async process({ source, destination, ...options }) {
    const started = performance.now();
    resolveOptions(copy.options, options);
    const { files, warnings } = await selectFiles(source);
    return finishAction({ action: copy.name, source, destination, inputs: files, outputs: files, warnings, errors: [], started });
  }
};
