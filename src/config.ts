// Everything about assets.json as a document: reading it, merging its preset, checking its keys and resolving
// the base folders. Out comes the list of actions ready to run, in order, and the two absolute folders.

import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { actionLabel, actions, parseVirtualFolder, resolveOptions } from './actions/index.js';
import { normalizeDestination } from './files.js';
import type { AssetsConfig, Defaults, DestinationSpec, RegisteredAction, WhenSpec } from './types.js';
import { isPathUnderFolder, samePath, statOrNull, toPosix } from './utils/fs.js';
import { deepMerge, isObject, toArray } from './utils/object.js';
import { suggest } from './utils/similarity.js';

const TOP_LEVEL_KEYS = ['preset', 'source', 'destination', 'ignore', 'defaults', 'actions', 'clean', 'cache'];
const PRESET_KEYS = ['defaults', 'actions'];
const ACTION_KEYS = ['action', 'source', 'destination'];
const SOURCE_KEYS = ['include', 'exclude', 'when'];
const DESTINATION_KEYS = ['folder', 'filename'];

export interface LoadedConfig {
  config: AssetsConfig;
  /** Folder the config's relative paths resolve from: the config file's folder, or the working directory. */
  dir: string;
}

/** An object is used as is, a string is a file path, nothing means `assets.json` in the working directory (or an empty config when absent). */
export async function loadConfig(input: string | AssetsConfig | undefined): Promise<LoadedConfig> {
  if (input !== undefined && typeof input !== 'string') return { config: input, dir: process.cwd() };
  const configPath = path.resolve(input ?? 'assets.json');
  if (input === undefined && !(await statOrNull(configPath))) return { config: {}, dir: process.cwd() };
  return { config: await readConfigFile(configPath), dir: path.dirname(configPath) };
}

/** A config or preset file is JSON. */
export async function readConfigFile(file: string): Promise<AssetsConfig> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    throw new Error(`Config file not found: ${file}`);
  }
  try {
    // editors on Windows may save a BOM, which JSON.parse rejects
    return JSON.parse(text.replace(/^﻿/, '')) as AssetsConfig;
  } catch (error) {
    throw new Error(`${path.basename(file)} is not valid JSON: ${(error as Error).message}`);
  }
}

/** What a `source` selects, with the `#rest` and `#virtual` forms parsed out. */
export interface PreparedSource {
  include: string[];
  exclude: string[];
  when?: WhenSpec;
  /** `"source": "#rest"`: what the actions above left. */
  rest: boolean;
  /** `"source": "#name"` or `"#name/sub/**"`: the virtual folder; `include` then holds the sub-pattern. */
  virtual?: string;
}

export interface PreparedAction {
  /** 1-based position among the actions, for messages. */
  index: number;
  label: string;
  action: RegisteredAction;
  /** Checked and filled with defaults. */
  options: Record<string, unknown>;
  source: PreparedSource;
  /** `folder` undefined: each output lands where its source was. */
  destination: DestinationSpec;
  /** Comes from the preset: it only sees the files the config's own actions left. */
  fromPreset: boolean;
}

export interface PreparedConfig {
  /** Absolute base folders, after the checks that keep a build from writing over its own source. */
  source: string;
  destination: string;
  ignore: string[];
  clean: boolean;
  /** Undefined when the config does not say: build and watch each have their own default. */
  cache?: boolean;
  /** The config's own actions first, then the preset's. */
  actions: PreparedAction[];
  warnings: string[];
  errors: string[];
}

/** What checking the document collects: the problems, and how many actions were numbered so far. */
interface Messages {
  actionCount: number;
  warnings: string[];
  errors: string[];
}

/** The document checked, with its preset merged. Folder problems throw; everything else lands in `warnings` and `errors`. */
export async function prepareConfig(
  config: AssetsConfig,
  dir: string,
  overrides: { source?: string; destination?: string; preset?: string } = {}
): Promise<PreparedConfig> {
  const folders = resolveFolders(config, dir, overrides);
  await checkFolders(folders.source, folders.destination);
  const prepared: PreparedConfig = {
    ...folders,
    ignore: [],
    clean: config.clean !== false,
    actions: [],
    warnings: [],
    errors: []
  };
  const messages: Messages = { actionCount: 0, warnings: prepared.warnings, errors: prepared.errors };
  warnUnknownKeys(config as Record<string, unknown>, TOP_LEVEL_KEYS, 'config', messages);
  prepared.ignore = parsePatterns(config.ignore, 'config ignore', messages);
  for (const key of ['clean', 'cache'] as const) {
    const value = config[key];
    if (value !== undefined && typeof value !== 'boolean') {
      prepared.errors.push(`"${key}" must be true or false, got ${JSON.stringify(value)}`);
    }
  }
  if (typeof config.cache === 'boolean') prepared.cache = config.cache;

  const ownEntries: unknown = config.actions ?? [];
  if (!Array.isArray(ownEntries)) {
    prepared.errors.push('"actions" must be a list');
    return prepared;
  }

  let preset: AssetsConfig = {};
  const presetName = overrides.preset ?? config.preset ?? (config.actions === undefined ? 'default' : undefined);
  if (presetName !== undefined) {
    const where = `preset "${presetName}"`;
    try {
      preset = await loadPreset(presetName, dir);
    } catch (error) {
      prepared.errors.push(`${where}: ${(error as Error).message}`);
      return prepared;
    }
    warnUnknownKeys(preset as Record<string, unknown>, PRESET_KEYS, where, messages);
    if (!Array.isArray(preset.actions)) {
      prepared.errors.push(`${where}: the preset has no "actions"`);
      return prepared;
    }
  }

  // the config's defaults win over the preset's, key by key
  const defaults = deepMerge(
    parseDefaults(preset.defaults, `preset "${presetName}", defaults`, messages),
    parseDefaults(config.defaults, 'config defaults', messages)
  ) as Defaults;
  prepared.actions = [
    ...prepareActions(ownEntries, defaults, false, messages),
    ...prepareActions(preset.actions ?? [], defaults, true, messages)
  ];
  return prepared;
}

