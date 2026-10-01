/**
 * A `.blend` mesh's stored data, read the same way whichever Blender wrote it.
 *
 * **Three layouts, one result.** Until 3.4 a mesh was arrays of structs — `MVert`, `MEdge`,
 * `MPoly`, `MLoop` — with UVs and colours in `CustomData` layers beside them. From 3.5 to 4.x the
 * same data became named attributes in `CustomData`: `position`, `.edge_verts`, `.corner_vert`,
 * `sharp_face`. From 5.0 the attributes moved again, into `AttributeStorage`, with a type code of
 * their own. Each is read here into `BlendMeshData`, which is plain arrays and knows nothing about
 * where they came from.
 *
 * **What is read is what is stored.** Nothing is evaluated: a mesh with modifiers is the mesh
 * before them, and `blend.ts` refuses such a file rather than drawing the wrong shape.
 *
 * **Old meaning is translated to current meaning**, because the comparison is with Blender as it
 * is now opening the file. Before 4.1 a sharp edge did nothing unless the mesh had auto smooth on,
 * and Blender drops those edges when it opens such a file; with auto smooth on, it adds a modifier
 * that splits by angle, which is exactly the angle this reader applies.
 */

import { DrftError } from '@driftengine/drft';
import type { BlendData, BlendStruct } from './blendData.ts';

/** Domains, in the order both of Blender's attribute systems number them. */
export const POINT = 0;
export const EDGE = 1;
export const FACE = 2;
export const CORNER = 3;

export interface BlendColorLayer {
  readonly name: string;
  readonly domain: typeof POINT | typeof CORNER;
  /** RGBA per element, linear. A byte colour is stored sRGB-encoded and decoded here. */
  readonly rgba: Float32Array;
}

export interface BlendMeshData {
  readonly name: string;
  readonly positions: Float32Array;
  /** Face `f` owns corners `faceOffsets[f]` to `faceOffsets[f + 1]`. */
  readonly faceOffsets: Int32Array;
  readonly cornerVerts: Int32Array;
  readonly cornerEdges: Int32Array;
  readonly edgeVerts: Int32Array;
  readonly materialIndex: Int32Array | null;
  readonly sharpFace: Uint8Array | null;
  readonly sharpEdge: Uint8Array | null;
  /** UV maps in the file's order, two floats per corner. */
  readonly uvs: readonly { name: string; uv: Float32Array }[];
  /** Which UV map renders when a texture names none: Blender's "active render" map. */
  readonly renderUv: number;
  readonly colors: readonly BlendColorLayer[];
  /** The colour attribute a material's unnamed Color Attribute node reads. */
  readonly renderColor: number;
  /** Custom normals in Blender's packed form: two shorts per corner, relative to its fan. */
  readonly packedNormals: Int16Array | null;
  /** Custom normals stored as plain vectors, 4.5 on, in the domain they were written to. */
  readonly freeNormals: { domain: number; normals: Float32Array } | null;
  /** The split angle a pre-4.1 file's auto smooth asked for, or null where it was off. */
  readonly autoSmooth: number | null;
  /** Per vertex, the groups it belongs to and how much: flattened `(group, weight)` pairs. */
  readonly weights: { offsets: Int32Array; groups: Int32Array; values: Float32Array } | null;
  readonly groupNames: readonly string[];
}

/** One stored attribute, before it is interpreted. */
interface RawAttribute {
  readonly name: string;
  readonly domain: number;
  readonly kind: AttributeKind;
  readonly bytes: Uint8Array;
  /** One value for every element, which `AttributeStorage` can store instead of an array. */
  readonly single: boolean;
}

type AttributeKind =
  | 'bool'
  | 'int8'
  | 'short2'
  | 'int'
  | 'int2'
  | 'float'
  | 'float2'
  | 'float3'
  | 'byteColor'
  | 'color'
  | 'other';

