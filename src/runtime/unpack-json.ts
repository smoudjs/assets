// Reads JSON written by the json action's `pack` option. Runs in the game: no Node.js, no dependencies.
//
// The packed format, version 1:
//   { "$pack": 1, "k": ["tool", "points"], "v": { "a": ["paint", "erase"] }, "data": { "a": 1, "b": [...] } }
// - k lists every key once. In data, the key at index i is written as its short name: a, b, ..., z, A, ..., Z,
//   aa, ab, and so on.
// - v holds, by short name, the string values of a key that has a table; in data, such a value is written as its
//   index in that list.
// - data is the JSON itself, with those replacements.

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The packed format version this code reads and writes. */
export const PACK_VERSION = 1;

const LETTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** The short name of the key at an index in k: a, b, ..., Z, aa, ab, ... */
export function shortName(index: number): string {
  let name = '';
  for (let i = index; i >= 0; i = Math.floor(i / LETTERS.length) - 1) name = LETTERS[i % LETTERS.length] + name;
  return name;
}

const has = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);

function malformed(detail: string): Error {
  return new Error(`unpackJson: malformed packed JSON${detail}`);
}

/**
 * The JSON as it was before the json action's `pack` option packed it. Takes the parsed JSON or its text.
 * JSON that is not packed is returned as it is, so it is safe on any file. Throws on invalid JSON text, on a
 * newer packed format, and on a packed JSON that is damaged.
 */
export function unpackJson<T = any>(json: unknown): T {
  const packed: any = typeof json === 'string' ? JSON.parse(json) : json;
  if (packed === null || typeof packed !== 'object' || Array.isArray(packed) || !has(packed, '$pack')) return packed;
  if (packed.$pack !== PACK_VERSION) {
    throw new Error(`unpackJson: packed in format ${packed.$pack}, this version reads format ${PACK_VERSION}`);
  }
  if (!Array.isArray(packed.k) || (packed.v !== undefined && (typeof packed.v !== 'object' || packed.v === null))) {
    throw malformed('');
  }
  const keys = new Map<string, string>();
  for (let i = 0; i < packed.k.length; i++) keys.set(shortName(i), packed.k[i]);
  const tables = new Map<string, unknown[]>(Object.entries(packed.v ?? {}));

  const unpack = (node: any): any => {
    if (node === null || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(unpack);
    const result: any = {};
    const names = Object.keys(node);
    for (let i = 0; i < names.length; i++) {
      const name = names[i] as string;
      const key = keys.get(name);
      if (key === undefined) throw malformed(`, unknown key ${name}`);
      const table = tables.get(name);
      let value: unknown;
      if (table) {
        value = table[node[name]];
        if (value === undefined) throw malformed(`, ${key} has no value ${node[name]}`);
      } else {
        value = unpack(node[name]);
      }
      // assigning __proto__ would set the prototype; JSON.parse makes it a plain property, and so does this
      if (key === '__proto__') Object.defineProperty(result, key, { value, enumerable: true, writable: true, configurable: true });
      else result[key] = value;
    }
    return result;
  };
  return unpack(packed.data);
}
