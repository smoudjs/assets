// Finding files with the `source` syntax and writing them with the `destination` syntax. Paths inside the
// pipeline are posix and relative; `root` and the destination folder are the only absolute ones.

import { promises as fs, type Dirent, type Stats } from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import type {
  AssetFile,
  AssetMeta,
  Destination,
  DestinationSpec,
  Probe,
  Source,
  SourcePattern,
  SourceSpec,
  WhenSpec
} from './types.js';
import {
  basename,
  dirname,
  extension,
  isPathUnderFolder,
  join,
  renderFilename,
  statOrNull,
  stripFolder,
  toPosix,
  writeFile
} from './utils/fs.js';
import { toArray } from './utils/object.js';

export interface SelectOptions {
  /** Folder the patterns are relative to. Default: the working directory. */
  root?: string;
  /** Select from these files instead of the disk. */
  pool?: AssetFile[];
  /** Keep only files with these extensions. Default: every file. */
  accepts?: readonly string[] | '*';
  /** Answers `when` keys other than `size`. Without one such a key excludes the file and warns. */
  probe?: Probe;
  /** Patterns that never match, on top of the source's own `exclude`. */
  exclude?: SourcePattern | SourcePattern[];
  /** Drops a file by its origin before anything is read. Build uses it for `#rest`. */
  skip?: (origin: string) => boolean;
  /** The action's search for the files a selected file refers to; they are read into `file.companions`. */
  findCompanions?: (file: AssetFile) => string[];
}

export interface Selection {
  files: AssetFile[];
  /** Name of the one folder every file came from, like `icons`; `''` when they come from several. Group outputs are named after it. */
  folderName: string;
  warnings: string[];
}

const DEFAULT_FILENAME = '[name][ext]';
const MATCH_OPTIONS = { dot: false, nocase: process.platform === 'win32' || process.platform === 'darwin' };

/** The files a `source` selects, with their data loaded. Patterns resolve from `root`, absolute patterns as they are. */
export async function selectFiles(source: Source | AssetFile[], options: SelectOptions = {}): Promise<Selection> {
  const warnings: string[] = [];
  const fromMemory = isFileList(source);
  const spec = fromMemory ? { include: [], exclude: [] } : normalizeSource(source);
  const root = path.resolve(options.root ?? '.');
  const includes = spec.include.map((pattern) => compilePattern(pattern, root));
  const excluded = matchesAny([...toArray(options.exclude).map(cleanPattern), ...spec.exclude], root);
  const when = spec.when ? compileWhen(spec.when, warnings) : undefined;
  const accepts = options.accepts ?? '*';

  const pool = fromMemory ? source : options.pool;
  const candidates = pool ? pool.map(candidateFromMemory) : await walkPatternFolders(root, includes, excluded);

  const files: AssetFile[] = [];
  for (const candidate of candidates) {
    // files passed in memory keep the folder they were selected from, unless a pattern selects them again
    let selectedFrom = candidate.file?.selectedFrom ?? '';
    if (includes.length) {
      const hit = includes.find((include) => include.test(candidate.path));
      if (!hit) continue;
      selectedFrom = hit.selectedFrom(candidate.path);
    }
    if (excluded(candidate.path)) continue;
    if (options.skip?.(candidate.origin)) continue;
    if (accepts !== '*' && !accepts.includes(extension(candidate.path))) continue;

    // cheapest first: the size from the file system, then the facts; only a file that passes is read
    let meta = candidate.file?.meta;
    if (when) {
      meta ??= { size: (await fs.stat(candidate.absolute as string)).size };
      if (!when.testSize(meta.size)) continue;
      const input = candidate.file?.data ?? (candidate.absolute as string);
      if (!(await passesFacts(meta, when, options.probe, input, warnings))) continue;
    }
    const data = candidate.file?.data ?? (await fs.readFile(candidate.absolute as string));
    const file: AssetFile = {
      ...candidate.file,
      path: stripFolder(candidate.path, selectedFrom),
      data,
      meta: meta ?? { size: data.length },
      origin: candidate.origin,
      // a folder outside the root would let an output placed by its source folder escape the destination
      selectedFrom: selectedFrom.startsWith('..') ? '' : selectedFrom
    };
    // files handed over from an earlier selection already carry their companions
    if (options.findCompanions && !file.companions) {
      file.companions = await readCompanions(candidate, options.findCompanions(file), root, pool);
    }
    files.push(file);
  }
  return { files, folderName: commonFolderName(files), warnings };
}

