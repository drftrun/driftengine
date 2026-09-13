/**
 * Binary FBX → `MeshData`. Tier 2: a real attempt, and explicitly not a guarantee.
 *
 * FBX is what an asset store hands you as the source, so reading it removes a round trip
 * through an export dialog for the common case. The obstacle was never the format — it is
 * Autodesk's *SDK licence*, and nothing here uses or ships any of it. The binary container
 * is a self-describing tree of typed records, which is why a reader can be written against
 * it at all.
 *
 * **Inflate is injected.** Array properties are usually deflate-compressed, and the only
 * decompressor available without a dependency is Node's `zlib` — which must not be
 * imported here, because this file is part of an engine that runs in a browser. So the
 * caller supplies one. The baker passes `zlib.inflateSync`; a browser could pass
 * `DecompressionStream`. Neither is this module's business.
 *
 * What it reads: geometry, its normals and UVs, and per-model transforms. What it refuses:
 * anything it cannot understand, by name. It never returns the part of a scene it managed
 * — a model with holes in it is a worse outcome than an error, because the error says what
 * to do next.
 *
 * **It reports orientation and does not apply it.** The file's declared up axis comes back
 * as `declaredUp`, and standing the asset up is `orient.ts`, one implementation shared by
 * every format. That split is deliberate: a reader that quietly corrected its own files
 * would make this format's habits into the engine's defaults, and the next reader would be
 * written to match those rather than its own specification.
 */

import type { MeshData } from '@driftengine/drft';
import { DrftError } from '@driftengine/drft';
import { parseUpAxis } from './orient.ts';
import type { UpAxis } from './orient.ts';
import { FALLBACK_MATERIAL, readMaterials } from './fbxMaterial.ts';
import type { DrftMaterial } from '@driftengine/drft';
import type { AssetReference } from './assetPath.ts';
import { bareName, indexObjects, readClips, readSkin, writeInfluences } from './fbxRig.ts';
import type { AnimationClip, DrftSkin } from '@driftengine/drft';

/** One value repeated per vertex, for a material constant this format has nowhere else to put. */
function repeatTriple(count: number, value: readonly [number, number, number]): Float32Array {
  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    out[i * 3] = value[0];
    out[i * 3 + 1] = value[1];
    out[i * 3 + 2] = value[2];
  }
  return out;
}

/** Turn a deflate stream into bytes. Supplied by the caller; see the note above. */
export type Inflate = (compressed: Uint8Array, expectedBytes: number) => Uint8Array;

/** A node in the FBX record tree. */
export interface FbxNode {
  name: string;
  properties: unknown[];
  children: FbxNode[];
}

const MAGIC = 'Kaydara FBX Binary  ';

/** Parse the record tree. Structure only — nothing here knows what a mesh is. */
export function parseFbxTree(
  buffer: ArrayBuffer,
  inflate: Inflate,
): { root: FbxNode; version: number } {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const header = new TextDecoder('latin1').decode(bytes.subarray(0, MAGIC.length));
  if (header !== MAGIC) {
    throw new DrftError(
      'fbx: not a binary FBX. ASCII FBX is not read — re-export as binary, or as glTF.',
    );
  }
  const version = view.getUint32(23, true);
  /*
   * At 7500 the record offsets widened from 32 to 64 bits. It is the only structural
   * break in the container's history, and getting it wrong reads garbage rather than
   * failing, so it is decided once here from the file's own version.
   */
  const wide = version >= 7500;
  const root: FbxNode = { name: '', properties: [], children: [] };

  let at = 27;
  const readNode = (): FbxNode | null => {
    const endOffset = wide ? Number(view.getBigUint64(at, true)) : view.getUint32(at, true);
    const propertyCount = wide
      ? Number(view.getBigUint64(at + 8, true))
      : view.getUint32(at + 4, true);
    const headerBytes = wide ? 25 : 13;
    const nameLength = view.getUint8(at + (wide ? 24 : 12));
    /* A record of all zeroes is the terminator for a list of siblings. */
    if (endOffset === 0) {
      at += headerBytes;
      return null;
    }
    let cursor = at + headerBytes;
    const name = new TextDecoder('latin1').decode(bytes.subarray(cursor, cursor + nameLength));
    cursor += nameLength;

    const properties: unknown[] = [];
    for (let i = 0; i < propertyCount; i++) {
      const [value, next] = readProperty(view, bytes, cursor, inflate);
      properties.push(value);
      cursor = next;
    }

    const node: FbxNode = { name, properties, children: [] };
    /* Anything left before the recorded end of this record is a nested list. */
    while (cursor < endOffset) {
      const saved = at;
      at = cursor;
      const child = readNode();
      cursor = at;
      at = saved;
      if (child === null) break;
      node.children.push(child);
    }
    at = endOffset;
    return node;
  };

  while (at < bytes.length - 16) {
    const node = readNode();
    if (node === null) break;
    root.children.push(node);
  }
  return { root, version };
}

