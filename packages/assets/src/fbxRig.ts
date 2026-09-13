/**
 * The rig inside an FBX: a skeleton, what it is bound to, and the takes that move it.
 *
 * **Split from `fbx.ts` on the terms `fbxMaterial.ts` already set.** That file reads geometry and
 * knows nothing about deformers; this one reads deformers and knows nothing about polygons. They
 * meet over two small things — a control point's influences, and which model each joint is — and
 * keeping them apart is what stops the mesh loop growing a second subject.
 *
 * **What FBX calls a skin is three record kinds and four connections.** A `Deformer` of subtype
 * `Skin` hangs off a `Geometry`; a `Deformer` of subtype `Cluster` hangs off that skin, one per
 * bone; and a `Model` of subtype `LimbNode` hangs off each cluster. The weights live on the
 * cluster, keyed by control point, which is why they are read here and applied where the corners
 * are walked.
 *
 * **The bind pose is two matrices and not one.** A cluster carries `TransformLink`, where the bone
 * was when the mesh was bound, and `Transform`, where the *mesh* was. The engine's `inverseBind`
 * takes a vertex from model space into the joint's bind space, so it is the inverse of the first
 * times the second. Taking `TransformLink` alone is right exactly while the mesh sits at the
 * origin with no rotation, which is what a hand-made test file does and what a bought character
 * does not — the failure is a figure that is correctly posed and standing in the wrong place.
 *
 * **This is tier 2 and says so.** What it does not read: `PostRotation`, rotation orders other than
 * the default, blend-shape channels driven by curves, and the `Take` records of pre-7000 files.
 * Each is named where it is refused rather than silently approximated.
 */

import type { AnimationClip, Joint, JointTrack, TrackPath } from '@driftengine/drft';
import type { FbxNode } from './fbx.ts';

/** One second, in the integer unit `KeyTime` counts. FBX's own constant. */
const KTIME_PER_SECOND = 46186158000;

/** The most influences a vertex may carry, which is what the palette shader reads. */
const MAX_INFLUENCES = 4;

const IDENTITY: readonly number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

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
 * An object's own name, with the class the container tags it with taken off.
 *
 * **The two forms are not the same string, and only one of them looks like a separator.** ASCII FBX
 * writes `Model::spine_01`, which is what a reader tends to be written against because it is what
 * the specification's examples show. Binary FBX — which is the only form this reader accepts —
 * writes `spine_01\0\x01Model`: the name first, then a null and a `\x01`, then the class. Knowing
 * only the ASCII form left every joint of a bought character named
 * `rp_nathan_animated_003_walking_spine_01\0\x01Model` and its take named `Take 001\0\x01AnimStack`.
 *
 * Nothing fails on a name, which is why it survived: `Joint.name` is what **retargeting matches
 * on**, so a rig whose every joint carries a class suffix matches nothing, one subsystem away from
 * the reader that wrote it.
 */
export function bareName(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const binary = raw.indexOf('\u0000\u0001');
  const name =
    binary >= 0
      ? raw.slice(0, binary)
      : raw.includes('::')
        ? raw.slice(raw.indexOf('::') + 2)
        : raw;
  return name.length > 0 ? name : fallback;
}

