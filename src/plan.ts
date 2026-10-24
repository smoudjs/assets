// Turns the `actions` of a config into a plan the runner can execute:
//   "image"                          → an action with default settings
//   { action, source, destination }  → an action
//   { preset, source, destination }  → a group: the preset's actions, scoped by this entry

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfigFile } from './config.js';
import type { ActionType, AssetsConfig, Defaults, OptionDescriptor, OptionTable, WhenSpec } from './types.js';
import { deepMerge, isObject } from './utils/object.js';
import { suggest } from './utils/similarity.js';

const DEFAULT_FILENAME = '[name][ext]';
const TOP_LEVEL_KEYS = ['source', 'destination', 'exclude', 'defaults', 'actions', 'cache', 'clean'];
const ACTION_KEYS = ['action', 'source', 'destination'];
const PRESET_KEYS = ['preset', 'source', 'destination', 'defaults'];
const SOURCE_KEYS = ['include', 'exclude', 'when'];
const DESTINATION_KEYS = ['folder', 'filename'];

/** What an action or group selects. `include: []` means everything the type can handle. */
export interface Selection {
  include: string[];
  exclude: string[];
  when?: WhenSpec;
  /** `"source": "#rest"` */
  rest: boolean;
  /** `"source": "#name"` or `"#name/sub/**"`: the virtual folder's name; `include` then holds the sub-pattern. */
  virtual?: string;
}

/**
 * Where results go. `folder` undefined means: mirror the source tree. With `virtual` set, results stay in
 * memory under that name and `folder` is the sub-folder inside it (`''` for its root).
 */
export interface Target {
  folder?: string;
  virtual?: string;
  filename: string;
}

export interface Action {
  kind: 'action';
  /** 1-based position in the expanded plan, for messages and results. */
  index: number;
  label: string;
  type: ActionType;
  options: Record<string, unknown>;
  source: Selection;
  destinations: Target[];
}

export interface Group {
  kind: 'group';
  label: string;
  source: Selection;
  /** Prefix for every result of the group: a folder or a virtual folder. Undefined mirrors. */
  destination?: Target;
  items: Item[];
}

export type Item = Action | Group;

export interface Plan {
  items: Item[];
  actionCount: number;
  warnings: string[];
  errors: string[];
}

export async function createPlan(config: AssetsConfig, types: Record<string, ActionType>, configDir: string): Promise<Plan> {
  const plan: Plan = { items: [], actionCount: 0, warnings: [], errors: [] };
  warnUnknownKeys(config as Record<string, unknown>, TOP_LEVEL_KEYS, 'config', plan);

  let entries = config.actions;
  if (entries === undefined) entries = [{ preset: 'default' }];
  if (!Array.isArray(entries)) {
    plan.errors.push('"actions" must be a list');
    return plan;
  }
  plan.items = await expandEntries(entries, [config.defaults ?? {}], configDir, types, plan);
  return plan;
}

async function expandEntries(
  entries: unknown[],
  defaultsChain: Defaults[],
  dir: string,
  types: Record<string, ActionType>,
  plan: Plan
): Promise<Item[]> {
  const items: Item[] = [];
  for (let i = 0; i < entries.length; i++) {
    const raw = entries[i];
    const entry = typeof raw === 'string' ? { action: raw } : raw;
    const position = `entry ${i + 1}`;

    if (!isObject(entry)) {
      plan.errors.push(`${position}: must be an action name, an action object or a preset object`);
      continue;
    }

    if (typeof entry['preset'] === 'string') {
      const group = await expandPreset(
        entry as { preset: string } & Record<string, unknown>,
        defaultsChain,
        dir,
        types,
        plan
      );
      if (group) items.push(group);
      continue;
    }

    if (typeof entry['action'] !== 'string') {
      plan.errors.push(`${position}: needs "action" (an action type) or "preset" (a predefined set of actions)`);
      continue;
    }

    const typeName = entry['action'];
    const type = types[typeName];
    const label = labelFor(typeName, entry['source']);
    if (!type) {
      const hint = suggest(typeName, Object.keys(types));
      plan.errors.push(`${label}: unknown action type "${typeName}"${hint ? `, did you mean "${hint}"?` : ''}`);
      continue;
    }

    plan.actionCount++;
    const where = `action ${plan.actionCount} (${label})`;
    const own = Object.fromEntries(Object.entries(entry).filter(([key]) => !ACTION_KEYS.includes(key)));
    const merged = [...defaultsChain.map((d) => d[typeName] ?? {}), own].reduce(deepMerge, {});
    items.push({
      kind: 'action',
      index: plan.actionCount,
      label,
      type,
      options: validateOptions(merged, type.options, where, plan),
      source: normalizeSource(entry['source'], where, plan),
      destinations: normalizeDestinations(entry['destination'], where, plan)
    });
  }
  return items;
}

