import type { ActionType } from '../types.js';

/** Minifies JSON: parse, then serialize without spaces or line breaks. Invalid files fail. */
export const json: ActionType = {
  name: 'json',
  version: '1',
  accepts: ['json'],
  options: {},
  async process(files, _options, context) {
    const results = [];
    for (const file of files) {
      try {
        const data = Buffer.from(JSON.stringify(JSON.parse(file.data.toString('utf8'))));
        results.push({ ...file, data, meta: { ...file.meta, size: data.length } });
      } catch (error) {
        context.fail(file, `invalid JSON: ${(error as Error).message}`);
      }
    }
    return results;
  }
};
