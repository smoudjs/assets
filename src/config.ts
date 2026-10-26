// Everything about assets.json as a document: reading it, checking its keys, expanding presets and resolving
// the base folders. Out comes the list of actions ready to run, in order, and the two absolute folders.
//   "image"                          → an action with default settings
//   { action, source, destination }  → an action
//   { preset, source, destination }  → a group: the preset's actions, scoped by this entry

import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { actionLabel, actions, parseVirtualFolder, resolveOptions } from './actions/index.js';
import { normalizeDestination } from './files.js';
import type { ActionDefinition, AssetsConfig, Defaults, DestinationSpec, WhenSpec } from './types.js';
import { exists, isPathUnderFolder, samePath, toPosix } from './utils/fs.js';
import { deepMerge, isObject, toArray } from './utils/object.js';
import { suggest } from './utils/similarity.js';

const TOP_LEVEL_KEYS = ['source', 'destination', 'ignore', 'defaults', 'actions', 'clean'];
const ACTION_KEYS = ['action', 'source', 'destination'];
const PRESET_KEYS = ['preset', 'source', 'destination', 'defaults'];
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
  if (input === undefined && !(await exists(configPath))) return { config: {}, dir: process.cwd() };
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
  kind: 'action';
  /** 1-based position among the actions, for messages. */
  index: number;
  label: string;
  action: ActionDefinition;
  /** Checked and filled with defaults. */
  options: Record<string, unknown>;
  source: PreparedSource;
  /** `folder` undefined: each output lands where its source was. */
  destination: DestinationSpec;
}

/** A preset entry: its actions run inside the scope of this entry's source and destination. */
export interface PreparedGroup {
  kind: 'group';
  label: string;
  source: PreparedSource;
  destination?: DestinationSpec;
  items: PreparedItem[];
}

export type PreparedItem = PreparedAction | PreparedGroup;

export interface PreparedConfig {
  /** Absolute base folders, after the checks that keep a build from writing over its own source. */
  source: string;
  destination: string;
  ignore: string[];
  clean: boolean;
  items: PreparedItem[];
  warnings: string[];
  errors: string[];
}

/** What checking the document collects: the problems, and how many actions were numbered so far. */
interface Messages {
  actionCount: number;
  warnings: string[];
  errors: string[];
}

/** The document checked and expanded. Folder problems throw; everything else lands in `warnings` and `errors`. */
export async function prepareConfig(
  config: AssetsConfig,
  dir: string,
  overrides: { source?: string; destination?: string } = {}
): Promise<PreparedConfig> {
  const folders = resolveFolders(config, dir, overrides);
  const prepared: PreparedConfig = {
    ...folders,
    ignore: [],
    clean: config.clean !== false,
    items: [],
    warnings: [],
    errors: []
  };
  await checkFolders(folders.source, folders.destination);

  const messages: Messages = { actionCount: 0, warnings: prepared.warnings, errors: prepared.errors };
  warnUnknownKeys(config as Record<string, unknown>, TOP_LEVEL_KEYS, 'config', messages);
  prepared.ignore = parsePatterns(config.ignore, 'config ignore', messages);
  const defaults = parseDefaults(config.defaults, 'config defaults', messages);
  const entries: unknown = config.actions ?? [{ preset: 'default' }];
  if (!Array.isArray(entries)) {
    prepared.errors.push('"actions" must be a list');
    return prepared;
  }
  prepared.items = await expandEntries(entries, [defaults], dir, messages);
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
  return { source: resolveFolder('source', 'assets'), destination: resolveFolder('destination', 'assets/compiled') };
}

// the three layouts refused here would let `clean` delete the source or the project
async function checkFolders(source: string, destination: string): Promise<void> {
  const sourceStat = await fs.stat(source).catch(() => null);
  if (!sourceStat) throw new Error(`Source folder not found: ${source}`);
  if (!sourceStat.isDirectory()) throw new Error(`Source must be a folder: ${source}`);
  const destinationStat = await fs.stat(destination).catch(() => null);
  if (destinationStat && !destinationStat.isDirectory()) throw new Error(`Destination must be a folder: ${destination}`);

  if (samePath(destination, source)) throw new Error('Destination must not be the same folder as the source');
  if (samePath(destination, process.cwd())) throw new Error('Destination must not be the project root');
  if (isPathUnderFolder(source, destination)) throw new Error('Destination must not contain the source folder');
}

