// The registry of actions, the one way to add one, and what turns a `transform` into a full `process`.

import { cpus } from 'node:os';
import path from 'node:path';
import { cacheKey, readCache, writeCache } from '../cache.js';
import { destinationPath, isFileList, normalizeDestination, selectFiles, writeFiles } from '../files.js';
import type {
  ActionDefinition,
  ActionResult,
  AssetFile,
  Destination,
  FileResult,
  OptionDescriptor,
  OptionTable,
  ProcessParams,
  RegisteredAction,
  Source,
  TransformContext,
  TransformResult
} from '../types.js';
import { contentHash, join } from '../utils/fs.js';
import { isObject, toArray } from '../utils/object.js';
import { suggest } from '../utils/similarity.js';

export type ActionRegistry = {
  /** Adds an action, or replaces the one with the same name, and returns it with `process` in place. */
  register<A extends ActionDefinition<any>>(definition: A): RegisteredAction<A>;
} & Record<string, RegisteredAction>;

const registry: Record<string, RegisteredAction> = {};

/** Every registered action by name: the built-ins and whatever `register` added. */
export const actions: ActionRegistry = Object.defineProperty(registry, 'register', {
  value: register,
  enumerable: false
}) as ActionRegistry;

// the `process` functions `register` made, so registering the same action again is not taken for a custom `process`
const builtProcesses = new WeakSet<object>();

// an action that wrote its own `process` keeps it; otherwise `process` is built around its `transform`
function register<A extends ActionDefinition<any>>(definition: A): RegisteredAction<A> {
  const { name } = definition;
  if (!/^[a-z][\w-]*$/i.test(name) || name === 'register') throw new Error(`"${name}" is not a valid action name`);
  const action = definition as RegisteredAction<A>;
  const customProcess = action.process && !builtProcesses.has(action.process);
  if (action.cache) {
    if (customProcess)
      throw new Error(`action "${name}" sets cache, which works only with a transform, not its own process`);
    if (action.version === undefined) throw new Error(`action "${name}" sets cache, so it needs a version`);
  }
  if (!action.process) {
    if (!action.transform) throw new Error(`action "${name}" needs a transform or a process function`);
    action.process = (input) => processWithTransform(action, input);
    builtProcesses.add(action.process);
  }
  registry[name] = action as RegisteredAction;
  return action;
}

/** The `process` every action with a `transform` gets: select, check the options, transform, write, report. */
async function processWithTransform(
  action: ActionDefinition,
  { source, destination, cache, onProgress, ...input }: ProcessParams & Record<string, unknown>
): Promise<ActionResult> {
  const started = performance.now();
  const options = resolveOptions(action.options, input);
  const selection = await selectFiles(source, {
    accepts: action.accepts,
    probe: action.probe,
    findCompanions: action.findCompanions
  });
  const files = selection.files;
  const context: TransformContext = {
    folderName: selection.folderName,
    filenameTemplate: normalizeDestination(destination).filename as string
  };
  const label = actionLabel(action.name, source);
  const report: ReportProgress = (done, file) =>
    onProgress?.({ label, index: 1, actions: 1, done, total: files.length, ...(file ? { file } : {}) });
  const useCache = Boolean(cache && action.cache);

  report(0);
  let result: Transformed = { outputs: [], warnings: [], errors: [], fromCache: 0 };
  try {
    result =
      action.cache === true
        ? await transformEachFile(action, files, options, context, useCache, report)
        : await transformTogether(action, files, options, context, useCache);
  } catch (error) {
    result.errors.push((error as Error).message);
  }
  report(files.length);
  return finishAction({
    action: action.name,
    source,
    destination,
    inputs: selection.files,
    outputs: result.outputs,
    warnings: [...selection.warnings, ...result.warnings],
    errors: result.errors,
    fromCache: result.fromCache,
    started
  });
}

/** What a transform gave, in one shape, and how many of its inputs came from the cache. */
interface Transformed {
  outputs: AssetFile[];
  warnings: string[];
  errors: string[];
  fromCache: number;
}

async function runTransform(
  action: ActionDefinition,
  files: AssetFile[],
  options: Record<string, unknown>,
  context: TransformContext
): Promise<Transformed> {
  const result = await (action.transform as NonNullable<ActionDefinition['transform']>)(files, options, context);
  if (Array.isArray(result)) return { outputs: result, warnings: [], errors: [], fromCache: 0 };
  return { outputs: result.outputs, warnings: result.warnings ?? [], errors: result.errors ?? [], fromCache: 0 };
}

