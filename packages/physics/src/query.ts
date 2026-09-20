import { BODY_STATIC } from './bodies.ts';
import type { BodySet } from './bodies.ts';
import { closestOnCylinder, isCylinder, readCylinder } from './cylinder.ts';
import { faceCount } from './faces.ts';
import type { Aabb } from './collide/index.ts';
import { collideShapes, createManifold } from './manifold.ts';
import { fieldCandidates, fieldCorners, fieldPlane } from './heightfieldShape.ts';
import { collideMesh, isMesh } from './meshContact.ts';
import type { ShapePose } from './manifold.ts';
import type { ConvexShape } from './shape.ts';
import { DynamicTree } from './tree.ts';

/**
 * Asking the world questions: rays, shape sweeps and overlaps.
 *
 * **Nothing allocates.** Every result fills a caller-owned object, and a multi-hit query fills a
 * caller-supplied array to its length and returns a count — so a query in a tick costs no garbage.
 *
 * **Ties break by body index**, which is the same rule the pair list follows and is here for the
 * same reason: an answer decided by which proxy the tree reached first is an answer decided by
 * insertion history. **No test pins it**, and that is worth saying rather than leaving somebody to
 * look: two distinct bodies can only sit at the identical ray distance if they are coincident, and
 * the tree has never been observed to enumerate coincident proxies out of index order — so a bare
 * `<=` passes every variation tried. One comparison buys the guarantee by construction instead.
 *
 * A shapecast is conservative advancement over the same distance query the manifold code uses,
 * capped at a fixed iteration count. **What that gives up** is exactness at a grazing angle, where
 * advancement converges slowly and the cap stops it early — the hit is then reported slightly late.
 * **What would make it wrong** is a consumer relying on a sweep for precise placement rather than
 * for a first touch; the answer then is a root-find on the separation, which costs more per query.
 */

/** What a ray or a sweep found. Caller-owned; a query fills it and never allocates one. */
export interface RayHit {
  body: number;
  /** Fraction along the ray or sweep, in [0, 1]. */
  fraction: number;
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
}

export function createRayHit(): RayHit {
  return { body: -1, fraction: 1, x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0 };
}

/** Which bodies a query is allowed to see. */
export interface QueryFilter {
  /** The querier's own layer, tested against each body's mask. */
  layer?: number;
  /** Which layers the querier wants, tested against each body's layer. */
  mask?: number;
  /** A body to ignore, usually the one asking. */
  ignore?: number;
}

const HITS_START = 256;
let hits = new Int32Array(HITS_START);
const box: Aabb = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
const poseA: ShapePose = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 };
const poseB: ShapePose = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 };
const manifold = createManifold();
/**
 * One manifold for a mesh answer, because both callers here want one plane rather than the set.
 *
 * An overlap is a yes or a no, and a shapecast advances against the nearest surface it can see.
 * The full set is `PhysicsWorld`'s business, where every plane becomes a constraint.
 */
const MESH_ONE = [createManifold()] as const;

/**
 * Manifolds a sweep against a mesh gathers before it decides how far it may advance.
 *
 * **Which triangle stopped a sweep is not a question one manifold can answer.** `collideMesh` fills
 * its output in the order the tree hands triangles over, and the sweep read one of them — so near a
 * crease, where a wall meets a floor, a downward sweep was answered with the wall's horizontal
 * normal and nothing stopped the fall. Found by the first test of `CharacterController` against a
 * triangle mesh: a capsule on a captured room's floor sank straight through it, while the same
 * floor **on its own** held it, because adding the walls changed which triangle came back first.
 * Sixteen is far more than a sweep meets at once, and the one facing back along the travel is the
 * one in the way.
 */
const MESH_SET = [
  createManifold(),
  createManifold(),
  createManifold(),
  createManifold(),
  createManifold(),
  createManifold(),
  createManifold(),
  createManifold(),
  createManifold(),
  createManifold(),
  createManifold(),
  createManifold(),
  createManifold(),
  createManifold(),
  createManifold(),
  createManifold(),
] as const;

function copyManifold(from: typeof manifold, to: typeof manifold): void {
  to.nx = from.nx;
  to.ny = from.ny;
  to.nz = from.nz;
  to.count = from.count;
  to.curvedA = from.curvedA;
  to.curvedB = from.curvedB;
  to.points.set(from.points);
  to.separations.set(from.separations);
  to.featureIds.set(from.featureIds);
}

