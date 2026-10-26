/**
 * Types of @smoud/assets: the config a user writes, the action an implementation registers, the files that
 * flow through, and the results that come back. Nothing here touches the filesystem.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** A glob, a folder, a single file, or a `#virtual` folder. Relative to the base source folder. */
export type SourcePattern = string;

/** Numeric comparison as a string: `">200kb"`, `">=1024"`, `"<2mb"`. An array means every bound must hold. */
export type Comparison = string | string[];

/**
 * Facts a `source` filters on. `size` is always known. Every other key, like `width` or `alpha`, is answered
 * by the probe of the action that selects, and is compared as a boolean or as a `Comparison`.
 */
export interface WhenSpec {
  size?: Comparison;
  [fact: string]: boolean | Comparison | undefined;
}

export interface SourceSpec {
  /** Omitted: every file under the base source folder that the action can handle. */
  include?: SourcePattern | SourcePattern[];
  /** Always wins over `include`. */
  exclude?: SourcePattern | SourcePattern[];
  when?: WhenSpec;
}

/** `"source": "ui"` is shorthand for `{ "include": "ui" }`. */
export type Source = SourcePattern | SourcePattern[] | SourceSpec;

export interface DestinationSpec {
  /** A folder, or a `#virtual` folder that stays in memory. Omitted in a config: mirror the source tree. */
  folder?: string;
  /** Tokens: `[name]`, `[ext]`, `[hash]` (8 chars), `[hash:n]`. Default `[name][ext]`. */
  filename?: string;
}

/** `"destination": "ui"` is shorthand for `{ "folder": "ui" }`. */
export type Destination = string | DestinationSpec;

/** The reserved keys of an action entry. Everything else on the object is an option of the action. */
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

/** A string is an action with default settings: `"image"` equals `{ "action": "image" }`. */
export type ActionEntry = string | ActionConfig | PresetEntry;

/** Option overrides per action name, e.g. `{ "image": { "quality": 80 } }`. Unknown names and options are errors. */
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
  /** Remove stale files from the destination after a successful build. Default `true`. */
  clean?: boolean;
}

// ---------------------------------------------------------------------------
// Files in the pipeline
// ---------------------------------------------------------------------------

/** What a probe knows about a file: `{ width: 64, alpha: true }` for an image. */
export type Facts = Record<string, number | boolean | string | undefined>;

/** `size` is always known; the rest comes from a probe when a `when` needs it. */
export interface AssetMeta extends Facts {
  size: number;
}

/** Pure data. Actions receive and return these; only `selectFiles` and `writeFiles` touch disk. */
export interface AssetFile {
  /** Posix path relative to the folder it was selected from. */
  path: string;
  data: Buffer;
  meta: AssetMeta;
  /** Where it came from: relative to the root it was selected from, or `#name/path`. Set by `selectFiles`. */
  origin?: string;
  /** Folder part of the pattern that selected it, put back when a destination mirrors the source tree. Set by `selectFiles`. */
  base?: string;
  /** Values for filename tokens. An action may set `hash` so that linked outputs, like an atlas page and its JSON, share one. */
  tokens?: Record<string, string | number>;
  /** The original bytes were kept because the processed result would have been bigger. */
  keptOriginal?: boolean;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type OptionKind = 'boolean' | 'number' | 'string' | 'enum' | 'object' | 'list' | 'oneOf';

/** One table per action drives validation, defaults, the editor schema and `--help`. */
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

/** Reads facts out of a file's bytes so a `when` can filter on them. */
export type Probe = (data: Buffer) => Promise<Facts>;

/** What every `process` takes, next to the action's own options: `process({ source, destination, quality: 80 })`. */
export interface ProcessParams {
  /** A pattern, folder, file or spec relative to the working directory, or files already in memory. */
  source: Source | AssetFile[];
  /** A folder, or a `#virtual` folder. Omitted: nothing is written and the outputs come back on the result. */
  destination?: Destination;
}

/**
 * An action: what `actions.register` takes and what `actions.<name>` holds. `process` is the one required
 * function and has the same parameters and result for every action. Raw functions such as `packAtlas` sit
 * next to it under their own names.
 */
export interface ActionDefinition<O extends Record<string, unknown> = Record<string, unknown>> {
  /** The word users write after `"action":`. */
  name: string;
  /** Lower-case extensions without the dot this action handles, or `'*'` for every file. */
  accepts: readonly string[] | '*';
  options: OptionTable;
  /** Optional: answers `when` keys other than `size`. */
  probe?: Probe;
  process(input: ProcessParams & Partial<O>): Promise<ActionResult>;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface FileResult {
  /** Relative to the root it was selected from, or `#virtual/path`. */
  source: string;
  /** Relative to the destination folder, or `#virtual/path`. */
  outputs: string[];
  bytesIn: number;
  bytesOut: number;
  keptOriginal: boolean;
}

/** What `process` returns and what the report prints. A build holds one per action. */
export interface ActionResult {
  /** No errors. */
  ok: boolean;
  /** The action's name. */
  action: string;
  /** e.g. `image, source "ui"` */
  label: string;
  /** How many source files the action received. */
  selected: number;
  /** The virtual folder the files came from, or `memory` for files handed in directly. Those bytes are not source bytes. */
  virtualSource?: string;
  /** One per source file, or one for all of them when the action packs its files into group outputs (atlas). */
  files: FileResult[];
  /** The produced files, in memory. */
  outputs: AssetFile[];
  /** Absolute folder written to; null when the outputs stayed in memory. */
  destination: string | null;
  bytesIn: number;
  bytesOut: number;
  warnings: string[];
  errors: string[];
  /** Milliseconds. */
  duration: number;
}

export interface BuildResult {
  /** No errors, and no warnings when `strict`. */
  ok: boolean;
  dryRun: boolean;
  /** Absolute base folders. */
  source: string;
  destination: string;
  actions: ActionResult[];
  /** Source files no action selected, relative to the base source. */
  unselected: string[];
  warnings: string[];
  errors: string[];
  /** Milliseconds. */
  duration: number;
}
