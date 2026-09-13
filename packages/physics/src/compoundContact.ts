import type { Aabb } from './collide/index.ts';
import type { Manifold, ShapePose } from './manifold.ts';
import { collideShapes, createManifold } from './manifold.ts';
import { MAX_MESH_MANIFOLDS, collideMesh, isMesh } from './meshContact.ts';
import type { ConvexShape } from './shape.ts';
import { shapeBounds } from './shape.ts';
/**
 * The most parts one body may be made of.
 *
 * **It lives here rather than beside `decomposeConvex`, and that is a measurement rather than a
 * preference.** It was declared in `decompose.ts`, which is offline and which nothing in a frame
 * should reach; importing one integer from there put the whole decomposition — the voxeliser, the
 * flood fill, the merge, the direction table — into every bundle that touches the physics runtime.
 * `physics-only` moved outside its 3% band and an A/B against this one import line was what said so.
 *
 * A constant about how many shapes a body may hold is a fact about bodies. `decompose.ts` imports it
 * from here to cap `maxHulls`, which is the direction the dependency should have run in from the
 * start.
 */
export const MAX_BODY_PARTS = 32;

/**
 * A body made of several convex shapes, against whatever it meets.
 *
 * **The half of convex decomposition that lives in the tick.** `decomposeConvex` turns a concave
 * mesh into hulls offline; without this there is nowhere for them to go, because `BodySet.shape`
 * holds one shape per body and a decomposed body would have to become several bodies held together
 * by joints. `world.ts`'s own refusal message said the runtime already accepted hulls, and it did
 * not.
 *
 * **A part carries no offset and no rotation, and that is not a simplification.** A `ConvexShape` is
 * a point cloud in the body's frame — `shape.ts` says so where it defines `vertices` — so a
 * decomposition's parts are already where they belong. The kinematic `Body.parts` carries `ox/oy/oz`
 * because it wraps shapes a caller built at the origin and placed afterwards; nothing here does
 * that, and a field that is always zero is a field that is eventually set wrong.
 *
 * **This fills a set of manifolds where an ordinary pair fills one**, which is the shape
 * `meshContact.ts` established: `prepareContact` appends a constraint rather than replacing one and
 * `storeWarm` accumulates by pair, so the solver needed nothing new.
 */

/**
 * How many contact planes one pair may produce.
 *
 * **The same number as `MAX_BODY_PARTS`, so a compound against a single convex shape can never
 * overflow**: every part gets a plane. Two compounds can, at up to 32 by 32 part pairs against 32
 * slots, and the overflow rule there is the mesh path's — stop when the set is full. That is the one
 * place in this design where a contact can be dropped without anybody being told, and what would
 * make it matter is two 32-part bodies interpenetrating deeply.
 */
export const MAX_PAIR_MANIFOLDS = MAX_BODY_PARTS;

/** Whether a body is made of parts rather than of one shape. */
export function isCompound(
  parts: readonly ConvexShape[] | undefined,
): parts is readonly ConvexShape[] {
  return parts !== undefined;
}

/** How many shapes a body presents to the narrow phase, whichever way it is built. */
export function partCount(
  shape: ConvexShape | undefined,
  parts: readonly ConvexShape[] | undefined,
): number {
  if (parts !== undefined) return parts.length;
  return shape === undefined ? 0 : 1;
}

/** One of them, by index. */
export function partAt(
  shape: ConvexShape | undefined,
  parts: readonly ConvexShape[] | undefined,
  index: number,
): ConvexShape {
  if (parts !== undefined) return parts[index] as ConvexShape;
  return shape as ConvexShape;
}

/**
 * The largest distance from a body's own origin to any point of any part.
 *
 * What `boundsOf` needs, and it is a maximum rather than a sum because every part is already in the
 * body's frame: a part built off to one side carries that offset inside its own `boundRadius`.
 */
export function partsBoundRadius(parts: readonly ConvexShape[]): number {
  let radius = 0;
  for (const part of parts) if (part.boundRadius > radius) radius = part.boundRadius;
  return radius;
}