async function expandPreset(
  entry: { preset: string } & Record<string, unknown>,
  defaultsChain: Defaults[],
  dir: string,
  types: Record<string, ActionType>,
  plan: Plan
): Promise<Group | null> {
  const label = labelFor(`preset ${entry.preset}`, entry['source']);
  const extra = Object.keys(entry).filter((key) => !PRESET_KEYS.includes(key));
  if (extra.length) {
    plan.errors.push(`${label}: a preset entry takes no options (${extra.join(', ')}); put them under "defaults"`);
    return null;
  }

  let preset: AssetsConfig;
  let presetDir: string;
  try {
    ({ preset, dir: presetDir } = await loadPreset(entry.preset, dir));
  } catch (error) {
    plan.errors.push(`${label}: ${(error as Error).message}`);
    return null;
  }
  if (!Array.isArray(preset.actions)) {
    plan.errors.push(`${label}: the preset has no "actions"`);
    return null;
  }

  const entryDefaults = isObject(entry['defaults']) ? (entry['defaults'] as Defaults) : {};
  const chain = [preset.defaults ?? {}, ...defaultsChain, entryDefaults];
  const targets = normalizeDestinations(entry['destination'], label, plan);
  const group: Group = {
    kind: 'group',
    label,
    source: normalizeSource(entry['source'], label, plan),
    items: await expandEntries(preset.actions, chain, presetDir, types, plan)
  };
  if (entry['destination'] !== undefined && targets[0]) group.destination = targets[0];
  return group;
}

/** Resolution order: a path, then a built-in `presets/<name>.json` of the package, then an installed package. */
async function loadPreset(name: string, fromDir: string): Promise<{ preset: AssetsConfig; dir: string }> {
  const isPath = name.startsWith('.') || path.isAbsolute(name) || /\.(json|m?js|cjs)$/.test(name);
  if (isPath) {
    const file = path.resolve(fromDir, name);
    return { preset: await readConfigFile(file), dir: path.dirname(file) };
  }
  if (/^[\w-]+$/.test(name)) {
    const builtIn = fileURLToPath(new URL(`../presets/${name}.json`, import.meta.url));
    try {
      return { preset: await readConfigFile(builtIn), dir: path.dirname(builtIn) };
    } catch {
      // not a built-in; fall through to packages
    }
  }
  let file: string;
  try {
    file = createRequire(path.join(fromDir, 'noop.js')).resolve(name);
  } catch {
    throw new Error(`unknown preset "${name}"`);
  }
  return { preset: await readConfigFile(file), dir: path.dirname(file) };
}

function normalizeSource(raw: unknown, where: string, plan: Plan): Selection {
  const selection: Selection = { include: [], exclude: [], rest: false };
  if (raw === undefined) return selection;

  let include: unknown = raw;
  if (isObject(raw)) {
    warnUnknownKeys(raw, SOURCE_KEYS, `${where}, source`, plan);
    include = raw['include'];
    selection.exclude = patternList(raw['exclude'], `${where}, source.exclude`, plan);
    if (raw['when'] !== undefined) {
      if (isObject(raw['when'])) selection.when = raw['when'] as WhenSpec;
      else plan.errors.push(`${where}: "when" must be an object`);
    }
  }

  const list = patternList(include, `${where}, source`, plan);
  const virtual = list.filter((p) => p.startsWith('#'));
  if (virtual.length === 0) {
    selection.include = list;
  } else if (virtual.length === 1 && list.length === 1) {
    const [name, ...rest] = (virtual[0] as string).slice(1).split('/');
    if (name === 'rest') {
      selection.rest = true;
      if (rest.length) selection.include = [rest.join('/')];
    } else {
      selection.virtual = name;
      selection.include = rest.length ? [rest.join('/')] : [];
    }
  } else {
    plan.errors.push(`${where}: a "#" source cannot be combined with other patterns`);
  }
  return selection;
}

