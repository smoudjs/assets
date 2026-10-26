/**
 * @smoud/assets — public API.
 *
 *   await build();                                                        // assets.json in the working directory
 *   await image.process({ source: 'assets/ui', destination: 'public/ui', format: 'webp' });
 *   const { outputs } = await copy.process({ source: 'assets/fonts' });   // no destination: results in memory
 *   const webp = await image.optimizeImage(buffer, { format: 'webp' });  // bytes in, bytes out
 *   actions.register({ name: 'gltf', accepts: ['gltf', 'glb'], options: {}, async process(input) { ... } });
 */

import { actions } from './actions/index.js';
import { atlas } from './actions/atlas.js';
import { copy } from './actions/copy.js';
import { image } from './actions/image.js';
import { json } from './actions/json.js';
import { xml } from './actions/xml.js';

// the built-in actions; a new one is added to this list
for (const action of [image, atlas, json, xml, copy]) actions.register(action);

export {
  actions,
  finishAction,
  resolveOptions,
  transformFiles,
  type ActionOutcome,
  type ActionRegistry
} from './actions/index.js';
export {
  atlas,
  type AtlasAction,
  type AtlasFrame,
  type AtlasOptions,
  type AtlasPage,
  type AtlasSprite,
  type PackedAtlas
} from './actions/atlas.js';
export { copy } from './actions/copy.js';
export { image, type ImageAction, type ImageOptions, type OptimizedImage, type ResizeOptions } from './actions/image.js';
export { json, type JsonAction } from './actions/json.js';
export { xml, type XmlAction, type XmlOptions } from './actions/xml.js';
export { build, type BuildOptions } from './build.js';
export { destinationPath, selectFiles, writeFiles, type Selection, type SelectOptions } from './files.js';
export { formatReport, type ReportOptions } from './report.js';
export { contentHash, extension, renderFilename } from './utils/fs.js';
export type * from './types.js';

/** Package version. */
export const version: string = __VERSION__;