/** Scratch spheres, one per part of each side, so pruning allocates nothing. */
const SPHERES_A = new Float64Array(MAX_BODY_PARTS * 4);
const SPHERES_B = new Float64Array(MAX_BODY_PARTS * 4);
const LOCAL: Aabb = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
const SCRATCH: Manifold = createManifold();
const MESH_SCRATCH: readonly Manifold[] = Array.from(
  { length: MAX_MESH_MANIFOLDS },
  createManifold,
);

/**
 * A bounding sphere per part, in world, so the pair loop is a distance test and not a full collide.
 *
 * Computed once for each side of a pair rather than once per part pair: with 32 parts a side that is
 * 64 bound computations instead of 1,024 of them. `shapeBounds` reads a part's own points, which are
 * in the body frame, so the centre only has to be carried through the pose.
 */
function fillSpheres(
  shape: ConvexShape | undefined,
  parts: readonly ConvexShape[] | undefined,
  pose: ShapePose,
  out: Float64Array,
): number {
  const count = partCount(shape, parts);
  for (let i = 0; i < count; i++) {
    const part = partAt(shape, parts, i);
    shapeBounds(part, LOCAL);
    const cx = (LOCAL.minX + LOCAL.maxX) * 0.5;
    const cy = (LOCAL.minY + LOCAL.maxY) * 0.5;
    const cz = (LOCAL.minZ + LOCAL.maxZ) * 0.5;
    const hx = (LOCAL.maxX - LOCAL.minX) * 0.5;
    const hy = (LOCAL.maxY - LOCAL.minY) * 0.5;
    const hz = (LOCAL.maxZ - LOCAL.minZ) * 0.5;
    rotate(pose, cx, cy, cz, out, i * 4);
    out[i * 4] = (out[i * 4] as number) + pose.x;
    out[i * 4 + 1] = (out[i * 4 + 1] as number) + pose.y;
    out[i * 4 + 2] = (out[i * 4 + 2] as number) + pose.z;
    out[i * 4 + 3] = Math.sqrt(hx * hx + hy * hy + hz * hz);
  }
  return count;
}

/** A vector through a pose's rotation, written into `out` at `at`. */
function rotate(
  pose: ShapePose,
  x: number,
  y: number,
  z: number,
  out: Float64Array,
  at: number,
): void {
  const { qx, qy, qz, qw } = pose;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  out[at] = x + qw * tx + (qy * tz - qz * ty);
  out[at + 1] = y + qw * ty + (qz * tx - qx * tz);
  out[at + 2] = z + qw * tz + (qx * ty - qy * tx);
}

/**
 * Every touching pair of parts, as one manifold each.
 *
 * **A mesh partner is the pair this row exists for**, and it gets a rule of its own. A decomposed
 * body falling onto a level is a dynamic compound against a static mesh, so refusing it would refuse
 * the case. Each part goes through `collideMesh` unchanged, and the budget is divided between the
 * parts that find candidates, **never below one each**. That is a deliberate departure from the mesh
 * path's own first-come rule: `collideMesh` stops at eight and drops the rest, which is defensible
 * when the ninth candidate is a triangle and indefensible when it is a whole limb of the body — one
 * leg of a chair sinking through a floor while the other three hold.
 */