function multiply(a: readonly number[], b: readonly number[]): number[] {
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

/**
 * A full 4x4 inverse, because a bind matrix is not guaranteed to be a rigid motion.
 *
 * The cheap inverse — transpose the basis, negate the translation through it — is correct only
 * without scale, and character rigs carry scale far more often than a car does: a mirrored limb is
 * a negative scale on one axis, and inverting that as if it were a rotation turns the limb inside
 * out. Singular matrices come back as identity rather than as `NaN`, because a `NaN` in a bind
 * matrix takes every vertex the joint touches with it.
 */
function invert(m: readonly number[]): number[] {
  const a = (i: number): number => m[i] as number;
  const s0 = a(0) * a(5) - a(4) * a(1);
  const s1 = a(0) * a(6) - a(4) * a(2);
  const s2 = a(0) * a(7) - a(4) * a(3);
  const s3 = a(1) * a(6) - a(5) * a(2);
  const s4 = a(1) * a(7) - a(5) * a(3);
  const s5 = a(2) * a(7) - a(6) * a(3);
  const c5 = a(10) * a(15) - a(14) * a(11);
  const c4 = a(9) * a(15) - a(13) * a(11);
  const c3 = a(9) * a(14) - a(13) * a(10);
  const c2 = a(8) * a(15) - a(12) * a(11);
  const c1 = a(8) * a(14) - a(12) * a(10);
  const c0 = a(8) * a(13) - a(12) * a(9);
  const determinant = s0 * c5 - s1 * c4 + s2 * c3 + s3 * c2 - s4 * c1 + s5 * c0;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-20) return [...IDENTITY];
  const d = 1 / determinant;
  return [
    (a(5) * c5 - a(6) * c4 + a(7) * c3) * d,
    (-a(1) * c5 + a(2) * c4 - a(3) * c3) * d,
    (a(13) * s5 - a(14) * s4 + a(15) * s3) * d,
    (-a(9) * s5 + a(10) * s4 - a(11) * s3) * d,
    (-a(4) * c5 + a(6) * c2 - a(7) * c1) * d,
    (a(0) * c5 - a(2) * c2 + a(3) * c1) * d,
    (-a(12) * s5 + a(14) * s2 - a(15) * s1) * d,
    (a(8) * s5 - a(10) * s2 + a(11) * s1) * d,
    (a(4) * c4 - a(5) * c2 + a(7) * c0) * d,
    (-a(0) * c4 + a(1) * c2 - a(3) * c0) * d,
    (a(12) * s4 - a(13) * s2 + a(15) * s0) * d,
    (-a(8) * s4 + a(9) * s2 - a(11) * s0) * d,
    (-a(4) * c3 + a(5) * c1 - a(6) * c0) * d,
    (a(0) * c3 - a(1) * c1 + a(2) * c0) * d,
    (-a(12) * s3 + a(13) * s1 - a(14) * s0) * d,
    (a(8) * s3 - a(9) * s1 + a(10) * s0) * d,
  ];
}

/** Every `Objects` child, by id, with the class the record's third property names. */
export interface FbxObjects {
  readonly byId: Map<number, FbxNode>;
  /** child id to every parent it names, in file order. A bone names its cluster *and* its parent. */
  readonly parentsOf: Map<number, number[]>;
  /** `OP` connections: child id to the [parent, property] pairs it drives. */
  readonly drives: Map<number, { readonly parent: number; readonly property: string }[]>;
}

export function indexObjects(root: FbxNode): FbxObjects {
  const byId = new Map<number, FbxNode>();
  for (const objects of root.children.filter((child) => child.name === 'Objects')) {
    for (const child of objects.children) {
      const id = child.properties[0];
      if (typeof id === 'number') byId.set(id, child);
    }
  }
  const parentsOf = new Map<number, number[]>();
  const drives = new Map<number, { parent: number; property: string }[]>();
  for (const connections of root.children.filter((child) => child.name === 'Connections')) {
    for (const c of connections.children) {
      const [kind, child, parent, property] = c.properties;
      if (typeof child !== 'number' || typeof parent !== 'number') continue;
      if (kind === 'OO') {
        const list = parentsOf.get(child);
        if (list === undefined) parentsOf.set(child, [parent]);
        else list.push(parent);
      } else if (kind === 'OP' && typeof property === 'string') {
        const list = drives.get(child);
        const entry = { parent, property };
        if (list === undefined) drives.set(child, [entry]);
        else list.push(entry);
      }
    }
  }
  return { byId, parentsOf, drives };
}

