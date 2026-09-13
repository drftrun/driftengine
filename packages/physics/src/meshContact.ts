import type { Aabb } from './collide/index.ts';
import { fieldCandidates, fieldConvexEdges, fieldCorners, fieldPlane } from './heightfieldShape.ts';
import { collideShapes, createManifold } from './manifold.ts';
import type { Manifold, ShapePose } from './manifold.ts';
import type { ConvexShape } from './shape.ts';
import { shapeBounds } from './shape.ts';

/**
 * Contacts between a convex shape and a static triangle mesh.
 *
 * **Many manifolds, not one, and that is the whole structural difference.** Every other pair in
 * this engine has a single contact plane; a body in the corner of a mesh room has two or three, and
 * reducing them to one would pick a wall and let the body through the others. So this fills a set,
 * and `PhysicsWorld` prepares a constraint per entry — which the solver already supports, because
 * `prepareContact` appends rather than replaces.
 *
 * **Each triangle goes through `collideShapes` unchanged**, as a three-point polytope written into
 * one scratch shape. That is the reuse that makes this small: the separating-axis test, the
 * clipping, the sphere and capsule paths and the cylinder's own module are all exact against a
 * triangle already, and a second implementation of any of them would be a second thing to be wrong.
 * *What it costs* is that the moving shape is transformed into world space once per candidate
 * triangle rather than once per pair — eight vertices times twenty candidates for a box on a floor.
 * *What would make it wrong* is a consumer resting a 64-point hull on a dense mesh, where the
 * answer is to hoist the transform out of `collideShapes` rather than to write a second narrow
 * phase.
 *
 * **Two sources of triangles and one set of rules.** A level's triangles are stored and found
 * through a tree; a heightfield's are generated from four samples and found by index. Everything
 * below is written once for both — the one-sided rule, the many manifolds, the interior-edge
 * filter — and the only thing that differs is where a triangle's corners, plane and edge
 * classification come from. `heightfieldShape.ts` is the other source, and the split is the
 * 2026-08-13 rule applied to the one file here it would be most expensive to have two of.
 *
 * **One-sided.** A contact whose normal points into the back of a triangle is dropped. A level mesh
 * is a surface rather than a solid, so "which side" is the only thing that distinguishes standing
 * on a floor from being pushed up through it, and a two-sided triangle catches anything that has
 * already sunk below it and fires it out the wrong way.
 *
 * **And the interior-edge filter, which is the part that decides whether it feels right.** A box
 * sliding across two coplanar triangles meets their shared edge, where the narrow phase finds an
 * edge normal rather than the face's and shoves the box backwards along it — a character stumbling
 * on a flat floor once a metre. `meshShape` classifies every edge once as convex or not; a normal
 * that came off a non-convex edge is replaced with the face's, and the separation is recomputed
 * from the face plane. *What that gives up:* a genuinely convex ridge still produces its edge
 * normal, which is correct, so a consumer who wants a ridge softened has to bevel it.
 */

/** How many contact planes one pair may produce. A body in a corner needs three; eight is generous. */
export const MAX_MESH_MANIFOLDS = 8;

/** How parallel a contact normal must be to the face before it counts as coming off the face. */
const FACE_DOT = 0.999;

/** The candidate list from the tree, grown rather than capped. */
let candidates = new Int32Array(256);
const region: Aabb = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
const local: Aabb = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
const scratch = createManifold();
const rot = new Float32Array(9);

/**
 * A triangle as a polytope, rewritten per candidate.
 *
 * One face rather than two, which is what makes the pair one-sided at the level below as well:
 * `collideShapes` looks for a reference face and there is only the front one to find.
 */
const TRIANGLE: ConvexShape = {
  vertices: new Float32Array(9),
  faceNormals: new Float32Array(3),
  edgeDirs: new Float32Array(9),
  radius: 0,
  sideRadius: 0,
  boundRadius: 0,
  facePlanes: new Float32Array(4),
  faceVertexStart: new Uint16Array([0, 3]),
  faceVertexIndices: new Uint16Array([0, 1, 2]),
};

