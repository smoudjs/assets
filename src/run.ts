// select → process → stage → commit. Nothing touches the destination while actions run: results go to
// `<destination>/.staging`; on success they are renamed into place and stale files removed, on any
// error the staging folder is deleted and the previous output stays as it was.

import { promises as fs } from 'node:fs';
import { cpus } from 'node:os';
import path from 'node:path';
import { atlas } from './actions/atlas.js';
import { copy } from './actions/copy.js';
import { image } from './actions/image.js';
import { json } from './actions/json.js';
import { xml } from './actions/xml.js';
import { loadConfig, resolveFolders } from './config.js';
import { createPlan, type Action, type Item, type Selection, type Target } from './plan.js';
import { discover, loadData, pickFiles, resolveSelections, type PoolFile } from './select.js';
import type { ActionResult, ActionType, AssetFile, AssetsConfig, BuildResult, FileResult } from './types.js';
import {
  basename,
  dirname,
  exists,
  join,
  listFiles,
  remove,
  removeEmptyFolders,
  renameOver,
  renderFilename,
  stripBase,
  writeFile
} from './utils/fs.js';
import { toArray } from './utils/object.js';

export const actionTypes: Record<string, ActionType> = {
  image: image as ActionType,
  atlas: atlas as ActionType,
  json,
  xml: xml as ActionType,
  copy
};

export interface BuildOptions {
  /** A config object, a path to a config file, or nothing: `assets.json` in cwd when present. */
  config?: string | AssetsConfig;
  /** Folder that relative paths resolve from. Default: the process working directory. */
  cwd?: string;
  /** Override the base source folder (the `--source` flag). */
  source?: string;
  /** Override the base destination folder (the `--destination` flag). */
  destination?: string;
  /** Process everything, write nothing. */
  dryRun?: boolean;
  /** Warnings count as failure. */
  strict?: boolean;
  /** Files processed at the same time inside one action. Default: CPU count minus one. */
  concurrency?: number;
  /** Extra action types, e.g. plugins or test doubles. */
  types?: Record<string, ActionType>;
  /** Name of a virtual folder whose files become `result.outputs` (standalone in-memory calls). */
  outputSink?: string;
}

const STAGING = '.staging';

// Links an output back to the input it came from. Spread copies symbol keys, so `{ ...file, data }` keeps the link.
const ORIGIN = Symbol('origin');
type Traced = AssetFile & { [ORIGIN]?: PoolFile };

export async function build(options: BuildOptions = {}): Promise<BuildResult> {
  const started = performance.now();
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const types = { ...actionTypes, ...options.types };

  const loaded = await loadConfig(options.config, cwd);
  const dir = loaded.configPath ? path.dirname(loaded.configPath) : cwd;
  const folders = await resolveFolders(loaded.config, dir, cwd, {
    source: options.source,
    destination: options.destination
  });
  const plan = await createPlan(loaded.config, types, dir);

  const result: BuildResult = {
    ok: false,
    dryRun: Boolean(options.dryRun),
    source: folders.source,
    destination: folders.destination,
    actions: [],
    unselected: [],
    warnings: [...plan.warnings],
    errors: [...plan.errors],
    outputs: [],
    virtual: {},
    duration: 0
  };
  const { warnings, errors } = result;
  if (errors.length) return finishResult(result, started, options);

  const pool = await discover(folders.source, folders.destination, toArray(loaded.config.exclude));
  const selected = await resolveSelections(plan.items, pool, warnings);
  const actions = flattenActions(plan.items);
  warnOverlaps(actions, selected, warnings);

  const staging = path.join(folders.destination, STAGING);
  if (!result.dryRun) await remove(staging);

  // destination path → who produced it, for collision detection
  const produced = new Map<string, string>();
  const readVirtual = new Set<string>();
  const concurrency = options.concurrency ?? Math.max(1, cpus().length - 1);

  for (const action of actions) {
    const actionStarted = performance.now();
    const where = `action ${action.index} (${action.label})`;
    const actionResult: ActionResult = {
      index: action.index,
      label: action.label,
      type: action.type.name,
      selected: 0,
      files: [],
      bytesIn: 0,
      bytesOut: 0,
      duration: 0
    };
    result.actions.push(actionResult);

    let files = selected.get(action) ?? [];
    if (action.source.virtual !== undefined) {
      const name = action.source.virtual;
      readVirtual.add(name);
      const available = result.virtual[name];
      if (!available) {
        errors.push(`${where}: virtual folder "#${name}" is read before anything produced it`);
        continue;
      }
      const candidates: PoolFile[] = available.map((file) => ({
        ...file,
        origin: `#${name}/${file.path}`,
        base: '',
        prefix: ''
      }));
      files = await pickFiles(candidates, action.source, action.type.accepts, action.type, action.label, warnings);
    }
    if (!files.length) {
      warnings.push(`${where}: selected no files`);
      continue;
    }
    actionResult.selected = files.length;

    // processors see paths relative to the folder that selected the file; destinationPath puts the folder back
    const inputs: Traced[] = [];
    for (const file of files) {
      const data = await loadData(file);
      actionResult.bytesIn += data.length;
      inputs.push({ path: stripBase(file.path, file.base), data, meta: file.meta, tokens: file.tokens, [ORIGIN]: file });
    }

    const template = (action.destinations[0] as Target).filename;
    let outputs: Traced[];
    try {
      outputs = await action.type.process(inputs, action.options, {
        concurrency,
        folder: selectedFolder(files, action.source),
        filename: (file) => renderFilename(template, basename(file.path), file.data, file.tokens),
        warn: (message) => warnings.push(`${where}: ${message}`),
        fail: (file, message) => errors.push(`${where}: ${(file as Traced)[ORIGIN]?.origin ?? file.path}: ${message}`)
      });
    } catch (error) {
      errors.push(`${where}: ${(error as Error).message}`);
      continue;
    }

    const resultsByOrigin = new Map<string, FileResult>();
    for (const output of outputs) {
      const origin = output[ORIGIN];
      // group outputs (atlas pages) have no origin: they borrow the scope of their inputs and share one result row
      const scope = origin ?? (files[0] as PoolFile);
      const key = origin ? origin.origin : '#group';
      let fileResult = resultsByOrigin.get(key);
      if (!fileResult) {
        fileResult = {
          action: action.index,
          source: origin ? origin.origin : `${files.length} files`,
          outputs: [],
          bytesIn: origin ? origin.meta.size : actionResult.bytesIn,
          bytesOut: 0,
          cached: false,
          keptOriginal: false
        };
        resultsByOrigin.set(key, fileResult);
        actionResult.files.push(fileResult);
      }
      fileResult.bytesOut += output.data.length;
      actionResult.bytesOut += output.data.length;
      if (output.keptOriginal) fileResult.keptOriginal = true;

      for (const target of action.destinations) {
        const rel = destinationPath(output, scope, target, origin !== undefined);
        const virtualName = scope.redirect ?? target.virtual;
        if (virtualName !== undefined) {
          (result.virtual[virtualName] ??= []).push({
            path: rel,
            data: output.data,
            meta: output.meta,
            tokens: output.tokens
          });
          fileResult.outputs.push(`#${virtualName}/${rel}`);
          continue;
        }
        const owner = `${where} from ${fileResult.source}`;
        const existing = produced.get(rel);
        if (existing && existing !== owner) {
          const catchAll = actions.some(
            (a) => a.source.include.length === 0 && !a.source.rest && a.source.virtual === undefined
          );
          errors.push(
            `"${rel}" is produced twice: ${existing}, and ${owner}.` +
              (catchAll ? ' Give the catch-all "source": "#rest" to take only what others leave.' : '')
          );
          continue;
        }
        produced.set(rel, owner);
        if (!result.dryRun) await writeFile(path.join(staging, rel), output.data);
        fileResult.outputs.push(rel);
      }
    }
    actionResult.duration = performance.now() - actionStarted;
  }

  const taken = new Set([...selected.values()].flat().map((file) => file.origin));
  result.unselected = pool.filter((file) => !taken.has(file.origin)).map((file) => file.origin);
  for (const name of Object.keys(result.virtual)) {
    if (!readVirtual.has(name) && name !== options.outputSink)
      warnings.push(`virtual folder "#${name}" is produced but nothing reads it`);
  }

  if (!result.dryRun) {
    if (errors.length) await remove(staging);
    else await commit(staging, folders.destination, produced, loaded.config.clean !== false);
  }
  return finishResult(result, started, options);
}

