// What the Spine 4.2 JSON and binary (.skel) exports share: names of modes and timelines in binary order, colors,
// and the byte streams. The binary layout changes with every minor Spine version and a runtime reads only its own,
// so everything in this folder is for 4.2 alone.

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Json = Record<string, any>;

/** The Spine version this folder converts between JSON and .skel. */
export const SPINE_VERSION = '4.2';

/** Whether a version, like `4.2.43`, is the one this folder converts. */
export function isSpineVersion(version: string | null | undefined): boolean {
  return typeof version === 'string' && (version === SPINE_VERSION || version.startsWith(`${SPINE_VERSION}.`));
}

export function wrongVersion(version: string | null | undefined): Error {
  return new Error(`Spine ${version ?? 'of an unknown version'} is not converted, only ${SPINE_VERSION}`);
}

export const INHERIT = ['normal', 'onlyTranslation', 'noRotationOrReflection', 'noScale', 'noScaleOrReflection'];
export const BLEND = ['normal', 'additive', 'multiply', 'screen'];
export const POSITION_MODE = ['fixed', 'percent'];
export const SPACING_MODE = ['length', 'fixed', 'percent', 'proportional'];
export const ROTATE_MODE = ['tangent', 'chain', 'chainScale'];
export const SEQUENCE_MODE = ['hold', 'once', 'loop', 'pingpong', 'onceReverse', 'loopReverse', 'pingpongReverse'];
export const ATTACHMENT_TYPES = ['region', 'boundingbox', 'mesh', 'linkedmesh', 'path', 'point', 'clipping'];
export const SLOT_TIMELINES = ['attachment', 'rgba', 'rgb', 'rgba2', 'rgb2', 'alpha'];
// id, the value names of a two-value timeline, and the value a key without one has
export const BONE_TIMELINES: Record<string, [number, [string, string] | null, number]> = {
  rotate: [0, null, 0],
  translate: [1, ['x', 'y'], 0],
  translatex: [2, null, 0],
  translatey: [3, null, 0],
  scale: [4, ['x', 'y'], 1],
  scalex: [5, null, 1],
  scaley: [6, null, 1],
  shear: [7, ['x', 'y'], 0],
  shearx: [8, null, 0],
  sheary: [9, null, 0]
};
export const BONE_INHERIT = 10;
export const PATH_TIMELINES = ['position', 'spacing', 'mix'];
export const PHYSICS_TIMELINES: Record<string, number> = {
  inertia: 0,
  strength: 1,
  damping: 2,
  mass: 4,
  wind: 5,
  gravity: 6,
  mix: 7,
  reset: 8
};
export const PHYSICS_GLOBALS = [
  'inertiaGlobal',
  'strengthGlobal',
  'dampingGlobal',
  'massGlobal',
  'windGlobal',
  'gravityGlobal',
  'mixGlobal'
];
export const CURVE_LINEAR = 0;
export const CURVE_STEPPED = 1;
export const CURVE_BEZIER = 2;

/** The index of a mode by its JSON name, which Spine writes with a lower or upper first letter. */
export function enumIndex(values: string[], name: string, what: string): number {
  const index = values.indexOf(name.charAt(0).toLowerCase() + name.slice(1));
  if (index < 0) throw new Error(`unknown ${what}: ${name}`);
  return index;
}

export function enumName(values: string[], index: number, what: string): string {
  const name = values[index];
  if (name === undefined) throw new Error(`unknown ${what}: ${index}`);
  return name;
}

const hex = (text: string) => (text.charAt(0) === '#' ? text.slice(1) : text);

/** `rrggbb` or `rrggbbaa` as a signed 32-bit RGBA value. */
export function rgba8888(text: string): number {
  const h = hex(text);
  const alpha = h.length === 8 ? parseInt(h.slice(6, 8), 16) : 255;
  return ((parseInt(h.slice(0, 6), 16) << 8) | alpha) | 0;
}

/** `rrggbb` as a 24-bit RGB value. */
export const rgb888 = (text: string) => parseInt(hex(text).slice(0, 6), 16);

