// Runs a config: for every action select its files, call its `process` into a staging folder, then commit.
// Nothing touches the destination while actions run: results go to `<destination>/.staging`; on success they
// are moved into place and stale files removed, on any error the staging folder is deleted and the previous
// output stays as it was. A dry run stages into a temp folder that is deleted at the end.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { splitVirtual } from './actions/index.js';
import { loadConfig, prepareConfig, type ReadyAction, type ReadyConfig, type ReadyItem } from './config.js';
import { listSourceFiles, outputPath, selectFiles } from './files.js';
import type { ActionResult, AssetFile, AssetsConfig, BuildResult, FileResult } from './types.js';
import { exists, isPathUnderFolder, join, listFiles, remove, removeEmptyFolders, renameOver, toPosix, writeFile } from './utils/fs.js';

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
  prefix: string;
  /** Virtual folder every output of this scope goes to, when an enclosing preset sends it there. */
  redirect?: { name: string; sub: string };
}

interface Build {
  ready: ReadyConfig;
  staging: string;
  /** The config's exclude patterns plus the destination when it sits inside the source. */
  exclude: string[];
  result: BuildResult;
  /** Origins per action, for the overlap warning. */
  selected: Map<ReadyAction, string[]>;
  /** Destination-relative path → who produced it, for collision detection. */
  produced: Map<string, string>;
  virtual: Record<string, AssetFile[]>;
  readVirtual: Set<string>;
}

export async function build(options: BuildOptions = {}): Promise<BuildResult> {
  const started = performance.now();
  const { config, dir } = await loadConfig(options.config);
  const ready = await prepareConfig(config, dir, options);
  const result: BuildResult = {
    ok: false,
    dryRun: Boolean(options.dryRun),
    source: ready.source,
    destination: ready.destination,
    actions: [],
    unselected: [],
    warnings: [...ready.warnings],
    errors: [...ready.errors],
    duration: 0
  };
  if (result.errors.length) return finishBuild(result, started, options);

  const staging = path.join(ready.destination, STAGING);
  if (!result.dryRun) await remove(staging);
  const exclude = [...ready.exclude];
  if (isPathUnderFolder(ready.destination, ready.source)) exclude.push(toPosix(path.relative(ready.source, ready.destination)));
  const build: Build = { ready, staging, exclude, result, selected: new Map(), produced: new Map(), virtual: {}, readVirtual: new Set() };

  const scope: Scope = { taken: new Set(), prefix: '' };
  await runItems(ready.items, scope, build);

  const all = await listSourceFiles(ready.source, exclude);
  result.unselected = all.filter((origin) => !scope.taken.has(origin));
  for (const name of Object.keys(build.virtual)) {
    if (!build.readVirtual.has(name)) result.warnings.push(`virtual folder "#${name}" is produced but nothing reads it`);
  }
  warnOverlaps(build);

  if (!result.dryRun) {
    if (result.errors.length) await remove(staging);
    else await commit(staging, ready.destination, build.produced, ready.clean);
  }
  return finishBuild(result, started, options);
}

async function runItems(items: ReadyItem[], scope: Scope, build: Build): Promise<void> {
  for (const item of items) {
    const files = await selectItem(item, scope, build);
    if (!files) continue;
    if (item.kind === 'group') {
      const virtual = item.destination?.folder?.startsWith('#') ? splitVirtual(item.destination.folder) : undefined;
      const inner: Scope = {
        pool: files,
        taken: new Set(),
        prefix: virtual ? scope.prefix : join(scope.prefix, item.destination?.folder ?? commonBase(files)),
        redirect: virtual ?? scope.redirect
      };
      await runItems(item.items, inner, build);
      for (const origin of inner.taken) scope.taken.add(origin);
      continue;
    }
    const origins = files.map((file) => file.origin as string);
    for (const origin of origins) scope.taken.add(origin);
    build.selected.set(item, origins);
    await runAction(item, files, scope, build);
  }
}

/** The files an item gets: from the disk, from the enclosing preset's files, or from a virtual folder. Null skips the item. */
async function selectItem(item: ReadyItem, scope: Scope, build: Build): Promise<AssetFile[] | null> {
  const { source } = item;
  const where = item.kind === 'action' ? `action ${item.index} (${item.label})` : item.label;
  let pool = scope.pool;
  let skip: ((origin: string) => boolean) | undefined;
  if (source.virtual !== undefined) {
    if (item.kind === 'group') {
      build.result.warnings.push(`${where}: a preset cannot read a virtual folder; it selected nothing`);
      return null;
    }
    build.readVirtual.add(source.virtual);
    pool = build.virtual[source.virtual];
    if (!pool) {
      build.result.errors.push(`${where}: virtual folder "#${source.virtual}" is read before anything produced it`);
      return null;
    }
  } else if (source.rest) {
    skip = (origin) => scope.taken.has(origin);
  }
  const selection = await selectFiles(
    { include: source.include, exclude: source.exclude, when: source.when },
    {
      root: build.ready.source,
      pool,
      exclude: pool ? [] : build.exclude,
      accepts: item.kind === 'action' ? item.action.accepts : '*',
      probe: item.kind === 'action' ? item.action.probe : undefined,
      skip
    }
  );
  for (const warning of selection.warnings) build.result.warnings.push(`${where}: ${warning}`);
  return selection.files;
}

