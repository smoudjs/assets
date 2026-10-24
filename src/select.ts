import { promises as fs } from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import { isInside } from './config.js';
import type { Action, Group, Item, Selection } from './plan.js';
import type { ActionType, AssetMeta, WhenSpec } from './types.js';
import { extension, join, stripBase } from './utils/fs.js';

/** A file in the pool an action selects from. Disk files load `data` lazily; virtual files carry it already. */
export interface PoolFile {
  /** Relative to the current scope; re-rooted when entering a preset group. */
  path: string;
  /** Relative to the base source, or `#name/path` for virtual files. Used in results and messages. */
  origin: string;
  absolute?: string;
  data?: Buffer;
  meta: AssetMeta;
  tokens?: Record<string, string | number>;
  /** Folder part of the pattern that selected the file; reused to mirror the source tree. */
  base: string;
  /** Destination prefix accumulated from enclosing preset groups. */
  prefix: string;
  /** Set when an enclosing group sends everything to a virtual folder. */
  redirect?: string;
}

const MATCH_OPTIONS = { dot: false, nocase: process.platform === 'win32' || process.platform === 'darwin' };

// Like gitignore: a pattern without a slash matches by file name at any depth (`*.json`).
// picomatch's matchBase would do that for every pattern, so it is only switched on for slash-less ones.
const matchOptionsFor = (pattern: string) => (pattern.includes('/') ? MATCH_OPTIONS : { ...MATCH_OPTIONS, matchBase: true });

/** Every file under `source` as sorted posix paths. Skips the destination, dot entries, node_modules and symlinks that escape. */
export async function discover(source: string, destination: string, exclude: string[]): Promise<PoolFile[]> {
  const excluded = matchesAny(exclude, []);
  const realSource = await fs.realpath(source);
  const files: PoolFile[] = [];

  async function visit(dir: string, relative: string): Promise<void> {
    const entries = (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const absolute = path.join(dir, entry.name);
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (path.relative(destination, absolute) === '' || excluded(rel)) continue;

      let target = absolute;
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          target = await fs.realpath(absolute);
        } catch {
          continue;
        }
        if (!isInside(realSource, target)) continue;
        const stat = await fs.stat(target);
        [isDir, isFile] = [stat.isDirectory(), stat.isFile()];
      }

      if (isDir) await visit(absolute, rel);
      else if (isFile) {
        const { size } = await fs.stat(target);
        files.push({ path: rel, origin: rel, absolute: target, meta: { size }, base: '', prefix: '' });
      }
    }
  }

  await visit(source, '');
  return files;
}

/**
 * Which files each action gets, in list order: explicit and omitted sources select from the whole pool,
 * `#rest` from what the actions above have not taken. Virtual sources are resolved later by the runner.
 */
export async function resolveSelections(
  items: Item[],
  pool: PoolFile[],
  warnings: string[]
): Promise<Map<Action, PoolFile[]>> {
  const selected = new Map<Action, PoolFile[]>();
  await resolveGroup(items, pool, selected, warnings);
  return selected;
}

/** Returns the origins the group took out of `pool`, so the enclosing group can compute its own `#rest`. */
async function resolveGroup(
  items: Item[],
  pool: PoolFile[],
  selected: Map<Action, PoolFile[]>,
  warnings: string[]
): Promise<Set<string>> {
  const taken = new Set<string>();
  for (const item of items) {
    if (item.source.virtual) {
      if (item.kind === 'action') selected.set(item, []);
      else warnings.push(`${item.label}: a preset cannot read a virtual folder; it selected nothing`);
      continue;
    }
    const from = item.source.rest ? pool.filter((file) => !taken.has(file.origin)) : pool;
    const accepts = item.kind === 'action' ? item.type.accepts : '*';
    const type = item.kind === 'action' ? item.type : undefined;
    const files = await pickFiles(from, item.source, accepts, type, item.label, warnings);
    if (item.kind === 'action') {
      selected.set(item, files);
      for (const file of files) taken.add(file.origin);
    } else {
      const innerTaken = await resolveGroup(item.items, enterGroupScope(files, item), selected, warnings);
      for (const origin of innerTaken) taken.add(origin);
    }
  }
  return taken;
}

/** Files entering a preset group are re-rooted at the pattern folder; their results get the group's destination prefix. */
function enterGroupScope(files: PoolFile[], group: Group): PoolFile[] {
  const target = group.destination;
  return files.map((file) => ({
    ...file,
    path: stripBase(file.path, file.base),
    base: '',
    prefix: target?.virtual !== undefined ? file.prefix : join(file.prefix, target?.folder ?? file.base),
    redirect: target?.virtual ?? file.redirect
  }));
}

/** Match include / exclude, keep what the type accepts, then apply `when`. */
export async function pickFiles(
  pool: PoolFile[],
  selection: Selection,
  accepts: readonly string[] | '*',
  type: ActionType | undefined,
  label: string,
  warnings: string[]
): Promise<PoolFile[]> {
  const paths = pool.map((file) => file.path);
  const includes = selection.include.map((pattern) => compilePattern(pattern, paths));
  const excluded = matchesAny(selection.exclude, paths);
  const when = selection.when ? compileWhen(selection.when, label, warnings) : undefined;

  const result: PoolFile[] = [];
  for (const file of pool) {
    let base = file.base;
    if (includes.length) {
      const hit = includes.find((include) => include.test(file.path));
      if (!hit) continue;
      base = hit.base;
    }
    if (excluded(file.path)) continue;
    if (accepts !== '*' && !accepts.includes(extension(file.path))) continue;
    if (when) {
      if (when.needs.length) await probeFacts(file, type, when.needs, label, warnings);
      if (!when.test(file.meta)) continue;
    }
    result.push({ ...file, base });
  }
  return result;
}