/** `CustomData` layer types, by the number a 2.8-to-4.x file stores. */
const CD_KINDS: Record<number, AttributeKind> = {
  10: 'float',
  11: 'int',
  17: 'byteColor',
  41: 'short2',
  45: 'int8',
  46: 'int2',
  47: 'color',
  48: 'float3',
  49: 'float2',
  50: 'bool',
};

/**
 * `AttributeStorage` types, 5.0 on: Blender's `AttrType` in declaration order. Read off fixtures
 * rather than assumed: a byte colour attribute is stored as 9, four bytes an element, so the float
 * colour before it is 8.
 */
const STORAGE_KINDS: readonly AttributeKind[] = [
  'bool',
  'int8',
  'short2',
  'int',
  'int2',
  'float',
  'float2',
  'float3',
  'color',
  'byteColor',
];

const ELEMENT_BYTES: Record<AttributeKind, number> = {
  bool: 1,
  int8: 1,
  short2: 4,
  int: 4,
  int2: 8,
  float: 4,
  float2: 8,
  float3: 12,
  byteColor: 4,
  color: 16,
  other: 0,
};

const ME_AUTOSMOOTH = 1 << 5;
const ME_SMOOTH = 1;
const ME_SHARP = 1 << 9;
const CD_MVERT = 0;
const CD_MDEFORMVERT = 2;
const CD_MEDGE = 3;
const CD_MLOOPUV = 16;
const CD_MLOOPCOL = 17;
const CD_MPOLY = 25;
const CD_MLOOP = 26;

function counts(mesh: BlendStruct): [number, number, number, number] {
  const get = (...names: string[]): number => {
    for (const name of names) if (mesh.has(name)) return mesh.int(name);
    return 0;
  };
  return [
    get('totvert', 'verts_num'),
    get('totedge', 'edges_num'),
    get('totpoly', 'faces_num'),
    get('totloop', 'corners_num'),
  ];
}

function rawAttributes(mesh: BlendStruct): RawAttribute[] {
  const out: RawAttribute[] = [];
  const sizes = counts(mesh);
  if (mesh.has('attribute_storage')) {
    const storage = mesh.sub('attribute_storage');
    const list = storage.array('dna_attributes', 'Attribute', storage.int('dna_attributes_num'));
    for (const attribute of list) {
      const kind = STORAGE_KINDS[attribute.int('data_type')] ?? 'other';
      const single = attribute.int('storage_type') !== 0;
      const holder = attribute.deref('data', single ? 'AttributeSingle' : 'AttributeArray');
      const bytes = holder?.raw('data');
      if (bytes === null || bytes === undefined) continue;
      out.push({
        name: attribute.text('name'),
        domain: attribute.int('domain'),
        kind,
        bytes,
        single,
      });
    }
  }
  const layers = ['vdata', 'edata', 'pdata', 'ldata'];
  layers.forEach((field, domain) => {
    if (!mesh.has(field)) return;
    const data = mesh.sub(field);
    for (const layer of data.array('layers', 'CustomDataLayer', data.int('totlayer'))) {
      const kind = CD_KINDS[layer.int('type')];
      const bytes = layer.raw('data');
      if (kind === undefined || bytes === null) continue;
      const need = (sizes[domain] ?? 0) * ELEMENT_BYTES[kind];
      if (bytes.length < need) continue;
      out.push({ name: layer.string('name'), domain, kind, bytes, single: false });
    }
  });
  return out;
}