function admits(bodies: BodySet, i: number, filter: QueryFilter | undefined): boolean {
  if (!filter) return true;
  if (filter.ignore === i) return false;
  const layer = filter.layer ?? 0xffffffff;
  const mask = filter.mask ?? 0xffffffff;
  return ((bodies.layer[i] ?? 0) & mask) !== 0 && ((bodies.mask[i] ?? 0) & layer) !== 0;
}

/** Every body whose bounds the tree says could overlap `region`. Grows the scratch as needed. */
function candidates(tree: DynamicTree, region: Aabb): number {
  let found = tree.query(region, hits);
  while (found === hits.length) {
    hits = new Int32Array(hits.length * 2);
    found = tree.query(region, hits);
  }
  return found;
}

function readPose(bodies: BodySet, i: number, out: ShapePose): void {
  out.x = bodies.posX[i] ?? 0;
  out.y = bodies.posY[i] ?? 0;
  out.z = bodies.posZ[i] ?? 0;
  out.qx = bodies.rotX[i] ?? 0;
  out.qy = bodies.rotY[i] ?? 0;
  out.qz = bodies.rotZ[i] ?? 0;
  out.qw = bodies.rotW[i] ?? 1;
}

/**
 * The nearest body a ray meets, or `false` if it meets none.
 *
 * A ray starting *inside* a body reports that body at fraction zero, with the normal of the face it
 * is nearest to leaving through. Reporting nothing instead is the tempting alternative and is worse:
 * a line-of-sight test would then say a wall it started inside was not there.
 */
export function raycastWorld(
  bodies: BodySet,
  tree: DynamicTree,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDistance: number,
  out: RayHit,
  filter?: QueryFilter,
): boolean {
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len === 0 || maxDistance <= 0) return false;
  const ux = dx / len;
  const uy = dy / len;
  const uz = dz / len;
  const ex = ox + ux * maxDistance;
  const ey = oy + uy * maxDistance;
  const ez = oz + uz * maxDistance;
  box.minX = Math.min(ox, ex);
  box.minY = Math.min(oy, ey);
  box.minZ = Math.min(oz, ez);
  box.maxX = Math.max(ox, ex);
  box.maxY = Math.max(oy, ey);
  box.maxZ = Math.max(oz, ez);

  const n = candidates(tree, box);
  out.body = -1;
  out.fraction = 1;
  let best = Infinity;
  for (let k = 0; k < n; k++) {
    const i = hits[k] ?? 0;
    if (!admits(bodies, i, filter)) continue;
    const shape = bodies.shape[i];
    if (!shape) continue;
    readPose(bodies, i, poseA);
    if (!rayShape(shape, poseA, ox, oy, oz, ux, uy, uz, maxDistance)) continue;
    if (RAY[0] < best || (RAY[0] === best && i < out.body)) {
      best = RAY[0];
      out.body = i;
      out.fraction = RAY[0] / maxDistance;
      out.x = ox + ux * RAY[0];
      out.y = oy + uy * RAY[0];
      out.z = oz + uz * RAY[0];
      out.nx = RAY[1];
      out.ny = RAY[2];
      out.nz = RAY[3];
    }
  }
  return out.body >= 0;
}

/** `[distance, nx, ny, nz]` of the last ray test. */
const RAY = new Float64Array(4);
const WORLD_PLANES = new Float32Array(64 * 4);

/**
 * Slab test against a convex shape's world face planes, with the rounding radius folded in.
 *
 * A shape with no faces is a sphere or a capsule and takes the segment-to-segment path instead,
 * which is what its radius makes it.
 */
