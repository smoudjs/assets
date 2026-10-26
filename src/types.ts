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

/** A string is an action with default settings: `"image"` equals `{ "action": "image" }`. */
export type ActionEntry = string | ActionConfig;

/** Option overrides per action name, e.g. `{ "image": { "quality": 80 } }`. Unknown names and options are errors. */
export type Defaults = Record<string, Record<string, unknown>>;

/** assets.json. */
export interface AssetsConfig {
  /**
   * A base config yours extends: a built-in name, a path to a JSON file, or an installed package. Its `defaults`
   * merge under yours; your actions run first and its actions take the files yours left. Omitted with no
   * `actions`: the built-in `default` preset.
   */
  preset?: string;
  /** Base source folder. Always a folder. Default `assets`. */
  source?: string;
  /** Base destination folder. Always a folder. Default `assets/compiled`. */
  destination?: string;
  /** Files the build never sees. No action can select them. */
  ignore?: SourcePattern | SourcePattern[];
  defaults?: Defaults;
  actions?: ActionEntry[];
  /** Remove stale files from the destination after a successful build. Default `true`. */
  clean?: boolean;
}

// ---------------------------------------------------------------------------
// Files in the pipeline
// ---------------------------------------------------------------------------

/** Facts about a file. `size` is always known; the rest, like `{ width: 64, alpha: true }`, comes from a probe. */
export interface AssetMeta {
  size: number;
  [fact: string]: number | boolean | string | undefined;
}

/** Pure data. Actions receive and return these; only `selectFiles` and `writeFiles` touch disk. */
export interface AssetFile {
  /** Posix path relative to the folder it was selected from. */
  path: string;
  data: Buffer;
  meta: AssetMeta;
  /** Where it came from: relative to the root it was selected from, or `#name/path`. Set by `selectFiles`. */
  origin?: string;
  /** Folder part of the pattern that selected it, like `ui` for `"ui/**"`. A build puts it back when no destination folder is given. Set by `selectFiles`. */
  selectedFrom?: string;
  /** Values for the filename template. An action may set `hash` so that linked outputs, like an atlas page and its JSON, share one. */
  filenameTokens?: Record<string, string | number>;
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
export type Probe = (data: Buffer) => Promise<Partial<AssetMeta>>;

/** What every `process` takes, next to the action's own options: `process({ source, destination, quality: 80 })`. */
export interface ProcessParams {
  /** A pattern, folder, file or spec relative to the working directory, or files already in memory. */
  source: Source | AssetFile[];
  /** A folder, or a `#virtual` folder. Omitted: nothing is written and the outputs come back on the result. */
  destination?: Destination;
}

/** What `transform` gets besides the files and options. */
export interface TransformContext {
  /** Name of the folder the files were selected from, like `sprites`; `''` when they come from several. Names combined outputs, like an atlas. */
  folderName: string;
  /** The destination's filename template, like `[name].[hash][ext]`. With `destinationPath` it gives an output's final name before it is written. */
  filenameTemplate: string;
}

/** What `transform` may return instead of a plain list, to report problems without stopping. */
export interface TransformResult {
  outputs: AssetFile[];
  warnings?: string[];
  /** Broken files. The action fails and nothing is written. */
  errors?: string[];
}

/**
 * An action: what `actions.register` takes and what `actions.<name>` holds. You write `transform`, which
 * turns the selected files into outputs; `register` adds `process`, which selects, checks the options,
 * transforms, writes and reports. An action that defines `process` itself is used as is. Raw functions such
 * as `packAtlas` sit next to them under their own names.
 */
export interface ActionDefinition<O extends Record<string, unknown> = Record<string, unknown>> {
  /** The word users write after `"action":`. */
  name: string;
  /** Lower-case extensions without the dot this action handles, or `'*'` for every file. */
  accepts: readonly string[] | '*';
  options: OptionTable;
  /** Optional: answers `when` keys other than `size`. */
  probe?: Probe;
  /** All selected files in, all outputs out. A throw fails the action. */
  transform?(files: AssetFile[], options: O, context: TransformContext): Promise<AssetFile[] | TransformResult>;
  /** Source, destination and options in, the full result out. Added by `register` unless you write it. */
  process?(input: ProcessParams & Partial<O>): Promise<ActionResult>;
}

/** An action after `actions.register`: `process` is always there. */
export type RegisteredAction<A extends ActionDefinition<any> = ActionDefinition> = A & {
  process(input: ProcessParams & Record<string, unknown>): Promise<ActionResult>;
};

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
  /** Set when the files came from memory: the virtual folder's name, or `memory` for files handed in directly. Those bytes are not source bytes. */
  memorySource?: string;
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
