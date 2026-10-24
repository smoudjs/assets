import type { ActionType } from '../types.js';

/** Copies files unchanged. Accepts everything, has no options. */
export const copy: ActionType = {
  name: 'copy',
  version: '1',
  accepts: '*',
  options: {},
  async process(files) {
    return files;
  }
};