function rayShape(
  shape: ConvexShape,
  pose: ShapePose,
  ox: number,
  oy: number,
  oz: number,
  ux: number,
  uy: number,
  uz: number,
  maxDistance: number,
): boolean {
  if (shape.triangles !== undefined) {
    return rayMesh(shape, pose, ox, oy, oz, ux, uy, uz, maxDistance);
  }
  if (isCylinder(shape)) return rayCylinder(shape, pose, ox, oy, oz, ux, uy, uz, maxDistance);
  const faces = faceCount(shape);
  if (faces === 0) return rayRound(shape, pose, ox, oy, oz, ux, uy, uz, maxDistance);

  worldPlanes(shape, pose, faces);
  let enter = 0;
  let exit = maxDistance;
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let f = 0; f < faces; f++) {
    const px = WORLD_PLANES[f * 4] ?? 0;
    const py = WORLD_PLANES[f * 4 + 1] ?? 0;
    const pz = WORLD_PLANES[f * 4 + 2] ?? 0;
    const d = (WORLD_PLANES[f * 4 + 3] ?? 0) + shape.radius;
    const denom = px * ux + py * uy + pz * uz;
    const dist = px * ox + py * oy + pz * oz - d;
    if (denom === 0) {
      if (dist > 0) return false;
      continue;
    }
    const t = -dist / denom;
    if (denom < 0) {
      if (t > enter) {
        enter = t;
        nx = px;
        ny = py;
        nz = pz;
      }
    } else if (t < exit) {
      exit = t;
    }
    if (enter > exit) return false;
  }
  if (enter > maxDistance) return false;
  RAY[0] = enter;
  if (enter === 0) {
    // Started inside: the nearest face's outward normal is the honest answer.
    let nearest = 0;
    let best = -Infinity;
    for (let f = 0; f < faces; f++) {
      const v =
        (WORLD_PLANES[f * 4] ?? 0) * ox +
        (WORLD_PLANES[f * 4 + 1] ?? 0) * oy +
        (WORLD_PLANES[f * 4 + 2] ?? 0) * oz -
        (WORLD_PLANES[f * 4 + 3] ?? 0);
      if (v > best) {
        best = v;
        nearest = f;
      }
    }
    nx = WORLD_PLANES[nearest * 4] ?? 0;
    ny = WORLD_PLANES[nearest * 4 + 1] ?? 0;
    nz = WORLD_PLANES[nearest * 4 + 2] ?? 0;
  }
  RAY[1] = nx;
  RAY[2] = ny;
  RAY[3] = nz;
  return true;
}

/**
 * A ray against a cylinder: a quadratic against the infinite side, and two discs for the caps.
 *
 * **Closed form rather than the march `rayRound` uses**, and the reason is that a cylinder has one.
 * A capsule's distance field has no root a quadratic can find, so that function halves its way in
 * at a fixed iteration count; a cylinder's side is a quadratic in the ray parameter and its caps
 * are two plane intersections with one radial test each. Exact, and cheaper.
 *
 * A ray starting inside reports zero distance and the nearest surface's outward normal, which is
 * the same answer `rayShape` gives for a polytope and is what a caller asking "what am I in"
 * needs.
 */
function rayCylinder(
  shape: ConvexShape,
  pose: ShapePose,
  ox: number,
  oy: number,
  oz: number,
  ux: number,
  uy: number,
  uz: number,
  maxDistance: number,
): boolean {
  readCylinder(shape, pose, CYL);
  const cx = CYL[0] ?? 0;
  const cy = CYL[1] ?? 0;
  const cz = CYL[2] ?? 0;
  const ax = CYL[3] ?? 0;
  const ay = CYL[4] ?? 0;
  const az = CYL[5] ?? 0;
  const h = CYL[6] ?? 0;
  const r = (CYL[7] ?? 0) + shape.radius;

  closestOnCylinder(CYL, ox, oy, oz, INSIDE);
  if (INSIDE[6] <= shape.radius) {
    RAY[0] = 0;
    RAY[1] = INSIDE[3];
    RAY[2] = INSIDE[4];
    RAY[3] = INSIDE[5];
    return true;
  }

  const dx = ox - cx;
  const dy = oy - cy;
  const dz = oz - cz;
  const dAlong = dx * ax + dy * ay + dz * az;
  const uAlong = ux * ax + uy * ay + uz * az;
  const dpx = dx - ax * dAlong;
  const dpy = dy - ay * dAlong;
  const dpz = dz - az * dAlong;
  const upx = ux - ax * uAlong;
  const upy = uy - ay * uAlong;
  const upz = uz - az * uAlong;

  let best = Infinity;
  let nx = 0;
  let ny = 1;
  let nz = 0;

  const qa = upx * upx + upy * upy + upz * upz;
  if (qa > 1e-12) {
    const qb = 2 * (dpx * upx + dpy * upy + dpz * upz);
    const qc = dpx * dpx + dpy * dpy + dpz * dpz - r * r;
    const disc = qb * qb - 4 * qa * qc;
    if (disc >= 0) {
      const root = Math.sqrt(disc);
      for (let i = 0; i < 2; i++) {
        const t = (i === 0 ? -qb - root : -qb + root) / (2 * qa);
        if (t < 0 || t >= best) continue;
        const along = dAlong + uAlong * t;
        if (Math.abs(along) > h) continue;
        const px = dpx + upx * t;
        const py = dpy + upy * t;
        const pz = dpz + upz * t;
        const len = Math.sqrt(px * px + py * py + pz * pz) || 1;
        best = t;
        nx = px / len;
        ny = py / len;
        nz = pz / len;
      }
    }
  }

  // The two caps: a plane each, kept only where the crossing is inside the disc.
  if (Math.abs(uAlong) > 1e-12) {
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? 1 : -1;
      const t = (side * h - dAlong) / uAlong;
      if (t < 0 || t >= best) continue;
      const px = dpx + upx * t;
      const py = dpy + upy * t;
      const pz = dpz + upz * t;
      if (px * px + py * py + pz * pz > r * r) continue;
      best = t;
      nx = ax * side;
      ny = ay * side;
      nz = az * side;
    }
  }

  if (best > maxDistance) return false;
  RAY[0] = best;
  RAY[1] = nx;
  RAY[2] = ny;
  RAY[3] = nz;
  return true;
}