async function runAction(item: ReadyAction, files: AssetFile[], scope: Scope, build: Build): Promise<void> {
  const where = `action ${item.index} (${item.label})`;
  const target = item.destination;
  const ownVirtual = target.folder?.startsWith('#') ? splitVirtual(target.folder) : undefined;
  const virtual = ownVirtual ?? scope.redirect;

  // the action runs in memory; only the filename template goes along, so an atlas can predict its page names
  let result: ActionResult;
  try {
    result = await item.action.process({ ...item.options, source: files, destination: { filename: target.filename } });
  } catch (error) {
    build.result.errors.push(`${where}: ${(error as Error).message}`);
    return;
  }
  result.label = item.label;
  // build hands every action its files in memory; only a virtual source is not source bytes
  if (item.source.virtual !== undefined) result.virtualSource = item.source.virtual;
  else delete result.virtualSource;
  build.result.warnings.push(...result.warnings.map((warning) => `${where}: ${warning}`));
  build.result.errors.push(...result.errors.map((error) => `${where}: ${error}`));
  build.result.actions.push(result);

  // no destination folder: the output lands where its source was. A folder replaces the pattern's folder.
  const folder = ownVirtual ? ownVirtual.sub : target.folder;
  const rows = new Map(result.files.map((row) => [row.source, row]));
  for (const row of result.files) row.outputs = [];
  for (const output of result.outputs) {
    const row = rows.get(output.origin ?? `${result.selected} files`) as FileResult;
    const relative = join(ownVirtual ? '' : scope.redirect?.sub, scope.prefix, folder ?? output.base, outputPath(output, target.filename));
    output.path = relative;
    if (virtual) {
      (build.virtual[virtual.name] ??= []).push({ ...output, origin: `#${virtual.name}/${relative}`, base: '' });
      row.outputs.push(`#${virtual.name}/${relative}`);
      continue;
    }
    const owner = `${where} from ${row.source}`;
    const existing = build.produced.get(relative);
    if (existing && existing !== owner) {
      const catchAll = flattenActions(build.ready.items).some(isCatchAll);
      build.result.errors.push(
        `"${relative}" is produced twice: ${existing}, and ${owner}.` +
          (catchAll ? ' Give the catch-all "source": "#rest" to take only what others leave.' : '')
      );
      continue;
    }
    build.produced.set(relative, owner);
    if (!build.result.dryRun) await writeFile(path.join(build.staging, relative), output.data);
    row.outputs.push(relative);
  }
  if (!virtual) result.destination = path.join(build.ready.destination, scope.prefix, folder ?? '');
}

/** The one folder every file came from, as a path; `''` when they come from several. */
function commonBase(files: AssetFile[]): string {
  const bases = new Set(files.map((file) => file.base ?? ''));
  return bases.size === 1 ? ([...bases][0] as string) : '';
}

function flattenActions(items: ReadyItem[]): ReadyAction[] {
  return items.flatMap((item) => (item.kind === 'action' ? [item] : flattenActions(item.items)));
}

// an action without `source` takes every file its type accepts
function isCatchAll(action: ReadyAction): boolean {
  return action.source.include.length === 0 && !action.source.rest && action.source.virtual === undefined;
}

// A file taken by an action without `source` and again by another action usually means a catch-all is not last.
function warnOverlaps(build: Build): void {
  const actions = flattenActions(build.ready.items);
  for (const catchAll of actions) {
    if (!isCatchAll(catchAll)) continue;
    const mine = new Set(build.selected.get(catchAll) ?? []);
    for (const other of actions) {
      if (other === catchAll) continue;
      const shared = (build.selected.get(other) ?? []).filter((origin) => mine.has(origin)).length;
      if (!shared) continue;
      build.result.warnings.push(
        `${shared} file${shared === 1 ? '' : 's'} selected by action ${catchAll.index} (${catchAll.label}) are also selected by ` +
          `action ${other.index} (${other.label}). Give action ${catchAll.index} "source": "#rest" if it should take only what others do not.`
      );
    }
  }
}

async function commit(staging: string, destination: string, produced: Map<string, string>, clean: boolean): Promise<void> {
  for (const relative of await listFiles(staging)) await renameOver(path.join(staging, relative), path.join(destination, relative));
  if (clean && (await exists(destination))) {
    for (const relative of await listFiles(destination, [STAGING])) {
      if (!produced.has(relative)) await fs.unlink(path.join(destination, relative));
    }
    await removeEmptyFolders(destination);
  }
  await remove(staging);
}

function finishBuild(result: BuildResult, started: number, options: BuildOptions): BuildResult {
  result.ok = result.errors.length === 0 && (!options.strict || result.warnings.length === 0);
  result.duration = performance.now() - started;
  return result;
}
