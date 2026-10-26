// Filesystem, path and filename helpers. Every path inside the pipeline is posix-style and relative.

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Every file under `dir` as sorted posix paths relative to `dir`; `[]` when the folder does not exist. */
export async function listFiles(dir: string, skip: string[] = []): Promise<string[]> {
  const files: string[] = [];
  async function visit(current: string, relative: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!skip.includes(entry.name)) await visit(path.join(current, entry.name), rel);
      } else if (entry.isFile()) files.push(rel);
    }
  }
  await visit(dir, '');
  return files.sort();
}

/** Like fs.writeFile, but creates the folders first. */
export async function writeFile(file: string, data: Buffer): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, data);
}

/** Move a file into place over whatever is there. Falls back to copy + delete when a rename is refused. */
export async function renameOver(from: string, to: string): Promise<void> {
  await fs.mkdir(path.dirname(to), { recursive: true });
  try {
    await fs.rename(from, to);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'EEXIST') throw error;
    await fs.copyFile(from, to);
    await fs.unlink(from);
  }
}

export async function remove(target: string): Promise<void> {
  await fs.rm(target, { recursive: true, force: true, maxRetries: 3 });
}

/** Delete folders under `dir` that hold no files. `dir` itself stays. */
export async function removeEmptyFolders(dir: string): Promise<void> {
  async function visit(current: string): Promise<boolean> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    let empty = true;
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        empty = false;
        continue;
      }
      const child = path.join(current, entry.name);
      if (await visit(child)) await fs.rmdir(child);
      else empty = false;
    }
    return empty;
  }
  await visit(dir);
}

export async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export function samePath(a: string, b: string): boolean {
  return path.relative(a, b) === '';
}

/** `filePath` strictly below `folder` at any depth; equal paths give false. Both absolute. */
export function isPathUnderFolder(filePath: string, folder: string): boolean {
  const relative = path.relative(folder, filePath);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function toPosix(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

/** `stripBase('images/bg/sky.png', 'images')` → `bg/sky.png`. An empty base returns the path unchanged. */
export function stripBase(filePath: string, base: string): string {
  return base && filePath.startsWith(`${base}/`) ? filePath.slice(base.length + 1) : filePath;
}

/** Join path parts, skipping empty ones. */
export function join(...parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join('/');
}

/** Folder part of a path, `''` when there is none. */
export function dirname(filePath: string): string {
  const slash = filePath.lastIndexOf('/');
  return slash >= 0 ? filePath.slice(0, slash) : '';
}

export function basename(filePath: string): string {
  return filePath.slice(filePath.lastIndexOf('/') + 1);
}

/** Lower-case extension without the dot: `sky.PNG` → `png`. */
export function extension(filePath: string): string {
  return splitName(basename(filePath)).ext.slice(1).toLowerCase();
}

/** `sky.png` → `{ name: 'sky', ext: '.png' }`; `README` → `{ name: 'README', ext: '' }`. */
export function splitName(fileName: string): { name: string; ext: string } {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? { name: fileName.slice(0, dot), ext: fileName.slice(dot) } : { name: fileName, ext: '' };
}

/** sha1 of the content as hex. `[hash]` in a filename is its first characters. */
export function contentHash(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/**
 * Render a filename template: `[name]`, `[ext]` (with the dot), `[hash]` (8 chars of the content hash),
 * `[hash:n]`, and any token the action type supplied. Unknown tokens are left as written.
 * When the template has no `[ext]` and the result has no extension, the file's own is appended.
 */
export function renderFilename(
  template: string,
  fileName: string,
  data: Buffer,
  tokens: Record<string, string | number> = {}
): string {
  const { name, ext } = splitName(fileName);
  let usedExt = false;
  const rendered = template.replace(/\[([a-zA-Z]+)(?::(\d+))?\]/g, (whole, token: string, length?: string) => {
    if (token === 'name') return name;
    if (token === 'ext') {
      usedExt = true;
      return ext;
    }
    // a type may supply the hash itself so that linked outputs (an atlas page and its JSON) share one
    if (token === 'hash') return String(tokens['hash'] ?? contentHash(data)).slice(0, Number(length ?? 8));
    const value = tokens[token];
    return value === undefined ? whole : String(value);
  });
  if (usedExt || splitName(rendered).ext) return rendered;
  return rendered + ext;
}
