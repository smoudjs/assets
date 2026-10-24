import path from 'node:path';
import type { BuildResult } from './types.js';
import { bold, dim, gray, green, red, yellow } from './utils/colors.js';
import { formatBytes, formatChange, formatDuration, plural } from './utils/format.js';

export interface ReportOptions {
  /** One line per file under each action, and every warning and error instead of the first ten. */
  verbose?: boolean;
  /** Shown in the first line, e.g. the package version. */
  version?: string;
}

/** The terminal report for a build result, the same one `smoud-assets build` prints. Colours follow NO_COLOR / FORCE_COLOR. */
export function formatReport(result: BuildResult, options: ReportOptions = {}): string {
  const lines: string[] = [];
  lines.push(
    bold(`smoud-assets${options.version ? ` v${options.version}` : ''}`) +
      (result.dryRun ? yellow('  dry run, nothing written') : '')
  );
  lines.push('');

  const labelWidth = Math.max(12, ...result.actions.map((action) => action.label.length));
  for (const action of result.actions) {
    const count = action.selected;
    const columns = [
      gray(`#${action.index}`.padStart(3)),
      action.label.padEnd(labelWidth),
      plural(count, 'file').padStart(9)
    ];
    if (count)
      columns.push(
        `${formatBytes(action.bytesIn)} → ${formatBytes(action.bytesOut)}`,
        coloredChange(action.bytesIn, action.bytesOut)
      );
    lines.push(columns.join('  '));

    if (options.verbose) {
      lines.push(
        ...limitedList(action.files, (file) => {
          const kept = file.keptOriginal ? dim('  original kept') : '';
          const sizes = `${formatBytes(file.bytesIn)} → ${formatBytes(file.bytesOut)}`;
          return gray(`       ${file.source} → ${file.outputs.join(', ')}  ${sizes}`) + kept;
        })
      );
    }
  }

  const files = result.actions.reduce((sum, action) => sum + action.selected, 0);
  const bytesIn = result.actions.reduce((sum, action) => sum + action.bytesIn, 0);
  const bytesOut = result.actions.reduce((sum, action) => sum + action.bytesOut, 0);
  const keptOriginals = result.actions.reduce(
    (sum, action) => sum + action.files.filter((file) => file.keptOriginal).length,
    0
  );
  lines.push('');
  lines.push(
    `${bold('Total'.padEnd(labelWidth + 5))}  ${plural(files, 'file').padStart(9)}  ${formatBytes(bytesIn)} → ${formatBytes(bytesOut)}  ${coloredChange(bytesIn, bytesOut)}`
  );
  if (keptOriginals) lines.push(dim(`${plural(keptOriginals, 'original')} kept because re-encoding would have grown them`));
  if (result.unselected.length) {
    lines.push(dim(`${plural(result.unselected.length, 'file')} not selected by any action`));
    if (options.verbose) lines.push(...limitedList(result.unselected, (file) => gray(`       ${file}`)));
  }

  if (result.warnings.length || result.errors.length) lines.push('');
  const limit = options.verbose ? Infinity : LIST_LIMIT;
  lines.push(...limitedList(result.warnings, (warning) => yellow(`warning: ${warning}`), limit));
  lines.push(...limitedList(result.errors, (error) => red(`error: ${error}`), limit));

  lines.push('');
  if (result.errors.length) {
    lines.push(
      red(`Failed with ${plural(result.errors.length, 'error')}. Nothing was written; the previous output is untouched.`)
    );
  } else {
    const destinationNote =
      result.destination && !result.dryRun ? dim(`  → ${path.relative(process.cwd(), result.destination) || '.'}`) : '';
    lines.push(green(`Done in ${formatDuration(result.duration)}`) + destinationNote);
  }
  return lines.join('\n');
}

/** How many entries of a long list the report shows before "… and N more". */
const LIST_LIMIT = 10;

/** At most `limit` formatted items, then one line saying how many more there are. */
function limitedList<T>(items: T[], format: (item: T) => string, limit = LIST_LIMIT): string[] {
  const lines = items.slice(0, limit).map(format);
  if (items.length > limit) lines.push(gray(`       … and ${items.length - limit} more`));
  return lines;
}

/** Saved space in green, growth in red. */
function coloredChange(from: number, to: number): string {
  const text = formatChange(from, to);
  if (!text) return '';
  return to < from ? green(text) : to > from ? red(text) : dim(text);
}