/** What a cluster says about one bone's hold on one mesh. */
interface Cluster {
  readonly bone: number;
  readonly indexes: ArrayLike<number>;
  readonly weights: ArrayLike<number>;
  /** `inverse(TransformLink) * meshWorld`, already composed. See `readSkin`. */
  readonly inverseBind: readonly number[];
}

/** A skin, as this reader hands it on: the skeleton, and the influences keyed by control point. */
export interface FbxSkin {
  readonly joints: readonly Joint[];
  readonly inverseBind: Float32Array;
  /**
   * Control point index to its influences, as [joint, weight] pairs.
   *
   * A map rather than a dense array because a cluster covers the control points it covers: a
   * character's rig leaves nothing unweighted, and a prop bound to one bone leaves almost
   * everything out of every cluster but one.
   */
  readonly influences: Map<number, { joint: number; weight: number }[]>;
  /** Model id of each joint, in the sorted order, so a curve can find the track it belongs to. */
  readonly modelOfJoint: readonly number[];
}

/**
 * The skin bound to one geometry, or null where nothing is.
 *
 * **The joints are sorted parents-first here**, because this is also the layer that can remap
 * every index naming one — the mesh's own joint attribute is written from `influences` afterwards.
 * `Skeleton` refuses an unsorted rig rather than sorting it, for exactly that reason.
 */