// config folders are relative to the config file (`dir`), CLI overrides to the working directory
function resolveFolders(
  config: AssetsConfig,
  dir: string,
  overrides: { source?: string; destination?: string }
): { source: string; destination: string } {
  const resolveFolder = (key: 'source' | 'destination', fallback: string): string => {
    const value = config[key];
    if (value !== undefined && (typeof value !== 'string' || /[*?{}[\]]/.test(value))) {
      throw new Error(`"${key}" must be a folder path, got ${JSON.stringify(value)}. Move the pattern into an action.`);
    }
    const override = overrides[key];
    return override !== undefined ? path.resolve(override) : path.resolve(dir, value ?? fallback);
  };
  return { source: resolveFolder('source', 'assets'), destination: resolveFolder('destination', 'assets/optimized') };
}

// the two layouts refused here would let `clean` delete the source or the project. The source itself is allowed:
// the build then optimizes in place, and `clean` removes only source files nothing reproduced
async function checkFolders(source: string, destination: string): Promise<void> {
  const sourceStat = await statOrNull(source);
  if (!sourceStat) throw new Error(`Source folder not found: ${source}`);
  if (!sourceStat.isDirectory()) throw new Error(`Source must be a folder: ${source}`);
  const destinationStat = await statOrNull(destination);
  if (destinationStat && !destinationStat.isDirectory()) throw new Error(`Destination must be a folder: ${destination}`);

  if (samePath(destination, process.cwd())) throw new Error('Destination must not be the project root');
  if (isPathUnderFolder(source, destination)) throw new Error('Destination must not contain the source folder');
}

function prepareActions(entries: unknown[], defaults: Defaults, fromPreset: boolean, messages: Messages): PreparedAction[] {
  const prepared: PreparedAction[] = [];
  for (const [i, raw] of entries.entries()) {
    const entry = typeof raw === 'string' ? { action: raw } : raw;
    const position = `${fromPreset ? 'preset entry' : 'entry'} ${i + 1}`;
    if (!isObject(entry)) {
      messages.errors.push(`${position}: must be an action name or an action object`);
      continue;
    }
    if (entry['preset'] !== undefined) {
      messages.errors.push(`${position}: a preset goes in the top-level "preset" key, not in "actions"`);
      continue;
    }
    if (typeof entry['action'] !== 'string') {
      messages.errors.push(`${position}: needs "action", the name of an action`);
      continue;
    }

    const name = entry['action'];
    const action = lookupAction(name);
    const label = actionLabel(name, entry['source'] as never);
    if (!action) {
      const hint = suggest(name, Object.keys(actions));
      messages.errors.push(`${label}: unknown action "${name}"${hint ? `, did you mean "${hint}"?` : ''}`);
      continue;
    }

    messages.actionCount++;
    const where = `action ${messages.actionCount} (${label})`;
    const own = Object.fromEntries(Object.entries(entry).filter(([key]) => !ACTION_KEYS.includes(key)));
    const merged = deepMerge(defaults[name] ?? {}, own);
    // a typo in an option name is warned about and dropped, so one wrong key does not stop the whole build
    const known: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(merged)) {
      if (action.options[key]) {
        known[key] = value;
        continue;
      }
      const hint = suggest(key, [...Object.keys(action.options), ...ACTION_KEYS]);
      messages.warnings.push(`${where}: unknown option "${key}"${hint ? `, did you mean "${hint}"?` : ''}`);
    }
    let options: Record<string, unknown>;
    try {
      options = resolveOptions(action.options, known);
    } catch (error) {
      messages.errors.push(`${where}: ${(error as Error).message}`);
      continue;
    }
    prepared.push({
      index: messages.actionCount,
      label,
      action,
      options,
      source: parseSource(entry['source'], where, messages),
      destination: parseDestination(entry['destination'], where, messages),
      fromPreset
    });
  }
  return prepared;
}

