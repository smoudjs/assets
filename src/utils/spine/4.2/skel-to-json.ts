// A Spine 4.2 .skel as the skeleton .json Spine exports. A value is written only where it differs from what the JSON
// means without it, as Spine does. Nonessential data the .skel has, which only the editor uses, is kept.

import {
  ATTACHMENT_TYPES,
  BLEND,
  BONE_INHERIT,
  BONE_TIMELINES,
  bytesText,
  colorText,
  CURVE_BEZIER,
  CURVE_LINEAR,
  CURVE_STEPPED,
  enumName,
  INHERIT,
  Input,
  isSpineVersion,
  type Json,
  wrongVersion,
  PATH_TIMELINES,
  PHYSICS_GLOBALS,
  PHYSICS_TIMELINES,
  POSITION_MODE,
  ROTATE_MODE,
  SEQUENCE_MODE,
  SLOT_TIMELINES,
  SPACING_MODE
} from './skel-format.js';
import { skeletonVersion } from '../skeleton-version.js';

// colors the editor gives what has none; only nonessential data has them
const COLORS: Record<string, string> = {
  bone: '989898ff',
  skin: '99999900',
  boundingbox: '60f000ff',
  path: 'ff7f00ff',
  point: 'f1f100ff',
  clipping: 'ce3a3aff'
};

function put(target: Json, key: string, value: unknown, fallback?: unknown) {
  if (value !== fallback && value !== null && value !== undefined) target[key] = value;
}

const boneTypes = Object.entries(BONE_TIMELINES);
const physicsTypes = Object.entries(PHYSICS_TIMELINES);

