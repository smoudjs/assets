// Optimizes glTF models with glTF Transform, in one pass per model: read, remove what was turned off, textures,
// cleanup, simplify, quantize, write. Everything it writes loads without a decoder. glTF Transform and meshoptimizer
// are imported on first use, so builds without models never load them.

import { promises as fs } from 'node:fs';
import type { Document } from '@gltf-transform/core';
import { destinationPath } from '../files.js';
import type { ActionDefinition, AssetFile, AssetMeta, OptionTable } from '../types.js';
import { basename, dirname, extension, join } from '../utils/fs.js';
import { image } from './image.js';
import { resolveOptions, transformFiles } from './index.js';

type Form = 'glb' | 'gltf' | 'gltf-embedded';
type TextureFormat = 'png' | 'jpeg' | 'webp' | 'avif';
const FORMS: Form[] = ['glb', 'gltf', 'gltf-embedded'];
const MIME_TYPES: Record<TextureFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif'
};
const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/ktx2': 'ktx2'
};
const GLB_MAGIC = 0x46546c67;

export interface GltfOptions extends Record<string, unknown> {
  format?: Form;
  quantize: boolean;
  simplify: { ratio?: number; error: number; method: 'collapse' | 'sloppy' };
  textures: { format?: TextureFormat; quality?: number; maxSize?: number; extract: boolean };
  normals: boolean;
  tangents: boolean;
  uvs: boolean;
  vertexColors: boolean;
  materials: boolean;
  animations: boolean;
}

/** A model going into `optimizeGltf`. */
export interface GltfInput {
  /** Base name of the files written next to the model, like `crate` for `crate.bin`. */
  name: string;
  /** A `.glb`, or the JSON of a `.gltf`. */
  data: Buffer;
  /** The files a `.gltf` refers to, by the path written in it, like `{ "crate.bin": buffer }`. */
  companions?: Record<string, Buffer>;
  /** The name the model refers to a file next to it by, from its plain name and bytes. Default: the plain name. */
  fileName?: (plainName: string, data: Buffer) => string;
}

/** A file written next to the model: a `.bin` or texture of the `gltf` form, or an extracted texture. */
export interface GltfFile {
  /** Plain name, like `crate.bin` or `crate_wood_baseColor.png`. */
  name: string;
  data: Buffer;
}

/** What `optimizeGltf` returns: the model, the files next to it, and its facts. */
export interface OptimizedGltf {
  /** A `.glb`, or the JSON of a `.gltf`. */
  data: Buffer;
  format: Form;
  files: GltfFile[];
  triangles: number;
  vertices: number;
  textures: number;
  animations: number;
}

export interface GltfAction extends ActionDefinition<GltfOptions> {
  /** Form, triangles, vertices, textures and animations of a model, read from its JSON alone. Also the probe for `when`. */
  readGltfMeta(input: Buffer | string): Promise<Partial<AssetMeta>>;
  /**
   * Optimize one model. With `extract`, its textures come back as files and the model holds none, like Blender's
   * export with images set to None. Throws when a `.gltf` refers to a file that is not among its companions.
   */
  optimizeGltf(model: GltfInput, options?: Partial<GltfOptions>): Promise<OptimizedGltf>;
}

const keep = (what: string) =>
  ({ kind: 'boolean', description: `Keep ${what}; false removes them`, default: true }) as const;