interface CompiledPattern {
  test: (filePath: string) => boolean;
  base: string;
}

/** A glob, a folder name (everything under it), or a single file path. */
function compilePattern(pattern: string, paths: string[]): CompiledPattern {
  const scanned = picomatch.scan(pattern);
  if (scanned.isGlob) return { test: picomatch(pattern, matchOptionsFor(pattern)), base: cleanFolderPath(scanned.base) };
  const clean = cleanFolderPath(pattern);
  if (paths.includes(clean)) return { test: (p) => p === clean, base: cleanFolderPath(path.posix.dirname(clean)) };
  return { test: picomatch(`${clean}/**`, MATCH_OPTIONS), base: clean };
}

function matchesAny(patterns: string[], paths: string[]): (filePath: string) => boolean {
  if (!patterns.length) return () => false;
  const compiled = patterns.map((pattern) => compilePattern(pattern, paths));
  return (filePath) => compiled.some((pattern) => pattern.test(filePath));
}

function cleanFolderPath(folder: string): string {
  const clean = folder.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  return clean === '.' ? '' : clean;
}

type Fact = 'width' | 'height' | 'alpha' | 'animated';

interface CompiledWhen {
  /** Facts a probe has to supply before `test` can answer. */
  needs: Fact[];
  test: (meta: AssetMeta) => boolean;
}

const UNITS: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, px: 1 };

function compileWhen(when: WhenSpec, label: string, warnings: string[]): CompiledWhen {
  const checks: Array<(meta: AssetMeta) => boolean> = [];
  const needs: Fact[] = [];

  for (const key of Object.keys(when) as Array<keyof WhenSpec>) {
    const value = when[key];
    if (value === undefined) continue;
    if (key === 'alpha' || key === 'animated') {
      if (typeof value !== 'boolean') {
        warnings.push(`${label}: when.${key} must be true or false; ignored`);
        continue;
      }
      needs.push(key);
      checks.push((meta) => meta[key] === value);
    } else if (key === 'size' || key === 'width' || key === 'height') {
      const tests = (Array.isArray(value) ? value : [value]).map((text) => parseComparison(String(text), key === 'size'));
      const bad = tests.find((t) => typeof t === 'string');
      if (typeof bad === 'string') {
        warnings.push(`${label}: when.${key} ${bad}; ignored`);
        continue;
      }
      if (key !== 'size') needs.push(key);
      checks.push((meta) => {
        const actual = meta[key];
        return actual !== undefined && (tests as Array<(n: number) => boolean>).every((t) => t(actual));
      });
    } else {
      warnings.push(`${label}: unknown when "${key}"; ignored`);
    }
  }
  return { needs, test: (meta) => checks.every((check) => check(meta)) };
}

/** `">200kb"`, `">=1024"`, `"<2mb"`, `"512"` (bare number means equal). Returns a predicate, or a message when malformed. */
function parseComparison(text: string, bytes: boolean): ((n: number) => boolean) | string {
  const match = /^\s*(>=|<=|!=|==|>|<|=)?\s*(\d+(?:\.\d+)?)\s*([a-z]*)\s*$/i.exec(text);
  if (!match) return `"${text}" is not a comparison; write it like ">200kb" or ">=1024"`;
  const unit = (match[3] ?? '').toLowerCase();
  const factor = unit ? UNITS[unit] : 1;
  if (factor === undefined || (bytes ? unit === 'px' : unit && unit !== 'px'))
    return `"${text}" has an unexpected unit "${unit}"`;
  const target = Number(match[2]) * factor;
  switch (match[1] ?? '=') {
    case '>':
      return (n) => n > target;
    case '>=':
      return (n) => n >= target;
    case '<':
      return (n) => n < target;
    case '<=':
      return (n) => n <= target;
    case '!=':
      return (n) => n !== target;
    default:
      return (n) => n === target;
  }
}

/** Without a probe the facts stay unknown and the file fails the `when`; warned once per action. */
async function probeFacts(
  file: PoolFile,
  type: ActionType | undefined,
  needs: Fact[],
  label: string,
  warnings: string[]
): Promise<void> {
  if (needs.every((fact) => file.meta[fact] !== undefined)) return;
  if (!type?.probe) {
    const note = `${label}: "${type?.name ?? 'preset'}" cannot determine ${needs.join(', ')}; files failed this "when"`;
    if (!warnings.includes(note)) warnings.push(note);
    return;
  }
  const data = await loadData(file);
  Object.assign(file.meta, await type.probe({ path: file.path, data, meta: file.meta }));
}

export async function loadData(file: PoolFile): Promise<Buffer> {
  if (!file.data) file.data = await fs.readFile(file.absolute as string);
  return file.data;
}
