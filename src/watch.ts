// `smoud-assets watch`: one build at start, then a full rebuild after every change to the source folder, the config
// file or a local preset file. Builds never overlap: changes made during a build trigger one more build after it.

import { watch as watchPath, type FSWatcher } from 'node:fs';
import path from 'node:path';
// the engine comes from index.js like in cli.ts: the CLI bundle shares it with dist/index.js, where actions are registered
import {
  build,
  formatReport,
  presetFilePath,
  progressIndicator,
  readConfigFile,
  type AssetsConfig,
  type BuildOptions
} from './index.js';
import { dim, red } from './utils/colors.js';
import { isPathUnderFolder, samePath, toPosix } from './utils/fs.js';

// one save in an editor fires several events; wait this long for them to settle before rebuilding
const SETTLE_TIME = 200;

export interface WatchOptions extends BuildOptions {
  /** Path to the config file. Default: `assets.json` in the working directory, watched even before it exists. */
  config?: string;
  verbose?: boolean;
}

interface WatchedPath {
  path: string;
  watcher: FSWatcher;
}

/** Builds once, then rebuilds on every change until the process is stopped. */
export async function watch(options: WatchOptions): Promise<void> {
  const configFile = path.resolve(options.config ?? 'assets.json');
  const changed = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  let building = false;
  let pending = false;
  let source: WatchedPath | undefined;
  let preset: WatchedPath | undefined;
  let destination: string | undefined;

  const noteChange = (file: string): void => {
    changed.add(toPosix(path.relative(process.cwd(), file)) || '.');
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (building) pending = true;
      else void rebuild();
    }, SETTLE_TIME);
  };

  const watchSource = (folder: string): void => {
    if (source && samePath(source.path, folder)) return;
    source?.watcher.close();
    source = undefined;
    const watcher = startWatcher(folder, true, (file) => {
      // the destination usually sits inside the source; its own writes (staging included) must not trigger builds
      if (destination && (samePath(file, destination) || isPathUnderFolder(file, destination))) return;
      noteChange(file);
    });
    if (!watcher) return;
    source = { path: folder, watcher };
    watcher.on('close', () => {
      if (source?.watcher === watcher) source = undefined;
    });
  };

  const watchPreset = (config: AssetsConfig): void => {
    const file = findPresetFile(options.preset ?? config.preset, configFile);
    if (preset && file && samePath(preset.path, file)) return;
    preset?.watcher.close();
    preset = undefined;
    const watcher = file ? watchFile(file, noteChange) : undefined;
    if (file && watcher) preset = { path: file, watcher };
  };

  const runBuild = async (): Promise<void> => {
    // read here only to find a preset file to watch; build reads and checks the config on its own
    const config = await readConfigOrEmpty(configFile);
    const progress = progressIndicator();
    try {
      const result = await build({ ...options, onProgress: progress.update });
      progress.stop();
      process.stdout.write(`${formatReport(result, { verbose: options.verbose })}\n`);
      destination = result.destination;
      watchSource(result.source);
    } catch (error) {
      progress.stop();
      process.stderr.write(`${red(`error: ${(error as Error).message}`)}\n`);
    }
    watchPreset(config);
  };

  const rebuild = async (): Promise<void> => {
    building = true;
    do {
      pending = false;
      const files = [...changed];
      changed.clear();
      if (files.length) {
        const time = new Date().toTimeString().slice(0, 8);
        process.stdout.write(`\n${dim(`${time}  changed: ${files.join(', ')}`)}\n`);
      }
      await runBuild();
    } while (pending);
    building = false;
  };

  watchFile(configFile, noteChange);
  await rebuild();
  process.stdout.write(`${dim('watching for changes, Ctrl+C to stop')}\n`);
}

// editors often save by writing a new file and renaming it over the old one, which ends a watcher on the file
// itself; watching its folder and filtering by name survives that, and also sees the file being created
function watchFile(file: string, onChange: (file: string) => void): FSWatcher | undefined {
  const folder = path.dirname(file);
  return startWatcher(folder, false, (changed) => {
    if (samePath(changed, file) || samePath(changed, folder)) onChange(file);
  });
}

// `changed` is the folder itself when the platform does not say which file changed
function startWatcher(folder: string, recursive: boolean, onChange: (changed: string) => void): FSWatcher | undefined {
  try {
    const watcher = watchPath(folder, { recursive }, (_event, name) => onChange(name ? path.join(folder, name) : folder));
    watcher.on('error', (error) => {
      process.stderr.write(`${red(`error: stopped watching ${folder}: ${error.message}`)}\n`);
      watcher.close();
    });
    return watcher;
  } catch (error) {
    process.stderr.write(`${red(`error: cannot watch ${folder}: ${(error as Error).message}`)}\n`);
    return undefined;
  }
}

// a missing or broken config reads as empty here; the build reports what is wrong with it
async function readConfigOrEmpty(configFile: string): Promise<AssetsConfig> {
  try {
    return await readConfigFile(configFile);
  } catch {
    return {};
  }
}

// only a preset given as a path can change while you work; built-in and package presets cannot
function findPresetFile(name: unknown, configFile: string): string | undefined {
  return typeof name === 'string' ? presetFilePath(name, path.dirname(configFile)) : undefined;
}