/** `done` files finished; `file` set when a file starts. */
type ReportProgress = (done: number, file?: string) => void;

// `cache: true` declares that files do not depend on each other: each one runs through `transform` alone, so the
// progress moves per file and, with the cache on, each file has its own entry. Results with errors are not stored.
async function transformEachFile(
  action: ActionDefinition,
  files: AssetFile[],
  options: Record<string, unknown>,
  context: TransformContext,
  useCache: boolean,
  report: ReportProgress
): Promise<Transformed> {
  const results: Transformed[] = new Array(files.length);
  let done = 0;
  await forEachConcurrently(files, async (file, index) => {
    const key = useCache ? cacheKeyFor(action, options, context, [file]) : undefined;
    const cached = key ? await readCache(key) : undefined;
    if (cached) results[index] = { ...cached, errors: [], fromCache: 1 };
    else {
      report(done, file.origin ?? file.path);
      try {
        const result = await runTransform(action, [file], options, context);
        if (key && !result.errors.length) {
          await writeCache(key, result);
          // a file written over its source comes back next build as its own output: stored as giving itself, it is
          // never compressed or resized twice
          const output = result.outputs.length === 1 ? result.outputs[0] : undefined;
          if (output && output.path === file.path && !file.companions?.length && !output.data.equals(file.data)) {
            const outputAsInput = { ...file, data: output.data };
            await writeCache(cacheKeyFor(action, options, context, [outputAsInput]), { outputs: [output], warnings: [] });
          }
        }
        results[index] = result;
      } catch (error) {
        results[index] = {
          outputs: [],
          warnings: [],
          errors: [`${file.origin ?? file.path}: ${(error as Error).message}`],
          fromCache: 0
        };
      }
    }
    report(++done);
  });
  return {
    outputs: results.flatMap((result) => result.outputs),
    warnings: results.flatMap((result) => result.warnings),
    errors: results.flatMap((result) => result.errors),
    fromCache: results.reduce((total, result) => total + result.fromCache, 0)
  };
}

// all files in one `transform` call; with the cache on and `cache: 'together'`, one entry for all of them
async function transformTogether(
  action: ActionDefinition,
  files: AssetFile[],
  options: Record<string, unknown>,
  context: TransformContext,
  useCache: boolean
): Promise<Transformed> {
  const key = useCache ? cacheKeyFor(action, options, context, files) : undefined;
  const cached = key ? await readCache(key) : undefined;
  if (cached) return { ...cached, errors: [], fromCache: files.length };
  const result = await runTransform(action, files, options, context);
  if (key && !result.errors.length) await writeCache(key, result);
  return result;
}

function cacheKeyFor(
  action: ActionDefinition,
  options: Record<string, unknown>,
  context: TransformContext,
  inputs: AssetFile[]
): string {
  return cacheKey([action.name, action.version, options, context, inputs.map(describeInput)]);
}

