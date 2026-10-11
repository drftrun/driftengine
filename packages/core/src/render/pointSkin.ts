/**
 * A mesh posed on the device from weighted points in its joints' own spaces: the data, its checks,
 * and the bounds a pose is culled by. Each backend's binding poses the vertices.
 *
 * **What it is for.** Some formats store a vertex as up to four points, each in the space of a
 * joint, with a weight each and a normal in the space of the first: posed, the vertex is the
 * weighted sum of each point moved by its joint. That is not ordinary skinning, which moves one
 * bind-pose position by a blend of joints, so a rig of that kind had to be posed on the main thread
 * and its positions uploaded every frame. Reported at 38% of the main thread's drawing time.
 * Posed on the device into a dynamic mesh's own buffers, the main thread hands over the joints.
 *
 * **Into a dynamic mesh rather than in the vertex stage**, because a skinned vertex stage has no
 * attribute left for four more points, and every pass that draws a mesh would need a variant that
 * reads them: lit, cast, glass, motion. Posed once into the mesh's positions and normals, it is an
 * ordinary dynamic mesh to every one of them, motion vectors included. What it costs is the mesh's
 * two buffers, written a pose, and a pass that runs before the draws.
 *
 * **The bounds are a box of spheres, not the posed vertices**, which the CPU never sees. Each joint
 * reaches as far as the farthest point a weighted influence holds in its space, scaled by its
 * largest axis; a weighted sum of points inside those spheres lies inside their box, scaled by the
 * least and greatest sums of a vertex's weights. Conservative, so it culls nothing visible; loose
 * by the joints' reach where a mesh is long and thin, which culls a little less than it could.
 */
import type { Bounds } from '../math/bounds.ts';
import { MAX_JOINTS } from './skinPalette.ts';

/** A point skin, one entry a vertex unless said otherwise. */
export interface PointSkinData {
  /** Four joint indices a vertex, as floats, as `MeshData.joints` is. */
  readonly joints: Float32Array;
  /** Four weights a vertex. An influence of weight 0 is skipped, whatever its joint and point. */
  readonly weights: Float32Array;
  /** Four points a vertex, three floats each: influence `k`'s point in joint `k`'s own space. */
  readonly points: Float32Array;
  /** One normal a vertex, in the space of its first joint. */
  readonly normals: Float32Array;
}

/** How far a skin reaches from each joint, and what its weights sum to: what a pose's bounds need. */
export interface PointSkinReach {
  /** Joints a pose must hand over: one past the highest any vertex names and uses. */
  readonly joints: number;
  /** For each joint, the farthest point a weighted influence holds in its space; -1 where none. */
  readonly reach: Float32Array;
  /** The least and the greatest sum of one vertex's weights. */
  readonly sums: readonly [number, number];
}

/** Refuse a skin whose arrays disagree with a mesh of `vertices`, or that names a joint past the rest. */
export function validatePointSkin(data: PointSkinData, vertices: number): void {
  const fail = (what: string): never => {
    throw new Error(`point skin: ${what}`);
  };
  for (const [name, values, width] of [
    ['joints', data.joints, 4],
    ['weights', data.weights, 4],
    ['points', data.points, 12],
    ['normals', data.normals, 3],
  ] as const) {
    if (values.length !== vertices * width) {
      fail(`${name} holds ${values.length / width} vertices and the mesh has ${vertices}`);
    }
  }
  for (let at = 0; at < data.joints.length; at++) {
    const joint = data.joints[at] as number;
    if (!(Number.isInteger(joint) && joint >= 0 && joint < MAX_JOINTS)) {
      fail(`vertex ${Math.floor(at / 4)} names joint ${joint}; a joint is 0 to ${MAX_JOINTS - 1}`);
    }
  }
}

/** Measure a skin's reach once, at creation. */
export function reachOf(data: PointSkinData): PointSkinReach {
  const reach = new Float32Array(MAX_JOINTS).fill(-1);
  let joints = 0;
  let least = Infinity;
  let most = -Infinity;
  const vertices = data.weights.length / 4;
  for (let v = 0; v < vertices; v++) {
    /* The first joint carries the normal, so it is named whatever its weight. */
    joints = Math.max(joints, (data.joints[v * 4] as number) + 1);
    let sum = 0;
    for (let k = 0; k < 4; k++) {
      const weight = data.weights[v * 4 + k] as number;
      if (weight === 0) continue;
      sum += weight;
      const joint = data.joints[v * 4 + k] as number;
      joints = Math.max(joints, joint + 1);
      const at = (v * 4 + k) * 3;
      const x = data.points[at] as number;
      const y = data.points[at + 1] as number;
      const z = data.points[at + 2] as number;
      reach[joint] = Math.max(reach[joint] as number, Math.sqrt(x * x + y * y + z * z));
    }
    least = Math.min(least, sum);
    most = Math.max(most, sum);
  }
  return {
    joints,
    reach: reach.slice(0, joints),
    sums: vertices === 0 ? [1, 1] : [least, most],
  };
}

/**
 * The bounds of a pose, into the mesh's own: `matrices` holds each joint's transform into the
 * mesh's model space, sixteen floats, column-major. Allocates nothing.
 */
export function poseBounds(matrices: Float32Array, skin: PointSkinReach, out: Bounds): void {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let j = 0; j < skin.joints; j++) {
    const reach = skin.reach[j] as number;
    if (reach < 0) continue;
    const m = j * 16;
    const scale = Math.sqrt(
      Math.max(
        columnLength2(matrices, m),
        columnLength2(matrices, m + 4),
        columnLength2(matrices, m + 8),
      ),
    );
    const r = reach * scale;
    const x = matrices[m + 12] as number;
    const y = matrices[m + 13] as number;
    const z = matrices[m + 14] as number;
    minX = Math.min(minX, x - r);
    minY = Math.min(minY, y - r);
    minZ = Math.min(minZ, z - r);
    maxX = Math.max(maxX, x + r);
    maxY = Math.max(maxY, y + r);
    maxZ = Math.max(maxZ, z + r);
  }
  if (minX > maxX) {
    out.min.fill(0);
    out.max.fill(0);
    out.centre.fill(0);
    out.radius = 0;
    return;
  }
  /* A sum of weights other than one scales the box about the origin, by the least and the most. */
  const [least, most] = skin.sums;
  out.min[0] = Math.min(least * minX, most * minX);
  out.min[1] = Math.min(least * minY, most * minY);
  out.min[2] = Math.min(least * minZ, most * minZ);
  out.max[0] = Math.max(least * maxX, most * maxX);
  out.max[1] = Math.max(least * maxY, most * maxY);
  out.max[2] = Math.max(least * maxZ, most * maxZ);
  let radius2 = 0;
  for (let axis = 0; axis < 3; axis++) {
    const centre = ((out.min[axis] as number) + (out.max[axis] as number)) / 2;
    out.centre[axis] = centre;
    const half = (out.max[axis] as number) - centre;
    radius2 += half * half;
  }
  out.radius = Math.sqrt(radius2);
}

/** The squared length of one column's first three components. */
function columnLength2(m: Float32Array, at: number): number {
  const x = m[at] as number;
  const y = m[at + 1] as number;
  const z = m[at + 2] as number;
  return x * x + y * y + z * z;
}

/** Refuse a pose that hands over fewer joints than the skin names. */
export function validatePose(matrices: Float32Array, skin: PointSkinReach): void {
  if (matrices.length % 16 !== 0 || matrices.length / 16 < skin.joints) {
    throw new Error(
      `point skin: a pose of ${matrices.length / 16} joints for a skin that names ${skin.joints}`,
    );
  }
}
