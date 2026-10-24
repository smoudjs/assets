/** Object and array helpers. */

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Merge `extra` over `base`. Plain objects merge key by key; arrays and scalars are replaced. */
export function deepMerge(base: Record<string, unknown>, extra: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    const current = result[key];
    result[key] = isObject(current) && isObject(value) ? deepMerge(current, value) : value;
  }
  return result;
}

/** `undefined` → `[]`, a single value → `[value]`, an array → itself. */
export function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}