async function commit(staging: string, destination: string, produced: Map<string, string>, clean: boolean): Promise<void> {
  for (const rel of await listFiles(staging)) await renameOver(path.join(staging, rel), path.join(destination, rel));
  if (clean && (await exists(destination))) {
    for (const rel of await listFiles(destination, [STAGING])) {
      if (!produced.has(rel)) await fs.unlink(path.join(destination, rel));
    }
    await removeEmptyFolders(destination);
  }
  await remove(staging);
}

// An output's path is relative to the folder part of the pattern that selected its input; with no destination
// folder that part is put back, so the tree mirrors. Group outputs (no origin) land at the scope root.
function destinationPath(output: AssetFile, scope: PoolFile, target: Target, traced: boolean): string {
  const dir = join(scope.prefix, target.folder ?? (traced ? scope.base : ''), dirname(output.path));
  return join(dir, renderFilename(target.filename, basename(output.path), output.data, output.tokens));
}

// The name of the one folder every file came from. Files at the root of a virtual folder take its name.
function selectedFolder(files: PoolFile[], source: Selection): string {
  const bases = new Set(files.map((file) => file.base));
  if (bases.size !== 1) return '';
  return basename([...bases][0] as string) || source.virtual || '';
}

function flattenActions(items: Item[]): Action[] {
  return items.flatMap((item) => (item.kind === 'action' ? [item] : flattenActions(item.items)));
}

// A file taken by an action without `source` and again by another action usually means a catch-all is not last.
function warnOverlaps(actions: Action[], selected: Map<Action, PoolFile[]>, warnings: string[]): void {
  for (const catchAll of actions) {
    if (catchAll.source.include.length || catchAll.source.rest || catchAll.source.virtual !== undefined) continue;
    const mine = new Set((selected.get(catchAll) ?? []).map((file) => file.origin));
    for (const other of actions) {
      if (other === catchAll) continue;
      const shared = (selected.get(other) ?? []).filter((file) => mine.has(file.origin)).length;
      if (!shared) continue;
      warnings.push(
        `${shared} file${shared === 1 ? '' : 's'} selected by action ${catchAll.index} (${catchAll.label}) are also selected by ` +
          `action ${other.index} (${other.label}). Give action ${catchAll.index} "source": "#rest" if it should take only what others do not.`
      );
    }
  }
}

function finishResult(result: BuildResult, started: number, options: BuildOptions): BuildResult {
  if (options.outputSink) {
    result.outputs = result.virtual[options.outputSink] ?? [];
    result.destination = null;
  }
  result.ok = result.errors.length === 0 && (!options.strict || result.warnings.length === 0);
  result.duration = performance.now() - started;
  return result;
}
