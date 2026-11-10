// The Spine version a skeleton was exported from, read from either export without parsing all of it. A .skel starts
// with its hash and then its version: Spine 4 writes the hash as 8 bytes, Spine 3 as a string.

/** The Spine version a .skel or skeleton .json was exported from, like `4.2.43`, or undefined when it is neither. */
export function skeletonVersion(data: Buffer, kind: 'json' | 'skel'): string | undefined {
  if (kind === 'json') {
    // the skeleton header comes first in a Spine export, so the start of the file is enough
    return /"spine"\s*:\s*"([^"]*)"/.exec(data.subarray(0, 4096).toString('utf8'))?.[1];
  }
  const spine4 = readString(data, 8)?.text;
  if (spine4 && isVersion(spine4)) return spine4;
  const hash = readString(data, 0);
  const spine3 = hash && readString(data, hash.end)?.text;
  return spine3 && isVersion(spine3) ? spine3 : undefined;
}

const isVersion = (text: string) => /^\d+\.\d+(\.\d+)*$/.test(text);

// a .skel string: its byte length plus one as a varint, then its UTF-8 bytes
function readString(data: Buffer, at: number): { text: string; end: number } | undefined {
  let length = 0;
  for (let shift = 0; shift < 35; shift += 7) {
    const b = data[at++];
    if (b === undefined) return undefined;
    length |= (b & 0x7f) << shift;
    if (!(b & 0x80)) break;
  }
  if (length < 1 || at + length - 1 > data.length || length > 64) return undefined;
  return { text: data.toString('utf8', at, at + length - 1), end: at + length - 1 };
}