function readProperty(
  view: DataView,
  bytes: Uint8Array,
  at: number,
  inflate: Inflate,
): [unknown, number] {
  const type = String.fromCharCode(view.getUint8(at));
  const start = at + 1;
  switch (type) {
    case 'Y':
      return [view.getInt16(start, true), start + 2];
    case 'C':
      return [view.getUint8(start) !== 0, start + 1];
    case 'I':
      return [view.getInt32(start, true), start + 4];
    case 'F':
      return [view.getFloat32(start, true), start + 4];
    case 'D':
      return [view.getFloat64(start, true), start + 8];
    case 'L':
      return [Number(view.getBigInt64(start, true)), start + 8];
    case 'S':
    case 'R': {
      const length = view.getUint32(start, true);
      const raw = bytes.subarray(start + 4, start + 4 + length);
      return [type === 'S' ? new TextDecoder('latin1').decode(raw) : raw, start + 4 + length];
    }
    case 'f':
    case 'd':
    case 'l':
    case 'i':
    case 'b': {
      const count = view.getUint32(start, true);
      const encoding = view.getUint32(start + 4, true);
      const compressedLength = view.getUint32(start + 8, true);
      const elementBytes = type === 'd' || type === 'l' ? 8 : type === 'b' ? 1 : 4;
      const payload = bytes.subarray(start + 12, start + 12 + compressedLength);
      const raw = encoding === 1 ? inflate(payload, count * elementBytes) : payload;
      return [decodeArray(type, raw, count), start + 12 + compressedLength];
    }
    default:
      throw new DrftError(`fbx: property type "${type}" at ${at} is not one this reader knows`);
  }
}

function decodeArray(type: string, raw: Uint8Array, count: number): ArrayLike<number> {
  /* `slice` rather than a view: the payload may be unaligned within the file. */
  const aligned = raw.byteOffset % 8 === 0 ? raw : raw.slice();
  const buffer = aligned.buffer as ArrayBuffer;
  const offset = aligned.byteOffset;
  switch (type) {
    case 'f':
      return new Float32Array(buffer, offset, count);
    case 'd':
      return new Float64Array(buffer, offset, count);
    case 'i':
      return new Int32Array(buffer, offset, count);
    case 'l': {
      const big = new BigInt64Array(buffer, offset, count);
      const out = new Float64Array(count);
      for (let i = 0; i < count; i++) out[i] = Number(big[i]);
      return out;
    }
    default:
      return new Uint8Array(buffer, offset, count);
  }
}

function findAll(node: FbxNode, name: string, out: FbxNode[] = []): FbxNode[] {
  for (const child of node.children) {
    if (child.name === name) out.push(child);
    findAll(child, name, out);
  }
  return out;
}

function findChild(node: FbxNode, name: string): FbxNode | undefined {
  return node.children.find((child) => child.name === name);
}

function numbers(node: FbxNode | undefined): ArrayLike<number> | null {
  const value = node?.properties[0];
  return value !== undefined && typeof value === 'object' && value !== null && 'length' in value
    ? (value as ArrayLike<number>)
    : null;
}

/**
 * Which way this file *says* is up, from its own `GlobalSettings`.
 *
 * FBX records the convention rather than fixing one, and the tools disagree: 3ds Max and
 * most game exports are Z-up, Maya is Y-up. Ignoring it does not produce a small error —
 * a Z-up car imported as Y-up lies on its side, half sunk through the floor, with its
 * longest span on the wrong axis. It was reported in exactly those words.
 *
 * **The sign is half of the answer and was previously dropped.** `UpAxis` names an axis and
 * `UpAxisSign` says which end of it, so `1, -1` means up is *minus* Y — a file that reads
 * as innocent while importing every model in it upside down, which is the same symptom as
 * a rotation bug and none of the same cause. Reading the axis and discarding the sign is
 * how a reader produces that silently.
 *
 * This only *reports*. Turning the asset is `orient.ts`, once, for every format, so no one
 * format's habits become the engine's defaults.
 */
/**
 * Metres per file unit, from `GlobalSettings.UnitScaleFactor`.
 *
 * **The container's own unit is the centimetre**, and `UnitScaleFactor` counts how many of them one
 * file unit is: one for a file authored in centimetres, a hundred for one authored in metres. So
 * metres per unit is that figure over a hundred, and a file stating nothing is centimetres because
 * that is what the container defines rather than what this reader would prefer.
 *
 * **It is read rather than applied**, on exactly the terms `declaredUp` beside it is: a reader that
 * quietly rescaled its own files would make this format's habits into the engine's defaults. What
 * it replaces is worse than a rescale — a consumer with no figure to scale by was dividing by a
 * measured height, which is a guess dressed as arithmetic and is wrong for anything that is not a
 * standing human.
 */