/** Writes every file under the destination folder, the filename template applied. Returns the paths relative to it. */
export async function writeFiles(files: AssetFile[], destination: Destination): Promise<string[]> {
  const { folder, filename } = normalizeDestination(destination);
  if (folder === undefined || folder.startsWith('#')) throw new Error('writeFiles needs a destination folder on disk');
  const written: string[] = [];
  for (const file of files) {
    const relative = destinationPath(file, filename);
    await writeFile(path.resolve(folder, relative), file.data);
    written.push(relative);
  }
  return written;
}

/** Where a file lands relative to its destination folder: its own folder part, then the filename template applied. */
export function destinationPath(file: AssetFile, filename: string = DEFAULT_FILENAME): string {
  return join(dirname(file.path), renderFilename(filename, basename(file.path), file.data, file.filenameTokens));
}

/** `"ui"` → `{ folder: "ui" }`; folders are cleaned to posix without `./` or a trailing slash. */
export function normalizeDestination(destination: Destination | undefined): DestinationSpec {
  const spec = typeof destination === 'string' ? { folder: destination } : (destination ?? {});
  return {
    folder: spec.folder === undefined ? undefined : cleanFolderPath(toPosix(spec.folder)),
    filename: spec.filename ?? DEFAULT_FILENAME
  };
}

export interface NormalizedSource {
  include: string[];
  exclude: string[];
  when?: WhenSpec;
}

/** `"ui"` → `{ include: ["ui"], exclude: [] }`; patterns are cleaned, a `#virtual` pattern is refused. */
export function normalizeSource(source: Source): NormalizedSource {
  const spec: SourceSpec = typeof source === 'string' || Array.isArray(source) ? { include: source } : source;
  const include = toArray(spec.include).map(cleanPattern);
  const exclude = toArray(spec.exclude).map(cleanPattern);
  for (const pattern of include) {
    if (pattern.startsWith('#')) throw new Error(`"${pattern}": virtual folders exist only inside a build`);
  }
  return { include, exclude, when: spec.when };
}

/** Every file under `root` that `ignore` does not drop, as root-relative posix paths, without reading any. */
export async function listSourceFiles(root: string, ignore: SourcePattern | SourcePattern[] = []): Promise<string[]> {
  const absolute = path.resolve(root);
  const ignored = matchesAny(toArray(ignore).map(cleanPattern), absolute);
  return (await walkPatternFolders(absolute, [], ignored)).map((candidate) => candidate.origin);
}

/** Files already in memory, as opposed to patterns. An empty list counts as files. */
export function isFileList(source: Source | AssetFile[]): source is AssetFile[] {
  return Array.isArray(source) && source.every((item) => typeof item === 'object');
}

