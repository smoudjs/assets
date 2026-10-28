/**
 * @smoud/assets — public API.
 *
 *   await build();                                                        // assets.json in the working directory
 *   await image.process({ source: 'assets/ui', destination: 'public/ui', format: 'webp' });
 *   const { outputs } = await copy.process({ source: 'assets/fonts' });   // no destination: results in memory
 *   const webp = await image.optimizeImage(buffer, { format: 'webp' });  // bytes in, bytes out
 *   actions.register({ name: 'upper', accepts: ['txt'], options: {}, async transform(files) { ... } });
 */

import { actions } from './actions/index.js';
import { atlas as atlasAction } from './actions/atlas.js';
import { audio as audioAction } from './actions/audio.js';
import { audiosprite as audiospriteAction } from './actions/audiosprite.js';
import { copy as copyAction } from './actions/copy.js';
import { font as fontAction } from './actions/font.js';
import { gltf as gltfAction } from './actions/gltf.js';
import { image as imageAction } from './actions/image.js';
import { json as jsonAction } from './actions/json.js';
import { meshopt as meshoptAction } from './actions/meshopt.js';
import { spine as spineAction } from './actions/spine.js';
import { video as videoAction } from './actions/video.js';
import { xml as xmlAction } from './actions/xml.js';

// the built-in actions; a new one is registered here
export const image = actions.register(imageAction);
export const atlas = actions.register(atlasAction);
export const audio = actions.register(audioAction);
export const audiosprite = actions.register(audiospriteAction);
export const video = actions.register(videoAction);
export const font = actions.register(fontAction);
export const gltf = actions.register(gltfAction);
export const meshopt = actions.register(meshoptAction);
export const spine = actions.register(spineAction);
export const json = actions.register(jsonAction);
export const xml = actions.register(xmlAction);
export const copy = actions.register(copyAction);

export {
  actions,
  finishAction,
  resolveOptions,
  transformFiles,
  type ActionOutcome,
  type ActionRegistry
} from './actions/index.js';
export {
  type AtlasAction,
  type AtlasFrame,
  type AtlasOptions,
  type AtlasPage,
  type AtlasSprite,
  type PackedAtlas
} from './actions/atlas.js';
export { type AudioAction, type AudioOptions, type EncodedAudio } from './actions/audio.js';
export {
  type AudioSpriteAction,
  type AudioSpriteEntry,
  type AudioSpriteOptions,
  type AudioSpriteSound,
  type PackedAudioSprite
} from './actions/audiosprite.js';
export { type FontAction, type FontOptions, type OptimizedFont } from './actions/font.js';
export { type GltfAction, type GltfFile, type GltfInput, type GltfOptions, type OptimizedGltf } from './actions/gltf.js';
export { type ImageAction, type ImageOptions, type OptimizedImage, type ResizeOptions } from './actions/image.js';
export { type JsonAction } from './actions/json.js';
export { type MeshoptAction, type MeshoptOptions } from './actions/meshopt.js';
export {
  type OptimizedSpine,
  type SpineAction,
  type SpineFile,
  type SpineInput,
  type SpineOptions
} from './actions/spine.js';
export { type EncodedVideo, type VideoAction, type VideoOptions } from './actions/video.js';
export { type XmlAction, type XmlOptions } from './actions/xml.js';
export { build, type BuildOptions } from './build.js';
export { loadPreset, presetFilePath, readConfigFile } from './config.js';
export { destinationPath, selectFiles, writeFiles, type Selection, type SelectOptions } from './files.js';
export { formatReport, type ReportOptions } from './report.js';
export { progressIndicator, type ProgressIndicator } from './progress.js';
export { contentHash, extension, renderFilename } from './utils/fs.js';
export type * from './types.js';

/** Package version. */
export const version: string = __VERSION__;