const options: OptionTable = {
  format: {
    kind: 'enum',
    values: FORMS,
    description: 'glb, gltf with separate files, or gltf with everything inside. Omitted: as the source'
  },
  quantize: {
    kind: 'boolean',
    description: 'Store vertex data in smaller numbers (KHR_mesh_quantization); every engine loads it without a decoder',
    default: true
  },
  simplify: {
    kind: 'object',
    description: "Fewer triangles, like Blender's Decimate. Runs only with a ratio",
    properties: {
      ratio: { kind: 'number', description: 'Share of triangles to keep, 0 to 1', min: 0, max: 1 },
      error: {
        kind: 'number',
        description: 'Most the shape may change, as a share of the model size; simplifying stops there',
        min: 0,
        max: 1,
        default: 0.01
      },
      method: {
        kind: 'enum',
        values: ['collapse', 'sloppy'],
        description: 'collapse keeps the shape and UV seams; sloppy is faster and coarser, for far LODs',
        default: 'collapse'
      }
    }
  },
  textures: {
    kind: 'object',
    description: 'Re-encode textures through the image action, or extract them as files next to the model',
    properties: {
      format: { kind: 'enum', values: ['png', 'jpeg', 'webp', 'avif'], description: 'Texture format. Omitted: as it is' },
      quality: { kind: 'number', description: 'Quality, as in the image action', min: 1, max: 100 },
      maxSize: {
        kind: 'number',
        description: 'Shrink textures wider or taller than this, keeping the aspect ratio',
        min: 1
      },
      extract: {
        kind: 'boolean',
        description: 'Write the textures as files next to the model and remove them from it',
        default: false
      }
    }
  },
  normals: keep('normals'),
  tangents: keep('tangents'),
  uvs: keep('UVs; without them textures go too'),
  vertexColors: keep('vertex colors'),
  materials: keep('materials; without them textures go'),
  animations: keep('animations')
};

/** Optimize glTF and GLB models: cleanup, removals, simplify, quantize and textures, all without a decoder. */
export const gltf: GltfAction = {
  name: 'gltf',
  // bump whenever a code change alters the output: cached results of older versions stop matching
  version: 1,
  cache: true,
  accepts: ['glb', 'gltf'],
  options,

  findCompanions(file) {
    if (extension(file.path) !== 'gltf') return [];
    try {
      return externalUris(JSON.parse(file.data.toString('utf8')))
        .filter((uri) => !isWebUrl(uri))
        .map((uri) => decodeURIComponent(uri));
    } catch {
      return [];
    }
  },

  async readGltfMeta(input) {
    const data = typeof input === 'string' ? await readModelHead(input) : input;
    const json = readJson(data);
    const count = (index: unknown) => (typeof index === 'number' ? (json.accessors?.[index]?.count ?? 0) : 0);
    let triangles = 0;
    let vertices = 0;
    for (const mesh of json.meshes ?? []) {
      for (const primitive of mesh.primitives ?? []) {
        const vertexCount = count(primitive.attributes?.['POSITION']);
        vertices += vertexCount;
        if ((primitive.mode ?? 4) === 4) {
          triangles += Math.floor((primitive.indices === undefined ? vertexCount : count(primitive.indices)) / 3);
        }
      }
    }
    return {
      format: formOf(data),
      triangles,
      vertices,
      textures: json.textures?.length ?? 0,
      animations: json.animations?.length ?? 0
    };
  },

  // every fact comes from the JSON, so `'cheap'` already gets them all
  probe(input) {
    return gltf.readGltfMeta(input);
  },

  async optimizeGltf(model, input = {}) {
    const options = resolveOptions<GltfOptions>(gltf.options, input);
    const tools = await loadGltfTransform();
    const sourceForm = formOf(model.data);
    const form = options.format ?? sourceForm;
    const doc = await readDocument(tools, model, sourceForm);
    const { functions } = tools;

    removeData(doc, options);
    const extracted = await processTextures(doc, model.name, options, tools);
    // extracted textures leave their UVs behind on purpose: the game puts the textures back
    await doc.transform(functions.prune({ keepAttributes: options.textures.extract }), functions.dedup(), functions.weld());
    if (options.simplify.ratio !== undefined)
      await simplify(doc, options.simplify as Required<GltfOptions['simplify']>, tools);
    if (options.quantize) await doc.transform(functions.quantize());
    await doc.transform(functions.unpartition());

    const written = await writeDocument(doc, form, model, tools);
    const meta = await gltf.readGltfMeta(written.data);
    return {
      data: written.data,
      format: form,
      files: [...written.files, ...extracted],
      triangles: meta.triangles as number,
      vertices: meta.vertices as number,
      textures: meta.textures as number,
      animations: meta.animations as number
    };
  },

  async transform(files, options, { filenameTemplate }) {
    // transformFiles keeps one output per input, so the files next to each model wait here and follow it
    const nextToModel = new Map<AssetFile, AssetFile[]>();
    const { outputs, errors } = await transformFiles(files, async (file) => {
      const name = basename(file.path).replace(/\.[^.]+$/, '');
      const folder = dirname(file.path);
      const optimized = await gltf.optimizeGltf(
        {
          name,
          data: file.data,
          companions: Object.fromEntries((file.companions ?? []).map((companion) => [companion.path, companion.data])),
          // the model refers to each file by the name the filename template gives it, as an atlas JSON does
          fileName: (plainName, data) =>
            basename(destinationPath({ path: plainName, data, meta: { size: 0 } }, filenameTemplate))
        },
        options
      );
      const { data, format, triangles, vertices, textures, animations } = optimized;
      const modelFile: AssetFile = {
        ...file,
        companions: undefined,
        path: join(folder, `${name}${format === 'glb' ? '.glb' : '.gltf'}`),
        data,
        meta: { ...file.meta, format, triangles, vertices, textures, animations }
      };
      nextToModel.set(
        modelFile,
        optimized.files.map((extra) => ({
          ...file,
          companions: undefined,
          path: join(folder, extra.name),
          data: extra.data,
          meta: { size: 0 }
        }))
      );
      return modelFile;
    });
    return { outputs: outputs.flatMap((model) => [model, ...(nextToModel.get(model) ?? [])]), errors };
  }
};