export function readSkin(
  objects: FbxObjects,
  geometryId: number,
  /**
   * Where the mesh this skin deforms sits, from the node graph.
   *
   * **This is the half a cluster's own `Transform` claims to be and cannot be trusted for.** The
   * SDK documents `Transform` as the mesh's global transform at bind time, which makes it one
   * matrix for the whole skin — and a bought character measured here has **sixty-eight of its
   * sixty-nine weight-bearing clusters disagreeing about it**, each holding something close to the
   * inverse of its own `TransformLink` instead. Composed as documented, the bone's frame goes in
   * twice: the inverse bind for that character's hip came back as a pure translation of
   * `(0, -94.4, +94.4)` where the joint is at `(0, 94.4, 0)`, so inverting it put every joint on a
   * mirror of the skeleton that no geometry occupies.
   *
   * So the mesh's bind transform is taken from the one authority this reader already has for where
   * anything is, which is the same walk every static mesh goes through. It is also what the other
   * readers of this format settle on, and for the same reason.
   */
  meshWorld: readonly number[],
  warnings: string[],
): FbxSkin | null {
  const skinIds: number[] = [];
  for (const [id, node] of objects.byId) {
    if (node.name !== 'Deformer' || node.properties[2] !== 'Skin') continue;
    if ((objects.parentsOf.get(id) ?? []).includes(geometryId)) skinIds.push(id);
  }
  if (skinIds.length === 0) return null;
  if (skinIds.length > 1) {
    warnings.push(
      `fbx: a geometry carries ${skinIds.length} skins and only the first is read; the rest are ` +
        `blend shapes or a second bind, neither of which this reader knows.`,
    );
  }
  const skinId = skinIds[0] as number;

  const clusters: Cluster[] = [];
  for (const [id, node] of objects.byId) {
    if (node.name !== 'Deformer' || node.properties[2] !== 'Cluster') continue;
    if (!(objects.parentsOf.get(id) ?? []).includes(skinId)) continue;
    /* The bone is the cluster's *child* in FBX's direction: it names the cluster as a parent. */
    let bone = -1;
    for (const [candidate, parents] of objects.parentsOf) {
      if (!parents.includes(id)) continue;
      const model = objects.byId.get(candidate);
      if (model?.name === 'Model') {
        bone = candidate;
        break;
      }
    }
    if (bone < 0) continue;
    const indexes = numbers(findChild(node, 'Indexes'));
    const weights = numbers(findChild(node, 'Weights'));
    const transformLink = numbers(findChild(node, 'TransformLink'));
    /*
     * A cluster with no `Indexes` is legal and common: it is a bone in the skeleton that holds no
     * vertices. It still belongs to the skeleton, because a clip drives it and its children hang
     * off it, so it takes a joint with no influences rather than being dropped.
     */
    const link = transformLink === null ? IDENTITY : Array.from(transformLink).slice(0, 16);
    clusters.push({
      bone,
      indexes: indexes ?? [],
      weights: weights ?? [],
      inverseBind: multiply(invert(link), meshWorld),
    });
  }
  if (clusters.length === 0) return null;

  /* Bone id to its parent bone, taking only parents that are themselves models in this skeleton. */
  const bones = new Set(clusters.map((cluster) => cluster.bone));
  const parentBone = new Map<number, number>();
  for (const bone of bones) {
    for (const parent of objects.parentsOf.get(bone) ?? []) {
      if (bones.has(parent)) {
        parentBone.set(bone, parent);
        break;
      }
    }
  }

  /*
   * Parents before children, by a walk from each root rather than by a comparator.
   *
   * "Before its parent" is not a total order, so a sort would have to invent one; visiting a bone
   * only after its parent is what a depth-first walk gives for free. `gltfSkin.ts` reaches the
   * same conclusion in the same words, and the two orders have to agree because both feed the same
   * `Skeleton`.
   */
  const order: number[] = [];
  const placed = new Set<number>();
  const place = (bone: number, depth: number): void => {
    if (placed.has(bone) || depth > 512) return;
    const parent = parentBone.get(bone);
    if (parent !== undefined && !placed.has(parent)) place(parent, depth + 1);
    if (placed.has(bone)) return;
    placed.add(bone);
    order.push(bone);
  };
  for (const bone of bones) place(bone, 0);

  const jointOfBone = new Map<number, number>();
  order.forEach((bone, at) => jointOfBone.set(bone, at));

  const joints: Joint[] = order.map((bone) => {
    const parent = parentBone.get(bone);
    return {
      parent: parent === undefined ? -1 : (jointOfBone.get(parent) ?? -1),
      name: bareName(objects.byId.get(bone)?.properties[1], `joint ${bone}`),
    };
  });

  const inverseBind = new Float32Array(order.length * 16);
  const influences = new Map<number, { joint: number; weight: number }[]>();
  for (const cluster of clusters) {
    const joint = jointOfBone.get(cluster.bone);
    if (joint === undefined) continue;
    inverseBind.set(cluster.inverseBind, joint * 16);
    const count = Math.min(cluster.indexes.length, cluster.weights.length);
    for (let i = 0; i < count; i++) {
      const point = Math.trunc(cluster.indexes[i] as number);
      const weight = cluster.weights[i] as number;
      if (!(weight > 0) || point < 0) continue;
      const list = influences.get(point);
      if (list === undefined) influences.set(point, [{ joint, weight }]);
      else list.push({ joint, weight });
    }
  }

  return { joints, inverseBind, influences, modelOfJoint: order };
}

/**
 * One control point's four influences, largest first, normalised, written into a caller's arrays.
 *
 * **Four is the shader's number and the file's is unbounded.** A rig authored with six influences
 * on a shoulder is ordinary, so the four largest are kept and renormalised rather than the first
 * four taken: dropping by *order* would discard whichever the exporter happened to write last,
 * which on a shoulder is as likely to be the dominant one as not.
 *
 * Returns true where something was dropped or rescaled, so the caller can say so once for the mesh
 * rather than once per vertex.
 */
