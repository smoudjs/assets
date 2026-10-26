// Runs a config: for every action select its files, call its `process` in memory, then place the outputs.
// Nothing touches the destination while actions run: results go to `<destination>/.staging`; on success they
// are moved into place and stale files removed, on any error the staging folder is deleted and the previous
// output stays as it was. A dry run writes nothing at all.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseVirtualFolder } from './actions/index.js';
import { loadConfig, prepareConfig, type PreparedAction, type PreparedConfig, type PreparedItem } from './config.js';
import { commonSelectedFrom, destinationPath, listSourceFiles, selectFiles } from './files.js';
import type { ActionResult, AssetFile, AssetsConfig, BuildResult, FileResult } from './types.js';
import {
  exists,
  isPathUnderFolder,
  join,
  listFiles,
  moveFile,
  removeEmptyFolders,
  removePath,
  toPosix,
  writeFile
} from './utils/fs.js';

const STAGING = '.staging';

export interface BuildOptions {
  /** A config object, a path to a config file, or nothing: `assets.json` in the working directory when present. */
  config?: string | AssetsConfig;
  /** Override the base source folder (the `--source` flag). */
  source?: string;
  /** Override the base destination folder (the `--destination` flag). */
  destination?: string;
  /** Process everything, write nothing to the destination. */
  dryRun?: boolean;
  /** Warnings count as failure. */
  strict?: boolean;
}

/** What the items of one config level, or of one preset, select from and write to. */
interface Scope {
  /** Files to select from; undefined means the source folder on disk. */
  pool?: AssetFile[];
  /** Origins the items of this scope took, for `#rest`. */
  taken: Set<string>;
  /** Folder every output of this scope goes under, accumulated from the enclosing presets. */
  outputFolder: string;
  /** Virtual folder every output of this scope goes to, when an enclosing preset sends it there. */
  virtualTarget?: { name: string; sub: string };
}

/** Everything one build run keeps track of while its actions run. */
interface BuildState {
  config: PreparedConfig;
  staging: string;
  /** The config's ignore patterns plus the destination when it sits inside the source. */
  ignore: string[];
  result: BuildResult;
  /** Origins per action, for the overlap warning. */
  selected: Map<PreparedAction, string[]>;
  /** Destination-relative path → who produced it, for collision detection. */
  produced: Map<string, string>;
  virtual: Record<string, AssetFile[]>;
  readVirtual: Set<string>;
}

export async function build(options: BuildOptions = {}): Promise<BuildResult> {
  const started = performance.now();
  const loaded = await loadConfig(options.config);
  const config = await prepareConfig(loaded.config, loaded.dir, options);
  const result: BuildResult = {
    ok: false,
    dryRun: Boolean(options.dryRun),
    source: config.source,
    destination: config.destination,
    actions: [],
    unselected: [],
    warnings: [...config.warnings],
    errors: [...config.errors],
    duration: 0
  };
  if (result.errors.length) return finishBuild(result, started, options);

  const staging = path.join(config.destination, STAGING);
  if (!result.dryRun) await removePath(staging);
  const ignore = [...config.ignore];
  if (isPathUnderFolder(config.destination, config.source))
    ignore.push(toPosix(path.relative(config.source, config.destination)));
  const state: BuildState = {
    config,
    staging,
    ignore,
    result,
    selected: new Map(),
    produced: new Map(),
    virtual: {},
    readVirtual: new Set()
  };

  const scope: Scope = { taken: new Set(), outputFolder: '' };
  await runItems(config.items, scope, state);

  const all = await listSourceFiles(config.source, ignore);
  result.unselected = all.filter((origin) => !scope.taken.has(origin));
  for (const name of Object.keys(state.virtual)) {
    if (!state.readVirtual.has(name)) result.warnings.push(`virtual folder "#${name}" is produced but nothing reads it`);
  }
  warnOverlaps(state);

  if (!result.dryRun) {
    if (result.errors.length) await removePath(staging);
    else await commitStaging(staging, config.destination, state.produced, config.clean);
  }
  return finishBuild(result, started, options);
}

async function runItems(items: PreparedItem[], scope: Scope, state: BuildState): Promise<void> {
  for (const item of items) {
    const files = await selectItem(item, scope, state);
    if (!files) continue;
    if (item.kind === 'group') {
      const virtual = item.destination?.folder?.startsWith('#') ? parseVirtualFolder(item.destination.folder) : undefined;
      const inner: Scope = {
        pool: files,
        taken: new Set(),
        outputFolder: virtual
          ? scope.outputFolder
          : join(scope.outputFolder, item.destination?.folder ?? commonSelectedFrom(files)),
        virtualTarget: virtual ?? scope.virtualTarget
      };
      await runItems(item.items, inner, state);
      for (const origin of inner.taken) scope.taken.add(origin);
      continue;
    }
    const origins = files.map((file) => file.origin as string);
    for (const origin of origins) scope.taken.add(origin);
    state.selected.set(item, origins);
    await runAction(item, files, scope, state);
  }
}

