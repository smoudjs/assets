// A Spine 4.2 skeleton .json as a .skel. Nonessential data, which only the editor uses, is left out.

import {
  ATTACHMENT_TYPES,
  BLEND,
  BONE_INHERIT,
  BONE_TIMELINES,
  CURVE_BEZIER,
  CURVE_LINEAR,
  CURVE_STEPPED,
  colorBytes,
  enumIndex,
  INHERIT,
  isSpineVersion,
  type Json,
  wrongVersion,
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
  SPACING_MODE
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

/** A Spine 4.2 skeleton .json, parsed, as a .skel. Throws on another version and on data a .skel cannot hold. */
export function jsonToSkel(json: Json): Buffer {
  const skeleton: Json = json.skeleton ?? {};
  if (!isSpineVersion(skeleton.spine)) throw wrongVersion(skeleton.spine);
  const bones: Json[] = json.bones ?? [];
  const slots: Json[] = json.slots ?? [];
  const ik: Json[] = json.ik ?? [];
  const transform: Json[] = json.transform ?? [];
  const path: Json[] = json.path ?? [];
  const physics: Json[] = json.physics ?? [];
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

  out.varint(bones.length);
  bones.forEach((bone, i) => {
    out.string(bone.name);
    if (i > 0) {
      if (!bone.parent) throw new Error(`bone ${bone.name} has no parent; only the first bone may be the root`);
      out.varint(lookup(boneIndex, bone.parent, 'bone'));
    } else if (bone.parent) {
      throw new Error('the first bone must be the root');
    }
    out.float(bone.rotation ?? 0);
    out.float(bone.x ?? 0);
    out.float(bone.y ?? 0);
    out.float(bone.scaleX ?? 1);
    out.float(bone.scaleY ?? 1);
    out.float(bone.shearX ?? 0);
    out.float(bone.shearY ?? 0);
    out.float(bone.length ?? 0);
    out.byte(enumIndex(INHERIT, bone.inherit ?? 'normal', 'inherit mode'));
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
    boneList(c.bones);
    out.varint(lookup(boneIndex, c.target, 'bone'));
    const mix = c.mix ?? 1;
    const softness = c.softness ?? 0;
    let flags = 0;
    if (c.skin) flags |= 1;
    if (c.bendPositive ?? true) flags |= 2;
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
    boneList(c.bones);
    out.varint(lookup(boneIndex, c.target, 'bone'));
    const mixX = c.mixX ?? 1;
    const mixScaleX = c.mixScaleX ?? 1;
    // a value of 0 is left out, its flag unset
    const offsets = [c.rotation ?? 0, c.x ?? 0, c.y ?? 0, c.scaleX ?? 0, c.scaleY ?? 0];
    const rest = [c.shearY ?? 0, c.mixRotate ?? 1, mixX, c.mixY ?? mixX, mixScaleX, c.mixScaleY ?? mixScaleX, c.mixShearY ?? 1];
    let flags = (c.skin ? 1 : 0) | (c.local ? 2 : 0) | (c.relative ? 4 : 0);
    offsets.forEach((v, i) => {
      if (v !== 0) flags |= 8 << i;
    });
    out.byte(flags);
    for (const v of offsets) if (v !== 0) out.float(v);
    flags = 0;
    rest.forEach((v, i) => {
      if (v !== 0) flags |= 1 << i;
    });
    out.byte(flags);
    for (const v of rest) if (v !== 0) out.float(v);
  }

  out.varint(path.length);
  for (const c of path) {
    out.string(c.name);
    out.varint(c.order ?? 0);
    out.bool(c.skin);
    boneList(c.bones);
    out.varint(lookup(slotIndex, c.target, 'slot'));
    const rotation = c.rotation ?? 0;
    out.byte(
      enumIndex(POSITION_MODE, c.positionMode ?? 'percent', 'position mode') |
        (enumIndex(SPACING_MODE, c.spacingMode ?? 'length', 'spacing mode') << 1) |
        (enumIndex(ROTATE_MODE, c.rotateMode ?? 'tangent', 'rotate mode') << 3) |
        (rotation !== 0 ? 128 : 0)
    );
    if (rotation !== 0) out.float(rotation);
    const mixX = c.mixX ?? 1;
    out.float(c.position ?? 0);
    out.float(c.spacing ?? 0);
    out.float(c.mixRotate ?? 1);
    out.float(mixX);
    out.float(c.mixY ?? mixX);
  }

  out.varint(physics.length);
  for (const c of physics) {
    out.string(c.name);
    out.varint(c.order ?? 0);
    out.varint(lookup(boneIndex, c.bone, 'bone'));
    const optional = [c.x ?? 0, c.y ?? 0, c.rotate ?? 0, c.scaleX ?? 0, c.shearX ?? 0];
    const limit = c.limit ?? 5000;
    const mass = c.mass ?? 1;
    const mix = c.mix ?? 1;
    let flags = c.skin ? 1 : 0;
    optional.forEach((v, i) => {
      if (v !== 0) flags |= 2 << i;
    });
    if (limit !== 5000) flags |= 64;
    if (mass !== 1) flags |= 128;
    out.byte(flags);
    for (const v of optional) if (v !== 0) out.float(v);
    if (limit !== 5000) out.float(limit);
    const fps = Math.round(c.fps ?? 60);
    if (fps < 1 || fps > 255) throw new Error(`physics ${c.name}: fps ${c.fps} is outside the 1 to 255 a .skel holds`);
    out.byte(fps);
    out.float(c.inertia ?? 1);
    out.float(c.strength ?? 100);
    out.float(c.damping ?? 1);
    if (mass !== 1) out.float(1 / mass);
    out.float(c.wind ?? 0);
    out.float(c.gravity ?? 0);
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
    out.varint(vertexCount);
    if (vertices.length === vertexCount * 2) {
      for (const v of vertices) out.float(v);
      return;
    }
    for (let i = 0; i < vertices.length; ) {
      const boneCount = vertices[i++] as number;
      out.varint(boneCount);
      for (const end = i + boneCount * 4; i < end; i += 4) {
        out.varint(vertices[i] as number);
        out.float(vertices[i + 1] as number);
        out.float(vertices[i + 2] as number);
        out.float(vertices[i + 3] as number);
      }
    }
  };

  const writeAttachment = (map: Json, key: string) => {
    const name: string = map.name ?? key;
    const nameFlag = name !== key ? 8 : 0;
    let type: string = map.type ?? 'region';
    if (type === 'mesh' && map.parent) type = 'linkedmesh';
    const typeId = ATTACHMENT_TYPES.indexOf(type);
    if (typeId < 0) throw new Error(`unknown attachment type: ${type}`);
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
      if (map.sequence) {
        out.varint(map.sequence.count ?? 0);
        out.varint(map.sequence.start ?? 1);
        out.varint(map.sequence.digits ?? 0);
        out.varint(map.sequence.setup ?? 0);
      }
      if (type === 'region') {
        if (flags & 128) out.float(map.rotation);
        out.float(map.x ?? 0);
        out.float(map.y ?? 0);
        out.float(map.scaleX ?? 1);
        out.float(map.scaleY ?? 1);
        out.float(map.width ?? 32);
        out.float(map.height ?? 32);
      } else if (type === 'mesh') {
        const vertexCount = map.uvs.length >> 1;
        const hull = map.hull ?? 0;
        // a .skel does not store the triangle count: it follows from the vertices and the hull
        if (map.triangles.length !== (vertexCount * 2 - hull - 2) * 3) {
          throw new Error(
            `mesh ${name}: ${map.triangles.length / 3} triangles for ${vertexCount} vertices and a hull of ${hull}, which a .skel cannot hold`
          );
        }
        out.varint(hull);
        writeVertices(map.vertices, vertexCount);
        for (const v of map.uvs) out.float(v);
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
    switch (type) {
      case 'boundingbox':
        out.byte(typeId | nameFlag | (weighted ? 16 : 0));
        writeName();
        writeVertices(vertices, vertexCount);
        break;
      case 'path': {
        out.byte(typeId | nameFlag | (map.closed ? 16 : 0) | ((map.constantSpeed ?? true) ? 32 : 0) | (weighted ? 64 : 0));
        writeName();
        writeVertices(vertices, vertexCount);
        const lengths: number[] = map.lengths ?? [];
        for (let i = 0; i < vertexCount / 3; i++) out.float(lengths[i] ?? 0);
        break;
      }
      case 'point':
        out.byte(typeId | nameFlag);
        writeName();
        out.float(map.rotation ?? 0);
        out.float(map.x ?? 0);
        out.float(map.y ?? 0);
        break;
      case 'clipping':
        out.byte(typeId | nameFlag | (weighted ? 16 : 0));
        writeName();
        if (!map.end) throw new Error(`clipping ${name} has no end slot`);
        out.varint(lookup(slotIndex, map.end, 'slot'));
        writeVertices(vertices, vertexCount);
        break;
    }
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
    ['path', pathIndex, 'path constraint'],
    ['physics', physicsIndex, 'physics constraint']
  ];
  for (const skin of otherSkins) {
    out.string(skin.name);
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
    out.string(name);
    out.varint(event.int ?? 0, false);
    out.float(event.float ?? 0);
    out.string(event.string ?? '');
    out.string(event.audio ?? null);
    if (event.audio) {
      out.float(event.volume ?? 1);
      out.float(event.balance ?? 0);
    }
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
            const bytes = two ? [...colorBytes(key.light, alpha), ...colorBytes(key.dark, false)] : colorBytes(key.color, alpha);
            for (const b of bytes) o.byte(b);
          });
        }
      }
    }

    const boneGroups = groups(animation.bones, boneIndex, 'bone', (type) => type in BONE_TIMELINES || type === 'inherit');
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
          writeCurveTimeline(o, keys, 2, (key) => {
            o.float(key[names[0]] ?? fallback);
            o.float(key[names[1]] ?? fallback);
          });
        } else {
          writeTimeline1(o, keys, fallback);
        }
      }
    }

    // an ik key packs its booleans and its curve kind into one byte
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
        let flags = 0;
        if (mix !== 0) flags |= 1;
        if (mix !== 0 && mix !== 1) flags |= 2;
        if (softness !== 0) flags |= 4;
        if (key.bendPositive ?? true) flags |= 8;
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
      writeCurveTimeline(o, keys, 6, (key) => {
        const mixX = key.mixX ?? 1;
        const mixScaleX = key.mixScaleX ?? 1;
        for (const v of [key.mixRotate ?? 1, mixX, key.mixY ?? mixX, mixScaleX, key.mixScaleY ?? mixScaleX, key.mixShearY ?? 1]) {
          o.float(v);
        }
      });
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
        if (type === 'mix') {
          writeCurveTimeline(o, keys, 3, (key) => {
            const mixX = key.mixX ?? 1;
            o.float(key.mixRotate ?? 1);
            o.float(mixX);
            o.float(key.mixY ?? mixX);
          });
        } else {
          writeTimeline1(o, keys, 0);
        }
      }
    }

    // an empty constraint name stands for every physics constraint, index 0; the others are their index plus one
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

    const attachmentSkins = Object.entries<Json>(animation.attachments ?? {});
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
              for (const v of vertices) o.float(v);
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
      o.string(key.string ?? null);
      if (data.audio) {
        o.float(key.volume ?? 1);
        o.float(key.balance ?? 0);
      }
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
  head.string(skeleton.spine);
  head.float(skeleton.x ?? 0);
  head.float(skeleton.y ?? 0);
  head.float(skeleton.width ?? 0);
  head.float(skeleton.height ?? 0);
  head.float(skeleton.referenceScale ?? 100);
  head.bool(false);
  head.varint(strings.size);
  for (const text of strings.keys()) head.string(text);

  return Buffer.concat([head.toBuffer(), out.toBuffer()]);
}