type GltfTransform = Awaited<ReturnType<typeof importGltfTransform>>;

let loading: Promise<GltfTransform> | undefined;

function loadGltfTransform(): Promise<GltfTransform> {
  loading ??= importGltfTransform();
  return loading;
}

async function importGltfTransform() {
  const [core, extensions, functions, meshoptimizer] = await Promise.all([
    import('@gltf-transform/core'),
    import('@gltf-transform/extensions'),
    import('@gltf-transform/functions'),
    import('meshoptimizer')
  ]);
  await meshoptimizer.MeshoptSimplifier.ready;
  // glTF Transform logs every step to the console; the build report says what happened instead
  const io = new core.NodeIO()
    .registerExtensions(extensions.ALL_EXTENSIONS)
    .setLogger(new core.Logger(core.Logger.Verbosity.SILENT));
  return { core, extensions, functions, simplifier: meshoptimizer.MeshoptSimplifier, io };
}

/** The parts of the glTF JSON this file reads. */
interface GltfJson {
  buffers?: Array<{ uri?: string }>;
  images?: Array<{ uri?: string; mimeType?: string }>;
  accessors?: Array<{ count?: number }>;
  meshes?: Array<{ primitives?: Array<{ attributes?: Record<string, number>; indices?: number; mode?: number }> }>;
  textures?: unknown[];
  animations?: unknown[];
}

// a .glb starts with "glTF", then its JSON chunk at byte 20; a .gltf is the JSON itself
function readJson(data: Buffer): GltfJson {
  if (data.length >= 20 && data.readUInt32LE(0) === GLB_MAGIC) {
    return JSON.parse(data.subarray(20, 20 + data.readUInt32LE(12)).toString('utf8')) as GltfJson;
  }
  return JSON.parse(data.toString('utf8')) as GltfJson;
}

// a .glb needs only its 20-byte header and JSON chunk, a few KB however big its geometry; a .gltf is the JSON itself
async function readModelHead(file: string): Promise<Buffer> {
  const handle = await fs.open(file, 'r');
  let head: Buffer | undefined;
  try {
    const header = Buffer.alloc(20);
    const { bytesRead } = await handle.read(header, 0, 20, 0);
    if (bytesRead === 20 && header.readUInt32LE(0) === GLB_MAGIC) {
      head = Buffer.alloc(20 + header.readUInt32LE(12));
      await handle.read(head, 0, head.length, 0);
    }
  } finally {
    await handle.close();
  }
  return head ?? fs.readFile(file);
}