export function writeInfluences(
  influences: readonly { joint: number; weight: number }[] | undefined,
  joints: Float32Array,
  weights: Float32Array,
  at: number,
): { dropped: boolean; rescaled: boolean } {
  if (influences === undefined || influences.length === 0)
    return { dropped: false, rescaled: false };
  const sorted = [...influences].sort((a, b) => b.weight - a.weight);
  const kept = sorted.slice(0, MAX_INFLUENCES);
  let sum = 0;
  for (const influence of kept) sum += influence.weight;
  if (sum <= 0) return { dropped: false, rescaled: false };
  for (let i = 0; i < kept.length; i++) {
    const influence = kept[i] as { joint: number; weight: number };
    joints[at * MAX_INFLUENCES + i] = influence.joint;
    weights[at * MAX_INFLUENCES + i] = influence.weight / sum;
  }
  let total = 0;
  for (const influence of sorted) total += influence.weight;
  return {
    dropped: sorted.length > MAX_INFLUENCES,
    /* A tenth of a per cent, which is wider than float noise and narrower than an authoring slip. */
    rescaled: Math.abs(total - 1) > 1e-3,
  };
}

/** Euler degrees in the file's default XYZ order, as a quaternion. */
function eulerToQuaternion(x: number, y: number, z: number): [number, number, number, number] {
  const half = Math.PI / 360;
  const cx = Math.cos(x * half);
  const sx = Math.sin(x * half);
  const cy = Math.cos(y * half);
  const sy = Math.sin(y * half);
  const cz = Math.cos(z * half);
  const sz = Math.sin(z * half);
  /* Rz * Ry * Rx, which is what `eEulerXYZ` composes to — the same product `compose` builds in
     `fbx.ts`, and the same trap: written the other way round it turns a limb inside out. */
  return [
    sx * cy * cz + cx * sy * sz,
    cx * sy * cz - sx * cy * sz,
    cx * cy * sz + sx * sy * cz,
    cx * cy * cz - sx * sy * sz,
  ];
}

/** Hamilton product, which is how two rotations compose. */
function multiplyQuaternion(
  a: readonly [number, number, number, number],
  b: readonly [number, number, number, number],
): [number, number, number, number] {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

/** A joint's fixed rotations, which sit either side of the one a curve drives. */
interface RotationFrame {
  readonly pre: [number, number, number, number];
  /** Already conjugated, because FBX's chain uses the *inverse* of the post-rotation. */
  readonly postInverse: [number, number, number, number];
  readonly composed: boolean;
}

const NO_ROTATION: RotationFrame = {
  pre: [0, 0, 0, 1],
  postInverse: [0, 0, 0, 1],
  composed: false,
};

/**
 * A joint's `PreRotation` and `PostRotation`, as the two quaternions the chain needs.
 *
 * **FBX's local rotation is `PreRotation * R * inverse(PostRotation)`**, not `R`. Both are fixed
 * per joint and written on the model rather than in the curve, so a reader that takes the curve
 * alone plays a clip in which every joint carrying one is turned by a constant amount — twenty-nine
 * of eighty-eight on the bought character this was measured against. Every key interpolates, the
 * take runs, and the figure is wrong in a way that reads as a bad export.
 */
function rotationFrame(model: FbxNode | undefined): RotationFrame {
  if (model === undefined) return NO_ROTATION;
  const properties = findChild(model, 'Properties70');
  let pre: [number, number, number, number] | null = null;
  let post: [number, number, number, number] | null = null;
  for (const property of properties?.children ?? []) {
    const name = property.properties[0];
    if (name !== 'PreRotation' && name !== 'PostRotation') continue;
    const x = property.properties[4];
    const y = property.properties[5];
    const z = property.properties[6];
    if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') continue;
    if (x === 0 && y === 0 && z === 0) continue;
    if (name === 'PreRotation') pre = eulerToQuaternion(x, y, z);
    else post = eulerToQuaternion(x, y, z);
  }
  if (pre === null && post === null) return NO_ROTATION;
  return {
    pre: pre ?? [0, 0, 0, 1],
    postInverse: post === null ? [0, 0, 0, 1] : [-post[0], -post[1], -post[2], post[3]],
    composed: true,
  };
}

/** Which of the three transforms an `OP` property name drives, or null for one we do not animate. */
function pathOf(property: string): TrackPath | null {
  if (property === 'Lcl Translation') return 'translation';
  if (property === 'Lcl Rotation') return 'rotation';
  if (property === 'Lcl Scaling') return 'scale';
  return null;
}

/** A curve node's per-channel default, which is the value of a channel nothing curves. */
function channelDefaults(node: FbxNode): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0];
  const properties = findChild(node, 'Properties70');
  for (const property of properties?.children ?? []) {
    const name = property.properties[0];
    const value = property.properties[4];
    if (typeof value !== 'number') continue;
    if (name === 'd|X') out[0] = value;
    else if (name === 'd|Y') out[1] = value;
    else if (name === 'd|Z') out[2] = value;
  }
  return out;
}