/** The files an item gets: from the disk, from the enclosing preset's files, or from a virtual folder. Null skips the item. */
async function selectItem(item: PreparedItem, scope: Scope, state: BuildState): Promise<AssetFile[] | null> {
  const { source } = item;
  const where = item.kind === 'action' ? `action ${item.index} (${item.label})` : item.label;
  let pool = scope.pool;
  let skip: ((origin: string) => boolean) | undefined;
  if (source.virtual !== undefined) {
    if (item.kind === 'group') {
      state.result.warnings.push(`${where}: a preset cannot read a virtual folder; it selected nothing`);
      return null;
    }
    state.readVirtual.add(source.virtual);
    pool = state.virtual[source.virtual];
    if (!pool) {
      state.result.errors.push(`${where}: virtual folder "#${source.virtual}" is read before anything produced it`);
      return null;
    }
  } else if (source.rest) {
    skip = (origin) => scope.taken.has(origin);
  }
  const selection = await selectFiles(
    { include: source.include, exclude: source.exclude, when: source.when },
    {
      root: state.config.source,
      pool,
      exclude: pool ? [] : state.ignore,
      accepts: item.kind === 'action' ? item.action.accepts : '*',
      probe: item.kind === 'action' ? item.action.probe : undefined,
      skip
    }
  );
  for (const warning of selection.warnings) state.result.warnings.push(`${where}: ${warning}`);
  return selection.files;
}

async function runAction(item: PreparedAction, files: AssetFile[], scope: Scope, state: BuildState): Promise<void> {
  const where = `action ${item.index} (${item.label})`;
  const target = item.destination;
  const ownVirtual = target.folder?.startsWith('#') ? parseVirtualFolder(target.folder) : undefined;
  const virtual = ownVirtual ?? scope.virtualTarget;

  // the action runs in memory; only the filename template goes along, so an atlas can predict its page names
  let result: ActionResult;
  try {
    result = await item.action.process({ ...item.options, source: files, destination: { filename: target.filename } });
  } catch (error) {
    state.result.errors.push(`${where}: ${(error as Error).message}`);
    return;
  }
  result.label = item.label;
  // build hands every action its files in memory; only a virtual source is not source bytes
  if (item.source.virtual !== undefined) result.memorySource = item.source.virtual;
  else delete result.memorySource;
  state.result.warnings.push(...result.warnings.map((warning) => `${where}: ${warning}`));
  state.result.errors.push(...result.errors.map((error) => `${where}: ${error}`));
  state.result.actions.push(result);

  // no destination folder: the output lands where its source was. A folder replaces the pattern's folder.
  const folder = ownVirtual ? ownVirtual.sub : target.folder;
  const rows = new Map(result.files.map((row) => [row.source, row]));
  for (const row of result.files) row.outputs = [];
  for (const output of result.outputs) {
    const row = rows.get(output.origin ?? `${result.selected} files`) as FileResult;
    const relative = join(
      ownVirtual ? '' : scope.virtualTarget?.sub,
      scope.outputFolder,
      folder ?? output.selectedFrom,
      destinationPath(output, target.filename)
    );
    output.path = relative;
    if (virtual) {
      (state.virtual[virtual.name] ??= []).push({ ...output, origin: `#${virtual.name}/${relative}`, selectedFrom: '' });
      row.outputs.push(`#${virtual.name}/${relative}`);
      continue;
    }
    const owner = `${where} from ${row.source}`;
    const existing = state.produced.get(relative);
    if (existing && existing !== owner) {
      const catchAll = flattenActions(state.config.items).some(isCatchAll);
      state.result.errors.push(
        `"${relative}" is produced twice: ${existing}, and ${owner}.` +
          (catchAll ? ' Give the catch-all "source": "#rest" to take only what others leave.' : '')
      );
      continue;
    }
    state.produced.set(relative, owner);
    if (!state.result.dryRun) await writeFile(path.join(state.staging, relative), output.data);
    row.outputs.push(relative);
  }
  if (!virtual) result.destination = path.join(state.config.destination, scope.outputFolder, folder ?? '');
}

function flattenActions(items: PreparedItem[]): PreparedAction[] {
  return items.flatMap((item) => (item.kind === 'action' ? [item] : flattenActions(item.items)));
}

// an action without `source` takes every file its type accepts
function isCatchAll(action: PreparedAction): boolean {
  return action.source.include.length === 0 && !action.source.rest && action.source.virtual === undefined;
}

// A file taken by an action without `source` and again by another action usually means a catch-all is not last.
function warnOverlaps(state: BuildState): void {
  const actions = flattenActions(state.config.items);
  for (const catchAll of actions) {
    if (!isCatchAll(catchAll)) continue;
    const mine = new Set(state.selected.get(catchAll) ?? []);
    for (const other of actions) {
      if (other === catchAll) continue;
      const shared = (state.selected.get(other) ?? []).filter((origin) => mine.has(origin)).length;
      if (!shared) continue;
      state.result.warnings.push(
        `${shared} file${shared === 1 ? '' : 's'} selected by action ${catchAll.index} (${catchAll.label}) are also selected by ` +
          `action ${other.index} (${other.label}). Give action ${catchAll.index} "source": "#rest" if it should take only what others do not.`
      );
    }
  }
}

async function commitStaging(
  staging: string,
  destination: string,
  produced: Map<string, string>,
  clean: boolean
): Promise<void> {
  for (const relative of await listFiles(staging))
    await moveFile(path.join(staging, relative), path.join(destination, relative));
  if (clean && (await exists(destination))) {
    for (const relative of await listFiles(destination, [STAGING])) {
      if (!produced.has(relative)) await fs.unlink(path.join(destination, relative));
    }
    await removeEmptyFolders(destination);
  }
  await removePath(staging);
}

function finishBuild(result: BuildResult, started: number, options: BuildOptions): BuildResult {
  result.ok = result.errors.length === 0 && (!options.strict || result.warnings.length === 0);
  result.duration = performance.now() - started;
  return result;
}
