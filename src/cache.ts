// The result cache in node_modules/.cache/smoud-assets: one file per result, named by a key built from everything
// that decides it. A file is a 4-byte header length, a JSON header (outputs without their bytes, and warnings),
// then the bytes of every output in order. Files are written under a temporary name and renamed, so a crash never
// leaves half a file; anything that does not read back cleanly is a miss, never an error.

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { AssetFile } from './types.js';
import { contentHash, listFiles, statOrNull, writeFile } from './utils/fs.js';

const CACHE_FOLDER = path.join('node_modules', '.cache', 'smoud-assets');
const MINUTE = 60 * 1000;
const PRUNE_INTERVAL = 10 * MINUTE;
const MAX_AGE = 30 * 24 * 60 * MINUTE;
const MAX_SIZE = 1024 ** 3;
const PRUNE_MARKER = '.pruned';

let lastPrune = 0;

export interface CachedResult {
  outputs: AssetFile[];
  warnings: string[];
}

interface Header {
  outputs: Array<Omit<AssetFile, 'data'> & { length: number }>;
  warnings: string[];
}

const cacheFolder = (): string => path.resolve(CACHE_FOLDER);
const cacheFile = (key: string): string => path.join(cacheFolder(), key.slice(0, 2), `${key}.bin`);

/** One key for everything that decides a result. The sharp version is always part of it. */
export function cacheKey(parts: unknown[]): string {
  return contentHash(Buffer.from(stableJson([sharp.versions, ...parts])));
}

/** The stored result, or undefined when there is none or it does not read back cleanly. */
export async function readCache(key: string): Promise<CachedResult | undefined> {
  try {
    const file = await fs.readFile(cacheFile(key));
    const headerLength = file.readUInt32BE(0);
    const header = JSON.parse(file.subarray(4, 4 + headerLength).toString('utf8')) as Header;
    let offset = 4 + headerLength;
    const outputs = header.outputs.map(({ length, ...output }) => {
      const data = file.subarray(offset, offset + length);
      offset += length;
      return { ...output, data };
    });
    if (offset !== file.length) return undefined;
    return { outputs, warnings: header.warnings };
  } catch {
    return undefined;
  }
}

/** Stores a result. A failed write is ignored: it only means a miss next time. */
export async function writeCache(key: string, result: CachedResult): Promise<void> {
  const header: Header = {
    outputs: result.outputs.map(({ data, ...output }) => ({ ...output, length: data.length })),
    warnings: result.warnings
  };
  const headerBytes = Buffer.from(JSON.stringify(header));
  const headerLength = Buffer.alloc(4);
  headerLength.writeUInt32BE(headerBytes.length);
  const file = cacheFile(key);
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, Buffer.concat([headerLength, headerBytes, ...result.outputs.map((output) => output.data)]));
    await fs.rename(temporary, file);
  } catch {
    await fs.rm(temporary, { force: true });
  }
  void pruneCache();
}

// At most every 10 minutes: files older than 30 days go, and over 1 GB the oldest go until half is left; temporary
// files are leftovers of interrupted writes once they are old enough to belong to no running build. Every build is
// a new process, so the time of the last run is the date of a marker file; `lastPrune` only saves checking it.
async function pruneCache(): Promise<void> {
  if (Date.now() - lastPrune < PRUNE_INTERVAL) return;
  lastPrune = Date.now();
  try {
    const marker = path.join(cacheFolder(), PRUNE_MARKER);
    const lastRun = await statOrNull(marker);
    if (lastRun && Date.now() - lastRun.mtimeMs < PRUNE_INTERVAL) return;
    await writeFile(marker, Buffer.alloc(0));

    const now = Date.now();
    const found = await Promise.all(
      (await listFiles(cacheFolder())).map(async (relative) => {
        const file = path.join(cacheFolder(), relative);
        const isTemporary = file.endsWith('.tmp');
        if (!isTemporary && !file.endsWith('.bin')) return undefined;
        const stats = await fs.stat(file);
        if (now - stats.mtimeMs > (isTemporary ? PRUNE_INTERVAL : MAX_AGE)) {
          await fs.rm(file, { force: true });
          return undefined;
        }
        return isTemporary ? undefined : { file, created: stats.mtimeMs, size: stats.size };
      })
    );
    const files = found.filter((entry) => entry !== undefined);
    let total = files.reduce((sum, entry) => sum + entry.size, 0);
    if (total <= MAX_SIZE) return;
    files.sort((a, b) => a.created - b.created);
    const oldest: string[] = [];
    for (const entry of files) {
      if (total <= MAX_SIZE / 2) break;
      oldest.push(entry.file);
      total -= entry.size;
    }
    await Promise.all(oldest.map((file) => fs.rm(file, { force: true })));
  } catch {
    // a cache that could not be pruned still works
  }
}

// object keys sorted, so the same options written in another order give the same key
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