function unitScaleOf(root: FbxNode): number {
  for (const settings of root.children.filter((child) => child.name === 'GlobalSettings')) {
    const properties = findChild(settings, 'Properties70');
    for (const property of properties?.children ?? []) {
      if (property.properties[0] !== 'UnitScaleFactor') continue;
      const factor = property.properties[4];
      /* A zero or a negative would scale a model to nothing or inside out, so it is refused in
         favour of the container's default rather than trusted for being present. */
      if (typeof factor === 'number' && Number.isFinite(factor) && factor > 0) return factor / 100;
    }
  }
  return 0.01;
}

function declaredUpOf(root: FbxNode): UpAxis {
  /* 0 is X, 1 is Y, 2 is Z. Anything else is treated as Y, which is the engine's own. */
  let axis = 1;
  let sign = 1;
  for (const settings of root.children.filter((child) => child.name === 'GlobalSettings')) {
    const properties = settings.children.find((child) => child.name === 'Properties70');
    for (const property of properties?.children ?? []) {
      const value = property.properties[4];
      if (typeof value !== 'number') continue;
      if (property.properties[0] === 'UpAxis') axis = value;
      else if (property.properties[0] === 'UpAxisSign') sign = value;
    }
  }
  return parseUpAxis(`${sign < 0 ? '-' : '+'}${axis === 0 ? 'x' : axis === 2 ? 'z' : 'y'}`);
}

/**
 * Where each geometry belongs, composed from the model hierarchy.
 *
 * **This is what a car looks like without it.** A `Geometry` record holds vertices in its
 * *own* local space, and the transform that puts it on the car lives on a separate `Model`
 * record joined to it through the file's `Connections` table. Skip that and all 187 parts
 * arrive stacked at the origin, overlapping in a heap — which reads as random lines rather
 * than as a missing transform, and is why it looked like a parsing fault.
 *
 * Connections are `C` records of `["OO", childId, parentId]`, so the graph is walked from
 * a geometry up through its model's ancestors, and the transforms composed on the way.
 */
function readTransforms(root: FbxNode): {
  world: Map<number, readonly number[]>;
  /** Geometry id to the model wearing it, which is also where its materials hang. */
  modelOf: Map<number, number>;
} {
  const models = new Map<number, FbxNode>();
  const geometryIds = new Map<FbxNode, number>();
  for (const objects of root.children.filter((child) => child.name === 'Objects')) {
    for (const node of objects.children) {
      const id = node.properties[0];
      if (typeof id !== 'number') continue;
      if (node.name === 'Model') models.set(id, node);
      else if (node.name === 'Geometry') geometryIds.set(node, id);
    }
  }

  /*
   * child -> parent, from the file's own connection table, **taking only parents that are models**.
   *
   * An object names every parent it has and the table is in whatever order the exporter wrote it,
   * so "the first `OO` parent" is not the hierarchy. A bone names its skin cluster as well as its
   * parent bone, and a cluster is not a model: taking it made the walk to the world stop there and
   * silently return identity, which drops every ancestor above that bone. A prop parented to a
   * hand then drew as though the hand were a root — right relative to the hand, in the wrong place
   * in the scene, which reads as a rigging fault rather than as a connection read in the wrong
   * order. Geometry is exempt because a geometry's parent is the model wearing it, which is the
   * one edge this map is asked for that does not run between two models.
   */
  const parentOf = new Map<number, number>();
  for (const connections of root.children.filter((child) => child.name === 'Connections')) {
    for (const c of connections.children) {
      const [kind, child, parent] = c.properties;
      if (kind !== 'OO' || typeof child !== 'number' || typeof parent !== 'number') continue;
      if (parentOf.has(child) || !models.has(parent)) continue;
      parentOf.set(child, parent);
    }
  }

  /** A model's own transform, from its `Properties70` entries. */
  const localOf = (model: FbxNode): number[] => {
    let tx = 0;
    let ty = 0;
    let tz = 0;
    let rx = 0;
    let ry = 0;
    let rz = 0;
    let sx = 1;
    let sy = 1;
    let sz = 1;
    const properties = model.children.find((child) => child.name === 'Properties70');
    for (const property of properties?.children ?? []) {
      const name = property.properties[0];
      const a = property.properties[4];
      const b = property.properties[5];
      const c = property.properties[6];
      if (typeof a !== 'number' || typeof b !== 'number' || typeof c !== 'number') continue;
      if (name === 'Lcl Translation') [tx, ty, tz] = [a, b, c];
      else if (name === 'Lcl Rotation') [rx, ry, rz] = [a, b, c];
      else if (name === 'Lcl Scaling') [sx, sy, sz] = [a, b, c];
    }
    return compose(tx, ty, tz, rx, ry, rz, sx, sy, sz);
  };

  const worldCache = new Map<number, readonly number[]>();
  const worldOf = (id: number, depth = 0): readonly number[] => {
    const cached = worldCache.get(id);
    if (cached !== undefined) return cached;
    const model = models.get(id);
    if (model === undefined || depth > 32) return IDENTITY_4;
    const parent = parentOf.get(id);
    const world =
      parent === undefined ? localOf(model) : multiply4(worldOf(parent, depth + 1), localOf(model));
    worldCache.set(id, world);
    return world;
  };

  const world = new Map<number, readonly number[]>();
  const modelOf = new Map<number, number>();
  for (const [, id] of geometryIds) {
    const model = parentOf.get(id);
    world.set(id, model === undefined ? IDENTITY_4 : worldOf(model));
    if (model !== undefined) modelOf.set(id, model);
  }
  return { world, modelOf };
}