/** A `CustomData` layer of a legacy struct type, as the views of its elements. */
function legacyLayer(
  mesh: BlendStruct,
  field: string,
  type: number,
  struct: string,
  count: number,
): BlendStruct[] {
  if (!mesh.has(field)) return [];
  const data = mesh.sub(field);
  for (const layer of data.array('layers', 'CustomDataLayer', data.int('totlayer'))) {
    if (layer.int('type') === type) return layer.array('data', struct, count);
  }
  return [];
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function readFloats(
  attribute: RawAttribute,
  count: number,
  width: number,
  le: boolean,
): Float32Array {
  const out = new Float32Array(count * width);
  const data = view(attribute.bytes);
  for (let i = 0; i < count; i++) {
    const at = attribute.single ? 0 : i * width * 4;
    for (let k = 0; k < width; k++) out[i * width + k] = data.getFloat32(at + k * 4, le);
  }
  return out;
}

function readInts(attribute: RawAttribute, count: number, width: number, le: boolean): Int32Array {
  const out = new Int32Array(count * width);
  const data = view(attribute.bytes);
  for (let i = 0; i < count; i++) {
    const at = attribute.single ? 0 : i * width * 4;
    for (let k = 0; k < width; k++) out[i * width + k] = data.getInt32(at + k * 4, le);
  }
  return out;
}

function readBools(attribute: RawAttribute, count: number): Uint8Array {
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++)
    out[i] = (attribute.single ? attribute.bytes[0] : attribute.bytes[i]) === 0 ? 0 : 1;
  return out;
}