const CYL = new Float64Array(11);
const INSIDE = new Float64Array(7);

/**
 * A ray against a static triangle mesh: the segment's own box against the tree, then every
 * candidate.
 *
 * **The tree is queried with the whole segment's bounds rather than walked**, and that is a cost
 * stated rather than hidden: a long ray across a large mesh returns candidates along a box that is
 * mostly empty, where a descent testing the ray against each node's box would return a handful.
 * *What it buys* is that nothing new had to be built — `DynamicTree.query` is the tested thing this
 * package already has. *What would make it wrong* is a consumer casting long rays through a dense
 * level every frame, at which point the tree grows a ray descent and this calls it instead.
 *
 * Möller-Trumbore per triangle, which needs only the arithmetic the determinism gate permits: four
 * cross products, three dots and one divide, with no transcendental anywhere. **Two-sided here**,
 * unlike the contact path: a ray is a question about geometry rather than a body being pushed, and
 * a line-of-sight test that saw through a wall from behind would be a worse answer than one that
 * did not.
 */
function rayMesh(
  shape: ConvexShape,
  pose: ShapePose,
  ox: number,
  oy: number,
  oz: number,
  ux: number,
  uy: number,
  uz: number,
  maxDistance: number,
): boolean {
  const mesh = shape.triangles;
  if (mesh === undefined) return false;
  /* The ray in the mesh's own frame, because the tree is in that frame. */
  unrotatePose(pose, ox - pose.x, oy - pose.y, oz - pose.z, RAY_LOCAL, 0);
  unrotatePose(pose, ux, uy, uz, RAY_LOCAL, 3);
  const lx = RAY_LOCAL[0];
  const ly = RAY_LOCAL[1];
  const lz = RAY_LOCAL[2];
  const dx = RAY_LOCAL[3];
  const dy = RAY_LOCAL[4];
  const dz = RAY_LOCAL[5];
  const ex = lx + dx * maxDistance;
  const ey = ly + dy * maxDistance;
  const ez = lz + dz * maxDistance;
  box.minX = Math.min(lx, ex);
  box.minY = Math.min(ly, ey);
  box.minZ = Math.min(lz, ez);
  box.maxX = Math.max(lx, ex);
  box.maxY = Math.max(ly, ey);
  box.maxZ = Math.max(lz, ez);
  /* A tree for a level, an index range for a heightfield. Both fill to the buffer's length and
     stop, so the grow-and-retry is the same either way. See `heightfieldShape.ts`. */
  const ask = (): number =>
    mesh.field !== undefined
      ? fieldCandidates(mesh.field, box, hits)
      : (mesh.tree?.query(box, hits) ?? 0);
  let found = ask();
  while (found === hits.length) {
    hits = new Int32Array(hits.length * 2);
    found = ask();
  }

  let best = maxDistance;
  let triangle = -1;
  for (let i = 0; i < found; i++) {
    const t = hits[i] ?? 0;
    const distance = rayTriangle(mesh, t, lx, ly, lz, dx, dy, dz);
    if (distance >= 0 && distance < best) {
      best = distance;
      triangle = t;
    }
  }
  if (triangle < 0) return false;

  RAY[0] = best;
  /* The face normal, turned to face the ray: a hit from behind reports the side it was hit on. */
  trianglePlane(mesh, triangle, RAY_PLANE);
  rotatePose(pose, RAY_PLANE[0] ?? 0, RAY_PLANE[1] ?? 0, RAY_PLANE[2] ?? 0, RAY_LOCAL, 6);
  const facing = RAY_LOCAL[6] * ux + RAY_LOCAL[7] * uy + RAY_LOCAL[8] * uz;
  const sign = facing > 0 ? -1 : 1;
  RAY[1] = RAY_LOCAL[6] * sign;
  RAY[2] = RAY_LOCAL[7] * sign;
  RAY[3] = RAY_LOCAL[8] * sign;
  return true;
}