export function collideCompound(
  shapeA: ConvexShape | undefined,
  partsA: readonly ConvexShape[] | undefined,
  poseA: ShapePose,
  shapeB: ConvexShape | undefined,
  partsB: readonly ConvexShape[] | undefined,
  poseB: ShapePose,
  margin: number,
  out: readonly Manifold[],
): number {
  const countA = fillSpheres(shapeA, partsA, poseA, SPHERES_A);
  const countB = fillSpheres(shapeB, partsB, poseB, SPHERES_B);
  if (countA === 0 || countB === 0) return 0;

  /*
   * A mesh has no parts and never moves, so it is always the other side of the pair. Its budget is
   * shared out below rather than spent by whichever part is tried first.
   */
  const meshSide =
    countA === 1 && isMesh(partAt(shapeA, partsA, 0))
      ? 0
      : countB === 1 && isMesh(partAt(shapeB, partsB, 0))
        ? 1
        : -1;
  if (meshSide >= 0) {
    return collideCompoundMesh(
      meshSide === 0 ? shapeB : shapeA,
      meshSide === 0 ? partsB : partsA,
      meshSide === 0 ? poseB : poseA,
      partAt(meshSide === 0 ? shapeA : shapeB, meshSide === 0 ? partsA : partsB, 0),
      meshSide === 0 ? poseA : poseB,
      meshSide === 0,
      margin,
      out,
    );
  }

  let count = 0;
  for (let i = 0; i < countA && count < out.length; i++) {
    const ax = SPHERES_A[i * 4] as number;
    const ay = SPHERES_A[i * 4 + 1] as number;
    const az = SPHERES_A[i * 4 + 2] as number;
    const ar = (SPHERES_A[i * 4 + 3] as number) + margin;
    const shapeI = partAt(shapeA, partsA, i);
    for (let j = 0; j < countB && count < out.length; j++) {
      const dx = (SPHERES_B[j * 4] as number) - ax;
      const dy = (SPHERES_B[j * 4 + 1] as number) - ay;
      const dz = (SPHERES_B[j * 4 + 2] as number) - az;
      const reach = ar + (SPHERES_B[j * 4 + 3] as number);
      if (dx * dx + dy * dy + dz * dz > reach * reach) continue;
      const shapeJ = partAt(shapeB, partsB, j);
      if (!collideShapes(shapeI, poseA, shapeJ, poseB, margin, SCRATCH)) continue;
      copyInto(SCRATCH, out[count] as Manifold, partKey(i, j));
      count++;
    }
  }
  return count;
}

/** Every part of a compound against one static triangle mesh, sharing the manifold budget. */
function collideCompoundMesh(
  shape: ConvexShape | undefined,
  parts: readonly ConvexShape[] | undefined,
  pose: ShapePose,
  mesh: ConvexShape,
  meshPose: ShapePose,
  meshIsA: boolean,
  margin: number,
  out: readonly Manifold[],
): number {
  const count = partCount(shape, parts);
  /*
   * At least one slot each, and the remainder shared. A part that touches the mesh always gets a
   * contact plane; a part that touches it in three places gets three only if the budget allows.
   */
  const share = Math.max(1, Math.floor(out.length / Math.max(1, count)));
  let filled = 0;
  for (let i = 0; i < count && filled < out.length; i++) {
    const part = partAt(shape, parts, i);
    /*
     * The scratch set is passed whole and the *copy* is what the share limits — slicing it here
     * would allocate an array per part per pair, in the tick, which is the one thing this package
     * does not do.
     */
    const found = meshIsA
      ? collideMesh(mesh, meshPose, part, pose, margin, MESH_SCRATCH)
      : collideMesh(part, pose, mesh, meshPose, margin, MESH_SCRATCH);
    const room = Math.min(found, share, out.length - filled);
    for (let m = 0; m < room && filled < out.length; m++) {
      copyInto(MESH_SCRATCH[m] as Manifold, out[filled] as Manifold, partKey(i, 0));
      filled++;
    }
  }
  return filled;
}

/**
 * The two part indices, folded into one number the feature id can carry.
 *
 * `meshContact.ts` folds a triangle index into every feature id for the same reason: warm starting
 * pairs an accumulated impulse to a contact by identity, and a body resting across two parts would
 * otherwise hand one part's impulse to the other on the tick a contact moves between them.
 */
function partKey(a: number, b: number): number {
  return a * MAX_BODY_PARTS + b;
}

/** A manifold copied into the pair's set, with the part pair folded into every feature id. */
function copyInto(from: Manifold, to: Manifold, key: number): void {
  to.nx = from.nx;
  to.ny = from.ny;
  to.nz = from.nz;
  to.count = from.count;
  to.curvedA = from.curvedA;
  to.curvedB = from.curvedB;
  for (let i = 0; i < from.count; i++) {
    to.points[i * 3] = from.points[i * 3] ?? 0;
    to.points[i * 3 + 1] = from.points[i * 3 + 1] ?? 0;
    to.points[i * 3 + 2] = from.points[i * 3 + 2] ?? 0;
    to.separations[i] = from.separations[i] ?? 0;
    to.featureIds[i] = (((key & 0xffff) << 12) ^ (from.featureIds[i] ?? 0)) | 0;
  }
}
