/**
 * A `.blend` as a glTF document in memory, so that `readModel` reads it through the glTF reader.
 *
 * **Why glTF in the middle.** Blender's own exporter writes glTF, and the baker hands a file it
 * cannot read directly to that exporter. Building the same document here means the two routes share
 * every step after it — materials, textures, skins, lights, the flattening into world space — and
 * so cannot drift apart on any of them. It also makes Blender's export of a fixture an independent
 * check on this one: the two documents should say the same thing.
 *
 * **What it refuses** it lists in `refusals`, and `readBlend` declines the whole file: a modifier,
 * a constraint, a rig, a curve. Half a scene is worse than an error, because nobody can see what is
 * missing. **What it approximates** — a node graph glTF cannot hold, animation it does not read —
 * it lists in `approximations` and draws anyway, as Blender's exporter would.
 */

import type { BlendData, BlendStruct } from './blendData.ts';
import type { GltfDocument } from './gltf.ts';
import type { Mat4 } from './blendMatrix.ts';
import { invert, multiply } from './blendMatrix.ts';
import { readBlendMesh } from './blendMesh.ts';
import { cornerNormals } from './blendNormals.ts';
import { meshPrimitives } from './blendGeometry.ts';
import { readBlendSurface } from './blendMaterial.ts';
import type { BlendSurface, ChannelSource } from './blendMaterial.ts';
import { judgeModifiers } from './blendModifiers.ts';
import { OB_ARMATURE, OB_LAMP, OB_MESH, placeObjects } from './blendScene.ts';
import type { BlendPlaced } from './blendScene.ts';

export interface BlendGltf {
  readonly doc: GltfDocument;
  readonly binary: Uint8Array;
  /** What only Blender can evaluate. `readBlend` refuses the file over any of these. */
  readonly refusals: string[];
  /** What Blender's own exporter would do better: animation, a channel glTF needs repacked. */
  readonly approximations: string[];
  /** What glTF cannot hold by either route, said once each. */
  readonly warnings: string[];
  readonly notes: string[];
}

/** Blender Z up to glTF Y up, and back: the basis change Blender's exporter applies. */
const Z_TO_Y: Mat4 = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1];
const Y_TO_Z: Mat4 = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1];
/** A light shines down its local -Z in Blender and in glTF; this keeps it shining the same way. */
const LIGHT_CORRECTION: Mat4 = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1];
const WATTS_TO_LUMENS = 683;
/** `Light.mode`'s bit for a colour taken from a temperature, read off a fixture that sets it. */
const LA_USE_TEMPERATURE = 1 << 24;
const KEYBLOCK_MUTE = 1;

/** Accessors and buffer views over one growing binary chunk. */
class Builder {
  readonly doc: GltfDocument & Required<Pick<GltfDocument, 'accessors' | 'bufferViews'>>;
  private chunks: Uint8Array[] = [];
  private length = 0;

  constructor(doc: GltfDocument) {
    this.doc = { ...doc, accessors: [], bufferViews: [] };
  }

  view(bytes: Uint8Array): number {
    const pad = (4 - (this.length % 4)) % 4;
    if (pad > 0) this.push(new Uint8Array(pad));
    const index = this.doc.bufferViews.length;
    this.doc.bufferViews.push({ buffer: 0, byteOffset: this.length, byteLength: bytes.length });
    this.push(bytes);
    return index;
  }