/** A Spine 4.2 .skel as its skeleton .json, parsed. Throws on another version and on a .skel it cannot read. */
export function skelToJson(data: Buffer): Json {
  // checked before reading: an older .skel lays out even its header differently
  const found = skeletonVersion(data, 'skel');
  if (!isSpineVersion(found)) throw wrongVersion(found);
  const input = new Input(data);
  const hash = data.subarray(0, 8);
  input.int32();
  input.int32();
  const version = input.string();

  const skeleton: Json = {};
  // the JSON holds the same 8 bytes as base64 without padding
  if (hash.some((b) => b !== 0)) skeleton.hash = hash.toString('base64').replace(/=+$/, '');
  skeleton.spine = version;
  const [x, y, width, height, referenceScale] = input.floats(5) as number[];
  Object.assign(skeleton, { x, y, width, height });
  put(skeleton, 'referenceScale', referenceScale, 100);
  const nonessential = input.bool();
  if (nonessential) {
    put(skeleton, 'fps', input.float(), 30);
    put(skeleton, 'images', input.string());
    put(skeleton, 'audio', input.string());
  }
  for (let i = 0, n = input.varint(); i < n; i++) {
    const text = input.string();
    if (!text) throw new Error('a string in the .skel string table is empty');
    input.strings.push(text);
  }
  const json: Json = { skeleton };

  const named = (list: Json[], what: string) => (index: number) => {
    const item = list[index];
    if (!item) throw new Error(`${what} ${index} is not in the .skel`);
    return item.name as string;
  };

  const bones: Json[] = [];
  const boneName = named(bones, 'bone');
  for (let i = 0, n = input.varint(); i < n; i++) {
    const bone: Json = { name: input.string() };
    if (i > 0) bone.parent = boneName(input.varint());
    const [rotation, bx, by, scaleX, scaleY, shearX, shearY, length] = input.floats(8);
    put(bone, 'length', length, 0);
    put(bone, 'rotation', rotation, 0);
    put(bone, 'x', bx, 0);
    put(bone, 'y', by, 0);
    put(bone, 'scaleX', scaleX, 1);
    put(bone, 'scaleY', scaleY, 1);
    put(bone, 'shearX', shearX, 0);
    put(bone, 'shearY', shearY, 0);
    put(bone, 'inherit', enumName(INHERIT, input.byte(), 'inherit mode'), 'normal');
    put(bone, 'skin', input.bool(), false);
    if (nonessential) {
      put(bone, 'color', colorText(input.int32()), COLORS.bone);
      put(bone, 'icon', input.string());
      put(bone, 'visible', input.bool(), true);
    }
    bones.push(bone);
  }
  json.bones = bones;
  const boneList = () => Array.from({ length: input.varint() }, () => boneName(input.varint()));

  const slots: Json[] = [];
  const slotName = named(slots, 'slot');
  for (let i = 0, n = input.varint(); i < n; i++) {
    const slot: Json = { name: input.string(), bone: boneName(input.varint()) };
    put(slot, 'color', colorText(input.int32()), 'ffffffff');
    const dark = input.int32();
    if (dark !== -1) slot.dark = colorText(dark, 6);
    put(slot, 'attachment', input.stringRef());
    put(slot, 'blend', enumName(BLEND, input.varint(), 'blend mode'), 'normal');
    if (nonessential) put(slot, 'visible', input.bool(), true);
    slots.push(slot);
  }
  if (slots.length) json.slots = slots;

  const ik: Json[] = [];
  for (let i = 0, n = input.varint(); i < n; i++) {
    const c: Json = { name: input.string() };
    put(c, 'order', input.varint(), 0);
    c.bones = boneList();
    c.target = boneName(input.varint());
    const flags = input.byte();
    put(c, 'skin', (flags & 1) !== 0, false);
    put(c, 'bendPositive', (flags & 2) !== 0, true);
    put(c, 'compress', (flags & 4) !== 0, false);
    put(c, 'stretch', (flags & 8) !== 0, false);
    put(c, 'uniform', (flags & 16) !== 0, false);
    put(c, 'mix', flags & 32 ? (flags & 64 ? input.float() : 1) : 0, 1);
    if (flags & 128) c.softness = input.float();
    ik.push(c);
  }
  if (ik.length) json.ik = ik;

  const transform: Json[] = [];
  for (let i = 0, n = input.varint(); i < n; i++) {
    const c: Json = { name: input.string() };
    put(c, 'order', input.varint(), 0);
    c.bones = boneList();
    c.target = boneName(input.varint());
    let flags = input.byte();
    put(c, 'skin', (flags & 1) !== 0, false);
    put(c, 'local', (flags & 2) !== 0, false);
    put(c, 'relative', (flags & 4) !== 0, false);
    ['rotation', 'x', 'y', 'scaleX', 'scaleY'].forEach((key, k) => {
      if (flags & (8 << k)) c[key] = input.float();
    });
    flags = input.byte();
    if (flags & 1) c.shearY = input.float();
    // a mix the .skel leaves out is 0, where the JSON without it means 1, or mixX and mixScaleX for mixY and mixScaleY
    const [mixRotate, mixX, mixY, mixScaleX, mixScaleY, mixShearY] = [2, 4, 8, 16, 32, 64].map((bit) =>
      flags & bit ? input.float() : 0
    ) as number[];
    put(c, 'mixRotate', mixRotate, 1);
    put(c, 'mixX', mixX, 1);
    put(c, 'mixY', mixY, mixX);
    put(c, 'mixScaleX', mixScaleX, 1);
    put(c, 'mixScaleY', mixScaleY, mixScaleX);
    put(c, 'mixShearY', mixShearY, 1);
    transform.push(c);
  }
  if (transform.length) json.transform = transform;

  const path: Json[] = [];
  for (let i = 0, n = input.varint(); i < n; i++) {
    const c: Json = { name: input.string() };
    put(c, 'order', input.varint(), 0);
    put(c, 'skin', input.bool(), false);
    c.bones = boneList();
    c.target = slotName(input.varint());
    const flags = input.byte();
    put(c, 'positionMode', enumName(POSITION_MODE, flags & 1, 'position mode'), 'percent');
    put(c, 'spacingMode', enumName(SPACING_MODE, (flags >> 1) & 3, 'spacing mode'), 'length');
    put(c, 'rotateMode', enumName(ROTATE_MODE, (flags >> 3) & 3, 'rotate mode'), 'tangent');
    if (flags & 128) c.rotation = input.float();
    const [position, spacing, mixRotate, mixX, mixY] = input.floats(5) as number[];
    put(c, 'position', position, 0);
    put(c, 'spacing', spacing, 0);
    put(c, 'mixRotate', mixRotate, 1);
    put(c, 'mixX', mixX, 1);
    put(c, 'mixY', mixY, mixX);
    path.push(c);
  }
  if (path.length) json.path = path;

  const physics: Json[] = [];
  for (let i = 0, n = input.varint(); i < n; i++) {
    const c: Json = { name: input.string() };
    put(c, 'order', input.varint(), 0);
    c.bone = boneName(input.varint());
    let flags = input.byte();
    put(c, 'skin', (flags & 1) !== 0, false);
    ['x', 'y', 'rotate', 'scaleX', 'shearX'].forEach((key, k) => {
      if (flags & (2 << k)) c[key] = input.float();
    });
    if (flags & 64) c.limit = input.float();
    put(c, 'fps', input.byte(), 60);
    const [inertia, strength, damping] = input.floats(3);
    put(c, 'inertia', inertia, 1);
    put(c, 'strength', strength, 100);
    put(c, 'damping', damping, 1);
    // the .skel holds the inverse of the mass
    if (flags & 128) c.mass = 1 / input.float();
    const [wind, gravity] = input.floats(2);
    put(c, 'wind', wind, 0);
    put(c, 'gravity', gravity, 0);
    flags = input.byte();
    PHYSICS_GLOBALS.forEach((key, k) => {
      if (flags & (1 << k)) c[key] = true;
    });
    if (flags & 128) c.mix = input.float();
    physics.push(c);
  }
  if (physics.length) json.physics = physics;

  const readVertices = (target: Json, weighted: boolean, withCount: boolean): number => {
    const vertexCount = input.varint();
    if (withCount) target.vertexCount = vertexCount;
    if (!weighted) {
      target.vertices = input.floats(vertexCount * 2);
      return vertexCount;
    }
    const vertices: number[] = [];
    for (let i = 0; i < vertexCount; i++) {
      const boneCount = input.varint();
      vertices.push(boneCount);
      for (let b = 0; b < boneCount; b++) vertices.push(input.varint(), input.float(), input.float(), input.float());
    }
    target.vertices = vertices;
    return vertexCount;
  };

  // a linked mesh names its skin by index, known once every skin is read
  const linked: { map: Json; skin: number }[] = [];

  const readAttachment = (key: string): Json => {
    const flags = input.byte();
    const map: Json = {};
    const name = flags & 8 ? input.stringRef() : key;
    if (name !== key) map.name = name;
    const type = enumName(ATTACHMENT_TYPES, flags & 7, 'attachment type');
    if (type !== 'region') map.type = type;
    switch (type) {
      case 'region':
      case 'mesh':
      case 'linkedmesh': {
        if (flags & 16) put(map, 'path', input.stringRef());
        if (flags & 32) put(map, 'color', colorText(input.int32()), 'ffffffff');
        if (flags & 64) {
          const sequence: Json = { count: input.varint() };
          put(sequence, 'start', input.varint(), 1);
          put(sequence, 'digits', input.varint(), 0);
          put(sequence, 'setup', input.varint(), 0);
          map.sequence = sequence;
        }
        if (type === 'region') {
          if (flags & 128) map.rotation = input.float();
          const [rx, ry, scaleX, scaleY, rw, rh] = input.floats(6);
          put(map, 'x', rx, 0);
          put(map, 'y', ry, 0);
          put(map, 'scaleX', scaleX, 1);
          put(map, 'scaleY', scaleY, 1);
          map.width = rw;
          map.height = rh;
        } else if (type === 'mesh') {
          const hull = input.varint();
          const vertexCount = readVertices(map, (flags & 128) !== 0, false);
          map.uvs = input.floats(vertexCount * 2);
          map.triangles = input.varints((vertexCount * 2 - hull - 2) * 3);
          map.hull = hull;
          if (nonessential) {
            const edges = input.varints(input.varint());
            if (edges.length) map.edges = edges;
            map.width = input.float();
            map.height = input.float();
          }
        } else {
          if (!(flags & 128)) map.timelines = false;
          linked.push({ map, skin: input.varint() });
          map.parent = input.stringRef();
          if (nonessential) {
            map.width = input.float();
            map.height = input.float();
          }
        }
        break;
      }
      case 'boundingbox':
        readVertices(map, (flags & 16) !== 0, true);
        break;
      case 'path': {
        put(map, 'closed', (flags & 16) !== 0, false);
        put(map, 'constantSpeed', (flags & 32) !== 0, true);
        const vertexCount = readVertices(map, (flags & 64) !== 0, true);
        map.lengths = input.floats(vertexCount / 3);
        break;
      }
      case 'point': {
        const [rotation, px, py] = input.floats(3);
        put(map, 'x', px, 0);
        put(map, 'y', py, 0);
        put(map, 'rotation', rotation, 0);
        break;
      }
      case 'clipping':
        map.end = slotName(input.varint());
        readVertices(map, (flags & 16) !== 0, true);
        break;
    }
    if (nonessential && type in COLORS) put(map, 'color', colorText(input.int32()), COLORS[type]);
    return map;
  };

  const readSkinAttachments = (skin: Json, slotCount: number) => {
    const attachments: Json = {};
    for (let i = 0; i < slotCount; i++) {
      const slotMap: Json = (attachments[slotName(input.varint())] ??= {});
      for (let a = 0, n = input.varint(); a < n; a++) {
        const key = input.stringRef();
        if (key === null) throw new Error('an attachment in the .skel has no name');
        slotMap[key] = readAttachment(key);
      }
    }
    skin.attachments = attachments;
  };

  // skins in the order the .skel refers to them by: the default first, when it has attachments
  const skins: Json[] = [];
  const defaultSlots = input.varint();
  if (defaultSlots > 0) {
    const skin: Json = { name: 'default' };
    readSkinAttachments(skin, defaultSlots);
    skins.push(skin);
  }
  const skinLists: [string, (index: number) => string][] = [
    ['bones', boneName],
    ['ik', named(ik, 'ik constraint')],
    ['transform', named(transform, 'transform constraint')],
    ['path', named(path, 'path constraint')],
    ['physics', named(physics, 'physics constraint')]
  ];
  for (let i = 0, n = input.varint(); i < n; i++) {
    const skin: Json = { name: input.string() };
    if (nonessential) put(skin, 'color', colorText(input.int32()), COLORS.skin);
    for (const [key, name] of skinLists) {
      const names = Array.from({ length: input.varint() }, () => name(input.varint()));
      if (names.length) skin[key] = names;
    }
    readSkinAttachments(skin, input.varint());
    skins.push(skin);
  }
  const skinName = named(skins, 'skin');
  for (const { map, skin } of linked) put(map, 'skin', skinName(skin), 'default');
  if (skins.length) json.skins = skins;

  const eventNames: string[] = [];
  const events: Json = {};
  for (let i = 0, n = input.varint(); i < n; i++) {
    const name = input.string() as string;
    const event: Json = {};
    put(event, 'int', input.varint(false), 0);
    put(event, 'float', input.float(), 0);
    put(event, 'string', input.string(), '');
    const audio = input.string();
    if (audio) {
      event.audio = audio;
      put(event, 'volume', input.float(), 1);
      put(event, 'balance', input.float(), 0);
    }
    events[name] = event;
    eventNames.push(name);
  }
  if (eventNames.length) json.events = events;
  const eventName = (index: number) => {
    const name = eventNames[index];
    if (name === undefined) throw new Error(`event ${index} is not in the .skel`);
    return name;
  };

  const animations: Json = {};
  for (let i = 0, n = input.varint(); i < n; i++) {
    const name = input.string() as string;
    animations[name] = readAnimation();
  }
  if (Object.keys(animations).length) json.animations = animations;
  if (!input.done) throw new Error('the .skel has data after its last animation');
  return json;

  // the curve of a key leads to the next one, and is read after the next one's values
  function readCurve(key: Json, values: number, type = input.byte()) {
    if (type === CURVE_STEPPED) key.curve = 'stepped';
    else if (type === CURVE_BEZIER) key.curve = input.floats(values * 4);
    else if (type !== CURVE_LINEAR) throw new Error(`unknown curve type: ${type}`);
  }

  function readCurveTimeline(count: number, values: number, readValues: (key: Json) => void): Json[] {
    input.varint(); // bezier count
    const keys: Json[] = [];
    for (let i = 0; i < count; i++) {
      const key: Json = {};
      put(key, 'time', input.float(), 0);
      readValues(key);
      if (i > 0) readCurve(keys[i - 1] as Json, values);
      keys.push(key);
    }
    return keys;
  }

  function readTimeline1(count: number, fallback: number) {
    return readCurveTimeline(count, 1, (key) => put(key, 'value', input.float(), fallback));
  }

  function timeOnly() {
    const key: Json = {};
    put(key, 'time', input.float(), 0);
    return key;
  }

  function readAnimation(): Json {
    input.varint(); // timeline count
    const animation: Json = {};
    const group = (name: string): Json => (animation[name] ??= {});

    for (let i = 0, n = input.varint(); i < n; i++) {
      const timelines: Json = (group('slots')[slotName(input.varint())] ??= {});
      for (let t = 0, nt = input.varint(); t < nt; t++) {
        const type = enumName(SLOT_TIMELINES, input.byte(), 'slot timeline');
        const count = input.varint();
        if (type === 'attachment') {
          timelines[type] = Array.from({ length: count }, () => {
            const key = timeOnly();
            key.name = input.stringRef();
            return key;
          });
        } else if (type === 'alpha') {
          timelines[type] = readCurveTimeline(count, 1, (key) => put(key, 'value', input.byte() / 255, 0));
        } else {
          const two = type === 'rgba2' || type === 'rgb2';
          const alpha = type === 'rgba' || type === 'rgba2';
          const color = (n: number) => bytesText(Array.from({ length: n }, () => input.byte()));
          timelines[type] = readCurveTimeline(count, (alpha ? 4 : 3) + (two ? 3 : 0), (key) => {
            if (!two) return void (key.color = color(alpha ? 4 : 3));
            key.light = color(alpha ? 4 : 3);
            key.dark = color(3);
          });
        }
      }
    }

    for (let i = 0, n = input.varint(); i < n; i++) {
      const timelines: Json = (group('bones')[boneName(input.varint())] ??= {});
      for (let t = 0, nt = input.varint(); t < nt; t++) {
        const id = input.byte();
        const count = input.varint();
        if (id === BONE_INHERIT) {
          timelines.inherit = Array.from({ length: count }, () => {
            const key = timeOnly();
            put(key, 'inherit', enumName(INHERIT, input.byte(), 'inherit mode'), 'normal');
            return key;
          });
          continue;
        }
        const entry = boneTypes.find(([, [value]]) => value === id);
        if (!entry) throw new Error(`unknown bone timeline: ${id}`);
        const [type, [, names, fallback]] = entry;
        timelines[type] = names
          ? readCurveTimeline(count, 2, (key) => {
              put(key, names[0], input.float(), fallback);
              put(key, names[1], input.float(), fallback);
            })
          : readTimeline1(count, fallback);
      }
    }

    // an ik key packs its booleans and the kind of curve leading to it into one byte
    for (let i = 0, n = input.varint(); i < n; i++) {
      const name = named(ik, 'ik constraint')(input.varint());
      const count = input.varint();
      input.varint(); // bezier count
      const keys: Json[] = [];
      for (let k = 0; k < count; k++) {
        const flags = input.byte();
        const key = timeOnly();
        put(key, 'mix', flags & 1 ? (flags & 2 ? input.float() : 1) : 0, 1);
        if (flags & 4) key.softness = input.float();
        put(key, 'bendPositive', (flags & 8) !== 0, true);
        put(key, 'compress', (flags & 16) !== 0, false);
        put(key, 'stretch', (flags & 32) !== 0, false);
        if (k > 0) readCurve(keys[k - 1] as Json, 2, flags & 64 ? CURVE_STEPPED : flags & 128 ? CURVE_BEZIER : CURVE_LINEAR);
        keys.push(key);
      }
      group('ik')[name] = keys;
    }

    for (let i = 0, n = input.varint(); i < n; i++) {
      const name = named(transform, 'transform constraint')(input.varint());
      group('transform')[name] = readCurveTimeline(input.varint(), 6, (key) => {
        const [mixRotate, mixX, mixY, mixScaleX, mixScaleY, mixShearY] = input.floats(6) as number[];
        put(key, 'mixRotate', mixRotate, 1);
        put(key, 'mixX', mixX, 1);
        put(key, 'mixY', mixY, mixX);
        put(key, 'mixScaleX', mixScaleX, 1);
        put(key, 'mixScaleY', mixScaleY, mixScaleX);
        put(key, 'mixShearY', mixShearY, 1);
      });
    }

    for (let i = 0, n = input.varint(); i < n; i++) {
      const timelines: Json = (group('path')[named(path, 'path constraint')(input.varint())] ??= {});
      for (let t = 0, nt = input.varint(); t < nt; t++) {
        const type = enumName(PATH_TIMELINES, input.byte(), 'path timeline');
        const count = input.varint();
        timelines[type] =
          type === 'mix'
            ? readCurveTimeline(count, 3, (key) => {
                const [mixRotate, mixX, mixY] = input.floats(3) as number[];
                put(key, 'mixRotate', mixRotate, 1);
                put(key, 'mixX', mixX, 1);
                put(key, 'mixY', mixY, mixX);
              })
            : readTimeline1(count, 0);
      }
    }

    // index 0 stands for every physics constraint, an empty name in the JSON; the others are their index plus one
    for (let i = 0, n = input.varint(); i < n; i++) {
      const index = input.varint();
      const name = index === 0 ? '' : named(physics, 'physics constraint')(index - 1);
      const timelines: Json = (group('physics')[name] ??= {});
      for (let t = 0, nt = input.varint(); t < nt; t++) {
        const id = input.byte();
        const type = physicsTypes.find(([, value]) => value === id)?.[0];
        if (!type) throw new Error(`unknown physics timeline: ${id}`);
        const count = input.varint();
        timelines[type] = type === 'reset' ? Array.from({ length: count }, timeOnly) : readTimeline1(count, 0);
      }
    }

    for (let i = 0, n = input.varint(); i < n; i++) {
      const skinMap: Json = (group('attachments')[skinName(input.varint())] ??= {});
      for (let s = 0, ns = input.varint(); s < ns; s++) {
        const slotMap: Json = (skinMap[slotName(input.varint())] ??= {});
        for (let a = 0, na = input.varint(); a < na; a++) {
          const timelines: Json = (slotMap[input.stringRef() as string] ??= {});
          const type = input.byte();
          const count = input.varint();
          if (type === 0) {
            // each key after the first starts with its time and the curve leading to it, then its vertices
            input.varint(); // bezier count
            const keys: Json[] = [];
            let time = input.float();
            for (let k = 0; k < count; k++) {
              const key: Json = {};
              put(key, 'time', time, 0);
              const length = input.varint();
              if (length > 0) {
                put(key, 'offset', input.varint(), 0);
                key.vertices = input.floats(length);
              }
              keys.push(key);
              if (k === count - 1) break;
              time = input.float();
              readCurve(key, 1);
            }
            timelines.deform = keys;
          } else if (type === 1) {
            let lastDelay = 0;
            timelines.sequence = Array.from({ length: count }, () => {
              const key = timeOnly();
              const modeAndIndex = input.int32();
              put(key, 'mode', enumName(SEQUENCE_MODE, modeAndIndex & 0xf, 'sequence mode'), 'hold');
              put(key, 'index', modeAndIndex >> 4, 0);
              const delay = input.float();
              put(key, 'delay', delay, lastDelay);
              lastDelay = delay;
              return key;
            });
          } else {
            throw new Error(`unknown attachment timeline: ${type}`);
          }
        }
      }
    }

    const drawOrder: Json[] = [];
    for (let i = 0, n = input.varint(); i < n; i++) {
      const key = timeOnly();
      const offsets = Array.from({ length: input.varint() }, () => ({ slot: slotName(input.varint()), offset: input.varint() }));
      if (offsets.length) key.offsets = offsets;
      drawOrder.push(key);
    }
    if (drawOrder.length) animation.drawOrder = drawOrder;

    const eventKeys: Json[] = [];
    for (let i = 0, n = input.varint(); i < n; i++) {
      const key = timeOnly();
      const name = eventName(input.varint());
      const event = events[name];
      key.name = name;
      put(key, 'int', input.varint(false), event.int ?? 0);
      put(key, 'float', input.float(), event.float ?? 0);
      put(key, 'string', input.string());
      if (event.audio) {
        put(key, 'volume', input.float(), 1);
        put(key, 'balance', input.float(), 0);
      }
      eventKeys.push(key);
    }
    if (eventKeys.length) animation.events = eventKeys;

    return animation;
  }
}