function cleanPattern(pattern: unknown): string {
  if (typeof pattern !== 'string' || !pattern.trim())
    throw new Error(`patterns must be non-empty strings, got ${JSON.stringify(pattern)}`);
  return toPosix(pattern).replace(/^\.\//, '');
}

function cleanFolderPath(folder: string): string {
  const clean = folder.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  return clean === '.' ? '' : clean;
}

// Reads exactly the paths the action's findCompanions named, relative to the file. A missing one is left out, so the
// action can name the file it needed; a path that climbs above the root, or out of the files in memory, is never read.
async function readCompanions(
  candidate: Candidate,
  references: string[],
  root: string,
  pool: AssetFile[] | undefined
): Promise<AssetFile[]> {
  const companions: AssetFile[] = [];
  for (const reference of references) {
    const relative = path.posix.normalize(join(dirname(candidate.path), toPosix(reference)));
    if (relative.startsWith('..')) continue;
    if (pool) {
      const found = pool.find((file) => file.path === relative);
      if (found) companions.push({ ...found, path: reference });
      continue;
    }
    const data = await fs.readFile(path.resolve(root, relative)).catch(() => undefined);
    if (data) companions.push({ path: reference, data, meta: { size: data.length }, origin: relative });
  }
  return companions;
}

/** The name of the folder the files have in common: the pattern's folder, or the virtual folder they were read from. */
function commonFolderName(files: AssetFile[]): string {
  const folders = new Set(files.map((file) => file.selectedFrom ?? ''));
  const folder = folders.size === 1 ? ([...folders][0] as string) : '';
  if (folder) return basename(folder);
  const virtual = new Set(files.map((file) => (file.origin?.startsWith('#') ? file.origin.slice(1).split('/')[0] : '')));
  return virtual.size === 1 ? ([...virtual][0] as string) : '';
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

interface CompiledPattern {
  test(relative: string): boolean;
  /** Folder part of the pattern, for the file it matched. */
  selectedFrom(relative: string): string;
  /** Where to start walking the disk: a folder, or a single file. Relative to the root. */
  walkFrom: string;
}

// A pattern without a slash matches by file name at any depth (`*.json`).
// picomatch's matchBase would do that for every pattern, so it is only switched on for slash-less ones.
const matchOptionsFor = (pattern: string) => (pattern.includes('/') ? MATCH_OPTIONS : { ...MATCH_OPTIONS, matchBase: true });

/** A glob, a folder (everything under it), or a single file. An absolute pattern is made relative to the root first. */
function compilePattern(input: string, root: string): CompiledPattern {
  const pattern = path.isAbsolute(input) ? toPosix(path.relative(root, input)) : input;
  const scanned = picomatch.scan(pattern);
  if (scanned.isGlob) {
    const matcher = picomatch(pattern, matchOptionsFor(pattern));
    const folder = cleanFolderPath(scanned.base);
    return { test: matcher, selectedFrom: () => folder, walkFrom: folder };
  }
  // a plain path is a folder, unless it names exactly one file
  const clean = cleanFolderPath(pattern);
  const under = picomatch(`${clean}/**`, MATCH_OPTIONS);
  return {
    test: (relative) => relative === clean || under(relative),
    selectedFrom: (relative) => (relative === clean ? cleanFolderPath(path.posix.dirname(clean)) : clean),
    walkFrom: clean
  };
}

function matchesAny(patterns: string[], root: string): (relative: string) => boolean {
  if (!patterns.length) return () => false;
  const compiled = patterns.map((pattern) => compilePattern(pattern, root));
  return (relative) => compiled.some((pattern) => pattern.test(relative));
}

// ---------------------------------------------------------------------------
// Walking the disk
// ---------------------------------------------------------------------------

interface Candidate {
  /** Path the patterns are matched against: relative to the root, or the file's own path when it comes from memory. */
  path: string;
  origin: string;
  absolute?: string;
  file?: AssetFile;
}

function candidateFromMemory(file: AssetFile): Candidate {
  return { path: file.path, origin: file.origin ?? file.path, file };
}

/** Every file under the folder part of each pattern, as root-relative posix paths. No patterns: everything under the root. */
async function walkPatternFolders(
  root: string,
  includes: CompiledPattern[],
  excluded: (relative: string) => boolean
): Promise<Candidate[]> {
  const starts = includes.length ? includes.map((include) => path.resolve(root, include.walkFrom)) : [root];
  const unique = [...new Set(starts)].sort();
  const candidates: Candidate[] = [];
  for (const [index, start] of unique.entries()) {
    if (unique.slice(0, index).some((other) => isPathUnderFolder(start, other))) continue;
    const kind = await statOrNull(start);
    if (!kind) continue;
    const origin = toPosix(path.relative(root, start));
    if (kind.isFile()) candidates.push({ path: origin, origin, absolute: start });
    else if (kind.isDirectory()) await walkFolder(start, origin, candidates, excluded);
  }
  return candidates;
}

/** Skips dot entries, node_modules, excluded folders and symlinks that lead outside the folder being walked. */
async function walkFolder(
  folder: string,
  origin: string,
  candidates: Candidate[],
  excluded: (relative: string) => boolean
): Promise<void> {
  const real = await fs.realpath(folder);
  async function visit(dir: string, relative: string): Promise<void> {
    const entries = (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const absolute = path.join(dir, entry.name);
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (excluded(rel)) continue;

      let target = absolute;
      let kind: Dirent | Stats = entry;
      if (entry.isSymbolicLink()) {
        try {
          target = await fs.realpath(absolute);
        } catch {
          continue;
        }
        if (!isPathUnderFolder(target, real)) continue;
        kind = await fs.stat(target);
      }
      if (kind.isDirectory()) await visit(absolute, rel);
      else if (kind.isFile()) candidates.push({ path: rel, origin: rel, absolute: target });
    }
  }
  await visit(folder, origin);
}

// ---------------------------------------------------------------------------
// when
// ---------------------------------------------------------------------------

interface CompiledWhen {
  /** Facts other than size, which a probe has to supply. */
  needs: string[];
  testSize(size: number): boolean;
  /** The facts other than size; with `knownOnly`, those not known yet are skipped instead of failing. */
  testFacts(meta: AssetMeta, knownOnly?: boolean): boolean;
}

const UNITS: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, px: 1 };

const COMPARE: Record<string, (actual: number, target: number) => boolean> = {
  '>': (actual, target) => actual > target,
  '>=': (actual, target) => actual >= target,
  '<': (actual, target) => actual < target,
  '<=': (actual, target) => actual <= target,
  '!=': (actual, target) => actual !== target,
  '=': (actual, target) => actual === target,
  '==': (actual, target) => actual === target
};

function compileWhen(when: WhenSpec, warnings: string[]): CompiledWhen {
  const checks: Array<{ key: string; check: (meta: AssetMeta) => boolean }> = [];
  for (const [key, value] of Object.entries(when)) {
    if (value === undefined) continue;
    if (typeof value === 'boolean') {
      checks.push({ key, check: (meta) => meta[key] === value });
      continue;
    }
    const tests = toArray(value).map((text) => parseComparison(String(text)));
    const bad = tests.find((test) => typeof test === 'string');
    if (typeof bad === 'string') {
      warnings.push(`when.${key} ${bad}; ignored`);
      continue;
    }
    const check = (meta: AssetMeta) => {
      const actual = meta[key];
      return typeof actual === 'number' && (tests as Array<(n: number) => boolean>).every((test) => test(actual));
    };
    checks.push({ key, check });
  }
  const sizeChecks = checks.filter(({ key }) => key === 'size');
  const factChecks = checks.filter(({ key }) => key !== 'size');
  return {
    needs: [...new Set(Object.keys(when).filter((key) => key !== 'size' && when[key] !== undefined))],
    testSize: (size) => sizeChecks.every(({ check }) => check({ size })),
    testFacts: (meta, knownOnly) =>
      factChecks.every(({ key, check }) => (knownOnly && meta[key] === undefined) || check(meta))
  };
}

/** `">200kb"`, `">=1024"`, `"<2mb"`, `"512"` (bare number means equal). Returns a predicate, or a message when malformed. */
function parseComparison(text: string): ((n: number) => boolean) | string {
  const match = /^\s*(>=|<=|!=|==|>|<|=)?\s*(\d+(?:\.\d+)?)\s*([a-z]*)\s*$/i.exec(text);
  if (!match) return `"${text}" is not a comparison; write it like ">200kb" or ">=1024"`;
  const unit = (match[3] ?? '').toLowerCase();
  const factor = unit ? UNITS[unit] : 1;
  if (factor === undefined) return `"${text}" has an unexpected unit "${unit}"`;
  const target = Number(match[2]) * factor;
  const compare = COMPARE[match[1] ?? '='] as (actual: number, target: number) => boolean;
  return (actual) => compare(actual, target);
}

// The cheap facts come first and are checked at once, so a file they rule out never pays for the expensive ones; then
// the probe works out only the facts still missing. A fact nothing can tell fails the file, warned once.
async function passesFacts(
  meta: AssetMeta,
  when: CompiledWhen,
  probe: Probe | undefined,
  input: Buffer | string,
  warnings: string[]
): Promise<boolean> {
  const missing = () => when.needs.filter((fact) => meta[fact] === undefined);
  if (missing().length && probe) {
    Object.assign(meta, await probe(input, 'cheap', meta));
    if (!when.testFacts(meta, true)) return false;
    if (missing().length) Object.assign(meta, await probe(input, missing(), meta));
  }
  const unknown = missing();
  if (unknown.length) {
    const note = `when.${unknown.join(', when.')} cannot be determined for these files; they failed this "when"`;
    if (!warnings.includes(note)) warnings.push(note);
  }
  return when.testFacts(meta);
}