const RAY_LOCAL = new Float64Array(9);
/** The current triangle's plane and corners, from whichever source the shape has. */
const RAY_PLANE = new Float64Array(4);
const RAY_CORNERS = new Float64Array(9);

/** A triangle's plane: read for a level, computed for a heightfield. */
function trianglePlane(
  mesh: NonNullable<ConvexShape['triangles']>,
  triangle: number,
  out: Float64Array,
): void {
  if (mesh.field !== undefined) {
    fieldPlane(mesh.field, triangle, out);
    return;
  }
  out[0] = mesh.planes[triangle * 4] ?? 0;
  out[1] = mesh.planes[triangle * 4 + 1] ?? 0;
  out[2] = mesh.planes[triangle * 4 + 2] ?? 0;
  out[3] = mesh.planes[triangle * 4 + 3] ?? 0;
}

/** A triangle's three corners, likewise. */
function triangleCorners(
  mesh: NonNullable<ConvexShape['triangles']>,
  triangle: number,
  out: Float64Array,
): void {
  if (mesh.field !== undefined) {
    fieldCorners(mesh.field, triangle, out);
    return;
  }
  for (let k = 0; k < 3; k++) {
    const index = mesh.indices[triangle * 3 + k] ?? 0;
    out[k * 3] = mesh.positions[index * 3] ?? 0;
    out[k * 3 + 1] = mesh.positions[index * 3 + 1] ?? 0;
    out[k * 3 + 2] = mesh.positions[index * 3 + 2] ?? 0;
  }
}

/** Möller-Trumbore. Returns the distance along the ray, or −1 for a miss. */
function rayTriangle(
  mesh: NonNullable<ConvexShape['triangles']>,
  triangle: number,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
): number {
  triangleCorners(mesh, triangle, RAY_CORNERS);
  const ax = RAY_CORNERS[0] ?? 0;
  const ay = RAY_CORNERS[1] ?? 0;
  const az = RAY_CORNERS[2] ?? 0;
  const e1x = (RAY_CORNERS[3] ?? 0) - ax;
  const e1y = (RAY_CORNERS[4] ?? 0) - ay;
  const e1z = (RAY_CORNERS[5] ?? 0) - az;
  const e2x = (RAY_CORNERS[6] ?? 0) - ax;
  const e2y = (RAY_CORNERS[7] ?? 0) - ay;
  const e2z = (RAY_CORNERS[8] ?? 0) - az;

  const px = dy * e2z - dz * e2y;
  const py = dz * e2x - dx * e2z;
  const pz = dx * e2y - dy * e2x;
  const determinant = e1x * px + e1y * py + e1z * pz;
  /* Parallel to the plane, from either side: no crossing to report. */
  if (determinant > -1e-12 && determinant < 1e-12) return -1;
  const inverse = 1 / determinant;

  const tx = ox - ax;
  const ty = oy - ay;
  const tz = oz - az;
  const u = (tx * px + ty * py + tz * pz) * inverse;
  if (u < 0 || u > 1) return -1;

  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inverse;
  if (v < 0 || u + v > 1) return -1;

  const distance = (e2x * qx + e2y * qy + e2z * qz) * inverse;
  return distance >= 0 ? distance : -1;
}

