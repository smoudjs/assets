// A Spine 4.1 or 4.2 skeleton .json as a .skel. Nonessential data, which only the editor uses, is left out. Both
// versions write most sections alike; 4.2 packs constraints and attachments into flags and adds physics.

import {
  ATTACHMENT_TYPES,
  BLEND,
  BONE_FLOATS,
  BONE_INHERIT,
  BONE_TIMELINES,
  CURVE_BEZIER,
  CURVE_LINEAR,
  CURVE_STEPPED,
  colorBytes,
  enumIndex,
  INHERIT,
  type Json,
  mixValues,
  Output,
  PATH_TIMELINES,
  PHYSICS_GLOBALS,
  PHYSICS_TIMELINES,
  POSITION_MODE,
  rgb888,
  rgba8888,
  ROTATE_MODE,
  SEQUENCE_MODE,
  SLOT_TIMELINES,
  SPACING_MODE,
  spineVersion,
  TRANSFORM_OFFSETS,
  wrongVersion
} from './skel-format.js';

const isWhite = (text: string | undefined) => text == null || rgba8888(text) === -1;
const filled = (keys: unknown): keys is Json[] => Array.isArray(keys) && keys.length > 0;

function indexOf(list: Json[]): Map<string, number> {
  return new Map(list.map((item, i) => [item.name as string, i]));
}

function lookup(map: Map<string, number>, name: string, what: string): number {
  const index = map.get(name);
  if (index === undefined) throw new Error(`${what} not found: ${name}`);
  return index;
}

function bezierCount(keys: Json[], values: number): number {
  let count = 0;
  for (let i = 0; i < keys.length - 1; i++) if (Array.isArray(keys[i]?.curve)) count += values;
  return count;
}

// the curve of a key leads to the next one; a bezier has four numbers per value
function writeCurve(out: Output, key: Json, values: number) {
  const { curve } = key;
  if (!curve) return out.byte(CURVE_LINEAR);
  if (curve === 'stepped') return out.byte(CURVE_STEPPED);
  out.byte(CURVE_BEZIER);
  for (let i = 0; i < values * 4; i++) out.float(curve[i] ?? 0);
}

function writeCurveTimeline(out: Output, keys: Json[], values: number, writeValues: (key: Json) => void) {
  out.varint(bezierCount(keys, values));
  keys.forEach((key, i) => {
    out.float(key.time ?? 0);
    writeValues(key);
    if (i > 0) writeCurve(out, keys[i - 1] as Json, values);
  });
}

const writeTimeline1 = (out: Output, keys: Json[], fallback: number) =>
  writeCurveTimeline(out, keys, 1, (key) => out.float(key.value ?? fallback));

// flags with the bit of each value that is not 0, from the first bit given on
function nonZeroFlags(values: number[], firstBit: number): number {
  let flags = 0;
  values.forEach((v, i) => {
    if (v !== 0) flags |= firstBit << i;
  });
  return flags;
}