  accessor(data: Float32Array | Uint32Array, type: 'SCALAR' | 'VEC2' | 'VEC3' | 'VEC4'): number {
    const width = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[type];
    const view = this.view(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    const index = this.doc.accessors.length;
    this.doc.accessors.push({
      bufferView: view,
      componentType: data instanceof Uint32Array ? 5125 : 5126,
      count: data.length / width,
      type,
    });
    return index;
  }

  finish(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    this.doc.buffers = [{ byteLength: this.length }];
    return out;
  }

  private push(bytes: Uint8Array): void {
    this.chunks.push(bytes);
    this.length += bytes.length;
  }
}

/** The bytes a packed image holds, or null where it lives in a file beside the `.blend`. */
export function packedImage(image: BlendStruct): Uint8Array | null {
  const packed = image.has('packedfiles')
    ? image.list('packedfiles')[0]?.deref('packedfile')
    : null;
  const file = packed ?? (image.has('packedfile') ? image.deref('packedfile') : null);
  if (file === null || file === undefined) return null;
  const data = file.raw('data');
  return data === null ? null : data.subarray(0, file.int('size'));
}

/**
 * Whether an image stores one channel: a grey PNG, or a JPEG of one component. An image that is not
 * packed cannot be looked at here and is taken to be grey, which is what a scalar map usually is.
 */
export function isGreyImage(image: BlendStruct): boolean {
  const bytes = packedImage(image);
  if (bytes === null) return true;
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return bytes[25] === 0 || bytes[25] === 4;
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    for (let at = 2; at + 9 < bytes.length;) {
      if (bytes[at] !== 0xff) return false;
      const marker = bytes[at + 1] as number;
      const length = ((bytes[at + 2] as number) << 8) | (bytes[at + 3] as number);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
        return bytes[at + 9] === 1;
      at += 2 + length;
    }
  }
  return false;
}

/** A packed image's media type, from its first bytes. */
export function imageMime(bytes: Uint8Array): string | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x52 && bytes[8] === 0x57 && bytes[9] === 0x45) return 'image/webp';
  return null;
}

/** Where an unpacked image lives, relative to the `.blend` when Blender wrote it that way. */
export function imagePath(image: BlendStruct): string {
  const path = image.string('name');
  return path.startsWith('//') ? path.slice(2) : path;
}

/** What `blendToGltf` reads, where the whole open scene is not wanted. */
export interface BlendGltfOptions {
  /**
   * One object alone at the origin rather than the scene: a bake that keeps a world's instancing
   * converts each distinct mesh once this way and places the copies itself.
   */
  readonly only?: BlendStruct;
  /**
   * Name each image by `imageUri` rather than carrying its bytes. A bake converting thousands of
   * objects that share a few thousand images reads each image once, itself, rather than once a
   * document.
   */
  readonly imageUri?: (image: BlendStruct) => string;
}