/**
 * Every take in the file, as clips over the joints a skin named.
 *
 * **A curve is per channel and a track is per joint**, so the three curves under one curve node are
 * merged onto one timeline: the union of their key times, each channel read at that time. A key a
 * channel does not have is held at its neighbour rather than interpolated, which is what a stepped
 * read of a curve gives and is exact wherever the exporter wrote all three channels together —
 * which is what every exporter does for a joint it is baking.
 *
 * **Rotation arrives as Euler degrees and leaves as a quaternion**, in the file's default XYZ
 * order. A joint carrying a `PreRotation` or a non-default `RotationOrder` is named in a warning
 * rather than approximated: both are silent when read wrongly, and a limb that is ninety degrees
 * out reads as a broken clip rather than as an unread field.
 */
export function readClips(
  objects: FbxObjects,
  jointOfModel: ReadonlyMap<number, number>,
  warnings: string[],
): AnimationClip[] {
  const stacks = [...objects.byId].filter(([, node]) => node.name === 'AnimationStack');
  if (stacks.length === 0) return [];

  /*
   * The one part of the rotation chain that is still not read.
   *
   * `PreRotation` and `PostRotation` are composed below. A `RotationOrder` other than the default
   * `eEulerXYZ` is not: it would change which product the three Euler angles build, and getting it
   * wrong is silent in exactly the way the pre-rotation was. Named rather than approximated.
   */
  const orders = new Set<number>();
  for (const [model] of jointOfModel) {
    const properties = findChild(
      objects.byId.get(model) ?? { name: '', properties: [], children: [] },
      'Properties70',
    );
    for (const property of properties?.children ?? []) {
      if (property.properties[0] !== 'RotationOrder') continue;
      const order = property.properties[4];
      if (typeof order === 'number' && order !== 0) orders.add(order);
    }
  }
  if (orders.size > 0) {
    warnings.push(
      `fbx: joints declare rotation order ${[...orders].sort().join(', ')} and this reader composes ` +
        `the default XYZ only, so their rotations may be wrong. Export as glTF if the clip matters.`,
    );
  }

  const clips: AnimationClip[] = [];
  for (const [stackId, stack] of stacks) {
    /* Layers under the stack, and the curve nodes under those. Only the first layer is read: the
       rest are additive or override layers, which is a blend this reader does not perform. */
    const layers = [...objects.parentsOf]
      .filter(([, parents]) => parents.includes(stackId))
      .map(([id]) => id)
      .filter((id) => objects.byId.get(id)?.name === 'AnimationLayer');
    if (layers.length > 1) {
      warnings.push(
        `fbx: "${bareName(stack.properties[1], 'take')}" has ${layers.length} animation layers ` +
          `and only the first is read; the others would have to be blended.`,
      );
    }
    const layer = layers[0];
    if (layer === undefined) continue;

    const tracks: JointTrack[] = [];
    let duration = 0;

    for (const [curveNodeId, parents] of objects.parentsOf) {
      if (!parents.includes(layer)) continue;
      const curveNode = objects.byId.get(curveNodeId);
      if (curveNode?.name !== 'AnimationCurveNode') continue;

      /* What this node drives, which is an `OP` connection naming the property by its own name. */
      let joint: number | undefined;
      let path: TrackPath | null = null;
      let modelOfTrack = -1;
      for (const target of objects.drives.get(curveNodeId) ?? []) {
        const candidate = jointOfModel.get(target.parent);
        const kind = pathOf(target.property);
        if (candidate !== undefined && kind !== null) {
          joint = candidate;
          path = kind;
          modelOfTrack = target.parent;
          break;
        }
      }
      if (joint === undefined || path === null) continue;

      /* The three channels, each an `AnimationCurve` naming `d|X`, `d|Y` or `d|Z`. */
      const channels: ({ times: number[]; values: number[] } | null)[] = [null, null, null];
      for (const [curveId, targets] of objects.drives) {
        if (objects.byId.get(curveId)?.name !== 'AnimationCurve') continue;
        for (const target of targets) {
          if (target.parent !== curveNodeId) continue;
          const axis =
            target.property === 'd|X'
              ? 0
              : target.property === 'd|Y'
                ? 1
                : target.property === 'd|Z'
                  ? 2
                  : -1;
          if (axis < 0) continue;
          const curve = objects.byId.get(curveId) as FbxNode;
          const times = numbers(findChild(curve, 'KeyTime'));
          const values = numbers(findChild(curve, 'KeyValueFloat'));
          if (times === null || values === null) continue;
          const count = Math.min(times.length, values.length);
          const t: number[] = [];
          const v: number[] = [];
          for (let i = 0; i < count; i++) {
            t.push((times[i] as number) / KTIME_PER_SECOND);
            v.push(values[i] as number);
          }
          channels[axis] = { times: t, values: v };
        }
      }
      if (channels.every((channel) => channel === null)) continue;

      const merged = new Set<number>();
      for (const channel of channels) for (const time of channel?.times ?? []) merged.add(time);
      const times = [...merged].sort((a, b) => a - b);
      if (times.length === 0) continue;
      duration = Math.max(duration, times[times.length - 1] as number);

      const defaults = channelDefaults(curveNode);
      /** A channel's value at a time, held at the last key at or before it. */
      const at = (axis: number, time: number): number => {
        const channel = channels[axis];
        if (channel === null || channel === undefined || channel.times.length === 0) {
          return defaults[axis] as number;
        }
        let index = 0;
        while (index + 1 < channel.times.length && (channel.times[index + 1] as number) <= time)
          index++;
        return channel.values[index] as number;
      };

      const stride = path === 'rotation' ? 4 : 3;
      const frame =
        path === 'rotation' ? rotationFrame(objects.byId.get(modelOfTrack)) : NO_ROTATION;
      const values = new Float32Array(times.length * stride);
      times.forEach((time, key) => {
        const x = at(0, time);
        const y = at(1, time);
        const z = at(2, time);
        if (path !== 'rotation') {
          values.set([x, y, z], key * 3);
          return;
        }
        const curved = eulerToQuaternion(x, y, z);
        values.set(
          frame.composed
            ? multiplyQuaternion(multiplyQuaternion(frame.pre, curved), frame.postInverse)
            : curved,
          key * 4,
        );
      });

      tracks.push({ joint, path, times: new Float32Array(times), values });
    }

    if (tracks.length === 0) continue;
    /* The stack's own stop time where it states one, since a clip may end after its last key. */
    const properties = findChild(stack, 'Properties70');
    for (const property of properties?.children ?? []) {
      if (property.properties[0] !== 'LocalStop') continue;
      const raw = property.properties[4];
      if (typeof raw === 'number') duration = Math.max(duration, raw / KTIME_PER_SECOND);
    }
    /* Sorted, so a clip's tracks are in a stable order whatever order the connection table was in
       — two bakes of one file that differ only in track order are two different `.drft` files. */
    tracks.sort((a, b) => a.joint - b.joint || a.path.localeCompare(b.path));
    clips.push({ name: bareName(stack.properties[1], 'take'), durationSec: duration, tracks });
  }
  return clips;
}
