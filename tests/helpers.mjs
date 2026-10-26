/**
 * Test helpers. Tests read the shared resources in tests/assets in place and write to fresh folders
 * under tests/.tmp, which are removed when the test file finishes.
 */

import { cp, mkdir, mkdtemp, readdir, readFile, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { actions, build, finishAction, outputPath, resolveOptions, selectFiles } from '../dist/index.js';

const TESTS = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path of the shared resources. */
export const ASSETS = path.join(TESTS, 'assets');
const TMP = path.join(TESTS, '.tmp');

// Test files run in parallel processes and share tests/.tmp: remove only this file's folders,
// and the shared folder only once it is empty.
const temps = [];
after(async () => {
  await Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 3 })));
  await rmdir(TMP).catch(() => {});
});

/** A fresh folder under tests/.tmp, removed after the test file. */
export async function tempDir() {
  await mkdir(TMP, { recursive: true });
  const dir = await mkdtemp(path.join(TMP, 'run-'));
  temps.push(dir);
  return dir;
}

/**
 * Run a build: source is tests/assets (or `config.source`), destination a fresh temp folder
 * (or `config.destination` to build into the same place again). Returns the result plus helpers
 * to look at the output.
 */
export async function run(config, options = {}) {
  const destination = config.destination ?? (await tempDir());
  const exclude = ['generate.mjs', ...(Array.isArray(config.exclude) ? config.exclude : config.exclude ? [config.exclude] : [])];
  const result = await build({ ...options, config: { source: ASSETS, ...config, destination, exclude } });
  return {
    result,
    destination,
    /** Output files relative to the destination, sorted. */
    outputs: () => listFiles(destination),
    exists: (relative) => stat(path.join(destination, relative)).then(() => true, () => false),
    read: (relative) => readFile(path.join(destination, relative))
  };
}

/** Every file under `dir` as sorted posix paths relative to `dir`; `[]` when the folder does not exist. */
export async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath ?? entry.path, entry.name)).replaceAll('\\', '/'))
    .sort();
}

/** A writable copy of tests/assets for tests that delete or change source files. */
export async function scratchAssets() {
  const dir = await tempDir();
  await cp(ASSETS, dir, { recursive: true, filter: (file) => !file.endsWith('generate.mjs') });
  return {
    dir,
    remove: (relative) => rm(path.join(dir, relative), { recursive: true, force: true }),
    write: (relative, content) => writeFile(path.join(dir, relative), content)
  };
}

/**
 * A test action that turns all its files into one group output, like an atlas does: a `.txt` listing the
 * input paths, named after the selected folder, plus a `.ref` holding the name the `.txt` gets on disk.
 */
export const bundle = actions.register({
  name: 'bundle',
  accepts: '*',
  options: {},
  async process({ source, destination }) {
    const started = performance.now();
    const { files, folder, warnings } = await selectFiles(source);
    const name = folder || 'all';
    const template = typeof destination === 'object' ? destination.filename : undefined;
    const list = { path: `${name}.txt`, data: Buffer.from(files.map((file) => file.path).join('\n')), meta: { size: 0 } };
    const ref = { path: `${name}.ref`, data: Buffer.from(outputPath(list, template)), meta: { size: 0 } };
    return finishAction({ action: 'bundle', source, destination, inputs: files, outputs: [list, ref], warnings, errors: [], started });
  }
});

/** A test action that renames every file, so outputs differ from inputs without needing Sharp. */
export const tag = actions.register({
  name: 'tag',
  accepts: '*',
  options: { suffix: { kind: 'string', description: 'appended before the extension', default: '-tagged' } },
  async process({ source, destination, ...input }) {
    const started = performance.now();
    const options = resolveOptions(tag.options, input);
    const { files, warnings } = await selectFiles(source);
    const outputs = files.map((file) => ({ ...file, path: file.path.replace(/(\.[^./]+)?$/, `${options.suffix}$1`) }));
    return finishAction({ action: 'tag', source, destination, inputs: files, outputs, warnings, errors: [], started });
  }
});
