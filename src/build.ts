// Runs a config: for every action select its files, call its `process` in memory, then place the outputs.
// Nothing touches the destination while actions run: results go to `<destination>/.staging`; on success they
// are moved into place and stale files removed, on any error the staging folder is deleted and the previous
// output stays as it was. A dry run writes nothing at all. A destination equal to the source optimizes in place.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseVirtualFolder } from './actions/index.js';
import { loadConfig, prepareConfig, type PreparedAction, type PreparedConfig } from './config.js';
import { destinationPath, listSourceFiles, selectFiles } from './files.js';
import type {
  ActionResult,
  AssetFile,
  AssetsConfig,
  BuildResult,
  FileResult,
  ProcessParams,
  ProgressEvent
} from './types.js';
import {
  isPathUnderFolder,
  join,
  listFiles,
  moveFile,
  removeEmptyFolders,
  removePath,
  samePath,
  statOrNull,
  toPosix,
  writeFile
} from './utils/fs.js';
import { plural } from './utils/format.js';

const STAGING = '.staging';

export interface BuildOptions {
  /** A config object, a path to a config file, or nothing: `assets.json` in the working directory when present. */
  config?: string | AssetsConfig;
  /** Use this preset, over the config's own `preset` (the `--preset` flag). */
  preset?: string;
  /** Override the base source folder (the `--source` flag). */
  source?: string;
  /** Override the base destination folder (the `--destination` flag). */
  destination?: string;
  /** Process everything, write nothing to the destination. */
  dryRun?: boolean;
  /** Warnings count as failure. */
  strict?: boolean;
  /** Reuse cached results for unchanged files, over the config's `cache`. Default `true`. */
  cache?: boolean;
  /** Called as each action moves through its files. */
  onProgress?: (event: ProgressEvent) => void;
}

/** Everything one build run keeps track of while its actions run. */
interface BuildState {
  config: PreparedConfig;
  staging: string;
  cache: boolean;
  onProgress?: (event: ProgressEvent) => void;
  /** The config's ignore patterns plus the destination when it sits inside the source. */
  ignore: string[];
  result: BuildResult;
  /** Origins every action took, for `#rest` and the list of unselected files. */
  taken: Set<string>;
  /** Origins the config's own actions took; the preset's actions never see them. */
  takenByOwnActions: Set<string>;
  /** Origins read as another file's companions, like the textures of a .gltf; no later action sees them. */
  companions: Set<string>;
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
    cache: options.cache ?? config.cache ?? true,
    onProgress: options.onProgress,
    ignore,
    result,
    taken: new Set(),
    takenByOwnActions: new Set(),
    companions: new Set(),
    selected: new Map(),
    produced: new Map(),
    virtual: {},
    readVirtual: new Set()
  };

  for (const action of config.actions) {
    const files = await selectActionFiles(action, state);
    // a preset is written for many projects, so its actions that find nothing in this one are skipped quietly
    if (!files || (action.fromPreset && !files.length)) continue;
    const origins = files.map((file) => file.origin as string);
    // a file's companions, like the .bin of a .gltf, are used up with it: no later action takes them
    const companions = files.flatMap((file) => (file.companions ?? []).map((companion) => companion.origin as string));
    for (const origin of companions) state.companions.add(origin);
    for (const origin of [...origins, ...companions]) {
      state.taken.add(origin);
      if (!action.fromPreset) state.takenByOwnActions.add(origin);
    }
    state.selected.set(action, origins);
    await runAction(action, files, state);
  }

  const all = await listSourceFiles(config.source, ignore);
  result.unselected = all.filter((origin) => !state.taken.has(origin));
  for (const name of Object.keys(state.virtual)) {
    if (!state.readVirtual.has(name)) result.warnings.push(`virtual folder "#${name}" is produced but nothing reads it`);
  }
  warnOverlaps(state);
  const inPlace = samePath(config.source, config.destination);
  if (inPlace && config.clean && result.unselected.length) {
    result.errors.push(
      `${plural(result.unselected.length, 'file')} no action takes would be deleted from the source folder. ` +
        'Add { "action": "copy", "source": "#rest" }, or set "clean": false'
    );
  }

  // a strict build fails on warnings too, so it decides before anything reaches the destination
  const failed = result.errors.length > 0 || (Boolean(options.strict) && result.warnings.length > 0);
  if (!result.dryRun) {
    if (failed) await removePath(staging);
    else {
      // in place, only files the build saw can go: ignored and dot files stay
      const existing = inPlace ? all : await listFiles(config.destination, [STAGING]);
      const stale = existing.filter((relative) => !state.produced.has(relative));
      await commitStaging(staging, config.destination, config.clean ? stale : undefined);
    }
  }
  return finishBuild(result, started, options);
}