function formOf(data: Buffer): Form {
  if (data.length >= 4 && data.readUInt32LE(0) === GLB_MAGIC) return 'glb';
  return externalUris(readJson(data)).length ? 'gltf' : 'gltf-embedded';
}

// the uris of buffers and images that live outside the JSON; data: uris are inside it
function externalUris(json: GltfJson): string[] {
  return [...(json.buffers ?? []), ...(json.images ?? [])]
    .map((item) => item.uri)
    .filter((uri): uri is string => typeof uri === 'string' && !uri.startsWith('data:'));
}

const isWebUrl = (uri: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(uri);

async function readDocument({ io }: GltfTransform, model: GltfInput, form: Form): Promise<Document> {
  if (form === 'glb') return io.readBinary(new Uint8Array(model.data));
  const json = readJson(model.data);
  const resources: Record<string, Uint8Array<ArrayBuffer>> = {};
  for (const uri of externalUris(json)) {
    if (isWebUrl(uri)) throw new Error(`${uri}: files on the web are not read; keep them next to the .gltf`);
    const companion = model.companions?.[decodeURIComponent(uri)];
    if (!companion) throw new Error(`${decodeURIComponent(uri)} is missing; it has to sit next to the .gltf`);
    resources[uri] = new Uint8Array(companion);
  }
  return io.readJSON({ json: json as never, resources });
}

function removeData(doc: Document, options: GltfOptions): void {
  const root = doc.getRoot();
  const primitives = root.listMeshes().flatMap((mesh) => mesh.listPrimitives());
  // morph targets carry their own normals and tangents
  const holders = [...primitives, ...primitives.flatMap((primitive) => primitive.listTargets())];
  const drop = (test: (semantic: string) => boolean) => {
    for (const holder of holders) {
      for (const semantic of holder.listSemantics()) if (test(semantic)) holder.setAttribute(semantic, null);
    }
  };
  if (!options.normals) drop((semantic) => semantic === 'NORMAL');
  if (!options.tangents) drop((semantic) => semantic === 'TANGENT');
  if (!options.vertexColors) drop((semantic) => semantic.startsWith('COLOR_'));
  if (!options.uvs) {
    drop((semantic) => semantic.startsWith('TEXCOORD_'));
    for (const texture of root.listTextures()) texture.dispose();
  }
  if (!options.materials) for (const material of root.listMaterials()) material.dispose();
  if (!options.animations) for (const animation of root.listAnimations()) animation.dispose();
}

async function processTextures(doc: Document, modelName: string, options: GltfOptions, tools: GltfTransform) {
  const { format, quality, maxSize, extract } = options.textures;
  const reencode = format !== undefined || quality !== undefined || maxSize !== undefined;
  const extracted: GltfFile[] = [];
  const names = new Set<string>();
  for (const texture of doc.getRoot().listTextures()) {
    const original = texture.getImage();
    if (!original) continue;
    let data: Buffer = Buffer.from(original);
    if (reencode && Object.values(MIME_TYPES).includes(texture.getMimeType())) {
      // a palette would band normal and roughness maps, so png textures stay lossless
      const optimized = await image.optimizeImage(data, {
        ...(format ? { format } : {}),
        ...(quality !== undefined ? { quality } : {}),
        ...(maxSize !== undefined ? { maxWidth: maxSize, maxHeight: maxSize } : {}),
        png: { palette: false, colors: 256, dither: 1, effort: 7 }
      });
      if (optimized) {
        data = optimized.data;
        texture.setImage(new Uint8Array(data)).setMimeType(MIME_TYPES[optimized.format as TextureFormat]);
      }
    }
    if (extract) {
      extracted.push({ name: uniqueName(textureFileName(modelName, texture, tools), names), data });
      texture.dispose();
    }
  }
  syncTextureExtensions(doc, tools);
  return extracted;
}

// webp and avif textures need their glTF extension declared; one no texture uses any more is dropped
function syncTextureExtensions(doc: Document, { extensions }: GltfTransform): void {
  const root = doc.getRoot();
  for (const [Extension, mimeType] of [
    [extensions.EXTTextureWebP, 'image/webp'],
    [extensions.EXTTextureAVIF, 'image/avif']
  ] as const) {
    const used = root.listTextures().some((texture) => texture.getMimeType() === mimeType);
    const declared = root.listExtensionsUsed().find((extension) => extension.extensionName === Extension.EXTENSION_NAME);
    // both extension classes work the same; the cast only satisfies createExtension's single-class signature
    if (used && !declared) doc.createExtension(Extension as typeof extensions.EXTTextureWebP).setRequired(true);
    if (!used && declared) declared.dispose();
  }
}

/** `crate_wood_baseColor.png`: the model, the first material using the texture, and the slot it fills. */
function textureFileName(modelName: string, texture: ReturnType<Document['createTexture']>, { functions }: GltfTransform) {
  const material = texture.listParents().find((parent) => parent.propertyType === 'Material');
  const slot = functions.listTextureSlots(texture)[0]?.replace(/Texture$/, '');
  const parts = [modelName, material?.getName() || texture.getName(), slot]
    .filter(Boolean)
    .map((part) => part!.replace(/[^\w-]+/g, '_'));
  return `${parts.join('_')}.${IMAGE_EXTENSIONS[texture.getMimeType()] ?? 'bin'}`;
}

function uniqueName(name: string, taken: Set<string>): string {
  let unique = name;
  for (let n = 2; taken.has(unique); n++) unique = name.replace(/(\.[^.]+)$/, `_${n}$1`);
  taken.add(unique);
  return unique;
}

async function simplify(doc: Document, options: Required<GltfOptions['simplify']>, tools: GltfTransform): Promise<void> {
  const { functions, simplifier } = tools;
  if (options.method === 'collapse') {
    await doc.transform(functions.simplify({ simplifier, ratio: options.ratio, error: options.error }));
    return;
  }
  // glTF Transform has no sloppy mode, so meshoptimizer runs on each triangle list directly
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const indices = primitive.getIndices();
      const position = primitive.getAttribute('POSITION');
      if (primitive.getMode() !== 4 || !indices || !position) continue;
      if (!(position.getArray() instanceof Float32Array)) functions.dequantizePrimitive(primitive);
      const positions = primitive.getAttribute('POSITION')?.getArray() as Float32Array;
      const source = Uint32Array.from(indices.getArray() ?? []);
      const target = Math.floor((source.length / 3) * options.ratio) * 3;
      const [result] = simplifier.simplifySloppy(source, positions, 3, null, target, options.error);
      if (!result.length) {
        primitive.dispose();
        continue;
      }
      primitive.setIndices(doc.createAccessor().setType('SCALAR').setArray(result).setBuffer(indices.getBuffer()));
      functions.compactPrimitive(primitive);
    }
  }
}