const srgbToLinear = (byte: number): number => {
  const c = byte / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** Read a mesh datablock into plain arrays. */
export function readBlendMesh(blend: BlendData, mesh: BlendStruct): BlendMeshData {
  const le = blend.header.littleEndian;
  const [verts, edges, faces, corners] = counts(mesh);
  const name = mesh.idName();
  if (faces === 0 && mesh.has('totface') && mesh.int('totface') > 0) {
    throw new DrftError(
      `blend: mesh "${name}" stores only tessellated faces, which predates Blender 2.63`,
    );
  }
  const attributes = rawAttributes(mesh);
  const named = (attribute: string, domain: number): RawAttribute | undefined =>
    attributes.find((a) => a.name === attribute && a.domain === domain);

  let positions: Float32Array;
  const position = named('position', POINT);
  if (position !== undefined) positions = readFloats(position, verts, 3, le);
  else {
    positions = new Float32Array(verts * 3);
    const mvert = mesh.has('mvert')
      ? mesh.array('mvert', 'MVert', verts)
      : legacyLayer(mesh, 'vdata', CD_MVERT, 'MVert', verts);
    mvert.forEach((v, i) => positions.set(v.floats('co'), i * 3));
  }

  let edgeVerts: Int32Array;
  const edgeAttr = named('.edge_verts', EDGE);
  let legacySharp: Uint8Array | null = null;
  if (edgeAttr !== undefined) edgeVerts = readInts(edgeAttr, edges, 2, le);
  else {
    edgeVerts = new Int32Array(edges * 2);
    const medge = mesh.has('medge')
      ? mesh.array('medge', 'MEdge', edges)
      : legacyLayer(mesh, 'edata', CD_MEDGE, 'MEdge', edges);
    if (medge.length > 0 && medge[0]?.has('flag') === true) legacySharp = new Uint8Array(edges);
    medge.forEach((e, i) => {
      edgeVerts[i * 2] = e.int('v1');
      edgeVerts[i * 2 + 1] = e.int('v2');
      if (legacySharp !== null) legacySharp[i] = (e.int('flag') & ME_SHARP) !== 0 ? 1 : 0;
    });
  }

  const faceOffsets = new Int32Array(faces + 1);
  let legacyFlat: Uint8Array | null = null;
  let legacyMaterial: Int32Array | null = null;
  if (mesh.has('poly_offset_indices') && mesh.ptr('poly_offset_indices') !== 0n) {
    const raw = mesh.raw('poly_offset_indices');
    if (raw === null)
      throw new DrftError(`blend: mesh "${name}" names face offsets it does not store`);
    const data = view(raw);
    for (let i = 0; i <= faces; i++) faceOffsets[i] = data.getInt32(i * 4, le);
  } else {
    const mpoly = mesh.has('mpoly')
      ? mesh.array('mpoly', 'MPoly', faces)
      : legacyLayer(mesh, 'pdata', CD_MPOLY, 'MPoly', faces);
    legacyFlat = new Uint8Array(faces);
    legacyMaterial = new Int32Array(faces);
    let total = 0;
    mpoly.forEach((p, i) => {
      faceOffsets[i] = p.int('loopstart');
      total = p.int('loopstart') + p.int('totloop');
      (legacyFlat as Uint8Array)[i] = (p.int('flag') & ME_SMOOTH) === 0 ? 1 : 0;
      (legacyMaterial as Int32Array)[i] = p.int('mat_nr');
    });
    faceOffsets[faces] = total;
  }

  let cornerVerts: Int32Array;
  let cornerEdges: Int32Array;
  const cv = named('.corner_vert', CORNER);
  const ce = named('.corner_edge', CORNER);
  if (cv !== undefined && ce !== undefined) {
    cornerVerts = readInts(cv, corners, 1, le);
    cornerEdges = readInts(ce, corners, 1, le);
  } else {
    cornerVerts = new Int32Array(corners);
    cornerEdges = new Int32Array(corners);
    const mloop = mesh.has('mloop')
      ? mesh.array('mloop', 'MLoop', corners)
      : legacyLayer(mesh, 'ldata', CD_MLOOP, 'MLoop', corners);
    mloop.forEach((l, i) => {
      cornerVerts[i] = l.int('v');
      cornerEdges[i] = l.int('e');
    });
  }
  if (cornerVerts.length !== corners || faceOffsets[faces] !== corners) {
    throw new DrftError(`blend: mesh "${name}" does not store the corners its faces name`);
  }

  const materialAttr = named('material_index', FACE);
  const materialIndex =
    materialAttr !== undefined ? readInts(materialAttr, faces, 1, le) : legacyMaterial;
  const flatAttr = named('sharp_face', FACE);
  const sharpFace = flatAttr !== undefined ? readBools(flatAttr, faces) : legacyFlat;
  const flag = mesh.has('flag') ? mesh.int('flag') : 0;
  const autoSmooth =
    blend.header.version < 401 && (flag & ME_AUTOSMOOTH) !== 0 && mesh.has('smoothresh')
      ? mesh.float('smoothresh')
      : null;
  const sharpAttr = named('sharp_edge', EDGE);
  const sharpEdge = sharpAttr !== undefined ? readBools(sharpAttr, edges) : legacySharp;

  const uvs: { name: string; uv: Float32Array }[] = [];
  for (const a of attributes) {
    if (a.kind === 'float2' && a.domain === CORNER && !a.name.startsWith('.')) {
      uvs.push({ name: a.name, uv: readFloats(a, corners, 2, le) });
    }
  }
  if (uvs.length === 0 && mesh.has('ldata')) {
    const data = mesh.sub('ldata');
    for (const layer of data.array('layers', 'CustomDataLayer', data.int('totlayer'))) {
      if (layer.int('type') !== CD_MLOOPUV) continue;
      const uv = new Float32Array(corners * 2);
      layer.array('data', 'MLoopUV', corners).forEach((l, i) => uv.set(l.floats('uv'), i * 2));
      uvs.push({ name: layer.string('name'), uv });
    }
  }

  const colors: BlendColorLayer[] = [];
  for (const a of attributes) {
    if (
      (a.kind !== 'color' && a.kind !== 'byteColor') ||
      (a.domain !== POINT && a.domain !== CORNER)
    )
      continue;
    const count = a.domain === POINT ? verts : corners;
    const rgba = new Float32Array(count * 4);
    if (a.kind === 'color') rgba.set(readFloats(a, count, 4, le));
    else {
      for (let i = 0; i < count; i++) {
        const at = a.single ? 0 : i * 4;
        for (let k = 0; k < 3; k++) rgba[i * 4 + k] = srgbToLinear(a.bytes[at + k] ?? 0);
        rgba[i * 4 + 3] = (a.bytes[at + 3] ?? 255) / 255;
      }
    }
    colors.push({ name: a.name, domain: a.domain, rgba });
  }
  if (colors.length === 0 && !attributes.some((a) => a.kind === 'byteColor') && mesh.has('ldata')) {
    const data = mesh.sub('ldata');
    for (const layer of data.array('layers', 'CustomDataLayer', data.int('totlayer'))) {
      if (layer.int('type') !== CD_MLOOPCOL) continue;
      const rgba = new Float32Array(corners * 4);
      layer.array('data', 'MLoopCol', corners).forEach((l, i) => {
        rgba[i * 4] = srgbToLinear(l.int('r'));
        rgba[i * 4 + 1] = srgbToLinear(l.int('g'));
        rgba[i * 4 + 2] = srgbToLinear(l.int('b'));
        rgba[i * 4 + 3] = l.int('a') / 255;
      });
      colors.push({ name: layer.string('name'), domain: CORNER, rgba });
    }
  }

  let packedNormals: Int16Array | null = null;
  let freeNormals: { domain: number; normals: Float32Array } | null = null;
  for (const a of attributes) {
    if (
      a.kind === 'short2' &&
      a.domain === CORNER &&
      (a.name === 'custom_normal' || a.name === '')
    ) {
      packedNormals = new Int16Array(corners * 2);
      const data = view(a.bytes);
      for (let i = 0; i < corners * 2; i++)
        packedNormals[i] = data.getInt16(a.single ? (i % 2) * 2 : i * 2, le);
    }
    if (a.kind === 'float3' && a.name === 'custom_normal') {
      const count = [verts, edges, faces, corners][a.domain] ?? 0;
      freeNormals = { domain: a.domain, normals: readFloats(a, count, 3, le) };
    }
  }

  /*
   * The active render maps. 5.0 names them on the mesh; before it, the first layer of a type
   * carries the index among its kind in `active_rnd`.
   */
  const named5 = (field: string): string | null =>
    mesh.has(field) && mesh.ptr(field) !== 0n ? mesh.text(field) : null;
  const activeIndex = (type: number): number => {
    if (!mesh.has('ldata')) return 0;
    const data = mesh.sub('ldata');
    const first = data
      .array('layers', 'CustomDataLayer', data.int('totlayer'))
      .find((l) => l.int('type') === type);
    return first?.has('active_rnd') === true ? first.int('active_rnd') : 0;
  };
  const uvName = named5('default_uv_map_attribute');
  let renderUv = uvName === null ? -1 : uvs.findIndex((u) => u.name === uvName);
  if (renderUv < 0)
    renderUv = Math.min(
      activeIndex(position !== undefined ? 49 : CD_MLOOPUV),
      Math.max(0, uvs.length - 1),
    );
  const colorName = named5('default_color_attribute');
  let renderColor = colorName === null ? -1 : colors.findIndex((c) => c.name === colorName);
  if (renderColor < 0) renderColor = 0;

  const groupNames: string[] = [];
  const groupList = mesh.has('vertex_group_names') ? mesh.list('vertex_group_names') : [];
  for (const group of groupList) groupNames.push(group.string('name'));
  const weights = readWeights(mesh, verts);

  return {
    name,
    positions,
    faceOffsets,
    cornerVerts,
    cornerEdges,
    edgeVerts,
    materialIndex,
    sharpFace,
    sharpEdge,
    uvs,
    renderUv,
    colors,
    renderColor,
    packedNormals,
    freeNormals,
    autoSmooth,
    weights,
    groupNames,
  };
}

function readWeights(mesh: BlendStruct, verts: number): BlendMeshData['weights'] {
  const dverts =
    mesh.has('dvert') && mesh.ptr('dvert') !== 0n
      ? mesh.array('dvert', 'MDeformVert', verts)
      : legacyLayer(mesh, 'vdata', CD_MDEFORMVERT, 'MDeformVert', verts);
  if (dverts.length !== verts || verts === 0) return null;
  const offsets = new Int32Array(verts + 1);
  const groups: number[] = [];
  const values: number[] = [];
  dverts.forEach((dvert, i) => {
    offsets[i] = groups.length;
    const n = dvert.int('totweight');
    if (n > 0) {
      for (const w of dvert.array('dw', 'MDeformWeight', n)) {
        groups.push(w.int('def_nr'));
        values.push(w.float('weight'));
      }
    }
  });
  offsets[verts] = groups.length;
  return { offsets, groups: Int32Array.from(groups), values: Float32Array.from(values) };
}