/**
 * A layer element, with the two modes that decide how to look a value up.
 *
 * FBX stores normals, UVs and colours as parallel arrays with a *mapping* saying what a
 * datum belongs to (a corner, a vertex, a polygon, or the whole mesh) and a *reference*
 * saying whether the array is read directly or through an index. The combination is the
 * whole of the format's flexibility here, and getting it wrong never fails: it shades the
 * model incorrectly, which is discovered by eye much later.
 */
interface Layer {
  readonly values: ArrayLike<number>;
  readonly indices: ArrayLike<number> | null;
  readonly mapping: string;
  readonly components: number;
}

function readLayer(
  geometry: FbxNode,
  element: string,
  valueName: string,
  indexName: string,
  components: number,
): Layer | null {
  const node = findChild(geometry, element);
  if (node === undefined) return null;
  const values = numbers(findChild(node, valueName));
  if (values === null) return null;
  const reference =
    (findChild(node, 'ReferenceInformationType')?.properties[0] as string) ?? 'Direct';
  const mapping =
    (findChild(node, 'MappingInformationType')?.properties[0] as string) ?? 'ByPolygonVertex';
  const indices = reference.startsWith('Index') ? numbers(findChild(node, indexName)) : null;
  return { values, indices, mapping, components };
}

/** Where this corner's datum starts in a layer's values, or -1 if the layer does not cover it. */
function layerAt(
  layer: Layer,
  polygonVertex: number,
  vertexIndex: number,
  polygon: number,
): number {
  const key =
    layer.mapping === 'ByVertice' || layer.mapping === 'ByVertex'
      ? vertexIndex
      : layer.mapping === 'ByPolygon'
        ? polygon
        : layer.mapping === 'AllSame'
          ? 0
          : polygonVertex;
  const at = layer.indices === null ? key : Math.trunc(layer.indices[key] as number);
  if (!(at >= 0)) return -1;
  const offset = at * layer.components;
  return offset + layer.components <= layer.values.length ? offset : -1;
}