/** Build the document. */
export function blendToGltf(blend: BlendData, options: BlendGltfOptions = {}): BlendGltf {
  const refusals: string[] = [];
  const approximations: string[] = [];
  const warnings: string[] = [];
  const notes: string[] = [];
  const only = options.only;
  const placed: BlendPlaced[] =
    only === undefined
      ? placeObjects(blend, refusals, () => null)
      : [
          {
            object: only,
            name: only.idName(),
            kind: only.int('type'),
            world: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
            parent: -1,
          },
        ];
  const builder = new Builder({
    asset: { version: '2.0', generator: 'DriftEngine .blend reader' },
  });
  const doc = builder.doc;
  doc.nodes = [];
  doc.meshes = [];
  doc.materials = [];
  doc.textures = [];
  doc.images = [];
  const lights: Record<string, unknown>[] = [];
  const used = new Set<string>();

  const imageIndex = new Map<number, number>();
  const textureOf = (image: BlendStruct): number => {
    const known = imageIndex.get(image.offset);
    if (known !== undefined) return known;
    const bytes = packedImage(image);
    const name = image.idName();
    const source = image.int('source');
    if (bytes === null && source === 4)
      approximations.push(
        `image "${name}" is generated by Blender and not packed, so it is drawn without`,
      );
    if (source === 6)
      approximations.push(`image "${name}" is tiled across UDIMs, and only its first tile is read`);
    const entry: { name: string; uri?: string; bufferView?: number; mimeType?: string } = { name };
    if (options.imageUri !== undefined) entry.uri = options.imageUri(image);
    else if (bytes !== null) {
      const mime = imageMime(bytes);
      if (mime === null)
        approximations.push(
          `image "${name}" is in a format the engine does not decode, which Blender's exporter converts`,
        );
      entry.bufferView = builder.view(bytes);
      entry.mimeType = mime ?? 'application/octet-stream';
    } else entry.uri = imagePath(image).split('/').map(encodeURIComponent).join('/');
    const index = (doc.images as unknown[]).length;
    (doc.images as unknown[]).push(entry);
    (doc.textures as unknown[]).push({ source: index });
    imageIndex.set(image.offset, index);
    return index;
  };

  const surfaces = new Map<number, BlendSurface>();
  const materialIndex = new Map<number, number>();
  const surfaceOf = (material: BlendStruct): BlendSurface => {
    let surface = surfaces.get(material.offset);
    if (surface === undefined) {
      surface = readBlendSurface(material, blend.header.version);
      surfaces.set(material.offset, surface);
      warnings.push(...surface.approximations);
    }
    return surface;
  };
  const gltfMaterial = (material: BlendStruct): number => {
    const known = materialIndex.get(material.offset);
    if (known !== undefined) return known;
    const json = surfaceToGltf(surfaceOf(material), textureOf, approximations);
    const index = (doc.materials as unknown[]).length;
    (doc.materials as unknown[]).push(json);
    materialIndex.set(material.offset, index);
    if (json.extensions !== undefined)
      for (const name of Object.keys(json.extensions)) used.add(name);
    return index;
  };

  const meshCache = new Map<string, number>();
  const worlds: Mat4[] = placed.map((p) => {
    const world = multiply(multiply(Z_TO_Y, p.world), Y_TO_Z);
    return p.kind === OB_LAMP ? multiply(world, LIGHT_CORRECTION) : world;
  });

  placed.forEach((p, i) => {
    const node: Record<string, unknown> = { name: p.name };
    const parentWorld = p.parent >= 0 ? (worlds[p.parent] as Mat4) : null;
    node['matrix'] =
      parentWorld === null ? worlds[i] : multiply(invert(parentWorld), worlds[i] as Mat4);
    if (p.kind === OB_ARMATURE)
      refusals.push(`"${p.name}" is an armature, and the direct reader does not read rigs yet`);
    if (p.object.has('adt') && p.object.ptr('adt') !== 0n)
      approximations.push(
        `"${p.name}" is animated, and the direct reader draws the frame it was saved on`,
      );
    if (p.kind === OB_MESH) {
      const mesh = meshOf(p, blend, refusals, warnings, gltfMaterial, builder, meshCache);
      if (mesh !== null) node['mesh'] = mesh;
    } else if (p.kind === OB_LAMP) {
      const light = lightOf(p, warnings);
      if (light !== null) {
        node['extensions'] = { KHR_lights_punctual: { light: lights.length } };
        lights.push(light);
      }
    }
    (doc.nodes as unknown[]).push(node);
  });
  placed.forEach((p, i) => {
    if (p.parent < 0) return;
    const parent = (doc.nodes as Record<string, unknown>[])[p.parent] as Record<string, unknown>;
    parent['children'] = [...((parent['children'] as number[] | undefined) ?? []), i];
  });
  doc.scenes = [{ nodes: placed.map((p, i) => (p.parent < 0 ? i : -1)).filter((i) => i >= 0) }];
  doc.scene = 0;
  if (lights.length > 0) {
    doc.extensions = { KHR_lights_punctual: { lights } };
    used.add('KHR_lights_punctual');
  }
  if (used.size > 0) doc.extensionsUsed = [...used];
  notes.push(
    `blend: Blender ${blend.header.version}, ${placed.length} objects, ${(doc.meshes as unknown[]).length} meshes, ${(doc.materials as unknown[]).length} materials.`,
  );
  return {
    doc,
    binary: builder.finish(),
    refusals: [...new Set(refusals)],
    approximations: [...new Set(approximations)],
    warnings: [...new Set(warnings)],
    notes,
  };
}

