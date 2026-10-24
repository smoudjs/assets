/**
 * Types of @smoud/assets: the config a user writes, the action-type interface an implementation
 * fulfils, and the result a build returns. Nothing here touches the filesystem.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** A glob, a folder, a single file, or a `#virtual` folder. Relative to the base source folder. */
export type SourcePattern = string;

/** Numeric comparison as a string: `">200kb"`, `">=1024"`, `"<2mb"`. An array means every bound must hold. */
export type Comparison = string | string[];

/** Facts about a file that a `source` can filter on. */
export interface WhenSpec {
  alpha?: boolean;
  animated?: boolean;
  /** With unit: `b`, `kb`, `mb`. */
  size?: Comparison;
  width?: Comparison;
  height?: Comparison;
}

export interface SourceSpec {
  /** Omitted: every file under the base source folder that the action type can handle. */
  include?: SourcePattern | SourcePattern[];
  /** Always wins over `include`. */
  exclude?: SourcePattern | SourcePattern[];
  when?: WhenSpec;
}

/** `"source": "ui"` is shorthand for `{ "include": "ui" }`. */
export type Source = SourcePattern | SourcePattern[] | SourceSpec;

export interface DestinationSpec {
  /** Relative to the base destination folder, or a `#virtual` folder. Omitted: mirror the source tree. */
  folder?: string;
  /** Tokens: `[name]`, `[ext]`, `[hash]` (8 chars), `[hash:n]`. Default `[name][ext]`. */
  filename?: string;
}

/** `"destination": "ui"` is shorthand for `{ "folder": "ui" }`. An array writes to several places. */
export type Destination = string | DestinationSpec | Array<string | DestinationSpec>;

/** The reserved keys of an action. Everything else on the object belongs to the action type. */
export interface ActionBase {
  action: string;
  source?: Source;
  destination?: Destination;
}

export type ActionConfig = ActionBase & Record<string, unknown>;

/** A preset reference inside `actions`. Scope only, never flat options. */
export interface PresetEntry {
  /** Built-in name, relative path, or npm package name. */
  preset: string;
  source?: Source;
  destination?: Destination;
  /** Overrides the preset's own `defaults` for this scope only. */
  defaults?: Defaults;
}

/** A string is an action type with default settings: `"image"` equals `{ "action": "image" }`. */
export type ActionEntry = string | ActionConfig | PresetEntry;

/** Starting options per action type, e.g. `{ "image": { "quality": 80 } }`. */
export type Defaults = Record<string, Record<string, unknown>>;

/** assets.json. A preset file has the same shape. */
export interface AssetsConfig {
  /** Base source folder. Always a folder. Default `assets`. */
  source?: string;
  /** Base destination folder. Always a folder. Default `assets/compiled`. */
  destination?: string;
  /** Never selected by anything. */
  exclude?: SourcePattern | SourcePattern[];
  defaults?: Defaults;
  /** Omitted: the built-in `default` preset's actions. */
  actions?: ActionEntry[];
  /** `true` (default), `false`, or a cache directory. */
  cache?: boolean | string;
  /** Remove stale files from the destination after a successful build. Default `true`. */
  clean?: boolean;
}

// ---------------------------------------------------------------------------
// Files in the pipeline
// ---------------------------------------------------------------------------

/** `size` is always known; the rest is filled by a type's probe when `when` needs it. */
export interface AssetMeta {
  size: number;
  /** `png`, `jpeg`, `webp`, `gif`, `svg`, ... */
  format?: string;
  width?: number;
  height?: number;
  alpha?: boolean;
  animated?: boolean;
}

/** Pure data. Processors receive and return these and never touch disk. */
export interface AssetFile {
  /** Posix path relative to the folder it was selected from. */
  path: string;
  data: Buffer;
  meta: AssetMeta;
  /** Values for filename tokens. A type may set `hash` so that linked outputs, like an atlas page and its JSON, share one. */
  tokens?: Record<string, string | number>;
  /** Set when a type emitted the original bytes because re-encoding would have grown the file. */
  keptOriginal?: boolean;
}

// ---------------------------------------------------------------------------
// Action types
// ---------------------------------------------------------------------------

export type OptionKind = 'boolean' | 'number' | 'string' | 'enum' | 'object' | 'list' | 'oneOf';

/** One table per type drives validation, the editor schema and `--help`. */
export interface OptionDescriptor {
  kind: OptionKind;
  description: string;
  default?: unknown;
  /** `enum` */
  values?: readonly (string | number)[];
  /** `number` */
  min?: number;
  max?: number;
  /** `object` */
  properties?: OptionTable;
  /** `list` */
  items?: OptionDescriptor;
  /** `oneOf`: alternatives tried in order, for shorthand-or-object options */
  oneOf?: OptionDescriptor[];
}

export type OptionTable = Record<string, OptionDescriptor>;

export interface ProcessContext {
  /**
   * Name of the folder all files were selected from: `"ui"` for `"source": "images/ui"`, the virtual folder's
   * name for `"#icons"`, `""` when the files come from several folders. Group outputs such as an atlas are named after it.
   */
  folder: string;
  /** The name an output will have on disk, after the destination's `filename` template. An atlas JSON names its image with it. */
  filename(file: AssetFile): string;
  /** Warn about the current action. The build continues. */
  warn(message: string): void;
  /** Report a broken file. The build continues, nothing is committed. */
  fail(file: AssetFile, message: string): void;
  /** How many files may be processed at the same time. */
  concurrency: number;
}

/**
 * `image`, `copy`, later `atlas`, `audio`, ... Pure by contract: files and options in, files out.
 * Finding, filtering and writing belong to the engine.
 */
export interface ActionType<O extends Record<string, unknown> = Record<string, unknown>> {
  /** The word users write after `"action":`. */
  name: string;
  /** Bumped whenever output for identical input and options could change. Part of the cache key. */
  version: string;
  /** Lower-case extensions without the dot this type can handle, or `'*'` for every file. */
  accepts: readonly string[] | '*';
  options: OptionTable;
  /** Optional: fill `width`, `alpha`, ... so `when` can filter on them. */
  probe?(file: AssetFile): Promise<Partial<AssetMeta>>;
  process(files: AssetFile[], options: O, context: ProcessContext): Promise<AssetFile[]>;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface FileResult {
  /** 1-based position of the action in the expanded plan. */
  action: number;
  /** Relative to the base source, or `#virtual/path`. */
  source: string;
  /** Relative to the base destination, or `#virtual/path`. */
  outputs: string[];
  bytesIn: number;
  bytesOut: number;
  cached: boolean;
  keptOriginal: boolean;
}

export interface ActionResult {
  index: number;
  /** e.g. `image, source "ui"` */
  label: string;
  type: string;
  /** How many source files the action received. */
  selected: number;
  /** One per source file, or one for all of them when the type packs its files into group outputs (atlas). */
  files: FileResult[];
  bytesIn: number;
  bytesOut: number;
  /** Milliseconds. */
  duration: number;
}

export interface BuildResult {
  /** No errors. Warnings do not make it false unless `strict`. */
  ok: boolean;
  dryRun: boolean;
  /** Absolute base folders. `destination` is null for an in-memory standalone call. */
  source: string;
  destination: string | null;
  actions: ActionResult[];
  /** Source files no action selected, relative to the base source. */
  unselected: string[];
  warnings: string[];
  errors: string[];
  /** In-memory results of a standalone call made without a destination. */
  outputs: AssetFile[];
  /** Every virtual folder the build produced, by name without `#`. */
  virtual: Record<string, AssetFile[]>;
  /** Milliseconds. */
  duration: number;
}
