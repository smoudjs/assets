// Packs JSON for a smaller raw size, for builds where the uncompressed size counts, like a single-file playable ad.
// The format is described in src/runtime/unpack-json.ts, whose unpackJson reads it back. One pass counts keys and
// string values, a second writes the packed copy: linear in the size of the JSON, about twice a JSON.stringify.

import { PACK_VERSION, shortName } from '../../runtime/unpack-json.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface KeyStats {
  uses: number;
  /** Whether every value of the key so far is a string. */
  strings: boolean;
  /** How often each string value appears, while every value is a string. */
  values: Map<string, number>;
}

/**
 * The JSON text of `data`, packed; `data` is parsed JSON. When packing would not make it smaller, the minified JSON
 * instead, which unpackJson returns as it is. An object with a "$pack" key of its own is always packed, so
 * unpackJson cannot mistake it. Pass `minified` when you already have it, to save serializing twice.
 */
export function packJson(data: unknown, minified: string = JSON.stringify(data)): string {
  const stats = new Map<string, KeyStats>();
  const scan = (node: any) => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) scan(node[i]);
      return;
    }
    const keys = Object.keys(node);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i] as string;
      const value = node[key];
      let entry = stats.get(key);
      if (!entry) stats.set(key, (entry = { uses: 0, strings: true, values: new Map() }));
      entry.uses++;
      if (typeof value === 'string') {
        if (entry.strings) entry.values.set(value, (entry.values.get(value) ?? 0) + 1);
      } else {
        entry.strings = false;
        entry.values.clear();
        scan(value);
      }
    }
  };
  scan(data);
  const ownMarker = data !== null && typeof data === 'object' && !Array.isArray(data) && Object.prototype.hasOwnProperty.call(data, '$pack');
  if (!stats.size && !ownMarker) return minified;

  // the most used keys get the shortest names
  const keys = [...stats.keys()].sort((a, b) => (stats.get(b) as KeyStats).uses - (stats.get(a) as KeyStats).uses);
  const names = new Map(keys.map((key, i) => [key, shortName(i)]));

  // a key whose values are all strings gets a table when the table saves bytes: each use then costs its index
  // instead of the string, and the table costs each string once plus its name
  const tables: Record<string, string[]> = {};
  const indexes = new Map<string, Map<string, number>>();
  for (const [key, { strings, values }] of stats) {
    if (!strings || !values.size) continue;
    const name = names.get(key) as string;
    const list = [...values.keys()].sort((a, b) => (values.get(b) as number) - (values.get(a) as number));
    let saved = -(name.length + 6);
    list.forEach((value, i) => {
      const length = JSON.stringify(value).length;
      saved += (values.get(value) as number) * (length - String(i).length) - (length + 1);
    });
    if (saved <= 0) continue;
    tables[name] = list;
    indexes.set(key, new Map(list.map((value, i) => [value, i])));
  }

  const pack = (node: any): any => {
    if (node === null || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(pack);
    const result: any = {};
    const keys = Object.keys(node);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i] as string;
      const index = indexes.get(key);
      result[names.get(key) as string] = index ? index.get(node[key]) : pack(node[key]);
    }
    return result;
  };
  const packed = JSON.stringify({ $pack: PACK_VERSION, k: keys, v: tables, data: pack(data) });
  return packed.length < minified.length || ownMarker ? packed : minified;
}
