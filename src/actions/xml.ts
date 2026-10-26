import type { ActionDefinition, OptionTable } from '../types.js';
import { finishAction, resolveOptions, transformFiles } from './index.js';
import { selectFiles } from '../files.js';

export interface XmlOptions extends Record<string, unknown> {
  comments: boolean;
}

export interface XmlAction extends ActionDefinition<XmlOptions> {
  /**
   * Removes whitespace between tags and around the document, and comments unless `comments` is true.
   * Text inside elements and CDATA sections is left exactly as written.
   */
  minifyXml(data: Buffer, options?: Partial<XmlOptions>): Buffer;
}

const options: OptionTable = {
  comments: { kind: 'boolean', description: 'Keep comments', default: false }
};

/** Minifies XML files. */
export const xml: XmlAction = {
  name: 'xml',
  accepts: ['xml'],
  options,

  minifyXml(data, options = {}) {
    const { comments } = resolveOptions<XmlOptions>(xml.options, options);
    // Keep CDATA untouched: swap each section for a placeholder, restore at the end.
    const cdata: string[] = [];
    let text = data
      .toString('utf8')
      .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, (section) => `\u0000${cdata.push(section) - 1}\u0000`);
    if (!comments) text = text.replace(/<!--[\s\S]*?-->/g, '');
    text = text.replace(/>\s+</g, '><').trim();
    return Buffer.from(text.replace(/\u0000(\d+)\u0000/g, (_, index: string) => cdata[Number(index)] as string));
  },

  async process({ source, destination, ...input }) {
    const started = performance.now();
    const options = resolveOptions<XmlOptions>(xml.options, input);
    const { files, warnings } = await selectFiles(source, { accepts: xml.accepts });
    const errors: string[] = [];
    const outputs = await transformFiles(
      files,
      async (file) => ({ ...file, data: xml.minifyXml(file.data, options) }),
      errors
    );
    return finishAction({ action: xml.name, source, destination, inputs: files, outputs, warnings, errors, started });
  }
};