/** A Spine 4.1 or 4.2 skeleton .json, parsed, as a .skel. Throws on another version and on data a .skel cannot hold. */
export function jsonToSkel(json: Json): Buffer {
  const skeleton: Json = json.skeleton ?? {};
  const version = spineVersion(skeleton.spine);
  if (!version) throw wrongVersion(skeleton.spine);
  const v41 = version === '4.1';
  const bones: Json[] = json.bones ?? [];
  const slots: Json[] = json.slots ?? [];
  const ik: Json[] = json.ik ?? [];
  const transform: Json[] = json.transform ?? [];
  const path: Json[] = json.path ?? [];
  const physics: Json[] = json.physics ?? [];
  if (v41 && physics.length) throw new Error('Spine 4.1 has no physics');
  const skins: Json[] = json.skins ?? [];
  const events: Json = json.events ?? {};
  const animations: Json = json.animations ?? {};

  const boneIndex = indexOf(bones);
  const slotIndex = indexOf(slots);
  const ikIndex = indexOf(ik);
  const transformIndex = indexOf(transform);
  const pathIndex = indexOf(path);
  const physicsIndex = indexOf(physics);
  const eventNames = Object.keys(events);
  const eventIndex = new Map(eventNames.map((name, i) => [name, i]));

  // names used more than once are written once, in a table the header carries
  const strings = new Map<string, number>();
  const ref = (text: string | null | undefined) => {
    if (text == null) return 0;
    if (text === '') throw new Error('an empty name cannot go into the .skel string table');
    let index = strings.get(text);
    if (index === undefined) strings.set(text, (index = strings.size + 1));
    return index;
  };

  const out = new Output();
  const boneList = (names: string[]) => {
    out.varint(names.length);
    for (const name of names) out.varint(lookup(boneIndex, name, 'bone'));
  };
  // 4.1 names events and skins from the string table, 4.2 writes them in place
  const writeName = (name: string) => (v41 ? out.varint(ref(name)) : out.string(name));

  out.varint(bones.length);
  bones.forEach((bone, i) => {
    out.string(bone.name);
    if (i > 0) {
      if (!bone.parent) throw new Error(`bone ${bone.name} has no parent; only the first bone may be the root`);
      out.varint(lookup(boneIndex, bone.parent, 'bone'));
    } else if (bone.parent) {
      throw new Error('the first bone must be the root');
    }
    for (const [key, fallback] of BONE_FLOATS) out.float(bone[key] ?? fallback);
    // 4.1 calls it transform and writes a varint, 4.2 a byte: the same byte for these few values
    out.byte(enumIndex(INHERIT, bone.inherit ?? bone.transform ?? 'normal', 'inherit mode'));
    out.bool(bone.skin);
  });

  out.varint(slots.length);
  for (const slot of slots) {
    out.string(slot.name);
    out.varint(lookup(boneIndex, slot.bone, 'bone'));
    out.int32(rgba8888(slot.color ?? 'ffffffff'));
    out.int32(slot.dark ? rgb888(slot.dark) : -1);
    out.varint(ref(slot.attachment));
    out.varint(enumIndex(BLEND, slot.blend ?? 'normal', 'blend mode'));
  }

  out.varint(ik.length);
  for (const c of ik) {
    out.string(c.name);
    out.varint(c.order ?? 0);
    if (v41) out.bool(c.skin);
    boneList(c.bones);
    out.varint(lookup(boneIndex, c.target, 'bone'));
    const mix = c.mix ?? 1;
    const softness = c.softness ?? 0;
    const bendPositive = c.bendPositive ?? true;
    if (v41) {
      out.floats([mix, softness]);
      out.byte(bendPositive ? 1 : -1);
      for (const value of [c.compress, c.stretch, c.uniform]) out.bool(value);
      continue;
    }
    let flags = 0;
    if (c.skin) flags |= 1;
    if (bendPositive) flags |= 2;
    if (c.compress) flags |= 4;
    if (c.stretch) flags |= 8;
    if (c.uniform) flags |= 16;
    if (mix !== 0) flags |= 32;
    if (mix !== 0 && mix !== 1) flags |= 64;
    if (softness !== 0) flags |= 128;
    out.byte(flags);
    if (flags & 64) out.float(mix);
    if (flags & 128) out.float(softness);
  }

  out.varint(transform.length);
  for (const c of transform) {
    out.string(c.name);
    out.varint(c.order ?? 0);
    if (v41) out.bool(c.skin);
    boneList(c.bones);
    out.varint(lookup(boneIndex, c.target, 'bone'));
    const values = [...TRANSFORM_OFFSETS.map((key) => c[key] ?? 0), ...mixValues(c)];
    if (v41) {
      out.bool(c.local);
      out.bool(c.relative);
      out.floats(values);
      continue;
    }
    // 4.2 leaves out a value of 0, its flag unset: the first five in one byte, the other seven in the next
    const [first, rest] = [values.slice(0, 5), values.slice(5)];
    out.byte((c.skin ? 1 : 0) | (c.local ? 2 : 0) | (c.relative ? 4 : 0) | nonZeroFlags(first, 8));
    out.floats(first.filter((v) => v !== 0));
    out.byte(nonZeroFlags(rest, 1));
    out.floats(rest.filter((v) => v !== 0));
  }

  out.varint(path.length);
  for (const c of path) {
    out.string(c.name);
    out.varint(c.order ?? 0);
    out.bool(c.skin);
    boneList(c.bones);
    out.varint(lookup(slotIndex, c.target, 'slot'));
    const modes = [
      enumIndex(POSITION_MODE, c.positionMode ?? 'percent', 'position mode'),
      enumIndex(SPACING_MODE, c.spacingMode ?? 'length', 'spacing mode'),
      enumIndex(ROTATE_MODE, c.rotateMode ?? 'tangent', 'rotate mode')
    ] as [number, number, number];
    const rotation = c.rotation ?? 0;
    if (v41) {
      for (const mode of modes) out.varint(mode);
      out.float(rotation);
    } else {
      out.byte(modes[0] | (modes[1] << 1) | (modes[2] << 3) | (rotation !== 0 ? 128 : 0));
      if (rotation !== 0) out.float(rotation);
    }
    out.floats([c.position ?? 0, c.spacing ?? 0, ...mixValues(c, 3)]);
  }

  if (!v41) out.varint(physics.length);
  for (const c of physics) {
    out.string(c.name);
    out.varint(c.order ?? 0);
    out.varint(lookup(boneIndex, c.bone, 'bone'));
    const optional = [c.x ?? 0, c.y ?? 0, c.rotate ?? 0, c.scaleX ?? 0, c.shearX ?? 0];
    const limit = c.limit ?? 5000;
    const mass = c.mass ?? 1;
    const mix = c.mix ?? 1;
    let flags = (c.skin ? 1 : 0) | nonZeroFlags(optional, 2);
    if (limit !== 5000) flags |= 64;
    if (mass !== 1) flags |= 128;
    out.byte(flags);
    out.floats(optional.filter((v) => v !== 0));
    if (limit !== 5000) out.float(limit);
    const fps = Math.round(c.fps ?? 60);
    if (fps < 1 || fps > 255) throw new Error(`physics ${c.name}: fps ${c.fps} is outside the 1 to 255 a .skel holds`);
    out.byte(fps);
    out.floats([c.inertia ?? 1, c.strength ?? 100, c.damping ?? 1]);
    // the .skel holds the inverse of the mass
    if (mass !== 1) out.float(1 / mass);
    out.floats([c.wind ?? 0, c.gravity ?? 0]);
    flags = 0;
    PHYSICS_GLOBALS.forEach((key, i) => {
      if (c[key]) flags |= 1 << i;
    });
    if (mix !== 1) flags |= 128;
    out.byte(flags);
    if (mix !== 1) out.float(mix);
  }

  // the default skin goes first, and only with attachments; linked meshes and deform timelines refer to skins in this order
  const hasAttachments = (skin: Json) => Object.keys(skin.attachments ?? {}).length > 0;
  const defaultSkin = skins.find((skin) => skin.name === 'default');
  const otherSkins = skins.filter((skin) => skin !== defaultSkin);
  const skinOrder = (defaultSkin && hasAttachments(defaultSkin) ? [defaultSkin] : []).concat(otherSkins);
  const skinIndex = indexOf(skinOrder);

  // unweighted: x, y per vertex. Weighted: per vertex its bone count, then bone, x, y and weight per bone
  const writeVertices = (vertices: number[], vertexCount: number) => {
    if (vertices.length === vertexCount * 2) return out.floats(vertices);
    for (let i = 0; i < vertices.length;) {
      const boneCount = vertices[i++] as number;
      out.varint(boneCount);
      for (const end = i + boneCount * 4; i < end; i += 4) {
        out.varint(vertices[i] as number);
        out.floats(vertices.slice(i + 1, i + 4));
      }
    }
  };

  const writeSequence = (sequence: Json) => {
    for (const value of [sequence.count ?? 0, sequence.start ?? 1, sequence.digits ?? 0, sequence.setup ?? 0])
      out.varint(value);
  };

  const regionFloats = (map: Json) => [
    map.x ?? 0,
    map.y ?? 0,
    map.scaleX ?? 1,
    map.scaleY ?? 1,
    map.width ?? 32,
    map.height ?? 32
  ];

  // a .skel does not store the triangle count in 4.2: it follows from the vertices and the hull
  const checkTriangles = (map: Json, name: string, vertexCount: number, hull: number) => {
    if (map.triangles.length === (vertexCount * 2 - hull - 2) * 3) return;
    throw new Error(
      `mesh ${name}: ${map.triangles.length / 3} triangles for ${vertexCount} vertices and a hull of ${hull}, which a .skel cannot hold`
    );
  };

  // 4.1: the name and a type byte, then each value in place; a boolean says whether the vertices are weighted
  const writeAttachment41 = (map: Json, name: string, type: string, typeId: number, key: string) => {
    out.varint(name !== key ? ref(name) : 0);
    out.byte(typeId);
    const imagePath: string = map.path ?? name;
    const writePath = () => out.varint(imagePath !== name ? ref(imagePath) : 0);
    const sequence = () => {
      out.bool(map.sequence);
      if (map.sequence) writeSequence(map.sequence);
    };
    const vertexCount = map.vertexCount ?? 0;
    const vertices = (count = vertexCount) => {
      const list: number[] = map.vertices ?? [];
      out.bool(list.length !== count * 2);
      writeVertices(list, count);
    };
    switch (type) {
      case 'region':
        writePath();
        out.floats([map.rotation ?? 0, ...regionFloats(map)]);
        out.int32(rgba8888(map.color ?? 'ffffffff'));
        sequence();
        break;
      case 'mesh': {
        writePath();
        out.int32(rgba8888(map.color ?? 'ffffffff'));
        const count = map.uvs.length >> 1;
        out.varint(count);
        out.floats(map.uvs);
        out.varint(map.triangles.length);
        for (const t of map.triangles) out.short(t);
        vertices(count);
        out.varint(map.hull ?? 0);
        sequence();
        break;
      }
      case 'linkedmesh':
        writePath();
        out.int32(rgba8888(map.color ?? 'ffffffff'));
        out.varint(ref(map.skin));
        out.varint(ref(map.parent));
        out.bool(map.timelines ?? true);
        sequence();
        break;
      case 'boundingbox':
        out.varint(vertexCount);
        vertices();
        break;
      case 'path':
        out.bool(map.closed);
        out.bool(map.constantSpeed ?? true);
        out.varint(vertexCount);
        vertices();
        out.floats(Array.from({ length: vertexCount / 3 }, (_, i) => map.lengths?.[i] ?? 0));
        break;
      case 'point':
        out.floats([map.rotation ?? 0, map.x ?? 0, map.y ?? 0]);
        break;
      case 'clipping':
        if (!map.end) throw new Error(`clipping ${name} has no end slot`);
        out.varint(lookup(slotIndex, map.end, 'slot'));
        out.varint(vertexCount);
        vertices();
        break;
    }
  };

  // 4.2: one flags byte carries the type and says which values follow
  const writeAttachment42 = (map: Json, name: string, type: string, typeId: number, key: string) => {
    const nameFlag = name !== key ? 8 : 0;
    const writeName = () => {
      if (nameFlag) out.varint(ref(name));
    };

    if (type === 'region' || type === 'mesh' || type === 'linkedmesh') {
      const imagePath: string = map.path ?? name;
      const hasColor = !isWhite(map.color);
      let flags = typeId | nameFlag | (imagePath !== name ? 16 : 0) | (hasColor ? 32 : 0) | (map.sequence ? 64 : 0);
      if (type === 'region' && (map.rotation ?? 0) !== 0) flags |= 128;
      if (type === 'mesh' && map.vertices.length !== map.uvs.length) flags |= 128;
      if (type === 'linkedmesh' && (map.timelines ?? true)) flags |= 128;
      out.byte(flags);
      writeName();
      if (flags & 16) out.varint(ref(imagePath));
      if (hasColor) out.int32(rgba8888(map.color));
      if (map.sequence) writeSequence(map.sequence);
      if (type === 'region') {
        if (flags & 128) out.float(map.rotation);
        out.floats(regionFloats(map));
      } else if (type === 'mesh') {
        const vertexCount = map.uvs.length >> 1;
        const hull = map.hull ?? 0;
        checkTriangles(map, name, vertexCount, hull);
        out.varint(hull);
        out.varint(vertexCount);
        writeVertices(map.vertices, vertexCount);
        out.floats(map.uvs);
        for (const t of map.triangles) out.varint(t);
      } else {
        out.varint(lookup(skinIndex, map.skin ?? 'default', 'skin'));
        out.varint(ref(map.parent));
      }
      return;
    }

    const vertexCount = map.vertexCount ?? 0;
    const vertices: number[] = map.vertices ?? [];
    const weighted = vertices.length !== vertexCount * 2;
    const writeAllVertices = () => {
      out.varint(vertexCount);
      writeVertices(vertices, vertexCount);
    };
    switch (type) {
      case 'boundingbox':
        out.byte(typeId | nameFlag | (weighted ? 16 : 0));
        writeName();
        writeAllVertices();
        break;
      case 'path': {
        out.byte(typeId | nameFlag | (map.closed ? 16 : 0) | ((map.constantSpeed ?? true) ? 32 : 0) | (weighted ? 64 : 0));
        writeName();
        writeAllVertices();
        out.floats(Array.from({ length: vertexCount / 3 }, (_, i) => map.lengths?.[i] ?? 0));
        break;
      }
      case 'point':
        out.byte(typeId | nameFlag);
        writeName();
        out.floats([map.rotation ?? 0, map.x ?? 0, map.y ?? 0]);
        break;
      case 'clipping':
        out.byte(typeId | nameFlag | (weighted ? 16 : 0));
        writeName();
        if (!map.end) throw new Error(`clipping ${name} has no end slot`);
        out.varint(lookup(slotIndex, map.end, 'slot'));
        writeAllVertices();
        break;
    }
  };

  const writeAttachment = (map: Json, key: string) => {
    const name: string = map.name ?? key;
    let type: string = map.type ?? 'region';
    if (type === 'mesh' && map.parent) type = 'linkedmesh';
    const typeId = ATTACHMENT_TYPES.indexOf(type);
    if (typeId < 0) throw new Error(`unknown attachment type: ${type}`);
    (v41 ? writeAttachment41 : writeAttachment42)(map, name, type, typeId, key);
  };

  const writeSkinAttachments = (skin: Json) => {
    const entries = Object.entries<Json>(skin.attachments ?? {});
    out.varint(entries.length);
    for (const [slotName, slotMap] of entries) {
      out.varint(lookup(slotIndex, slotName, 'slot'));
      const attachments = Object.entries<Json>(slotMap);
      out.varint(attachments.length);
      for (const [key, map] of attachments) {
        out.varint(ref(key));
        writeAttachment(map, key);
      }
    }
  };

  if (defaultSkin && hasAttachments(defaultSkin)) {
    for (const key of ['bones', 'ik', 'transform', 'path', 'physics']) {
      if (defaultSkin[key]?.length) throw new Error(`a .skel cannot hold ${key} on the default skin`);
    }
    writeSkinAttachments(defaultSkin);
  } else {
    out.varint(0);
  }

  out.varint(otherSkins.length);
  const skinLists: [string, Map<string, number>, string][] = [
    ['bones', boneIndex, 'bone'],
    ['ik', ikIndex, 'ik constraint'],
    ['transform', transformIndex, 'transform constraint'],
    ['path', pathIndex, 'path constraint']
  ];
  if (!v41) skinLists.push(['physics', physicsIndex, 'physics constraint']);
  for (const skin of otherSkins) {
    writeName(skin.name);
    for (const [key, map, what] of skinLists) {
      const names: string[] = skin[key] ?? [];
      out.varint(names.length);
      for (const name of names) out.varint(lookup(map, name, what));
    }
    writeSkinAttachments(skin);
  }

  out.varint(eventNames.length);
  for (const name of eventNames) {
    const event = events[name];
    writeName(name);
    out.varint(event.int ?? 0, false);
    out.float(event.float ?? 0);
    out.string(event.string ?? '');
    out.string(event.audio ?? null);
    if (event.audio) out.floats([event.volume ?? 1, event.balance ?? 0]);
  }

  const animationNames = Object.keys(animations);
  out.varint(animationNames.length);
  for (const name of animationNames) {
    out.string(name);
    // the timeline count comes before the timelines, so they are written apart first
    const body = new Output();
    out.varint(writeAnimation(body, animations[name]));
    out.append(body.toBuffer());
  }

  function writeAnimation(o: Output, animation: Json): number {
    let timelines = 0;
    // timelines grouped by what they animate, a bone, slot or constraint, with the empty ones left out
    const groups = (map: Json | undefined, index: Map<string, number>, what: string, known: (type: string) => boolean) =>
      Object.entries<Json>(map ?? {})
        .map(([name, types]) => {
          const list = Object.entries<Json[]>(types).filter(([type, keys]) => known(type) && filled(keys));
          return [lookup(index, name, what), list] as const;
        })
        .filter(([, list]) => list.length);

    const slotGroups = groups(animation.slots, slotIndex, 'slot', (type) => SLOT_TIMELINES.includes(type));
    o.varint(slotGroups.length);
    for (const [index, list] of slotGroups) {
      o.varint(index);
      o.varint(list.length);
      for (const [type, keys] of list) {
        timelines++;
        o.byte(SLOT_TIMELINES.indexOf(type));
        o.varint(keys.length);
        if (type === 'attachment') {
          for (const key of keys) {
            o.float(key.time ?? 0);
            o.varint(ref(key.name));
          }
        } else if (type === 'alpha') {
          writeCurveTimeline(o, keys, 1, (key) => o.byte(Math.round((key.value ?? 0) * 255)));
        } else {
          const two = type === 'rgba2' || type === 'rgb2';
          const alpha = type === 'rgba' || type === 'rgba2';
          writeCurveTimeline(o, keys, (alpha ? 4 : 3) + (two ? 3 : 0), (key) => {
            const bytes = two
              ? [...colorBytes(key.light, alpha), ...colorBytes(key.dark, false)]
              : colorBytes(key.color, alpha);
            for (const b of bytes) o.byte(b);
          });
        }
      }
    }

    const boneGroups = groups(
      animation.bones,
      boneIndex,
      'bone',
      (type) => type in BONE_TIMELINES || (!v41 && type === 'inherit')
    );
    o.varint(boneGroups.length);
    for (const [index, list] of boneGroups) {
      o.varint(index);
      o.varint(list.length);
      for (const [type, keys] of list) {
        timelines++;
        if (type === 'inherit') {
          o.byte(BONE_INHERIT);
          o.varint(keys.length);
          for (const key of keys) {
            o.float(key.time ?? 0);
            o.byte(enumIndex(INHERIT, key.inherit ?? 'normal', 'inherit mode'));
          }
          continue;
        }
        const [id, names, fallback] = BONE_TIMELINES[type] as [number, [string, string] | null, number];
        o.byte(id);
        o.varint(keys.length);
        if (names) {
          writeCurveTimeline(o, keys, 2, (key) => o.floats([key[names[0]] ?? fallback, key[names[1]] ?? fallback]));
        } else {
          writeTimeline1(o, keys, fallback);
        }
      }
    }

    const ikList = Object.entries<Json[]>(animation.ik ?? {}).filter(([, keys]) => filled(keys));
    o.varint(ikList.length);
    for (const [name, keys] of ikList) {
      timelines++;
      o.varint(lookup(ikIndex, name, 'ik constraint'));
      o.varint(keys.length);
      o.varint(bezierCount(keys, 2));
      keys.forEach((key, i) => {
        const mix = key.mix ?? 1;
        const softness = key.softness ?? 0;
        const bendPositive = key.bendPositive ?? true;
        // 4.1: the values, the curve leading to this key, then the booleans
        if (v41) {
          o.floats([key.time ?? 0, mix, softness]);
          if (i > 0) writeCurve(o, keys[i - 1] as Json, 2);
          o.byte(bendPositive ? 1 : -1);
          o.bool(key.compress);
          o.bool(key.stretch);
          return;
        }
        // 4.2 packs the booleans and the curve kind into one byte
        let flags = 0;
        if (mix !== 0) flags |= 1;
        if (mix !== 0 && mix !== 1) flags |= 2;
        if (softness !== 0) flags |= 4;
        if (bendPositive) flags |= 8;
        if (key.compress) flags |= 16;
        if (key.stretch) flags |= 32;
        const previous = i > 0 ? keys[i - 1]?.curve : null;
        if (previous === 'stepped') flags |= 64;
        else if (Array.isArray(previous)) flags |= 128;
        o.byte(flags);
        o.float(key.time ?? 0);
        if (flags & 2) o.float(mix);
        if (flags & 4) o.float(softness);
        if (flags & 128) for (let c = 0; c < 8; c++) o.float(previous[c] ?? 0);
      });
    }

    const transformList = Object.entries<Json[]>(animation.transform ?? {}).filter(([, keys]) => filled(keys));
    o.varint(transformList.length);
    for (const [name, keys] of transformList) {
      timelines++;
      o.varint(lookup(transformIndex, name, 'transform constraint'));
      o.varint(keys.length);
      writeCurveTimeline(o, keys, 6, (key) => o.floats(mixValues(key)));
    }

    const pathGroups = groups(animation.path, pathIndex, 'path constraint', (type) => PATH_TIMELINES.includes(type));
    o.varint(pathGroups.length);
    for (const [index, list] of pathGroups) {
      o.varint(index);
      o.varint(list.length);
      for (const [type, keys] of list) {
        timelines++;
        o.byte(PATH_TIMELINES.indexOf(type));
        o.varint(keys.length);
        if (type === 'mix') writeCurveTimeline(o, keys, 3, (key) => o.floats(mixValues(key, 3)));
        else writeTimeline1(o, keys, 0);
      }
    }

    // an empty constraint name stands for every physics constraint, index 0; the others are their index plus one
    if (!v41) {
      const physicsGroups = Object.entries<Json>(animation.physics ?? {})
        .map(([name, types]) => {
          const list = Object.entries<Json[]>(types).filter(([type, keys]) => type in PHYSICS_TIMELINES && filled(keys));
          return [name ? lookup(physicsIndex, name, 'physics constraint') + 1 : 0, list] as const;
        })
        .filter(([, list]) => list.length);
      o.varint(physicsGroups.length);
      for (const [index, list] of physicsGroups) {
        o.varint(index);
        o.varint(list.length);
        for (const [type, keys] of list) {
          timelines++;
          o.byte(PHYSICS_TIMELINES[type] as number);
          o.varint(keys.length);
          if (type === 'reset') {
            for (const key of keys) o.float(key.time ?? 0);
          } else {
            writeTimeline1(o, keys, 0);
          }
        }
      }
    }

    // a 4.1 export downgraded from 4.2 may still hold deform timelines as 4.0 did, keyed by skin, slot and attachment
    let attachmentTimelines: Json = animation.attachments ?? {};
    if (v41 && animation.deform) {
      attachmentTimelines = structuredClone(attachmentTimelines);
      for (const [skin, slotMap] of Object.entries<Json>(animation.deform)) {
        for (const [slot, items] of Object.entries<Json>(slotMap)) {
          for (const [name, keys] of Object.entries(items))
            (((attachmentTimelines[skin] ??= {})[slot] ??= {})[name] ??= {}).deform = keys;
        }
      }
    }
    const attachmentSkins = Object.entries<Json>(attachmentTimelines);
    o.varint(attachmentSkins.length);
    for (const [skinName, skinMap] of attachmentSkins) {
      o.varint(lookup(skinIndex, skinName, 'skin'));
      const slotEntries = Object.entries<Json>(skinMap);
      o.varint(slotEntries.length);
      for (const [slotName, slotMap] of slotEntries) {
        o.varint(lookup(slotIndex, slotName, 'slot'));
        const entries: [string, string, Json[]][] = [];
        for (const [attachmentName, types] of Object.entries<Json>(slotMap)) {
          for (const [type, keys] of Object.entries(types)) {
            if ((type === 'deform' || type === 'sequence') && filled(keys)) entries.push([attachmentName, type, keys]);
          }
        }
        o.varint(entries.length);
        for (const [attachmentName, type, keys] of entries) {
          timelines++;
          o.varint(ref(attachmentName));
          o.byte(type === 'deform' ? 0 : 1);
          o.varint(keys.length);
          if (type === 'deform') {
            // each key after the first starts with its time and the curve leading to it, then its vertices
            o.varint(bezierCount(keys, 1));
            o.float(keys[0]?.time ?? 0);
            keys.forEach((key, i) => {
              if (i > 0) {
                o.float(key.time ?? 0);
                writeCurve(o, keys[i - 1] as Json, 1);
              }
              const vertices: number[] | undefined = key.vertices;
              if (!vertices?.length) return o.varint(0);
              o.varint(vertices.length);
              o.varint(key.offset ?? 0);
              o.floats(vertices);
            });
          } else {
            let lastDelay = 0;
            for (const key of keys) {
              const delay = key.delay ?? lastDelay;
              o.float(key.time ?? 0);
              o.int32(((key.index ?? 0) << 4) | enumIndex(SEQUENCE_MODE, key.mode ?? 'hold', 'sequence mode'));
              o.float(delay);
              lastDelay = delay;
            }
          }
        }
      }
    }

    const drawOrder: Json[] = animation.drawOrder ?? [];
    o.varint(drawOrder.length);
    if (drawOrder.length) timelines++;
    for (const key of drawOrder) {
      o.float(key.time ?? 0);
      const offsets: Json[] = key.offsets ?? [];
      o.varint(offsets.length);
      for (const offset of offsets) {
        o.varint(lookup(slotIndex, offset.slot, 'slot'));
        o.varint(offset.offset);
      }
    }

    const eventKeys: Json[] = animation.events ?? [];
    o.varint(eventKeys.length);
    if (eventKeys.length) timelines++;
    for (const key of eventKeys) {
      const data = events[key.name];
      if (!data) throw new Error(`event not found: ${key.name}`);
      o.float(key.time ?? 0);
      o.varint(eventIndex.get(key.name) as number);
      o.varint(key.int ?? data.int ?? 0, false);
      o.float(key.float ?? data.float ?? 0);
      // 4.1 says whether a string follows, 4.2 writes none as null
      if (v41) o.bool(key.string != null);
      if (!v41 || key.string != null) o.string(key.string ?? null);
      if (data.audio) o.floats([key.volume ?? 1, key.balance ?? 0]);
    }

    return timelines;
  }

  // the header goes last, once the string table is complete
  const head = new Output();
  const hash = skeleton.hash ? Buffer.from(skeleton.hash, 'base64') : null;
  if (hash?.length === 8) head.append(hash);
  else {
    head.int32(0);
    head.int32(0);
  }
  // only the version number: a downgraded export's 4.1-from-4.2.43 is 4.1
  head.string(/^\d+(\.\d+)*/.exec(skeleton.spine)?.[0] ?? version);
  head.floats([skeleton.x ?? 0, skeleton.y ?? 0, skeleton.width ?? 0, skeleton.height ?? 0]);
  if (!v41) head.float(skeleton.referenceScale ?? 100);
  head.bool(false);
  head.varint(strings.size);
  for (const text of strings.keys()) head.string(text);

  return Buffer.concat([head.toBuffer(), out.toBuffer()]);
}