/**
 * Whether a shape is a static triangle mesh, which is the one question the dispatch asks.
 *
 * Takes an absent shape as *not* a mesh, because a compound body has no single shape and the
 * dispatch asks about both sides before it knows which kind of pair it has.
 */
export function isMesh(shape: ConvexShape | undefined): boolean {
  return shape?.triangles !== undefined;
}

/**
 * Fill `out` with up to `out.length` manifolds and return how many.
 *
 * `out` is the caller's, allocated once — this runs in the tick. The normal of each manifold points
 * from `shapeA` to `shapeB`, exactly as `collideShapes` promises, whichever of the two is the mesh.
 */
export function collideMesh(
  shapeA: ConvexShape,
  poseA: ShapePose,
  shapeB: ConvexShape,
  poseB: ShapePose,
  margin: number,
  out: readonly Manifold[],
): number {
  const meshIsA = isMesh(shapeA);
  const mesh = (meshIsA ? shapeA : shapeB).triangles;
  if (mesh === undefined) return 0;
  const meshPose = meshIsA ? poseA : poseB;
  const other = meshIsA ? shapeB : shapeA;
  const otherPose = meshIsA ? poseB : poseA;
  /* Two meshes never touch: both are static, so nothing would move if they did. */
  if (isMesh(other)) return 0;

  /*
   * The moving shape's bounds, carried into the mesh's own frame — because the tree is in that
   * frame and rebuilding it per frame is exactly what static means it never has to do. The box is
   * transformed rather than the tree: a rotated box's axis-aligned bounds are a little larger than
   * the shape, which costs a few extra candidates and nothing else.
   */
  shapeBounds(other, region);
  worldRegion(region, otherPose, meshPose, margin, local);
  let found = candidatesFor(mesh, local);
  while (found === candidates.length) {
    candidates = new Int32Array(candidates.length * 2);
    found = candidatesFor(mesh, local);
  }

  let count = 0;
  for (let i = 0; i < found; i++) {
    const triangle = candidates[i] ?? 0;
    if (!writeTriangle(mesh, triangle)) continue;
    /* A to B, with the triangle standing in for the mesh wherever the mesh stood. */
    const hit = meshIsA
      ? collideShapes(TRIANGLE, meshPose, other, otherPose, margin, scratch)
      : collideShapes(other, otherPose, TRIANGLE, meshPose, margin, scratch);
    if (!hit) continue;
    /* The face normal in world, pointing away from the front of the triangle. */
    planeOf(mesh, triangle);
    rotateInto(meshPose, PLANE, 0, FACE);
    /* Mesh-to-body, whichever way the manifold was asked for. */
    const sign = meshIsA ? 1 : -1;
    const away =
      sign * scratch.nx * FACE[0] + sign * scratch.ny * FACE[1] + sign * scratch.nz * FACE[2];
    /* One-sided: a normal pointing into the back of the triangle is a body already through it. */
    if (away <= 0) continue;
    if (away < FACE_DOT) filterInteriorEdge(mesh, triangle, meshPose, sign);

    const target = out[count];
    if (target === undefined) break;
    copyInto(scratch, target, triangle);
    count++;
    if (count === out.length) break;
  }
  return count;
}

/** `[nx, ny, nz]` of the current triangle's world face normal. */
const FACE = new Float64Array(3);
/** The current triangle's plane in the mesh's own frame, from wherever it came. */
const PLANE = new Float32Array(4);
/** The current triangle's three corners, likewise. */
const CORNERS = new Float64Array(9);

/**
 * The candidates a box could touch: a tree query for a level, an index range for a field.
 *
 * Both fill to `candidates.length` and stop, so the caller's grow-and-retry loop is the same one
 * either way.
 */
function candidatesFor(mesh: NonNullable<ConvexShape['triangles']>, local: Aabb): number {
  if (mesh.field !== undefined) return fieldCandidates(mesh.field, local, candidates);
  return mesh.tree?.query(local, candidates) ?? 0;
}

