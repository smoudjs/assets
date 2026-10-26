/**
 * smoud-assets — CLI entry.
 */

import { parseArgs } from 'node:util';
import { build, formatReport, version } from './index.js';
import { red } from './utils/colors.js';
import { watch } from './watch.js';

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
  --source <dir>         Base source folder (default: assets)
  --destination <dir>    Base destination folder (default: assets/compiled)
  --preset <name>        Preset the config extends (wins over its "preset")
  --strict               Treat warnings as errors
  --verbose              List every file
  --dry-run              Process everything, write nothing
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
        source: { type: 'string' },
        destination: { type: 'string' },
        preset: { type: 'string' },
        strict: { type: 'boolean', default: false },
        verbose: { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
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

  switch (command) {
    case 'build': {
      try {
        const result = await build({
          config: values.config as string | undefined,
          preset: values.preset as string | undefined,
          source: values.source as string | undefined,
          destination: values.destination as string | undefined,
          dryRun: Boolean(values['dry-run']),
          strict: Boolean(values.strict)
        });
        process.stdout.write(`${formatReport(result, { verbose: Boolean(values.verbose) })}\n`);
        return result.ok ? 0 : 1;
      } catch (error) {
        process.stderr.write(`${red(`error: ${(error as Error).message}`)}\n`);
        return 1;
      }
    }

    case 'watch':
      await watch({
        config: values.config as string | undefined,
        preset: values.preset as string | undefined,
        source: values.source as string | undefined,
        destination: values.destination as string | undefined,
        dryRun: Boolean(values['dry-run']),
        strict: Boolean(values.strict),
        verbose: Boolean(values.verbose)
      });
      return 0;

    case 'init':
      process.stderr.write(`"${command}" is not implemented yet.\n`);
      return 1;

    default:
      process.stderr.write(`${red(`Unknown command "${command}".`)}\n\n${HELP}`);
      return 2;
  }
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
