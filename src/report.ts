import path from 'node:path';
import type { ActionResult, BuildResult } from './types.js';
import { bold, dim, gray, green, red, yellow } from './utils/colors.js';
import { formatBytes, formatChange, formatDuration, plural } from './utils/format.js';
import { toArray } from './utils/object.js';

export interface ReportOptions {
  /** One line per file under each action, and every warning and error instead of the first ten. */
  verbose?: boolean;
}

/** How many entries of a long list the report shows before "… and N more". */
const LIST_LIMIT = 10;

/**
 * The terminal report for one action result, several, or a whole build; the same one `smoud-assets build`
 * prints. Bytes that pass through a virtual folder are shown muted and left out of the total, because they
 * are neither source nor destination bytes. Colours follow NO_COLOR / FORCE_COLOR.
 */
export function formatReport(input: ActionResult | ActionResult[] | BuildResult, options: ReportOptions = {}): string {
  const build = 'actions' in input ? input : undefined;
  const results: ActionResult[] = 'actions' in input ? input.actions : toArray(input);
  const lines: string[] = [];
  lines.push(bold(`smoud-assets v${__VERSION__}`) + (build?.dryRun ? yellow('  dry run, nothing written') : ''));
  lines.push('');

  const labelWidth = Math.max(12, ...results.map((result) => result.label.length));
  for (const [index, result] of results.entries()) {
    const columns = [
      gray(`#${index + 1}`.padStart(3)),
      result.label.padEnd(labelWidth),
      plural(result.selected, 'file').padStart(9)
    ];
    if (result.selected) {
      // outputs that never reach disk are a step in a chain: their change is shown dim, not as a warning colour
      const inMemory = result.destination === null;
      const change = inMemory
        ? dim(formatChange(result.bytesIn, result.bytesOut))
        : coloredChange(result.bytesIn, result.bytesOut);
      columns.push(`${formatBytes(result.bytesIn)} → ${formatBytes(result.bytesOut)}`, change);
      if (inMemory) columns.push(dim(`→ ${memoryTarget(result)}`));
    }
    lines.push(columns.join('  '));

    if (options.verbose) {
      lines.push(
        ...limitedList(result.files, (file) => {
          const kept = file.keptOriginal ? dim('  original kept') : '';
          const sizes = `${formatBytes(file.bytesIn)} → ${formatBytes(file.bytesOut)}`;
          return gray(`       ${file.source} → ${file.outputs.join(', ')}  ${sizes}`) + kept;
        })
      );
    }
  }

  let files = 0;
  let bytesIn = 0;
  let bytesOut = 0;
  let keptOriginals = 0;
  for (const result of results) {
    if (result.memorySource === undefined) {
      files += result.selected;
      bytesIn += result.bytesIn;
    }
    if (result.destination !== null) bytesOut += result.bytesOut;
    keptOriginals += result.files.filter((row) => row.keptOriginal).length;
  }
  lines.push('');
  lines.push(
    `${bold('Total'.padEnd(labelWidth + 5))}  ${plural(files, 'file').padStart(9)}  ${formatBytes(bytesIn)} → ${formatBytes(bytesOut)}  ${coloredChange(bytesIn, bytesOut)}`
  );
  if (keptOriginals) lines.push(dim(`${plural(keptOriginals, 'original')} kept because re-encoding would have grown them`));
  if (build?.unselected.length) {
    lines.push(dim(`${plural(build.unselected.length, 'file')} not selected by any action`));
    if (options.verbose) lines.push(...limitedList(build.unselected, (file) => gray(`       ${file}`)));
  }

  // a build has its messages prefixed already; several standalone results get their label in front
  const prefix = (result: ActionResult, message: string) => (results.length > 1 ? `${result.label}: ${message}` : message);
  const warnings = build ? build.warnings : results.flatMap((result) => result.warnings.map((w) => prefix(result, w)));
  const errors = build ? build.errors : results.flatMap((result) => result.errors.map((e) => prefix(result, e)));
  if (warnings.length || errors.length) lines.push('');
  const limit = options.verbose ? Infinity : LIST_LIMIT;
  lines.push(...limitedList(warnings, (warning) => yellow(`warning: ${warning}`), limit));
  lines.push(...limitedList(errors, (error) => red(`error: ${error}`), limit));

  lines.push('');
  if (errors.length) {
    const untouched = build ? '; the previous output is untouched' : '';
    lines.push(red(`Failed with ${plural(errors.length, 'error')}. Nothing was written${untouched}.`));
  } else {
    const duration = build ? build.duration : results.reduce((total, result) => total + result.duration, 0);
    const destination = build
      ? build.dryRun
        ? null
        : build.destination
      : results.length === 1
        ? (results[0] as ActionResult).destination
        : null;
    const note = destination ? dim(`  → ${path.relative(process.cwd(), destination) || '.'}`) : '';
    lines.push(green(`Done in ${formatDuration(duration)}`) + note);
  }
  return lines.join('\n');
}

/** Where in-memory outputs went: the virtual folders of a build, `#icons`, or `memory` for a direct call. */
function memoryTarget(result: ActionResult): string {
  const outputs = result.files.flatMap((row) => row.outputs);
  const folders = [
    ...new Set(outputs.filter((output) => output.startsWith('#')).map((output) => output.split('/')[0] as string))
  ];
  return folders.length ? folders.join(', ') : 'memory';
}

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