// everything about an input that can change what comes out; `meta` is left out because it is read from the bytes.
// Companions count too: a changed texture of a .gltf must not bring back the old result
function describeInput(file: AssetFile): unknown {
  const { path: filePath, origin, selectedFrom, filenameTokens, companions } = file;
  return {
    path: filePath,
    origin,
    selectedFrom,
    filenameTokens,
    hash: contentHash(file.data),
    companions: companions?.map((companion) => ({ path: companion.path, hash: contentHash(companion.data) }))
  };
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

// what every `process` takes besides the action's options (`ProcessParams`); never an action option
const RESERVED_KEYS = ['source', 'destination', 'cache', 'onProgress'];

/**
 * The options an action runs with: every value checked against the table, every missing key filled with its
 * default. An unknown key or a wrong value throws one error listing every problem. The `process` parameters
 * (`source`, `destination`, `cache`, `onProgress`) are skipped, so a whole `process` input can be passed.
 */
export function resolveOptions<O extends Record<string, unknown>>(table: OptionTable, input: Record<string, unknown>): O {
  const problems: string[] = [];
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (RESERVED_KEYS.includes(key)) continue;
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
 * Runs `transformFile` on every file, several at a time, keeping the input order. A throw becomes an error that
 * names the file, and the file is dropped; returning null drops it silently. The result can be returned from
 * a `transform` as it is.
 */
export async function transformFiles(
  files: AssetFile[],
  transformFile: (file: AssetFile) => Promise<AssetFile | null>
): Promise<TransformResult & { errors: string[] }> {
  const errors: string[] = [];
  const outputs: Array<AssetFile | null> = new Array(files.length).fill(null);
  await forEachConcurrently(files, async (file, index) => {
    try {
      outputs[index] = await transformFile(file);
    } catch (error) {
      errors.push(`${file.origin ?? file.path}: ${(error as Error).message}`);
    }
  });
  return { outputs: outputs.filter((output): output is AssetFile => output !== null), errors };
}

async function forEachConcurrently<T>(items: T[], work: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      await work(items[index] as T, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
}

/** What one `process` call did, which `finishAction` turns into its result. For actions that write their own `process`. */
export interface ActionOutcome {
  action: string;
  source: Source | AssetFile[];
  destination?: Destination;
  /** The files the action received. */
  inputs: AssetFile[];
  /** What it produced. Outputs that keep the input's `origin` (spread the input) get their own result row. */
  outputs: AssetFile[];
  warnings: string[];
  errors: string[];
  /** How many inputs came from the cache. Default 0. */
  fromCache?: number;
  /** `performance.now()` when `process` began. */
  started: number;
}

/**
 * Turns what a `process` did into its result. With a destination folder and no errors the outputs are written,
 * named by the filename template; with a `#virtual` destination they are renamed the same way but stay in memory.
 */
export async function finishAction(outcome: ActionOutcome): Promise<ActionResult> {
  const { action, source, inputs, errors, started } = outcome;
  const target = normalizeDestination(outcome.destination);
  const virtual = target.folder?.startsWith('#') ? parseVirtualFolder(target.folder) : undefined;
  const warnings = [...outcome.warnings];
  if (!inputs.length) warnings.push('selected no files');

  let outputs = outcome.outputs.map((output) => ({ ...output, meta: { ...output.meta, size: output.data.length } }));
  let destination: string | null = null;
  if (virtual) {
    outputs = outputs.map((output) => ({ ...output, path: join(virtual.sub, destinationPath(output, target.filename)) }));
  } else if (target.folder !== undefined && !errors.length) {
    const written = await writeFiles(outputs, target);
    outputs = outputs.map((output, index) => ({ ...output, path: written[index] as string }));
    destination = path.resolve(target.folder);
  }

  const inputsByOrigin = new Map(inputs.map((file) => [file.origin ?? file.path, file]));
  // a file's companions are part of what came in, like the .bin and textures of a .gltf
  const sizeIn = (file: AssetFile) =>
    file.meta.size + (file.companions ?? []).reduce((total, companion) => total + companion.data.length, 0);
  const bytesIn = inputs.reduce((total, file) => total + sizeIn(file), 0);
  const rows = new Map<string, FileResult>();
  for (const output of outputs) {
    // group outputs, like atlas pages, have no origin: they share one row that stands for every input
    const key = output.origin ?? '#group';
    let row = rows.get(key);
    if (!row) {
      const input = output.origin === undefined ? undefined : inputsByOrigin.get(output.origin);
      row = {
        source: output.origin ?? `${inputs.length} files`,
        outputs: [],
        bytesIn: output.origin === undefined ? bytesIn : input ? sizeIn(input) : 0,
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
  const origins = inputs.map((file) => file.origin ?? '');
  const fromMemory = isFileList(source);
  const memorySources = new Set(
    origins.map((origin) => (origin.startsWith('#') ? parseVirtualFolder(origin).name : fromMemory ? 'memory' : ''))
  );
  return {
    ok: errors.length === 0,
    action,
    label: actionLabel(action, source),
    selected: inputs.length,
    fromCache: outcome.fromCache ?? 0,
    ...(origins.length && memorySources.size === 1 && !memorySources.has('') ? { memorySource: [...memorySources][0] } : {}),
    files: [...rows.values()],
    outputs,
    destination,
    bytesIn,
    bytesOut: outputs.reduce((total, output) => total + output.data.length, 0),
    warnings,
    errors,
    duration: performance.now() - started
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
export function parseVirtualFolder(folder: string): { name: string; sub: string } {
  const [name, ...sub] = folder.slice(1).split('/');
  return { name: name ?? '', sub: sub.join('/') };
}