/** The file a preset name points to when the name is a path (`./my.json`, absolute, or ending in `.json`). */
export function presetFilePath(name: string, fromDir: string): string | undefined {
  return name.startsWith('.') || path.isAbsolute(name) || name.endsWith('.json') ? path.resolve(fromDir, name) : undefined;
}

/** A preset's content. Resolution order: a path, then a built-in `presets/<name>.json` of the package, then an installed package. */
export async function loadPreset(name: string, fromDir: string): Promise<AssetsConfig> {
  const file = presetFilePath(name, fromDir);
  if (file) return readConfigFile(file);
  if (/^[\w-]+$/.test(name)) {
    const builtIn = fileURLToPath(new URL(`../presets/${name}.json`, import.meta.url));
    if (await statOrNull(builtIn)) return readConfigFile(builtIn);
  }
  let packageFile: string;
  try {
    packageFile = createRequire(path.join(fromDir, 'noop.js')).resolve(name);
  } catch {
    throw new Error(`unknown preset "${name}"`);
  }
  return readConfigFile(packageFile);
}

function lookupAction(name: string): RegisteredAction | undefined {
  const found = actions[name];
  return found && typeof found === 'object' ? found : undefined;
}

/** The `defaults` map: every key must be a registered action, every value an object of its options. */
function parseDefaults(raw: unknown, where: string, messages: Messages): Defaults {
  if (raw === undefined) return {};
  if (!isObject(raw)) {
    messages.errors.push(`${where}: must be an object of action names`);
    return {};
  }
  const defaults: Defaults = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!lookupAction(name)) {
      const hint = suggest(name, Object.keys(actions));
      messages.errors.push(`${where}: unknown action "${name}"${hint ? `, did you mean "${hint}"?` : ''}`);
    } else if (!isObject(value)) {
      messages.errors.push(`${where}: "${name}" must be an object of options`);
    } else {
      defaults[name] = value;
    }
  }
  return defaults;
}

function parseSource(raw: unknown, where: string, messages: Messages): PreparedSource {
  const source: PreparedSource = { include: [], exclude: [], rest: false };
  if (raw === undefined) return source;

  let include: unknown = raw;
  if (isObject(raw)) {
    warnUnknownKeys(raw, SOURCE_KEYS, `${where}, source`, messages);
    include = raw['include'];
    source.exclude = parsePatterns(raw['exclude'], `${where}, source.exclude`, messages);
    if (raw['when'] !== undefined) {
      if (isObject(raw['when'])) source.when = raw['when'] as WhenSpec;
      else messages.errors.push(`${where}: "when" must be an object`);
    }
  }

  const patterns = parsePatterns(include, `${where}, source`, messages);
  const virtual = patterns.find((pattern) => pattern.startsWith('#'));
  if (virtual === undefined) source.include = patterns;
  else if (patterns.length > 1) messages.errors.push(`${where}: a "#" source cannot be combined with other patterns`);
  else {
    const { name, sub } = parseVirtualFolder(virtual);
    if (name === 'rest') source.rest = true;
    else source.virtual = name;
    if (sub) source.include = [sub];
  }
  return source;
}

function parseDestination(raw: unknown, where: string, messages: Messages): DestinationSpec {
  if (raw === undefined || typeof raw === 'string') return normalizeDestination(raw);
  if (!isObject(raw)) {
    messages.errors.push(`${where}: destination must be a folder, a "#virtual" folder or an object`);
    return normalizeDestination(undefined);
  }
  warnUnknownKeys(raw, DESTINATION_KEYS, `${where}, destination`, messages);
  return normalizeDestination({
    folder: stringOrUndefined(raw['folder'], `${where}: destination "folder"`, messages),
    filename: stringOrUndefined(raw['filename'], `${where}: destination "filename"`, messages)
  });
}

// a wrong type is an error and the value is dropped
function stringOrUndefined(value: unknown, what: string, messages: Messages): string | undefined {
  if (value === undefined || typeof value === 'string') return value;
  messages.errors.push(`${what} must be a string`);
  return undefined;
}

function parsePatterns(raw: unknown, where: string, messages: Messages): string[] {
  const patterns: string[] = [];
  for (const item of toArray(raw)) {
    if (typeof item === 'string' && item.trim()) patterns.push(toPosix(item).replace(/^\.\//, ''));
    else messages.errors.push(`${where}: patterns must be non-empty strings, got ${JSON.stringify(item)}`);
  }
  return patterns;
}

function warnUnknownKeys(object: Record<string, unknown>, known: string[], where: string, messages: Messages): void {
  for (const key of Object.keys(object)) {
    if (known.includes(key)) continue;
    const hint = suggest(key, known);
    messages.warnings.push(`${where}: unknown key "${key}"${hint ? `, did you mean "${hint}"?` : ''}`);
  }
}
