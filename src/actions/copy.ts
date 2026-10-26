import type { ActionDefinition } from '../types.js';

/** Copies files unchanged. Accepts everything, has no options. */
export const copy: ActionDefinition = {
  name: 'copy',
  accepts: '*',
  options: {},

  async transform(files) {
    return files;
  }
};
