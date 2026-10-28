/**
 * smoud-assets — CLI entry.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { build, formatReport, loadPreset, progressIndicator, version } from './index.js';
import { bold, red, yellow } from './utils/colors.js';
import { statOrNull } from './utils/fs.js';
import { watch } from './watch.js';

const COMMANDS = ['build', 'watch', 'init'];

const HELP = `smoud-assets v${version}
One config. One command. All your game assets optimized.

Usage
  smoud-assets <command> [options]

Commands
  build     Process assets once
  watch     Rebuild on change
  init      Write a starter assets.json

Options
  --config <file>        Config file (default: assets.json)
  --no-config            Ignore any config file
  --source <dir>         Base source folder (default: assets)
  --destination <dir>    Base destination folder (default: assets/optimized)
  --preset <name>        Preset the config extends (wins over its "preset")
  --strict               Treat warnings as errors
  --verbose              List every file
  --dry-run              Process everything, write nothing
  --cache / --no-cache   Reuse results for unchanged files (wins over the config, default: on)
  -h, --help             Show this help
  -v, --version          Show the version
`;

async function main(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        config: { type: 'string' },
        'no-config': { type: 'boolean', default: false },
        source: { type: 'string' },
        destination: { type: 'string' },
        preset: { type: 'string' },
        strict: { type: 'boolean', default: false },
        verbose: { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        // two flags: Node 20 cannot derive --no-cache from --cache
        cache: { type: 'boolean' },
        'no-cache': { type: 'boolean' },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false }
      }
    });
  } catch (error) {
    process.stderr.write(`${red((error as Error).message)}\n\n${HELP}`);
    return 2;
  }
  const { values, positionals } = parsed;

  if (values.version) {
    process.stdout.write(`${version}\n`);
    return 0;
  }
  const command = positionals[0];
  if (values.help || command === undefined) {
    process.stdout.write(HELP);
    return 0;
  }

  // undefined: neither flag given, so the config or the command's own default decides
  const cache = values['no-cache'] ? false : values.cache ? true : undefined;

  // printed first, so it is on screen while the progress line runs; the report below it has no header of its own
  if (COMMANDS.includes(command)) {
    const dryRun = values['dry-run'] && command !== 'init' ? yellow('  dry run, nothing written') : '';
    process.stdout.write(`${bold(`smoud-assets v${version}`)}${dryRun}\n\n`);
  }

  switch (command) {
    case 'build': {
      const progress = progressIndicator();
      try {
        const result = await build({
          config: values['no-config'] ? {} : (values.config as string | undefined),
          preset: values.preset as string | undefined,
          source: values.source as string | undefined,
          destination: values.destination as string | undefined,
          dryRun: Boolean(values['dry-run']),
          strict: Boolean(values.strict),
          cache,
          onProgress: progress.update
        });
        progress.stop();
        process.stdout.write(`${formatReport(result, { verbose: Boolean(values.verbose) })}\n`);
        return result.ok ? 0 : 1;
      } catch (error) {
        progress.stop();
        process.stderr.write(`${red(`error: ${(error as Error).message}`)}\n`);
        return 1;
      }
    }

    case 'watch':
      await watch({
        config: values.config as string | undefined,
        noConfig: Boolean(values['no-config']),
        preset: values.preset as string | undefined,
        source: values.source as string | undefined,
        destination: values.destination as string | undefined,
        dryRun: Boolean(values['dry-run']),
        strict: Boolean(values.strict),
        verbose: Boolean(values.verbose),
        cache
      });
      return 0;

    case 'init': {
      const file = path.resolve((values.config as string | undefined) ?? 'assets.json');
      if (await statOrNull(file)) {
        process.stdout.write(`${path.relative(process.cwd(), file)} already exists, skipped\n`);
        return 0;
      }
      // the preset written out in full, so every action is there to change
      const preset = await loadPreset((values.preset as string | undefined) ?? 'default', process.cwd());
      const config = {
        source: (values.source as string | undefined) ?? 'assets',
        destination: (values.destination as string | undefined) ?? 'assets/optimized',
        ...preset
      };
      await fs.writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
      process.stdout.write(`Created ${path.relative(process.cwd(), file)}\n`);
      return 0;
    }

    default:
      process.stderr.write(`${red(`Unknown command "${command}".`)}\n\n${HELP}`);
      return 2;
  }
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
