/**
 * @smoud/assets — public API.
 *
 *   await build();                                   // assets.json in cwd
 *   await build({ config: { actions: [...] } });      // the same object as the JSON
 *   await copy({ source: 'assets/fonts', destination: 'dist/fonts' });
 *   const files = await copy({ source: 'assets/fonts' });   // no destination: results in memory
 */

import os from 'node:os';
import path from 'node:path';
import { build } from './run.js';
import type { ActionBase, AssetsConfig, BuildResult, Destination, Source } from './types.js';

export { build, type BuildOptions } from './run.js';
export { formatReport, type ReportOptions } from './report.js';
export type * from './types.js';

/** Package version, injected at build time. */
export const version: string = __VERSION__;

/** Identity helper for JS configs: autocomplete and type checking, returns the object unchanged. */
export function defineConfig(config: AssetsConfig): AssetsConfig {
  return config;
}

/** One action on its own: the same keys as one JSON action, minus `action`. */
export type StandaloneAction = Omit<ActionBase, 'action'> & Record<string, unknown>;

/** Resize, trim, convert and compress images with Sharp. */
export function image(action: StandaloneAction): Promise<BuildResult> {
  return runAction('image', action);
}

/** Pack sprites into texture atlas pages with a TexturePacker-style JSON per page. */
export function atlas(action: StandaloneAction): Promise<BuildResult> {
  return runAction('atlas', action);
}

/** Minify JSON files. */
export function json(action: StandaloneAction): Promise<BuildResult> {
  return runAction('json', action);
}

/** Minify XML files. */
export function xml(action: StandaloneAction): Promise<BuildResult> {
  return runAction('xml', action);
}

/** Copy files unchanged. */
export function copy(action: StandaloneAction): Promise<BuildResult> {
  return runAction('copy', action);
}

/**
 * Run a single action outside a config. There is no base, so `source` is required and paths resolve
 * from the process folder. Without `destination` nothing is written: the results come back as `result.outputs`.
 */
export async function runAction(type: string, action: StandaloneAction): Promise<BuildResult> {
  if (action.source === undefined) throw new Error(`${type}(): "source" is required when calling an action on its own`);
  const { destination, ...rest } = action;
  const target = standaloneTarget(destination);
  return build({
    config: {
      source: '.',
      destination: target.base ?? path.join(os.tmpdir(), 'smoud-assets-memory'),
      // a single action owns only the files it writes; cleaning stale files is for whole config builds
      clean: false,
      actions: [{ ...rest, action: type, source: relativeSource(rest.source), destination: target.action }]
    },
    outputSink: target.base ? undefined : 'result'
  });
}

/** Absolute source paths become relative to the working directory, which is the base of a standalone call. */
function relativeSource(source: Source | undefined): Source | undefined {
  const relative = (pattern: string) =>
    path.isAbsolute(pattern) ? path.relative(process.cwd(), pattern).replace(/\\/g, '/') : pattern;
  if (source === undefined || typeof source === 'string') return source === undefined ? source : relative(source);
  if (Array.isArray(source)) return source.map(relative);
  const spec = { ...source };
  if (spec.include !== undefined)
    spec.include = Array.isArray(spec.include) ? spec.include.map(relative) : relative(spec.include);
  if (spec.exclude !== undefined)
    spec.exclude = Array.isArray(spec.exclude) ? spec.exclude.map(relative) : relative(spec.exclude);
  return spec;
}

/** The given destination folder becomes the base; the action writes to its root. No folder means in memory. */
function standaloneTarget(destination: Destination | undefined): { base?: string; action: Destination } {
  if (destination === undefined) return { action: '#result' };
  if (typeof destination === 'string') return { base: destination, action: '' };
  if (Array.isArray(destination)) throw new Error('a standalone action takes one destination; use build() for several');
  if (destination.folder === undefined) return { action: { folder: '#result', filename: destination.filename } };
  return { base: destination.folder, action: { folder: '', filename: destination.filename } };
}