function meshOf(
  p: BlendPlaced,
  blend: BlendData,
  refusals: string[],
  approximations: string[],
  gltfMaterial: (material: BlendStruct) => number,
  builder: Builder,
  cache: Map<string, number>,
): number | null {
  const data = p.object.deref('data');
  if (data === null) return null;
  const verdict = judgeModifiers(p.object);
  refusals.push(...verdict.refusals);
  if (verdict.refusals.length > 0) return null;
  const slots = materialSlots(p.object, data);
  const key = `${data.offset}:${verdict.splitAngle}:${slots.map((s) => s?.offset ?? 0).join(',')}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const mesh = readBlendMesh(blend, data);
  const normals = cornerNormals(mesh, verdict.splitAngle ?? mesh.autoSmooth);
  const surfaces = slots.map((material) =>
    material === null ? null : readBlendSurface(material, blend.header.version),
  );
  const primitives = meshPrimitives(mesh, normals, slots.length, (slot) => {
    const surface = surfaces[slot] ?? null;
    return {
      vertexColor: surface?.vertexColor ?? null,
      uvMap: surface?.uvMap ?? null,
      uvTransform: surface?.uvTransform ?? null,
    };
  });
  const keys = shapeKeys(data, mesh.positions.length / 3);
  if (keys.some((k) => k.vgroup !== ''))
    approximations.push(
      `mesh "${mesh.name}" has a shape key limited to a vertex group, which glTF cannot limit`,
    );
  const gltfPrimitives = primitives.map((primitive) => {
    const attributes: Record<string, number> = {
      POSITION: builder.accessor(primitive.positions, 'VEC3'),
      NORMAL: builder.accessor(primitive.normals, 'VEC3'),
    };
    if (primitive.uvs !== null) attributes['TEXCOORD_0'] = builder.accessor(primitive.uvs, 'VEC2');
    if (primitive.colors !== null)
      attributes['COLOR_0'] = builder.accessor(primitive.colors, 'VEC4');
    const out: Record<string, unknown> = {
      attributes,
      indices: builder.accessor(primitive.indices, 'SCALAR'),
      mode: 4,
    };
    const material = primitive.slot >= 0 ? slots[primitive.slot] : null;
    if (material !== null && material !== undefined) out['material'] = gltfMaterial(material);
    if (keys.length > 0) {
      out['targets'] = keys.map((key) => {
        const delta = new Float32Array(primitive.positions.length);
        const normalDelta = new Float32Array(primitive.positions.length);
        const shaped = cornerNormals(
          { ...mesh, positions: key.positions },
          verdict.splitAngle ?? mesh.autoSmooth,
        );
        for (let e = 0; e < primitive.sourceVertex.length; e++) {
          const v = primitive.sourceVertex[e] as number;
          const c = primitive.sourceCorner[e] as number;
          const d = [0, 1, 2].map(
            (k) => (key.positions[v * 3 + k] as number) - (key.reference[v * 3 + k] as number),
          );
          delta.set([d[0] as number, d[2] as number, -(d[1] as number)], e * 3);
          const n = [0, 1, 2].map(
            (k) => (shaped[c * 3 + k] as number) - (normals[c * 3 + k] as number),
          );
          normalDelta.set([n[0] as number, n[2] as number, -(n[1] as number)], e * 3);
        }
        return {
          POSITION: builder.accessor(delta, 'VEC3'),
          NORMAL: builder.accessor(normalDelta, 'VEC3'),
        };
      });
    }
    return out;
  });
  const meshes = builder.doc.meshes as Record<string, unknown>[];
  const entry: Record<string, unknown> = { name: mesh.name, primitives: gltfPrimitives };
  if (keys.length > 0) {
    entry['weights'] = keys.map((k) => k.weight);
    entry['extras'] = { targetNames: keys.map((k) => k.name) };
  }
  meshes.push(entry);
  cache.set(key, meshes.length - 1);
  return meshes.length - 1;
}

/** An object's material slots: the object's own material where its slot says so, else the mesh's. */
export function materialSlots(object: BlendStruct, mesh: BlendStruct): (BlendStruct | null)[] {
  const count = Math.max(object.int('totcol'), mesh.int('totcol'));
  const own = object.int('totcol') > 0 ? object.pointers('mat', object.int('totcol')) : [];
  const shared = mesh.int('totcol') > 0 ? mesh.pointers('mat', mesh.int('totcol')) : [];
  const bits = object.int('totcol') > 0 ? object.raw('matbits') : null;
  const out: (BlendStruct | null)[] = [];
  for (let i = 0; i < count; i++) {
    const useObject = bits !== null && (bits[i] ?? 0) !== 0;
    const address = useObject ? own[i] : shared[i];
    out.push(
      address === undefined || address === 0n
        ? null
        : (useObject ? object : mesh).file.at(address, (useObject ? object : mesh).scope),
    );
  }
  return out;
}

interface ShapeKey {
  readonly name: string;
  readonly weight: number;
  readonly positions: Float32Array;
  readonly reference: Float32Array;
  readonly vgroup: string;
}

/** The mesh's shape keys other than its basis, each with the key it is relative to. */
function shapeKeys(mesh: BlendStruct, verts: number): ShapeKey[] {
  const key = mesh.deref('key');
  if (key === null) return [];
  const blocks = key.list('block');
  const read = (block: BlendStruct): Float32Array => {
    const raw = block.raw('data');
    const out = new Float32Array(verts * 3);
    if (raw === null) return out;
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const le = block.file.header.littleEndian;
    for (let i = 0; i < Math.min(verts * 3, raw.length / 4); i++)
      out[i] = view.getFloat32(i * 4, le);
    return out;
  };
  const basis = key.ptr('refkey');
  const out: ShapeKey[] = [];
  const cache = new Map<number, Float32Array>();
  const data = (index: number): Float32Array => {
    let found = cache.get(index);
    if (found === undefined) cache.set(index, (found = read(blocks[index] as BlendStruct)));
    return found;
  };
  blocks.forEach((block, index) => {
    if (block.offset === key.file.at(basis, key.scope)?.offset) return;
    if ((block.int('flag') & KEYBLOCK_MUTE) !== 0) return;
    const relative = Math.max(0, Math.min(blocks.length - 1, block.int('relative')));
    if (relative === index) return;
    out.push({
      name: block.string('name'),
      weight: block.float('curval'),
      positions: data(index),
      reference: data(relative),
      vgroup: block.string('vgroup'),
    });
  });
  return out;
}

function lightOf(p: BlendPlaced, warnings: string[]): Record<string, unknown> | null {
  const lamp = p.object.deref('data');
  if (lamp === null) return null;
  const type = lamp.int('type');
  const exposure = lamp.has('exposure') ? 2 ** lamp.float('exposure') : 1;
  let color = [lamp.float('r'), lamp.float('g'), lamp.float('b')];
  if (
    lamp.has('mode') &&
    lamp.has('temperature') &&
    (lamp.int('mode') & LA_USE_TEMPERATURE) !== 0
  ) {
    const warmth = blackbody(lamp.float('temperature'));
    color = color.map((c, i) => c * (warmth[i] as number));
  }
  if (type === 1)
    return {
      type: 'directional',
      name: p.name,
      color,
      intensity: lamp.float('energy') * WATTS_TO_LUMENS * exposure,
    };
  const intensity = (lamp.float('energy') / (4 * Math.PI)) * WATTS_TO_LUMENS * exposure;
  if (type === 0) return { type: 'point', name: p.name, color, intensity };
  if (type === 2) {
    const outer = lamp.float('spotsize') / 2;
    return {
      type: 'spot',
      name: p.name,
      color,
      intensity,
      spot: { innerConeAngle: outer - outer * lamp.float('spotblend'), outerConeAngle: outer },
    };
  }
  warnings.push(`light "${p.name}" is an area light, which glTF cannot express, so it is left out`);
  return null;
}

/**
 * The colour of a black body at `kelvin`, in linear Rec. 709, scaled to unit luminance: what
 * Blender multiplies a light's colour by when the light takes its colour from a temperature.
 *
 * Planck's law through the CIE 1931 observer, by the multi-lobe fit of Wyman, Sloan and Shirley.
 * **Within 1% of Blender's table, not equal to it**: Blender's is fitted per range to its own colour
 * configuration, and at 3000 K reads (1.771, 0.844, 0.272) where this reads (1.752, 0.850, 0.271).
 */
export function blackbody(kelvin: number): [number, number, number] {
  const lobe = (x: number, mean: number, left: number, right: number): number => {
    const t = (x - mean) * (x < mean ? left : right);
    return Math.exp(-0.5 * t * t);
  };
  const h = 6.62607015e-34;
  const c = 2.99792458e8;
  const k = 1.380649e-23;
  const t = Math.min(40000, Math.max(800, kelvin));
  let x = 0;
  let y = 0;
  let z = 0;
  for (let nm = 360; nm <= 830; nm++) {
    const m = nm * 1e-9;
    const radiance = (2 * h * c * c) / m ** 5 / (Math.exp((h * c) / (m * k * t)) - 1);
    x +=
      radiance *
      (1.056 * lobe(nm, 599.8, 0.0264, 0.0323) +
        0.362 * lobe(nm, 442.0, 0.0624, 0.0374) -
        0.065 * lobe(nm, 501.1, 0.049, 0.0382));
    y +=
      radiance *
      (0.821 * lobe(nm, 568.8, 0.0213, 0.0247) + 0.286 * lobe(nm, 530.9, 0.0613, 0.0322));
    z +=
      radiance *
      (1.217 * lobe(nm, 437.0, 0.0845, 0.0278) + 0.681 * lobe(nm, 459.0, 0.0385, 0.0725));
  }
  const r = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
  const g = -0.969266 * x + 1.8760108 * y + 0.041556 * z;
  const b = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return [r / luminance, g / luminance, b / luminance];
}

/** A surface as a glTF material, packing what glTF packs and naming what it cannot. */
function surfaceToGltf(
  surface: BlendSurface,
  texture: (image: BlendStruct) => number,
  approximations: string[],
): Record<string, unknown> & { extensions?: Record<string, unknown> } {
  const note = (what: string): void => {
    approximations.push(`material "${surface.name}": ${what}`);
  };
  const pbr: Record<string, unknown> = {
    baseColorFactor: [...surface.baseColor, surface.alpha],
    metallicFactor: surface.metallic,
    roughnessFactor: surface.roughness,
  };
  const out: Record<string, unknown> & { extensions?: Record<string, unknown> } = {
    name: surface.name,
    pbrMetallicRoughness: pbr,
  };
  if (surface.baseColorMap !== null)
    pbr['baseColorTexture'] = { index: texture(surface.baseColorMap.image) };
  if (
    surface.alphaMap !== null &&
    (surface.alphaMap.channel !== 'a' ||
      surface.alphaMap.image.offset !== surface.baseColorMap?.image.offset)
  ) {
    note('its alpha comes from a different image than its colour, which glTF cannot hold apart');
  }
  const packed = [surface.roughnessMap, surface.metallicMap].filter(
    (m): m is ChannelSource => m !== null,
  );
  if (packed.length > 0) {
    const image = (packed[0] as ChannelSource).image;
    if (packed.some((m) => m.image.offset !== image.offset))
      note('its roughness and metallic come from two images, and glTF packs them into one');
    /* A grey image has the same value in every channel, so which one a socket reads changes nothing. */
    const grey = isGreyImage(image);
    if (!grey && surface.roughnessMap !== null && surface.roughnessMap.channel !== 'g')
      note(
        `its roughness is read from the ${surface.roughnessMap.channel} channel where glTF reads green`,
      );
    if (!grey && surface.metallicMap !== null && surface.metallicMap.channel !== 'b')
      note(
        `its metallic is read from the ${surface.metallicMap.channel} channel where glTF reads blue`,
      );
    /* A map for one of the pair only: glTF multiplies the other's factor by the same image, so the
       pair is exact only where that other factor is zero. */
    if (surface.metallicMap === null && surface.metallic !== 0)
      note(
        'its roughness has a map and its metallic does not, and glTF multiplies one image into both',
      );
    pbr['metallicRoughnessTexture'] = { index: texture(image) };
  }
  if (surface.occlusionMap !== null)
    out['occlusionTexture'] = { index: texture(surface.occlusionMap.image) };
  if (surface.normalMap !== null)
    out['normalTexture'] = {
      index: texture(surface.normalMap.image),
      scale: surface.normalStrength,
    };
  const emitted = surface.emission.map((c) => c * surface.emissionStrength);
  if (
    (surface.emissionMap !== null || emitted.some((c) => c > 0)) &&
    surface.emissionStrength > 0
  ) {
    if (Math.max(...emitted) > 1) {
      out['emissiveFactor'] = [...surface.emission];
      out.extensions = {
        ...out.extensions,
        KHR_materials_emissive_strength: { emissiveStrength: surface.emissionStrength },
      };
    } else out['emissiveFactor'] = emitted;
    if (surface.emissionMap !== null)
      out['emissiveTexture'] = { index: texture(surface.emissionMap.image) };
  }
  if (surface.transmission > 0)
    out.extensions = {
      ...out.extensions,
      KHR_materials_transmission: { transmissionFactor: surface.transmission },
    };
  if (surface.alphaMode !== 'OPAQUE') out['alphaMode'] = surface.alphaMode;
  if (surface.alphaMode === 'MASK' && surface.alphaCutoff !== 0.5)
    out['alphaCutoff'] = surface.alphaCutoff;
  if (surface.doubleSided) out['doubleSided'] = true;
  if (surface.extras !== null) out['extras'] = surface.extras;
  return out;
}
