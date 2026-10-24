import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AssetsConfig } from './types.js';

export const DEFAULT_SOURCE = 'assets';
export const DEFAULT_DESTINATION = 'assets/compiled';

export interface LoadedConfig {
  config: AssetsConfig;
  /** Absolute path of the config file, when one was read. */
  configPath?: string;
}

/** An object is used as is, a string is a file path, nothing means `assets.json` in cwd (or an empty config when absent). */
export async function loadConfig(input: string | AssetsConfig | undefined, cwd: string): Promise<LoadedConfig> {
  if (input !== undefined && typeof input !== 'string') return { config: input };
  const configPath = path.resolve(cwd, input ?? 'assets.json');
  if (input === undefined && !(await statOrNull(configPath))) return { config: {} };
  return { config: await readConfigFile(configPath), configPath };
}

export async function readConfigFile(file: string): Promise<AssetsConfig> {
  if (file.endsWith('.json')) {
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch {
      throw new Error(`Config file not found: ${file}`);
    }
    try {
      return JSON.parse(text.replace(/^﻿/, '')) as AssetsConfig;
    } catch (error) {
      throw new Error(`${path.basename(file)} is not valid JSON: ${(error as Error).message}`);
    }
  }
  if (/\.(m?js|cjs)$/.test(file)) {
    const loaded = (await import(pathToFileURL(file).href)) as { default?: unknown };
    const config = loaded.default ?? loaded;
    if (typeof config !== 'object' || config === null || Array.isArray(config)) {
      throw new Error(`${path.basename(file)} must export a config object`);
    }
    return config as AssetsConfig;
  }
  throw new Error(`Unsupported config file ${file}; use .json, .js, .mjs or .cjs`);
}

export interface Folders {
  source: string;
  destination: string;
}

/** Absolute base folders, after the checks that keep a build from writing over its own source. */
export async function resolveFolders(
  config: AssetsConfig,
  dir: string,
  cwd: string,
  overrides: Partial<Folders> = {}
): Promise<Folders> {
  for (const key of ['source', 'destination'] as const) {
    const value = config[key];
    if (value !== undefined && (typeof value !== 'string' || /[*?{}[\]]/.test(value))) {
      throw new Error(`"${key}" must be a folder path, got ${JSON.stringify(value)}. Move the pattern into an action.`);
    }
  }

  // config folders are relative to the config file (`dir`), CLI overrides to the working directory
  const source =
    overrides.source !== undefined
      ? path.resolve(cwd, overrides.source)
      : path.resolve(dir, config.source ?? DEFAULT_SOURCE);
  const destination =
    overrides.destination !== undefined
      ? path.resolve(cwd, overrides.destination)
      : path.resolve(dir, config.destination ?? DEFAULT_DESTINATION);

  const sourceStat = await statOrNull(source);
  if (!sourceStat) throw new Error(`Source folder not found: ${source}`);
  if (!sourceStat.isDirectory()) throw new Error(`Source must be a folder: ${source}`);
  const destinationStat = await statOrNull(destination);
  if (destinationStat && !destinationStat.isDirectory()) throw new Error(`Destination must be a folder: ${destination}`);

  if (samePath(destination, source)) throw new Error('Destination must not be the same folder as the source');
  if (samePath(destination, path.resolve(cwd))) throw new Error('Destination must not be the project root');
  if (isInside(destination, source)) throw new Error('Destination must not contain the source folder');

  return { source, destination };
}

export function samePath(a: string, b: string): boolean {
  return path.relative(a, b) === '';
}

/** `child` strictly below `parent` (equal paths give false). Both absolute. */
export function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function statOrNull(target: string) {
  try {
    return await fs.stat(target);
  } catch {
    return null;
  }
}