/** The files an action gets: from the disk, or from a virtual folder. Null skips the action. */
async function selectActionFiles(action: PreparedAction, state: BuildState): Promise<AssetFile[] | null> {
  const { source } = action;
  const where = `action ${action.index} (${action.label})`;
  let pool: AssetFile[] | undefined;
  if (source.virtual !== undefined) {
    state.readVirtual.add(source.virtual);
    pool = state.virtual[source.virtual];
    if (!pool) {
      state.result.errors.push(`${where}: virtual folder "#${source.virtual}" is read before anything produced it`);
      return null;
    }
  }
  const skip = (origin: string) =>
    (source.rest && state.taken.has(origin)) ||
    (action.fromPreset && state.takenByOwnActions.has(origin)) ||
    state.companions.has(origin);
  const selection = await selectFiles(
    { include: source.include, exclude: source.exclude, when: source.when },
    {
      root: state.config.source,
      pool,
      exclude: pool ? [] : state.ignore,
      accepts: action.action.accepts,
      probe: action.action.probe,
      findCompanions: action.action.findCompanions,
      skip
    }
  );
  for (const warning of selection.warnings) state.result.warnings.push(`${where}: ${warning}`);
  return selection.files;
}

async function runAction(action: PreparedAction, files: AssetFile[], state: BuildState): Promise<void> {
  const where = `action ${action.index} (${action.label})`;
  const target = action.destination;
  const virtual = target.folder?.startsWith('#') ? parseVirtualFolder(target.folder) : undefined;

  // the action runs in memory; only the filename template goes along, so an atlas can predict its page names.
  // `cache` goes only to actions that set it: an action with its own `process` would take it for an unknown option
  // the action reports as if it ran alone; its place in the build is filled in here. The first event comes from
  // here too, so an action with its own `process` that never reports still shows up
  const position = { label: action.label, index: action.index, actions: state.config.actions.length };
  const onProgress = state.onProgress && ((event: ProgressEvent) => state.onProgress?.({ ...event, ...position }));
  onProgress?.({ ...position, done: 0, total: files.length });
  const params: ProcessParams & Record<string, unknown> = {
    ...action.options,
    source: files,
    destination: { filename: target.filename }
  };
  if (state.cache && action.action.cache) params.cache = true;
  if (onProgress) params.onProgress = onProgress;
  let result: ActionResult;
  try {
    result = await action.action.process(params);
  } catch (error) {
    state.result.errors.push(`${where}: ${(error as Error).message}`);
    return;
  }
  result.label = action.label;
  // build hands every action its files in memory; only a virtual source is not source bytes
  if (action.source.virtual !== undefined) result.memorySource = action.source.virtual;
  else delete result.memorySource;
  state.result.warnings.push(...result.warnings.map((warning) => `${where}: ${warning}`));
  state.result.errors.push(...result.errors.map((error) => `${where}: ${error}`));
  state.result.actions.push(result);

  // no destination folder: the output lands where its source was. A folder replaces the pattern's folder.
  const folder = virtual ? virtual.sub : target.folder;
  const rows = new Map(result.files.map((row) => [row.source, row]));
  for (const row of result.files) row.outputs = [];
  for (const output of result.outputs) {
    const row = rows.get(output.origin ?? `${result.selected} files`) as FileResult;
    const relative = join(folder ?? output.selectedFrom, destinationPath(output, target.filename));
    output.path = relative;
    if (virtual) {
      (state.virtual[virtual.name] ??= []).push({ ...output, origin: `#${virtual.name}/${relative}`, selectedFrom: '' });
      row.outputs.push(`#${virtual.name}/${relative}`);
      continue;
    }
    const owner = `${where} from ${row.source}`;
    const existing = state.produced.get(relative);
    if (existing && existing !== owner) {
      const catchAll = state.config.actions.some(isCatchAll);
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
  if (!virtual) result.destination = path.join(state.config.destination, folder ?? '');
}

// an action without `source` takes every file its type accepts
function isCatchAll(action: PreparedAction): boolean {
  return action.source.include.length === 0 && !action.source.rest && action.source.virtual === undefined;
}

// A file taken by an action without `source` and again by another action usually means a catch-all is not last.
function warnOverlaps(state: BuildState): void {
  const { actions } = state.config;
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

// `stale`: the files `clean` removes, or undefined without `clean`
async function commitStaging(staging: string, destination: string, stale: string[] | undefined): Promise<void> {
  for (const relative of await listFiles(staging))
    await moveFile(path.join(staging, relative), path.join(destination, relative));
  if (stale && (await statOrNull(destination))) {
    for (const relative of stale) await fs.unlink(path.join(destination, relative));
    await removeEmptyFolders(destination);
  }
  await removePath(staging);
}

function finishBuild(result: BuildResult, started: number, options: BuildOptions): BuildResult {
  result.ok = result.errors.length === 0 && (!options.strict || result.warnings.length === 0);
  result.duration = performance.now() - started;
  return result;
}
