/** Word similarity for "did you mean" hints. */

/** Edit (Levenshtein) distance between two strings. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost);
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/**
 * The closest candidate when it is a plausible typo of `word`: at most two edits away,
 * and never more than half the word. Otherwise undefined.
 */
export function suggest(word: string, candidates: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = editDistance(word.toLowerCase(), candidate.toLowerCase());
    if (distance < bestDistance) [best, bestDistance] = [candidate, distance];
  }
  if (best === undefined) return undefined;
  const limit = Math.min(2, Math.floor(Math.max(word.length, best.length) / 2));
  return bestDistance <= limit ? best : undefined;
}
