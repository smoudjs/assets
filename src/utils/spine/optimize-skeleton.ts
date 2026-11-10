// The skeleton of a Spine export, as .json or .skel: animations and skins trimmed, numbers of a .json rounded, and
// written in the format asked for. Trimming works on the JSON, once; each format asked for is written from it, so a
// skeleton is converted at most once each way. A file already in the format asked for, with nothing to trim, is
// kept byte for byte, and a .json next to a .skel is the one trimmed. Only the Spine version in ./4.2 is converted;
// another keeps the format it has, with a warning.

import picomatch from 'picomatch';
import { jsonToSkel } from './4.2/json-to-skel.js';
import { isSpineVersion, type Json, SPINE_VERSION } from './4.2/skel-format.js';
import { skelToJson } from './4.2/skel-to-json.js';
import { skeletonVersion } from './skeleton-version.js';

export type SkeletonFormat = 'json' | 'skel';
export type NamePatterns = string[] | { include?: string[]; exclude?: string[] };

export interface SkeletonOptions {
  /** The format written. Omitted: as the source. */
  skeleton?: SkeletonFormat;
  precision: number;
  animations: boolean | { include?: string[]; exclude?: string[] };
  skins?: NamePatterns;
}

export interface SkeletonSource {
  name: string;
  data: Buffer;
}

/**
 * The skeleton files to write for a .json, a .skel, or both, exported from the same skeleton. A .json that is not
 * a Spine skeleton is returned as it is.
 */
export function optimizeSkeleton(
  sources: { json?: SkeletonSource; skel?: SkeletonSource },
  options: SkeletonOptions,
  warnings: string[]
): SkeletonSource[] {
  const results: SkeletonSource[] = [];
  let { json, skel } = sources;
  let parsed: Json | undefined;
  if (json) {
    parsed = parseSkeleton(json.data);
    if (!parsed) {
      results.push(json);
      json = undefined;
    }
  }
  const source = json ?? skel;
  if (!source) return results;
  const base = source.name.replace(/\.[^./]*$/, '');
  const trims = options.animations !== true || options.skins !== undefined;
  const wanted: SkeletonFormat[] = options.skeleton ? [options.skeleton] : [...(json ? ['json' as const] : []), ...(skel ? ['skel' as const] : [])];

  // the trimmed skeleton, made once: from the .json when there is one, else read from a 4.2 .skel
  let trimmed: Json | null | undefined;
  const trimmedSkeleton = (): Json | null => {
    if (trimmed !== undefined) return trimmed;
    if (parsed) return (trimmed = trimSkeleton(source.name, parsed, options, warnings));
    if (!convertible) return (trimmed = null);
    return (trimmed = trimSkeleton(source.name, skelToJson((skel as SkeletonSource).data), options, warnings));
  };
  // the version the skeleton was exported from: a .json and a .skel next to each other come from the same one
  const version = parsed ? (parsed.skeleton.spine as string) : skeletonVersion((skel as SkeletonSource).data, 'skel');
  const convertible = isSpineVersion(version);
  const keep = (file: SkeletonSource, what: string) => {
    warnings.push(`${file.name}: Spine ${version ?? 'of an unknown version'} is not converted, only ${SPINE_VERSION}; ${what}`);
    results.push(file);
  };
  const trimmedJson = () => ({ name: `${base}.json`, data: writeJson(trimmedSkeleton() as Json, options.precision) });

  for (const format of wanted) {
    if (format === 'json') {
      if (json || convertible) results.push(trimmedJson());
      else keep(skel as SkeletonSource, 'kept as .skel');
      continue;
    }
    // a .skel with nothing to trim stays as it is
    if (skel && !trims) {
      results.push(skel);
      continue;
    }
    if (!convertible) {
      if (skel) keep(skel, 'animations and skins work on a .json only; the .skel is kept as it is');
      else if (!wanted.includes('json')) keep(trimmedJson(), 'kept as .json');
      continue;
    }
    try {
      results.push({ name: `${base}.skel`, data: jsonToSkel(trimmedSkeleton() as Json) });
    } catch (error) {
      if (skel) {
        warnings.push(`${base}.skel cannot be written: ${(error as Error).message}; the source .skel is kept as it is`);
        results.push(skel);
      } else {
        warnings.push(`${base}.skel cannot be written: ${(error as Error).message}; kept as .json`);
        if (!wanted.includes('json')) results.push(trimmedJson());
      }
    }
  }
  return results;
}

function parseSkeleton(data: Buffer): Json | undefined {
  try {
    const json = JSON.parse(data.toString('utf8'));
    return json?.skeleton?.spine ? json : undefined;
  } catch {
    return undefined;
  }
}

function writeJson(json: Json, precision: number): Buffer {
  const factor = 10 ** precision;
  return Buffer.from(
    JSON.stringify(json, (_key, value: unknown) => (typeof value === 'number' ? Math.round(value * factor) / factor : value))
  );
}

// which names a list or include and exclude keep; a pattern matching none of them is worth a warning
function keptNames(names: string[], wanted: NamePatterns, what: string, where: string, warnings: string[]): Set<string> {
  const { include, exclude } = Array.isArray(wanted) ? { include: wanted, exclude: undefined } : wanted;
  if (include && exclude) throw new Error(`${what} takes include or exclude, not both`);
  const patterns = include ?? exclude ?? [];
  for (const pattern of patterns) {
    if (!names.some((name) => picomatch.isMatch(name, pattern))) warnings.push(`${where}: ${what} pattern "${pattern}" matches nothing`);
  }
  return new Set(names.filter((name) => !patterns.length || picomatch.isMatch(name, patterns) !== Boolean(exclude)));
}

// animations and skins left out. The default skin always stays, and so does a skin a kept linked mesh takes its mesh from
function trimSkeleton(where: string, json: Json, options: SkeletonOptions, warnings: string[]): Json {
  const { animations, skins } = options;
  if (animations === false) delete json.animations;
  else if (typeof animations === 'object') {
    const all = json.animations ?? {};
    const kept = keptNames(Object.keys(all), animations, 'animations', where, warnings);
    if (animations.include && !kept.size) throw new Error(`${where}: animations.include keeps no animation`);
    for (const name of Object.keys(all)) if (!kept.has(name)) delete all[name];
  }

  if (skins !== undefined) {
    if (!Array.isArray(json.skins)) {
      warnings.push(`${where}: skins work on Spine 3.8 and newer, where skins are a list; all kept`);
      return json;
    }
    const list: Json[] = json.skins;
    const keep = keptNames(
      list.map((skin) => skin.name as string),
      skins,
      'skins',
      where,
      warnings
    );
    keep.add('default');
    // a Set visits what is added while it is iterated, so skins needed by skins needed by kept ones are found too
    for (const name of keep) {
      const skin = list.find((item) => item.name === name);
      for (const slot of Object.values<Json>(skin?.attachments ?? {})) {
        for (const attachment of Object.values<Json>(slot)) if (attachment.parent && attachment.skin) keep.add(attachment.skin);
      }
    }
    json.skins = list.filter((skin) => keep.has(skin.name));
    // deform and sequence timelines are keyed by skin: attachments in 4.x, deform in 3.8
    for (const animation of Object.values<Json>(json.animations ?? {})) {
      for (const field of ['attachments', 'deform']) {
        if (animation[field]) {
          animation[field] = Object.fromEntries(Object.entries(animation[field]).filter(([name]) => keep.has(name)));
        }
      }
    }
  }
  return json;
}