const IDENTITY_4: readonly number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function multiply4(a: readonly number[], b: readonly number[]): number[] {
  const out = new Array<number>(16);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += (a[k * 4 + row] as number) * (b[col * 4 + k] as number);
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

/** A model's matrix from its translation, rotation and scale. Degrees, column-major. */
function compose(
  tx: number,
  ty: number,
  tz: number,
  rx: number,
  ry: number,
  rz: number,
  sx: number,
  sy: number,
  sz: number,
): number[] {
  const toRad = Math.PI / 180;
  const cx = Math.cos(rx * toRad);
  const sxr = Math.sin(rx * toRad);
  const cy = Math.cos(ry * toRad);
  const syr = Math.sin(ry * toRad);
  const cz = Math.cos(rz * toRad);
  const szr = Math.sin(rz * toRad);

  /*
   * Rz * Ry * Rx, and the order is the bug this replaces.
   *
   * FBX's default is `eEulerXYZ`, which names the order the axes are rotated *in* — X,
   * then Y, then Z — and therefore this product, not Rx * Ry * Rz. Backwards it does not
   * tilt a model slightly: on a hierarchy whose parts carry 90 and 180 degree rotations it
   * turns the assembly inside out, and the symptom is a car arriving upside down with its
   * body hanging below the origin. Found only after the file's own `UpAxis` had been
   * checked and was innocent.
   */
  const m00 = cz * cy;
  const m01 = cz * syr * sxr - szr * cx;
  const m02 = cz * syr * cx + szr * sxr;
  const m10 = szr * cy;
  const m11 = szr * syr * sxr + cz * cx;
  const m12 = szr * syr * cx - cz * sxr;
  const m20 = -syr;
  const m21 = cy * sxr;
  const m22 = cy * cx;

  return [
    m00 * sx,
    m10 * sx,
    m20 * sx,
    0,
    m01 * sy,
    m11 * sy,
    m21 * sy,
    0,
    m02 * sz,
    m12 * sz,
    m22 * sz,
    0,
    tx,
    ty,
    tz,
    1,
  ];
}

/**
 * Geometry out of a parsed tree, one `MeshData` per `Geometry` record.
 *
 * FBX stores polygons of any size as a flat index list where a **negative index marks the
 * last corner of a polygon**, encoded as its bitwise complement. Triangulating as a fan is
 * correct for the convex polygons these files contain and is what every other reader does.
 *
 * Normals and UVs arrive as layer elements with their own mapping and reference modes, and
 * the combination decides how to look a value up. Getting that wrong does not fail — it
 * shades the model wrongly — so each supported combination is handled explicitly and an
 * unsupported one is named rather than approximated.
 */
export function fbxToMeshes(
  buffer: ArrayBuffer,
  inflate: Inflate,
): {
  meshes: MeshData[];
  warnings: string[];
  version: number;
  declaredUp: UpAxis;
  /**
   * Parallel to `meshes`: the surface each one wears, including which texture colours it.
   *
   * A parallel array rather than a field on `MeshData`, because `MeshData` is the engine's
   * own vertex data and a texture *reference* is a fact about a file that has not been
   * resolved yet. Folding an unresolved path into the thing the renderer uploads would put a
   * bake-time concern inside a runtime type.
   */
  materials: DrftMaterial[];
  /** Textures the file names, with bytes where it embedded them itself. */
  textures: AssetReference[];
  /**
   * The rig, where the file carries one. Empty for the static meshes this reader began with.
   *
   * **A skinned geometry keeps its vertices in the space its own file put them in**, and does not
   * take the model's world transform the way a static one does. That is not an omission: a
   * cluster's bind matrices already carry where the mesh was, so applying the transform as well
   * places the character twice — which throws the rig across the scene rather than shifting it,
   * and is the same rule the glTF reader states for a skinned primitive.
   */
  skins: DrftSkin[];
  clips: AnimationClip[];
  /** Metres per source unit, which this format states. See `unitScaleOf`. */
  unitScale: number;
} {
  const { root, version } = parseFbxTree(buffer, inflate);
  const warnings: string[] = [];
  const meshes: MeshData[] = [];
  const perMesh: DrftMaterial[] = [];
  const transforms = readTransforms(root);
  const materials = readMaterials(root, warnings);
  const declaredUp = declaredUpOf(root);
  const unitScale = unitScaleOf(root);
  const objects = indexObjects(root);
  let seenGeometries = 0;
  let emptyGeometries = 0;
  const skins: DrftSkin[] = [];
  /** Model id to joint index, across every skin, so a clip's curves can find their tracks. */
  const jointOfModel = new Map<number, number>();

  for (const geometry of findAll(root, 'Geometry')) {
    const geometryId = geometry.properties[0] as number;
    /*
     * The skin first, because it decides which space this geometry's vertices stay in. See the
     * note on `skins` in the return type: a bound mesh is placed by its palette, so taking the
     * model transform as well places it twice.
     */
    const meshWorld = transforms.world.get(geometryId) ?? IDENTITY_4;
    const skin = readSkin(objects, geometryId, meshWorld, warnings);
    if (skin !== null) {
      skins.push({ joints: skin.joints, inverseBind: skin.inverseBind });
      skin.modelOfJoint.forEach((model, joint) => jointOfModel.set(model, joint));
    }
    const world = skin !== null ? IDENTITY_4 : meshWorld;
    const vertices = numbers(findChild(geometry, 'Vertices'));
    const polygonIndex = numbers(findChild(geometry, 'PolygonVertexIndex'));
    seenGeometries++;
    if (vertices === null || polygonIndex === null) {
      /* Counted rather than skipped in silence, so the refusal below can say which of the two
         shapes of nothing this file is: no geometry records at all, or records carrying something
         that is not a polygon mesh — a blend-shape target, a NURBS patch, a subdivision cage. */
      emptyGeometries++;
      continue;
    }

    /* Through the same helper the rig's names go through: a binary file tags a name with its class
       after a `\0\x01`, and splitting on a space was a guess that happened to survive because the
       result is only ever quoted in a warning. See `bareName`. */
    const name = bareName(geometry.properties[1], 'geometry');

    /* Corners, with the polygon boundaries resolved and fans emitted. The polygon a corner
       came from travels with it, because that is what a per-polygon layer is keyed by. */
    const corners: number[] = [];
    const polygonOfCorner: number[] = [];
    let polygonStart = 0;
    let polygon = 0;
    for (let i = 0; i < polygonIndex.length; i++) {
      if ((polygonIndex[i] as number) >= 0) continue;
      const end = i;
      for (let k = polygonStart + 1; k < end; k++) {
        corners.push(polygonStart, k, k + 1);
        polygonOfCorner.push(polygon, polygon, polygon);
      }
      polygonStart = end + 1;
      polygon++;
    }
    if (corners.length === 0) {
      warnings.push(`${name}: no polygons`);
      continue;
    }

    const indexOf = (polygonVertex: number): number => {
      const raw = polygonIndex[polygonVertex] as number;
      return raw < 0 ? ~raw : raw;
    };

    const normalLayer = readLayer(geometry, 'LayerElementNormal', 'Normals', 'NormalsIndex', 3);
    const uvLayer = readLayer(geometry, 'LayerElementUV', 'UV', 'UVIndex', 2);
    const colorLayer = readLayer(geometry, 'LayerElementColor', 'Colors', 'ColorIndex', 4);

    /*
     * Which material each polygon wears.
     *
     * `LayerElementMaterial` is the one layer whose values *are* its indices, so it does not
     * go through `readLayer`. `AllSame` means the whole geometry and is the common case;
     * `ByPolygon` is what a mesh authored with several materials writes, and it is the reason
     * the corners below are bucketed rather than emitted as a single mesh.
     */
    const materialElement = findChild(geometry, 'LayerElementMaterial');
    const materialValues =
      materialElement === undefined ? null : numbers(findChild(materialElement, 'Materials'));
    const perPolygon =
      materialElement !== undefined &&
      (findChild(materialElement, 'MappingInformationType')?.properties[0] as string) ===
        'ByPolygon';
    const slotOfPolygon = (at: number): number => {
      if (materialValues === null || materialValues.length === 0) return 0;
      const key = perPolygon ? Math.min(at, materialValues.length - 1) : 0;
      const slot = Math.trunc(materialValues[key] as number);
      return slot >= 0 ? slot : 0;
    };

    const modelId = transforms.modelOf.get(geometryId);
    const worn = modelId === undefined ? [] : (materials.ofModel.get(modelId) ?? []);

    /* One bucket of corners per material, so that a mesh carries exactly one surface. */
    const buckets = new Map<number, number[]>();
    for (let c = 0; c < corners.length; c++) {
      const slot = slotOfPolygon(polygonOfCorner[c] as number);
      const bucket = buckets.get(slot);
      if (bucket === undefined) buckets.set(slot, [c]);
      else bucket.push(c);
    }

    for (const [slot, bucket] of buckets) {
      const material = materials.byId.get(worn[slot] ?? -1) ?? FALLBACK_MATERIAL;
      const base = material.color;

      /*
       * **Indexed, by the offsets a corner's attributes actually resolved to.**
       *
       * This loop used to write `indices[i] = i` over every corner it had fanned, so a mesh came
       * back with one vertex per corner — a bought character at 64,518 vertices where its own file
       * describes 12,216, five times the geometry for the same triangles. The baker welds, so a
       * baked asset never showed it; anything calling `readModel` directly carried all of it.
       *
       * **Keyed on the values, and bucketed by control point to make that affordable.** Keying on
       * the layer *offsets* instead is the obvious cheap answer and it deduplicates almost nothing:
       * an exporter writing normals `ByPolygonVertex` `Direct` gives every corner its own offset
       * into an array of repeated values, so a car whose corners are 1,958,016 came back as
       * 1,958,002 vertices — fourteen shared out of two million. What a reader is asked for is
       * whether two corners *are* the same vertex, which is a question about values.
       *
       * Comparing values could have been a string key per corner; it is a bucket per control point
       * instead, because the candidates for any corner are the handful of vertices already emitted
       * for its own control point — typically one, and never more than the seams meeting there. A
       * control point split across a UV seam or a hard edge fails the comparison and stays two
       * vertices, which is correct rather than merely conservative.
       */
      const positions: number[] = [];
      const outNormals: number[] = [];
      const outColors: number[] = [];
      const outUvs: number[] | null = uvLayer === null ? null : [];
      const outJoints: number[] | null = skin === null ? null : [];
      const outWeights: number[] | null = skin === null ? null : [];
      const indices: number[] = [];
      /*
       * A mesh with no normals is not deduplicated, and that is the geometry speaking rather than
       * a shortcut: the normals below are computed per *face*, so two triangles meeting at a
       * control point need two vertices to hold their two normals. Sharing one would average
       * nothing and shade both faces with whichever was written last.
       */
      const shared = normalLayer === null ? null : new Map<number, number[]>();
      let droppedInfluences = false;
      let rescaledInfluences = false;

      for (const c of bucket) {
        const polygonVertex = corners[c] as number;
        const at = polygonOfCorner[c] as number;
        const vertexIndex = indexOf(polygonVertex);
        const normalAt =
          normalLayer === null ? -1 : layerAt(normalLayer, polygonVertex, vertexIndex, at);
        const uvAt = uvLayer === null ? -1 : layerAt(uvLayer, polygonVertex, vertexIndex, at);
        const colorAt =
          colorLayer === null ? -1 : layerAt(colorLayer, polygonVertex, vertexIndex, at);

        const vx = vertices[vertexIndex * 3] as number;
        const vy = vertices[vertexIndex * 3 + 1] as number;
        const vz = vertices[vertexIndex * 3 + 2] as number;
        const px =
          (world[0] as number) * vx +
          (world[4] as number) * vy +
          (world[8] as number) * vz +
          (world[12] as number);
        const py =
          (world[1] as number) * vx +
          (world[5] as number) * vy +
          (world[9] as number) * vz +
          (world[13] as number);
        const pz =
          (world[2] as number) * vx +
          (world[6] as number) * vy +
          (world[10] as number) * vz +
          (world[14] as number);

        let normalX = 0;
        let normalY = 0;
        let normalZ = 0;
        if (normalLayer !== null && normalAt >= 0) {
          const nx = normalLayer.values[normalAt] as number;
          const ny = normalLayer.values[normalAt + 1] as number;
          const nz = normalLayer.values[normalAt + 2] as number;
          /* Rotated by the same basis. Scale is left out: these files scale uniformly or
             not at all, and normalising after covers the rest. */
          const tnx =
            (world[0] as number) * nx + (world[4] as number) * ny + (world[8] as number) * nz;
          const tny =
            (world[1] as number) * nx + (world[5] as number) * ny + (world[9] as number) * nz;
          const tnz =
            (world[2] as number) * nx + (world[6] as number) * ny + (world[10] as number) * nz;
          const length = Math.hypot(tnx, tny, tnz) || 1;
          normalX = tnx / length;
          normalY = tny / length;
          normalZ = tnz / length;
        }

        /* The material's colour, modulated by a vertex colour wherever the file painted one. */
        let r = base[0] as number;
        let g = base[1] as number;
        let b = base[2] as number;
        if (colorLayer !== null && colorAt >= 0) {
          r *= colorLayer.values[colorAt] as number;
          g *= colorLayer.values[colorAt + 1] as number;
          b *= colorLayer.values[colorAt + 2] as number;
        }

        let u = 0;
        let v = 0;
        if (uvLayer !== null && uvAt >= 0) {
          u = uvLayer.values[uvAt] as number;
          /*
           * V is flipped once, here. FBX puts the origin at the bottom left and this engine
           * uploads every texture with the origin at the top left, so a map applied without
           * this arrives mirrored vertically. On a car that reads as badges upside down and
           * tread running the wrong way, which looks like a bad texture rather than a bad
           * coordinate, and so is looked for in the wrong place.
           */
          v = 1 - (uvLayer.values[uvAt + 1] as number);
        }

        const candidates = shared?.get(vertexIndex);
        let found = -1;
        for (const candidate of candidates ?? []) {
          if (
            outNormals[candidate * 3] === normalX &&
            outNormals[candidate * 3 + 1] === normalY &&
            outNormals[candidate * 3 + 2] === normalZ &&
            outColors[candidate * 3] === r &&
            outColors[candidate * 3 + 1] === g &&
            outColors[candidate * 3 + 2] === b &&
            (outUvs === null || (outUvs[candidate * 2] === u && outUvs[candidate * 2 + 1] === v))
          ) {
            found = candidate;
            break;
          }
        }
        if (found >= 0) {
          indices.push(found);
          continue;
        }

        const emitted = positions.length / 3;
        if (shared !== null) {
          if (candidates === undefined) shared.set(vertexIndex, [emitted]);
          else candidates.push(emitted);
        }
        indices.push(emitted);
        positions.push(px, py, pz);
        outNormals.push(normalX, normalY, normalZ);
        outColors.push(r, g, b);
        if (outUvs !== null) outUvs.push(u, v);

        if (outJoints !== null && outWeights !== null && skin !== null) {
          outJoints.push(0, 0, 0, 0);
          outWeights.push(0, 0, 0, 0);
          const scratchJoints = new Float32Array(4);
          const scratchWeights = new Float32Array(4);
          const report = writeInfluences(
            skin.influences.get(vertexIndex),
            scratchJoints,
            scratchWeights,
            0,
          );
          for (let k = 0; k < 4; k++) {
            outJoints[emitted * 4 + k] = scratchJoints[k] as number;
            outWeights[emitted * 4 + k] = scratchWeights[k] as number;
          }
          droppedInfluences ||= report.dropped;
          rescaledInfluences ||= report.rescaled;
        }
      }

      const count = positions.length / 3;
      const outPositions = Float32Array.from(positions);
      const normalsOut = Float32Array.from(outNormals);
      if (normalLayer === null) {
        warnings.push(`${name}: no normals, computed from the winding`);
        computeFaceNormals(outPositions, normalsOut);
      }
      if (droppedInfluences) {
        warnings.push(
          `${name}: a vertex is held by more than four joints; the four largest are kept and ` +
            `renormalised, because four is what the skinning palette reads.`,
        );
      }
      if (rescaledInfluences) {
        warnings.push(`${name}: skin weights did not sum to one and were normalised.`);
      }

      /*
       * A material's constants arrive as full arrays, which `weld` then shrinks where it can.
       * That is the wrong shape for the data and knowingly so: a mesh now carries exactly one
       * material, so each of these is one number repeated a million times. `MATL` is where it
       * gets stored once instead, and where these become constant attributes.
       */
      meshes.push({
        positions: outPositions,
        normals: normalsOut,
        colors: Float32Array.from(outColors),
        emissive: new Float32Array(count).fill(material.emissive),
        specular: new Float32Array(count).fill(material.specular),
        roughness: new Float32Array(count).fill(material.roughness),
        emissiveColor: repeatTriple(count, material.emissiveColor),
        indices: Uint32Array.from(indices),
        ...(outUvs === null ? {} : { uvs: Float32Array.from(outUvs) }),
        ...(outJoints === null || outWeights === null
          ? {}
          : { joints: Float32Array.from(outJoints), weights: Float32Array.from(outWeights) }),
      });
      perMesh.push(material);
    }
  }

  if (meshes.length === 0) {
    /*
     * **The refusal says what it found, because "no geometry" is three different faults.**
     *
     * It used to say only that there was none, which is where the trail ended for whoever met it:
     * two rig-specific exports of one character both failed here and the message could not tell
     * whether the records were missing, present but not polygon meshes, or present and empty. Each
     * of those is a different next step, and the counts separate them without the reader having to
     * guess which one it is looking at.
     */
    const found =
      seenGeometries === 0
        ? `It carries no Geometry records at all, across ${objects.byId.size} objects: this is an ` +
          `animation-only export, which is a skeleton and its curves with no mesh. The two that ` +
          `ship beside a bought character for a particular engine are usually exactly that, and the ` +
          `mesh is in the file next to them.`
        : emptyGeometries === seenGeometries
          ? `All ${seenGeometries} of its Geometry records lack Vertices or PolygonVertexIndex, so ` +
            `they are blend-shape targets, patches or cages rather than polygon meshes.`
          : `${seenGeometries} Geometry records were read and every one produced no polygons.`;
    throw new DrftError(
      `fbx: no geometry found in a version ${version} file. ${found} This reader is experimental ` +
        `(tier 2) — export glTF from your own software and bake that instead.`,
    );
  }
  return {
    meshes,
    warnings,
    version,
    declaredUp,
    materials: perMesh,
    textures: [...materials.textures],
    skins,
    /* After the meshes, because a curve is matched to a joint and the joints are numbered by the
       skins above. A file with takes and no skin has nothing for a track to drive. */
    clips: skins.length === 0 ? [] : readClips(objects, jointOfModel, warnings),
    unitScale,
  };
}

/** A zero normal is not neutral: everything multiplies by it, so the mesh arrives black. */
function computeFaceNormals(positions: Float32Array, normals: Float32Array): void {
  for (let i = 0; i + 2 < positions.length / 3; i += 3) {
    const ax = positions[i * 3] as number;
    const ay = positions[i * 3 + 1] as number;
    const az = positions[i * 3 + 2] as number;
    const ux = (positions[(i + 1) * 3] as number) - ax;
    const uy = (positions[(i + 1) * 3 + 1] as number) - ay;
    const uz = (positions[(i + 1) * 3 + 2] as number) - az;
    const vx = (positions[(i + 2) * 3] as number) - ax;
    const vy = (positions[(i + 2) * 3 + 1] as number) - ay;
    const vz = (positions[(i + 2) * 3 + 2] as number) - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz) || 1;
    nx /= length;
    ny /= length;
    nz /= length;
    for (let c = 0; c < 3; c++) {
      normals[(i + c) * 3] = nx;
      normals[(i + c) * 3 + 1] = ny;
      normals[(i + c) * 3 + 2] = nz;
    }
  }
}
