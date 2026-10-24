import type { ActionType } from '../types.js';

interface XmlOptions extends Record<string, unknown> {
  comments: boolean;
}

/**
 * Minifies XML: drops comments, removes whitespace between tags and around the document.
 * Text inside elements and CDATA sections is left exactly as written.
 */
export const xml: ActionType<XmlOptions> = {
  name: 'xml',
  version: '1',
  accepts: ['xml'],
  options: {
    comments: { kind: 'boolean', description: 'Keep comments', default: false }
  },
  async process(files, options) {
    return files.map((file) => {
      const data = Buffer.from(minify(file.data.toString('utf8'), options.comments));
      return { ...file, data, meta: { ...file.meta, size: data.length } };
    });
  }
};

function minify(text: string, keepComments: boolean): string {
  // Keep CDATA untouched: swap each section for a placeholder, restore at the end.
  const cdata: string[] = [];
  let result = text.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, (section) => `\u0000${cdata.push(section) - 1}\u0000`);
  if (!keepComments) result = result.replace(/<!--[\s\S]*?-->/g, '');
  result = result.replace(/>\s+</g, '><').trim();
  return result.replace(/\u0000(\d+)\u0000/g, (_, index: string) => cdata[Number(index)] as string);
}