function rotatePose(
  p: ShapePose,
  x: number,
  y: number,
  z: number,
  out: Float64Array,
  at: number,
): void {
  const tx = 2 * (p.qy * z - p.qz * y);
  const ty = 2 * (p.qz * x - p.qx * z);
  const tz = 2 * (p.qx * y - p.qy * x);
  out[at] = x + p.qw * tx + (p.qy * tz - p.qz * ty);
  out[at + 1] = y + p.qw * ty + (p.qz * tx - p.qx * tz);
  out[at + 2] = z + p.qw * tz + (p.qx * ty - p.qy * tx);
}

function unrotatePose(
  p: ShapePose,
  x: number,
  y: number,
  z: number,
  out: Float64Array,
  at: number,
): void {
  const qx = -p.qx;
  const qy = -p.qy;
  const qz = -p.qz;
  const qw = p.qw;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  out[at] = x + qw * tx + (qy * tz - qz * ty);
  out[at + 1] = y + qw * ty + (qz * tx - qx * tz);
  out[at + 2] = z + qw * tz + (qx * ty - qy * tx);
}

/** A ray against a sphere or a capsule: the closest approach to its segment against the radius. */
function rayRound(
  shape: ConvexShape,
  pose: ShapePose,
  ox: number,
  oy: number,
  oz: number,
  ux: number,
  uy: number,
  uz: number,
  maxDistance: number,
): boolean {
  const count = shape.vertices.length / 3;
  rotatePoint(shape, pose, 0, SEG, 0);
  if (count > 1) rotatePoint(shape, pose, 1, SEG, 3);
  else {
    SEG[3] = SEG[0];
    SEG[4] = SEG[1];
    SEG[5] = SEG[2];
  }
  // March the ray, halving the step whenever it would pass through. Fixed count, no tolerance loop.
  let t = 0;
  for (let step = 0; step < 32; step++) {
    const px = ox + ux * t;
    const py = oy + uy * t;
    const pz = oz + uz * t;
    const d = pointSegmentDistance(px, py, pz) - shape.radius;
    if (d < 1e-4) {
      RAY[0] = t;
      const cx = px - CLOSE[0];
      const cy = py - CLOSE[1];
      const cz = pz - CLOSE[2];
      const cl = Math.sqrt(cx * cx + cy * cy + cz * cz) || 1;
      RAY[1] = cx / cl;
      RAY[2] = cy / cl;
      RAY[3] = cz / cl;
      return true;
    }
    t += d;
    if (t > maxDistance) return false;
  }
  return false;
}

const SEG = new Float64Array(6);
const CLOSE = new Float64Array(3);

