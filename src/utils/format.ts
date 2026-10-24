/** Human-friendly numbers for the report. */

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/** Change from `from` to `to` as a signed percentage, e.g. `-71%`. Empty when there is nothing to compare. */
export function formatChange(from: number, to: number): string {
  if (from === 0) return '';
  const percent = Math.round(((to - from) / from) * 100);
  return percent === 0 ? '±0%' : `${percent > 0 ? '+' : ''}${percent}%`;
}

export function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}