async function writeDocument(doc: Document, form: Form, model: GltfInput, tools: GltfTransform) {
  const { io, core } = tools;
  if (form === 'glb') return { data: Buffer.from(await io.writeBinary(doc)), files: [] as GltfFile[] };

  const root = doc.getRoot();
  const names = new Set<string>();
  root
    .listBuffers()
    .forEach((buffer, index) => buffer.setURI(index ? `${model.name}_${index + 1}.bin` : `${model.name}.bin`));
  for (const texture of root.listTextures()) texture.setURI(uniqueName(textureFileName(model.name, texture, tools), names));
  const { json, resources } = await io.writeJSON(doc, { format: core.Format.GLTF });

  const files: GltfFile[] = [];
  const items = [...(json.buffers ?? []), ...(json.images ?? [])] as Array<{ uri?: string; mimeType?: string }>;
  for (const item of items) {
    const bytes = item.uri === undefined ? undefined : resources[item.uri];
    if (!item.uri || !bytes) continue;
    const data = Buffer.from(bytes);
    if (form === 'gltf-embedded') {
      item.uri = `data:${item.mimeType ?? 'application/octet-stream'};base64,${data.toString('base64')}`;
      continue;
    }
    files.push({ name: item.uri, data });
    item.uri = encodeURI(model.fileName?.(item.uri, data) ?? item.uri);
  }
  return { data: Buffer.from(JSON.stringify(json)), files };
}