function normalizeDestinations(raw: unknown, where: string, plan: Plan): Target[] {
  if (raw === undefined) return [{ filename: DEFAULT_FILENAME }];
  const list = Array.isArray(raw) ? raw : [raw];
  const targets: Target[] = [];
  for (const item of list) {
    if (typeof item === 'string') {
      targets.push(parseTarget(item, DEFAULT_FILENAME));
    } else if (isObject(item)) {
      warnUnknownKeys(item, DESTINATION_KEYS, `${where}, destination`, plan);
      const folder = item['folder'];
      const filename = item['filename'];
      if (folder !== undefined && typeof folder !== 'string')
        plan.errors.push(`${where}: destination "folder" must be a string`);
      if (filename !== undefined && typeof filename !== 'string')
        plan.errors.push(`${where}: destination "filename" must be a string`);
      targets.push(
        parseTarget(
          typeof folder === 'string' ? folder : undefined,
          typeof filename === 'string' ? filename : DEFAULT_FILENAME
        )
      );
    } else {
      plan.errors.push(`${where}: destination must be a folder, a "#virtual" folder or an object`);
    }
  }
  return targets.length ? targets : [{ filename: DEFAULT_FILENAME }];
}

/** `"ui"` → a folder; `"#tiles"` → the root of a virtual folder; `"#tiles/half"` → a sub-folder inside it. */
function parseTarget(folder: string | undefined, filename: string): Target {
  if (folder === undefined) return { filename };
  const clean = folder.replace(/\\/g, '/').replace(/^\.\/|\/$/g, '');
  if (!clean.startsWith('#')) return { folder: clean, filename };
  const [name, ...sub] = clean.slice(1).split('/');
  return { virtual: name, folder: sub.join('/'), filename };
}