/** The current triangle's plane into `PLANE`: read for a level, computed for a field. */
function planeOf(mesh: NonNullable<ConvexShape['triangles']>, triangle: number): void {
  if (mesh.field !== undefined) {
    fieldPlane(mesh.field, triangle, PLANE_SCRATCH);
    PLANE[0] = PLANE_SCRATCH[0] ?? 0;
    PLANE[1] = PLANE_SCRATCH[1] ?? 0;
    PLANE[2] = PLANE_SCRATCH[2] ?? 0;
    PLANE[3] = PLANE_SCRATCH[3] ?? 0;
    return;
  }
  PLANE[0] = mesh.planes[triangle * 4] ?? 0;
  PLANE[1] = mesh.planes[triangle * 4 + 1] ?? 0;
  PLANE[2] = mesh.planes[triangle * 4 + 2] ?? 0;
  PLANE[3] = mesh.planes[triangle * 4 + 3] ?? 0;
}

const PLANE_SCRATCH = new Float64Array(4);

/** The current triangle's corners into `CORNERS`, in the mesh's own frame. */
function cornersOf(mesh: NonNullable<ConvexShape['triangles']>, triangle: number): void {
  if (mesh.field !== undefined) {
    fieldCorners(mesh.field, triangle, CORNERS);
    return;
  }
  for (let k = 0; k < 3; k++) {
    const index = mesh.indices[triangle * 3 + k] ?? 0;
    CORNERS[k * 3] = mesh.positions[index * 3] ?? 0;
    CORNERS[k * 3 + 1] = mesh.positions[index * 3 + 1] ?? 0;
    CORNERS[k * 3 + 2] = mesh.positions[index * 3 + 2] ?? 0;
  }
}

/** Which of a triangle's edges may produce a normal: stored for a level, computed for a field. */
function convexEdgesOf(mesh: NonNullable<ConvexShape['triangles']>, triangle: number): number {
  if (mesh.field !== undefined) return fieldConvexEdges(mesh.field, triangle);
  return mesh.convexEdges[triangle] ?? 0;
}

/** One corner of a triangle, in world. */
function worldCorner(
  mesh: NonNullable<ConvexShape['triangles']>,
  triangle: number,
  corner: number,
  pose: ShapePose,
  out: Float64Array,
  at: number,
): void {
  cornersOf(mesh, triangle);
  poseRotation(pose);
  const x = CORNERS[corner * 3] ?? 0;
  const y = CORNERS[corner * 3 + 1] ?? 0;
  const z = CORNERS[corner * 3 + 2] ?? 0;
  out[at] = (rot[0] ?? 0) * x + (rot[1] ?? 0) * y + (rot[2] ?? 0) * z + pose.x;
  out[at + 1] = (rot[3] ?? 0) * x + (rot[4] ?? 0) * y + (rot[5] ?? 0) * z + pose.y;
  out[at + 2] = (rot[6] ?? 0) * x + (rot[7] ?? 0) * y + (rot[8] ?? 0) * z + pose.z;
}

/**
 * Replace an edge normal with the face's, where the edge it came off is not a real one.
 *
 * The deepest contact point decides which edge, by distance to each of the three in the triangle's
 * own plane — a vertex contact falls to whichever of its two edges is nearer, and both are treated
 * the same way, which is what the filter wants.
 *
 * The separations are recomputed from the face plane rather than scaled, because the direction has
 * changed and a scaled depth would hold a body off the floor by the cosine of an angle nobody
 * chose.
 */
