// Compresses glTF geometry and animations with EXT_meshopt_compression. The game needs meshoptimizer's decoder to
// load the result, so this is an action of its own: gltf output loads without one.

import type { ActionDefinition, OptionTable } from '../types.js';
import {
  detectFormat,
  gltf,
  loadGltfTransform,
  readDocument,
  transformModels,
  writeDocument,
  type GltfInput,
  type OptimizedGltf
} from './gltf.js';
import { resolveOptions } from './index.js';

export interface MeshoptOptions extends Record<string, unknown> {
  level: 'medium' | 'high';
}

export interface MeshoptAction extends ActionDefinition<MeshoptOptions> {
  /** Compress one model; it keeps its format. Throws when a `.gltf` refers to a file that is not among its companions. */
  compressGltf(model: GltfInput, options?: Partial<MeshoptOptions>): Promise<OptimizedGltf>;
}

const options: OptionTable = {
  level: {
    kind: 'enum',
    values: ['medium', 'high'],
    description: 'medium quantizes and compresses; high also stores normals and tangents in fewer bits, smaller still',
    default: 'high'
  }
};

/** Compress glTF and GLB models with EXT_meshopt_compression. The game loads them with meshoptimizer's decoder. */
export const meshopt: MeshoptAction = {
  name: 'meshopt',
  // bump whenever a code change alters the output: cached results of older versions stop matching
  version: 2,
  cache: true,
  accepts: ['glb', 'gltf'],
  options,
  findCompanions: gltf.findCompanions,

  probe(input) {
    return gltf.readGltfMeta(input);
  },

  async compressGltf(model, input = {}) {
    const options = resolveOptions<MeshoptOptions>(meshopt.options, input);
    const tools = await loadGltfTransform();
    const format = detectFormat(model.data);
    const doc = await readDocument(tools, model, format);
    await doc.transform(tools.functions.meshopt({ encoder: tools.encoder, level: options.level }));
    const written = await writeDocument(doc, format, model, tools);
    const meta = await gltf.readGltfMeta(written.data);
    return {
      data: written.data,
      format,
      files: written.files,
      triangles: meta.triangles as number,
      vertices: meta.vertices as number,
      textures: meta.textures as number,
      animations: meta.animations as number
    };
  },

  transform(files, options, { filenameTemplate }) {
    return transformModels(files, filenameTemplate, (model) => meshopt.compressGltf(model, options));
  }
};