function patternList(raw: unknown, where: string, plan: Plan): string[] {
  if (raw === undefined) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  const result: string[] = [];
  for (const item of list) {
    if (typeof item === 'string' && item.trim()) result.push(item.replace(/\\/g, '/').replace(/^\.\//, ''));
    else plan.errors.push(`${where}: patterns must be non-empty strings, got ${JSON.stringify(item)}`);
  }
  return result;
}

/** Unknown keys are warned about and dropped; wrong values are errors; missing keys get their defaults. */
export function validateOptions(
  options: Record<string, unknown>,
  table: OptionTable,
  where: string,
  plan: Plan
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    const descriptor = table[key];
    if (!descriptor) {
      const hint = suggest(key, [...Object.keys(table), ...ACTION_KEYS]);
      plan.warnings.push(`${where}: unknown option "${key}"${hint ? `, did you mean "${hint}"?` : ''}`);
      continue;
    }
    if (value === undefined) continue;
    const problem = findProblem(value, descriptor);
    if (problem) plan.errors.push(`${where}: "${key}" ${problem}`);
    else result[key] = fillDefaults(value, descriptor);
  }
  for (const [key, descriptor] of Object.entries(table)) {
    if (result[key] === undefined) result[key] = defaultFor(descriptor);
  }
  return result;
}

// An object option without its own default is built from the defaults of its properties,
// so `png: { palette: true, ... }` exists even when the user never mentions `png`.
function defaultFor(d: OptionDescriptor): unknown {
  if (d.default !== undefined) return d.default;
  if (d.kind === 'object' && d.properties) return fillDefaults({}, d);
  return undefined;
}

function findProblem(value: unknown, d: OptionDescriptor): string | null {
  switch (d.kind) {
    case 'boolean':
      return typeof value === 'boolean' ? null : `must be true or false, got ${describeValue(value)}`;
    case 'number':
      if (typeof value !== 'number' || Number.isNaN(value)) return `must be a number, got ${describeValue(value)}`;
      if (d.min !== undefined && value < d.min) return `must be at least ${d.min}, got ${value}`;
      if (d.max !== undefined && value > d.max) return `must be at most ${d.max}, got ${value}`;
      return null;
    case 'string':
      return typeof value === 'string' ? null : `must be a string, got ${describeValue(value)}`;
    case 'enum': {
      const values = d.values ?? [];
      if (values.includes(value as string)) return null;
      const hint = typeof value === 'string' ? suggest(value, values.map(String)) : undefined;
      return `must be one of ${values.map((v) => JSON.stringify(v)).join(', ')}, got ${describeValue(value)}${hint ? `; did you mean ${JSON.stringify(hint)}?` : ''}`;
    }
    case 'object': {
      if (!isObject(value)) return `must be an object, got ${describeValue(value)}`;
      for (const [key, inner] of Object.entries(value)) {
        const descriptor = d.properties?.[key];
        if (!descriptor) {
          const hint = suggest(key, Object.keys(d.properties ?? {}));
          return `has an unknown key "${key}"${hint ? `, did you mean "${hint}"?` : ''}`;
        }
        const problem = findProblem(inner, descriptor);
        if (problem) return `"${key}" ${problem}`;
      }
      return null;
    }
    case 'list': {
      if (!Array.isArray(value)) return `must be a list, got ${describeValue(value)}`;
      for (let i = 0; i < value.length; i++) {
        const problem = d.items ? findProblem(value[i], d.items) : null;
        if (problem) return `item ${i + 1} ${problem}`;
      }
      return null;
    }
    case 'oneOf': {
      const alternatives = d.oneOf ?? [];
      if (alternatives.some((alternative) => findProblem(value, alternative) === null)) return null;
      return `must be ${alternatives.map(describeDescriptor).join(' or ')}, got ${describeValue(value)}`;
    }
  }
}

// A oneOf value takes the defaults of the first alternative it fits.
function fillDefaults(value: unknown, d: OptionDescriptor): unknown {
  if (d.kind === 'oneOf') {
    const match = (d.oneOf ?? []).find((alternative) => findProblem(value, alternative) === null);
    return match ? fillDefaults(value, match) : value;
  }
  if (d.kind === 'object' && isObject(value) && d.properties) {
    const result = { ...value };
    for (const [key, inner] of Object.entries(d.properties)) {
      result[key] = result[key] === undefined ? defaultFor(inner) : fillDefaults(result[key], inner);
    }
    return result;
  }
  return value;
}

function describeDescriptor(d: OptionDescriptor): string {
  if (d.kind === 'enum') return `one of ${(d.values ?? []).map((v) => JSON.stringify(v)).join(', ')}`;
  if (d.kind === 'list') return d.items ? `a list of ${describeDescriptor(d.items)}` : 'a list';
  if (d.kind === 'object') return 'an object';
  return `a ${d.kind}`;
}

/** `image, source "ui"`: the label used in messages and the report. An object source is described by its `include`. */
function labelFor(name: string, source: unknown): string {
  const include = isObject(source) ? source['include'] : source;
  if (include === undefined) return isObject(source) ? `${name}, filtered` : name;
  return `${name}, source "${Array.isArray(include) ? include.join(', ') : String(include)}"`;
}

function warnUnknownKeys(object: Record<string, unknown>, known: string[], where: string, plan: Plan): void {
  for (const key of Object.keys(object)) {
    if (known.includes(key)) continue;
    const hint = suggest(key, known);
    plan.warnings.push(`${where}: unknown key "${key}"${hint ? `, did you mean "${hint}"?` : ''}`);
  }
}

function describeValue(value: unknown): string {
  if (Array.isArray(value)) return 'a list';
  if (isObject(value)) return 'an object';
  return JSON.stringify(value) ?? String(value);
}