function filterInteriorEdge(
  mesh: NonNullable<ConvexShape['triangles']>,
  triangle: number,
  meshPose: ShapePose,
  sign: number,
): void {
  let deepest = 0;
  for (let i = 1; i < scratch.count; i++) {
    if ((scratch.separations[i] ?? 0) < (scratch.separations[deepest] ?? 0)) deepest = i;
  }
  const px = scratch.points[deepest * 3] ?? 0;
  const py = scratch.points[deepest * 3 + 1] ?? 0;
  const pz = scratch.points[deepest * 3 + 2] ?? 0;

  let nearest = 0;
  let best = Infinity;
  for (let e = 0; e < 3; e++) {
    worldCorner(mesh, triangle, e, meshPose, EDGE, 0);
    worldCorner(mesh, triangle, (e + 1) % 3, meshPose, EDGE, 3);
    const distance = pointSegmentSquared(px, py, pz);
    if (distance < best) {
      best = distance;
      nearest = e;
    }
  }
  /* A convex edge is a real one: the ridge is there and the body should feel it. */
  if ((convexEdgesOf(mesh, triangle) >> nearest) & 1) return;

  scratch.nx = sign * FACE[0];
  scratch.ny = sign * FACE[1];
  scratch.nz = sign * FACE[2];
  worldPlaneAnchor(mesh, triangle, meshPose, ANCHOR);
  const plane = FACE[0] * ANCHOR[0] + FACE[1] * ANCHOR[1] + FACE[2] * ANCHOR[2];
  for (let i = 0; i < scratch.count; i++) {
    scratch.separations[i] =
      (scratch.points[i * 3] ?? 0) * FACE[0] +
      (scratch.points[i * 3 + 1] ?? 0) * FACE[1] +
      (scratch.points[i * 3 + 2] ?? 0) * FACE[2] -
      plane;
  }
}

const EDGE = new Float64Array(6);
const ANCHOR = new Float64Array(3);

function pointSegmentSquared(px: number, py: number, pz: number): number {
  const ax = EDGE[0];
  const ay = EDGE[1];
  const az = EDGE[2];
  const ex = EDGE[3] - ax;
  const ey = EDGE[4] - ay;
  const ez = EDGE[5] - az;
  const ee = ex * ex + ey * ey + ez * ez;
  let t = ee > 1e-12 ? ((px - ax) * ex + (py - ay) * ey + (pz - az) * ez) / ee : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - (ax + ex * t);
  const dy = py - (ay + ey * t);
  const dz = pz - (az + ez * t);
  return dx * dx + dy * dy + dz * dz;
}

/** Write one triangle into the scratch shape. Returns false for a degenerate one. */
function writeTriangle(mesh: NonNullable<ConvexShape['triangles']>, triangle: number): boolean {
  planeOf(mesh, triangle);
  const nx = PLANE[0] ?? 0;
  const ny = PLANE[1] ?? 0;
  const nz = PLANE[2] ?? 0;
  if (nx === 0 && ny === 0 && nz === 0) return false;

  cornersOf(mesh, triangle);
  const v = TRIANGLE.vertices;
  for (let k = 0; k < 9; k++) v[k] = CORNERS[k] ?? 0;
  TRIANGLE.faceNormals[0] = nx;
  TRIANGLE.faceNormals[1] = ny;
  TRIANGLE.faceNormals[2] = nz;
  TRIANGLE.facePlanes[0] = nx;
  TRIANGLE.facePlanes[1] = ny;
  TRIANGLE.facePlanes[2] = nz;
  TRIANGLE.facePlanes[3] = PLANE[3] ?? 0;
  for (let e = 0; e < 3; e++) {
    const j = (e + 1) % 3;
    TRIANGLE.edgeDirs[e * 3] = (v[j * 3] ?? 0) - (v[e * 3] ?? 0);
    TRIANGLE.edgeDirs[e * 3 + 1] = (v[j * 3 + 1] ?? 0) - (v[e * 3 + 1] ?? 0);
    TRIANGLE.edgeDirs[e * 3 + 2] = (v[j * 3 + 2] ?? 0) - (v[e * 3 + 2] ?? 0);
  }
  return true;
}

/**
 * Copy a manifold out of the scratch, folding the triangle into every feature id.
 *
 * **Warm starting is why the triangle has to be in the id.** Impulses persist across ticks by
 * feature id, and two triangles under one body produce the same clipping features — so without
 * this a box on a seam would hand triangle A's accumulated impulse to triangle B every tick, which
 * reads as a stack that will not settle.
 */
function copyInto(from: Manifold, to: Manifold, triangle: number): void {
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
    to.featureIds[i] = (((triangle & 0xffff) << 12) ^ (from.featureIds[i] ?? 0)) | 0;
  }
}

/** The triangle's first corner, in world, which is a point the face plane passes through. */
function worldPlaneAnchor(
  mesh: NonNullable<ConvexShape['triangles']>,
  triangle: number,
  pose: ShapePose,
  out: Float64Array,
): void {
  worldCorner(mesh, triangle, 0, pose, out, 0);
}