async function expandEntries(
  entries: unknown[],
  defaultsChain: Defaults[],
  dir: string,
  messages: Messages
): Promise<PreparedItem[]> {
  const items: PreparedItem[] = [];
  for (const [i, raw] of entries.entries()) {
    const entry = typeof raw === 'string' ? { action: raw } : raw;
    const position = `entry ${i + 1}`;
    if (!isObject(entry)) {
      messages.errors.push(`${position}: must be an action name, an action object or a preset object`);
      continue;
    }
    if (typeof entry['preset'] === 'string') {
      const group = await expandPreset(entry, defaultsChain, dir, messages);
      if (group) items.push(group);
      continue;
    }
    if (typeof entry['action'] !== 'string') {
      messages.errors.push(`${position}: needs "action" (an action type) or "preset" (a predefined set of actions)`);
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
    const merged = [...defaultsChain.map((defaults) => defaults[name] ?? {}), own].reduce(deepMerge, {});
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
    items.push({
      kind: 'action',
      index: messages.actionCount,
      label,
      action,
      options,
      source: parseSource(entry['source'], where, messages),
      destination: parseDestination(entry['destination'], where, messages)
    });
  }
  return items;
}

async function expandPreset(
  entry: Record<string, unknown>,
  defaultsChain: Defaults[],
  dir: string,
  messages: Messages
): Promise<PreparedGroup | null> {
  const name = entry['preset'] as string;
  const label = actionLabel(`preset ${name}`, entry['source'] as never);
  const extra = Object.keys(entry).filter((key) => !PRESET_KEYS.includes(key));
  if (extra.length) {
    messages.errors.push(`${label}: a preset entry takes no options (${extra.join(', ')}); put them under "defaults"`);
    return null;
  }

  let preset: AssetsConfig;
  let presetDir: string;
  try {
    ({ preset, dir: presetDir } = await loadPreset(name, dir));
  } catch (error) {
    messages.errors.push(`${label}: ${(error as Error).message}`);
    return null;
  }
  if (!Array.isArray(preset.actions)) {
    messages.errors.push(`${label}: the preset has no "actions"`);
    return null;
  }

  const chain = [preset.defaults ?? {}, ...defaultsChain, parseDefaults(entry['defaults'], `${label}, defaults`, messages)];
  const group: PreparedGroup = {
    kind: 'group',
    label,
    source: parseSource(entry['source'], label, messages),
    items: await expandEntries(preset.actions, chain, presetDir, messages)
  };
  if (entry['destination'] !== undefined) group.destination = parseDestination(entry['destination'], label, messages);
  return group;
}

/** Resolution order: a path, then a built-in `presets/<name>.json` of the package, then an installed package. */
async function loadPreset(name: string, fromDir: string): Promise<{ preset: AssetsConfig; dir: string }> {
  const isPath = name.startsWith('.') || path.isAbsolute(name) || name.endsWith('.json');
  if (isPath) {
    const file = path.resolve(fromDir, name);
    return { preset: await readConfigFile(file), dir: path.dirname(file) };
  }
  if (/^[\w-]+$/.test(name)) {
    const builtIn = fileURLToPath(new URL(`../presets/${name}.json`, import.meta.url));
    if (await exists(builtIn)) return { preset: await readConfigFile(builtIn), dir: path.dirname(builtIn) };
  }
  let file: string;
  try {
    file = createRequire(path.join(fromDir, 'noop.js')).resolve(name);
  } catch {
    throw new Error(`unknown preset "${name}"`);
  }
  return { preset: await readConfigFile(file), dir: path.dirname(file) };
}

function lookupAction(name: string): ActionDefinition | undefined {
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