export const colorText = (value: number, digits = 8) => (value >>> 0).toString(16).padStart(8, '0').slice(8 - digits);

export function colorBytes(text: string, alpha: boolean): number[] {
  const h = hex(text);
  const bytes = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  if (alpha) bytes.push(h.length === 8 ? parseInt(h.slice(6, 8), 16) : 255);
  return bytes;
}

export const bytesText = (bytes: number[]) => bytes.map((b) => b.toString(16).padStart(2, '0')).join('');

/** Writes the big-endian values and varints a .skel is made of. */
export class Output {
  private buf = Buffer.alloc(1 << 16);
  length = 0;

  private ensure(n: number) {
    if (this.length + n <= this.buf.length) return;
    const next = Buffer.alloc(Math.max(this.buf.length * 2, this.length + n));
    this.buf.copy(next, 0, 0, this.length);
    this.buf = next;
  }

  byte(value: number) {
    this.ensure(1);
    this.buf[this.length++] = value & 0xff;
  }

  bool(value: unknown) {
    this.byte(value ? 1 : 0);
  }

  int32(value: number) {
    this.ensure(4);
    this.buf.writeInt32BE(value | 0, this.length);
    this.length += 4;
  }

  // -0 is written as 0, so the same skeleton always gives the same bytes
  float(value: number) {
    this.ensure(4);
    this.buf.writeFloatBE(value === 0 ? 0 : value, this.length);
    this.length += 4;
  }

  varint(value: number, optimizePositive = true) {
    let u = (optimizePositive ? value : (value << 1) ^ (value >> 31)) >>> 0;
    while (u > 0x7f) {
      this.byte((u & 0x7f) | 0x80);
      u >>>= 7;
    }
    this.byte(u);
  }

  /** null as 0, a string as its byte length plus one, then its bytes. */
  string(text: string | null | undefined) {
    if (text == null) return this.varint(0);
    const bytes = Buffer.from(String(text), 'utf8');
    this.varint(bytes.length + 1);
    this.append(bytes);
  }

  append(bytes: Buffer) {
    this.ensure(bytes.length);
    bytes.copy(this.buf, this.length);
    this.length += bytes.length;
  }

  toBuffer() {
    return this.buf.subarray(0, this.length);
  }
}

/** Reads what Output writes; strings written once in the string table are referred to by index. */
export class Input {
  private at = 0;
  readonly strings: string[] = [];

  constructor(private readonly buf: Buffer) {}

  private need(n: number) {
    if (this.at + n > this.buf.length) throw new Error('the .skel ends too early');
  }

  byte(): number {
    this.need(1);
    return this.buf[this.at++] as number;
  }

  bool(): boolean {
    return this.byte() !== 0;
  }

  int32(): number {
    this.need(4);
    const value = this.buf.readInt32BE(this.at);
    this.at += 4;
    return value;
  }

  float(): number {
    this.need(4);
    const value = this.buf.readFloatBE(this.at);
    this.at += 4;
    return value;
  }

  varint(optimizePositive = true): number {
    let result = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      const b = this.byte();
      result |= (b & 0x7f) << shift;
      if (!(b & 0x80)) break;
    }
    return optimizePositive ? result : (result >>> 1) ^ -(result & 1);
  }

  string(): string | null {
    const length = this.varint();
    if (length === 0) return null;
    this.need(length - 1);
    const text = this.buf.toString('utf8', this.at, this.at + length - 1);
    this.at += length - 1;
    return text;
  }

  stringRef(): string | null {
    const index = this.varint();
    if (index === 0) return null;
    const text = this.strings[index - 1];
    if (text === undefined) throw new Error(`string ${index} is not in the .skel string table`);
    return text;
  }

  floats(n: number): number[] {
    return Array.from({ length: n }, () => this.float());
  }

  varints(n: number): number[] {
    return Array.from({ length: n }, () => this.varint());
  }

  get done() {
    return this.at === this.buf.length;
  }
}