/** Rotate a direction out of a packed array into `out`. */
function rotateInto(pose: ShapePose, source: Float32Array, at: number, out: Float64Array): void {
  poseRotation(pose);
  const x = source[at] ?? 0;
  const y = source[at + 1] ?? 0;
  const z = source[at + 2] ?? 0;
  out[0] = (rot[0] ?? 0) * x + (rot[1] ?? 0) * y + (rot[2] ?? 0) * z;
  out[1] = (rot[3] ?? 0) * x + (rot[4] ?? 0) * y + (rot[5] ?? 0) * z;
  out[2] = (rot[6] ?? 0) * x + (rot[7] ?? 0) * y + (rot[8] ?? 0) * z;
}

/**
 * The moving shape's world bounds, expressed in the mesh's frame and grown by the margin.
 *
 * Eight corners through the inverse of the mesh's pose, re-bounded: a rotated box's axis-aligned
 * bounds in another frame are larger than the shape, which costs a few candidates the narrow phase
 * then rejects and is far cheaper than transforming the geometry.
 */
function worldRegion(
  bounds: Aabb,
  otherPose: ShapePose,
  meshPose: ShapePose,
  margin: number,
  out: Aabb,
): void {
  out.minX = Infinity;
  out.minY = Infinity;
  out.minZ = Infinity;
  out.maxX = -Infinity;
  out.maxY = -Infinity;
  out.maxZ = -Infinity;
  for (let corner = 0; corner < 8; corner++) {
    const x = corner & 1 ? bounds.maxX : bounds.minX;
    const y = corner & 2 ? bounds.maxY : bounds.minY;
    const z = corner & 4 ? bounds.maxZ : bounds.minZ;
    /* Out of the shape's own frame into the world, then into the mesh's. */
    poseRotation(otherPose);
    const wx = (rot[0] ?? 0) * x + (rot[1] ?? 0) * y + (rot[2] ?? 0) * z + otherPose.x;
    const wy = (rot[3] ?? 0) * x + (rot[4] ?? 0) * y + (rot[5] ?? 0) * z + otherPose.y;
    const wz = (rot[6] ?? 0) * x + (rot[7] ?? 0) * y + (rot[8] ?? 0) * z + otherPose.z;
    unrotate(meshPose, wx - meshPose.x, wy - meshPose.y, wz - meshPose.z, ANCHOR);
    out.minX = Math.min(out.minX, ANCHOR[0]);
    out.minY = Math.min(out.minY, ANCHOR[1]);
    out.minZ = Math.min(out.minZ, ANCHOR[2]);
    out.maxX = Math.max(out.maxX, ANCHOR[0]);
    out.maxY = Math.max(out.maxY, ANCHOR[1]);
    out.maxZ = Math.max(out.maxZ, ANCHOR[2]);
  }
  out.minX -= margin;
  out.minY -= margin;
  out.minZ -= margin;
  out.maxX += margin;
  out.maxY += margin;
  out.maxZ += margin;
}

function poseRotation(p: ShapePose): void {
  const { qx: x, qy: y, qz: z, qw: w } = p;
  rot[0] = 1 - 2 * (y * y + z * z);
  rot[1] = 2 * (x * y - z * w);
  rot[2] = 2 * (x * z + y * w);
  rot[3] = 2 * (x * y + z * w);
  rot[4] = 1 - 2 * (x * x + z * z);
  rot[5] = 2 * (y * z - x * w);
  rot[6] = 2 * (x * z - y * w);
  rot[7] = 2 * (y * z + x * w);
  rot[8] = 1 - 2 * (x * x + y * y);
}

function unrotate(p: ShapePose, x: number, y: number, z: number, out: Float64Array): void {
  const qx = -p.qx;
  const qy = -p.qy;
  const qz = -p.qz;
  const qw = p.qw;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  out[0] = x + qw * tx + (qy * tz - qz * ty);
  out[1] = y + qw * ty + (qz * tx - qx * tz);
  out[2] = z + qw * tz + (qx * ty - qy * tx);
}
