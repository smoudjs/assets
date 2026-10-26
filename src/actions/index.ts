// The registry of actions, the one way to add one, and the helpers every `process` is written with.

import { cpus } from 'node:os';
import path from 'node:path';
import { isFileList, normalizeDestination, outputPath, writeFiles } from '../files.js';
import type {
  ActionDefinition,
  ActionResult,
  AssetFile,
  Destination,
  FileResult,
  OptionDescriptor,
  OptionTable,
  Source
} from '../types.js';
import { join } from '../utils/fs.js';
import { isObject, toArray } from '../utils/object.js';
import { suggest } from '../utils/similarity.js';

export type ActionRegistry = {
  /** Adds an action, or replaces the one with the same name, and returns it. */
  register<O extends Record<string, unknown>>(definition: ActionDefinition<O>): ActionDefinition<O>;
} & Record<string, ActionDefinition>;

const registry: Record<string, ActionDefinition> = {};

/** Every registered action by name: the built-ins and whatever `register` added. */
export const actions: ActionRegistry = Object.defineProperty(registry, 'register', {
  value: register,
  enumerable: false
}) as ActionRegistry;

function register<O extends Record<string, unknown>>(definition: ActionDefinition<O>): ActionDefinition<O> {
  if (!/^[a-z][\w-]*$/i.test(definition.name) || definition.name === 'register') {
    throw new Error(`"${definition.name}" is not a valid action name`);
  }
  registry[definition.name] = definition as ActionDefinition;
  return definition;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

const RESERVED_KEYS = ['source', 'destination'];

/**
 * The options an action runs with: every value checked against the table, every missing key filled with its
 * default. An unknown key or a wrong value throws one error listing every problem.
 */
export function resolveOptions<O extends Record<string, unknown>>(table: OptionTable, input: Record<string, unknown>): O {
  const problems: string[] = [];
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const descriptor = table[key];
    if (!descriptor) {
      const hint = suggest(key, [...Object.keys(table), ...RESERVED_KEYS]);
      problems.push(`unknown option "${key}"${hint ? `, did you mean "${hint}"?` : ''}`);
      continue;
    }
    if (value === undefined) continue;
    const problem = findProblem(value, descriptor);
    if (problem) problems.push(`"${key}" ${problem}`);
    else result[key] = fillDefaults(value, descriptor);
  }
  if (problems.length) throw new Error(problems.join('; '));
  for (const [key, descriptor] of Object.entries(table)) {
    if (result[key] === undefined) result[key] = defaultFor(descriptor);
  }
  return result as O;
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
      return `must be ${describeExpected(d)}, got ${describeValue(value)}${hint ? `; did you mean ${JSON.stringify(hint)}?` : ''}`;
    }
    case 'object': {
      if (!isObject(value)) return `must be an object, got ${describeValue(value)}`;
      for (const [key, inner] of Object.entries(value)) {
        if (inner === undefined) continue;
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
      return `must be ${alternatives.map(describeExpected).join(' or ')}, got ${describeValue(value)}`;
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

function describeExpected(d: OptionDescriptor): string {
  if (d.kind === 'enum') return `one of ${(d.values ?? []).map((v) => JSON.stringify(v)).join(', ')}`;
  if (d.kind === 'list') return d.items ? `a list of ${describeExpected(d.items)}` : 'a list';
  if (d.kind === 'object') return 'an object';
  return `a ${d.kind}`;
}

function describeValue(value: unknown): string {
  if (Array.isArray(value)) return 'a list';
  if (isObject(value)) return 'an object';
  return JSON.stringify(value) ?? String(value);
}

// ---------------------------------------------------------------------------
// Running and finishing
// ---------------------------------------------------------------------------

const CONCURRENCY = Math.max(1, cpus().length - 1);

/**
 * Runs `transform` on every file, several at a time, keeping the input order. A throw becomes an error that
 * names the file, and the file is dropped; returning null drops it silently.
 */
export async function transformFiles(
  files: AssetFile[],
  transform: (file: AssetFile) => Promise<AssetFile | null>,
  errors: string[]
): Promise<AssetFile[]> {
  const outputs: Array<AssetFile | null> = new Array(files.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const index = next++;
      const file = files[index] as AssetFile;
      try {
        outputs[index] = await transform(file);
      } catch (error) {
        errors.push(`${file.origin ?? file.path}: ${(error as Error).message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));
  return outputs.filter((output): output is AssetFile => output !== null);
}

export interface ActionRun {
  action: string;
  source: Source | AssetFile[];
  destination?: Destination;
  /** The files the action received. */
  inputs: AssetFile[];
  /** What it produced. Outputs that keep the input's `origin` (spread the input) get their own result row. */
  outputs: AssetFile[];
  warnings: string[];
  errors: string[];
  /** `performance.now()` when `process` began. */
  started: number;
}

/**
 * Turns what a `process` did into its result. With a destination folder and no errors the outputs are written,
 * named by the filename template; with a `#virtual` destination they are renamed the same way but stay in memory.
 */
export async function finishAction(run: ActionRun): Promise<ActionResult> {
  const target = normalizeDestination(run.destination);
  const virtual = target.folder?.startsWith('#') ? splitVirtual(target.folder) : undefined;
  const warnings = [...run.warnings];
  if (!run.inputs.length) warnings.push('selected no files');

  let outputs = run.outputs.map((output) => ({ ...output, meta: { ...output.meta, size: output.data.length } }));
  let destination: string | null = null;
  if (virtual) {
    outputs = outputs.map((output) => ({ ...output, path: join(virtual.sub, outputPath(output, target.filename)) }));
  } else if (target.folder !== undefined && !run.errors.length) {
    const written = await writeFiles(outputs, target);
    outputs = outputs.map((output, index) => ({ ...output, path: written[index] as string }));
    destination = path.resolve(target.folder);
  }

  const inputsByOrigin = new Map(run.inputs.map((file) => [file.origin ?? file.path, file]));
  const bytesIn = run.inputs.reduce((total, file) => total + file.meta.size, 0);
  const rows = new Map<string, FileResult>();
  for (const output of outputs) {
    // group outputs, like atlas pages, have no origin: they share one row that stands for every input
    const key = output.origin ?? '#group';
    let row = rows.get(key);
    if (!row) {
      const input = output.origin === undefined ? undefined : inputsByOrigin.get(output.origin);
      row = {
        source: output.origin ?? `${run.inputs.length} files`,
        outputs: [],
        bytesIn: output.origin === undefined ? bytesIn : (input?.meta.size ?? 0),
        bytesOut: 0,
        keptOriginal: false
      };
      rows.set(key, row);
    }
    row.outputs.push(virtual ? `#${virtual.name}/${output.path}` : output.path);
    row.bytesOut += output.data.length;
    if (output.keptOriginal) row.keptOriginal = true;
  }

  // files handed in directly are taken to be outputs of an earlier action, not source files
  const origins = run.inputs.map((file) => file.origin ?? '');
  const fromMemory = isFileList(run.source);
  const virtualSources = new Set(origins.map((origin) => (origin.startsWith('#') ? splitVirtual(origin).name : fromMemory ? 'memory' : '')));
  return {
    ok: run.errors.length === 0,
    action: run.action,
    label: actionLabel(run.action, run.source),
    selected: run.inputs.length,
    ...(origins.length && virtualSources.size === 1 && !virtualSources.has('') ? { virtualSource: [...virtualSources][0] } : {}),
    files: [...rows.values()],
    outputs,
    destination,
    bytesIn,
    bytesOut: outputs.reduce((total, output) => total + output.data.length, 0),
    warnings,
    errors: run.errors,
    duration: performance.now() - run.started
  };
}

/** `image, source "ui"`: the label used in messages and the report. */
export function actionLabel(action: string, source: Source | AssetFile[] | undefined): string {
  if (source === undefined || isFileList(source)) return action;
  const include = isObject(source) ? source.include : source;
  if (include === undefined) return isObject(source) ? `${action}, filtered` : action;
  return `${action}, source "${toArray(include).join(', ')}"`;
}

/** `#tiles/half` → the virtual folder `tiles` and the sub-folder `half` inside it. */
export function splitVirtual(folder: string): { name: string; sub: string } {
  const [name, ...sub] = folder.slice(1).split('/');
  return { name: name ?? '', sub: sub.join('/') };
}