function pointSegmentDistance(px: number, py: number, pz: number): number {
  const ax = SEG[0];
  const ay = SEG[1];
  const az = SEG[2];
  const bx = SEG[3] - ax;
  const by = SEG[4] - ay;
  const bz = SEG[5] - az;
  const bb = bx * bx + by * by + bz * bz;
  let s = 0;
  if (bb > 1e-12) {
    s = ((px - ax) * bx + (py - ay) * by + (pz - az) * bz) / bb;
    s = s < 0 ? 0 : s > 1 ? 1 : s;
  }
  CLOSE[0] = ax + bx * s;
  CLOSE[1] = ay + by * s;
  CLOSE[2] = az + bz * s;
  const dx = px - CLOSE[0];
  const dy = py - CLOSE[1];
  const dz = pz - CLOSE[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function rotatePoint(
  shape: ConvexShape,
  pose: ShapePose,
  index: number,
  out: Float64Array,
  at: number,
): void {
  const x = shape.vertices[index * 3] ?? 0;
  const y = shape.vertices[index * 3 + 1] ?? 0;
  const z = shape.vertices[index * 3 + 2] ?? 0;
  const tx = 2 * (pose.qy * z - pose.qz * y);
  const ty = 2 * (pose.qz * x - pose.qx * z);
  const tz = 2 * (pose.qx * y - pose.qy * x);
  out[at] = x + pose.qw * tx + (pose.qy * tz - pose.qz * ty) + pose.x;
  out[at + 1] = y + pose.qw * ty + (pose.qz * tx - pose.qx * tz) + pose.y;
  out[at + 2] = z + pose.qw * tz + (pose.qx * ty - pose.qy * tx) + pose.z;
}

function worldPlanes(shape: ConvexShape, pose: ShapePose, faces: number): void {
  const { qx, qy, qz, qw } = pose;
  const r0 = 1 - 2 * (qy * qy + qz * qz);
  const r1 = 2 * (qx * qy - qz * qw);
  const r2 = 2 * (qx * qz + qy * qw);
  const r3 = 2 * (qx * qy + qz * qw);
  const r4 = 1 - 2 * (qx * qx + qz * qz);
  const r5 = 2 * (qy * qz - qx * qw);
  const r6 = 2 * (qx * qz - qy * qw);
  const r7 = 2 * (qy * qz + qx * qw);
  const r8 = 1 - 2 * (qx * qx + qy * qy);
  for (let f = 0; f < faces; f++) {
    const x = shape.facePlanes[f * 4] ?? 0;
    const y = shape.facePlanes[f * 4 + 1] ?? 0;
    const z = shape.facePlanes[f * 4 + 2] ?? 0;
    const d = shape.facePlanes[f * 4 + 3] ?? 0;
    const nx = r0 * x + r1 * y + r2 * z;
    const ny = r3 * x + r4 * y + r5 * z;
    const nz = r6 * x + r7 * y + r8 * z;
    WORLD_PLANES[f * 4] = nx;
    WORLD_PLANES[f * 4 + 1] = ny;
    WORLD_PLANES[f * 4 + 2] = nz;
    // A plane through a rotated point at the same offset, translated onto the pose.
    WORLD_PLANES[f * 4 + 3] = d + nx * pose.x + ny * pose.y + nz * pose.z;
  }
}

/**
 * Every body overlapping a shape at a pose. Fills `out` to its length and returns how many.
 *
 * A return equal to `out.length` means the buffer filled, and the caller has been told about that
 * many rather than about all of them. Returning the true total instead would invite a loop over
 * entries that were never written.
 */
export function overlapWorld(
  bodies: BodySet,
  tree: DynamicTree,
  shape: ConvexShape,
  pose: ShapePose,
  out: Int32Array,
  filter?: QueryFilter,
): number {
  const r = shape.boundRadius;
  box.minX = pose.x - r;
  box.minY = pose.y - r;
  box.minZ = pose.z - r;
  box.maxX = pose.x + r;
  box.maxY = pose.y + r;
  box.maxZ = pose.z + r;
  const n = candidates(tree, box);
  let found = 0;
  // Ascending body index, because the tree's order is insertion history.
  for (let i = 0; i < bodies.count && found < out.length; i++) {
    let seen = false;
    for (let k = 0; k < n; k++) {
      if (hits[k] === i) {
        seen = true;
        break;
      }
    }
    if (!seen || !admits(bodies, i, filter)) continue;
    const other = bodies.shape[i];
    if (!other) continue;
    readPose(bodies, i, poseB);
    /* A mesh answers through its own path, which fills a set; overlap only needs "any". */
    const touching =
      isMesh(shape) || isMesh(other)
        ? collideMesh(shape, pose, other, poseB, 0, MESH_ONE) > 0
        : collideShapes(shape, pose, other, poseB, 0, manifold);
    if (touching) out[found++] = i;
  }
  return found;
}

/**
 * Sweep a shape from one point to another and report the first body it touches.
 *
 * Conservative advancement: step by the current separation, which cannot overshoot a contact, and
 * stop after a fixed number of steps. A fixed count rather than a tolerance, because §3a forbids
 * iterating to one.
 */
export function shapecastWorld(
  bodies: BodySet,
  tree: DynamicTree,
  shape: ConvexShape,
  pose: ShapePose,
  dx: number,
  dy: number,
  dz: number,
  out: RayHit,
  filter?: QueryFilter,
): boolean {
  const travel = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (travel === 0) return false;
  const r = shape.boundRadius;
  box.minX = Math.min(pose.x, pose.x + dx) - r;
  box.minY = Math.min(pose.y, pose.y + dy) - r;
  box.minZ = Math.min(pose.z, pose.z + dz) - r;
  box.maxX = Math.max(pose.x, pose.x + dx) + r;
  box.maxY = Math.max(pose.y, pose.y + dy) + r;
  box.maxZ = Math.max(pose.z, pose.z + dz) + r;
  const n = candidates(tree, box);

  out.body = -1;
  out.fraction = 1;
  let best = Infinity;
  const startX = pose.x;
  const startY = pose.y;
  const startZ = pose.z;
  for (let k = 0; k < n; k++) {
    const i = hits[k] ?? 0;
    if (!admits(bodies, i, filter)) continue;
    const other = bodies.shape[i];
    if (!other) continue;
    readPose(bodies, i, poseB);
    let t = 0;
    let touched = false;
    let brushing = false;
    for (let step = 0; step < 24; step++) {
      poseA.x = startX + dx * t;
      poseA.y = startY + dy * t;
      poseA.z = startZ + dz * t;
      poseA.qx = pose.qx;
      poseA.qy = pose.qy;
      poseA.qz = pose.qz;
      poseA.qw = pose.qw;
      /*
       * A mesh fills a set and the advance wants the *nearest* plane, which is the deepest
       * separation of the first entry the tree returned — good enough for a conservative step,
       * since a step short of the true one converges rather than missing.
       */
      if (isMesh(shape) || isMesh(other)) {
        /*
         * **Asked for within the travel that is left, not within everything.** The margin inflates
         * the tree query's box, so a margin of a billion metres makes every triangle of the mesh a
         * candidate — which is both the whole mesh's cost per step and the reason the set that came
         * back was arbitrary. Nothing further away than the sweep can reach can stop it.
         */
        const reach = travel * (1 - t) + 1e-4;
        const met = collideMesh(shape, poseA, other, poseB, reach, MESH_SET);
        if (met === 0) break;
        /*
         * **Two different questions, and one manifold cannot answer both.** How far the sweep may
         * advance is bounded by the *nearest* surface, whichever way it faces. Which surface
         * *stopped* it is the nearest one facing back along the travel — and near a crease, where a
         * wall meets a floor, those are not the same triangle. Answering the first for both is what
         * made a capsule walking at a captured step sink through the floor: the wall beside it was
         * always the nearer contact, so every downward sweep reported a horizontal normal and
         * nothing ever stopped the fall. On box bodies, which have one manifold, the same walk is
         * fine — which is why this only ever showed on a mesh.
         */
        let blocking = -1;
        let into = 1e-9;
        for (let m = 0; m < met; m++) {
          const held = MESH_SET[m];
          if (held === undefined) continue;
          if ((held.separations[0] ?? 0) >= 1e-4) continue;
          const opposes = dx * held.nx + dy * held.ny + dz * held.nz;
          if (opposes > into) {
            into = opposes;
            blocking = m;
          }
        }
        const chosen = MESH_SET[blocking >= 0 ? blocking : 0];
        if (chosen === undefined) break;
        copyManifold(chosen, manifold);
      } else if (!collideShapes(shape, poseA, other, poseB, 1e9, manifold)) break;
      const gap = manifold.separations[0] ?? 0;
      if (gap < 1e-4) {
        /*
         * A shape already touching a surface it is travelling *along* has not run into it.
         *
         * Without this, a character resting on the floor is reported as blocked at fraction zero by
         * every horizontal sweep, and never moves. `manifold.n` points from the swept shape into the
         * body, so travel into it is a positive dot; zero or negative is brushing past.
         */
        if (step === 0 && dx * manifold.nx + dy * manifold.ny + dz * manifold.nz <= 1e-9) {
          brushing = true;
          break;
        }
        touched = true;
        break;
      }
      t += gap / travel;
      if (t > 1) break;
    }
    if (brushing || !touched || t > 1) continue;
    if (t < best || (t === best && i < out.body)) {
      best = t;
      out.body = i;
      out.fraction = t;
      out.x = startX + dx * t;
      out.y = startY + dy * t;
      out.z = startZ + dz * t;
      /*
       * The **surface** normal, pointing out of the body toward the sweeper, which is the same
       * convention `raycastWorld` answers in. `manifold.n` points the other way — from the swept
       * shape into the body — and returning that made every caller that used both queries read a
       * floor as a wall.
       */
      out.nx = -manifold.nx;
      out.ny = -manifold.ny;
      out.nz = -manifold.nz;
    }
  }
  return out.body >= 0;
}

/** Whether a body is one a query should treat as scenery. */
export function isStaticBody(bodies: BodySet, i: number): boolean {
  return bodies.type[i] === BODY_STATIC;
}
