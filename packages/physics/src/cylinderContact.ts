import {
  CAP_POINTS,
  closestOnCylinder,
  cylinderFeature,
  cylinderMin,
  cylinderSupport,
  isCylinder,
  readCylinder,
} from './cylinder.ts';
import { faceCount, faceVertices } from './faces.ts';
import type { Manifold, ShapePose } from './manifold.ts';
import type { ConvexShape } from './shape.ts';

/**
 * Contact manifolds where one of the two shapes is a cylinder.
 *
 * **Three cases, like `manifold.ts`'s own three, and the split is what makes each exact.** A
 * cylinder has a curved side that no enumerated axis points along, so the separating-axis list
 * cannot be read off the shape the way a polytope's is. What replaces it is a list built *against
 * the other shape* — its faces, its edges crossed with the axis, and the radial and rim directions
 * of each of its vertices — with the cylinder's own support answering every one of them exactly.
 * That is the difference between this and the n-gon prism it replaces: a prism's support is exact
 * only at its own vertices, and a rolling wheel spends most of its time between them.
 *
 * - **against a sphere or a capsule** is the closest point on the cylinder to each of the one or
 *   two points the round shape is built on, which needs no axis list at all;
 * - **against a polytope** is that axis list, then the touching feature — cap disc, side line or
 *   rim point — clipped against the polytope's incident face;
 * - **against another cylinder** is four axes and the same feature clipping on both sides.
 *
 * **What the axis list gives up**, said plainly because it is the one approximation here: an edge
 * of the polytope cutting across the *rim circle* between two of its own vertices is covered by
 * the rim directions of those vertices rather than by an axis of its own, so a very long edge
 * meeting a very small rim at a shallow angle can report a normal a fraction of a degree off.
 * **What would make it wrong** is a consumer resting cylinders on thin rails, where the answer is
 * a per-edge closest-approach to the rim circle, which costs a quartic solve per edge.
 *
 * **The cost, so nobody has to guess.** A cylinder against a box is 6 face axes, 1 cap axis, 24
 * edge crosses and 16 vertex axes, each folding a support over 8 vertices — about 400 multiply-adds
 * before any clipping, against roughly 100 for box against box. A wheel is worth it; a world of
 * cylinders is what `sideRadius` on a hull would not have been.
 */

const CYL_A = new Float64Array(11);
const CYL_B = new Float64Array(11);
const CLOSEST = new Float64Array(7);

/** The polytope's points and face planes in world space. `hullShape` caps a shape at 64 points. */
const POLY_W = new Float64Array(64 * 3);
const POLY_P = new Float64Array(64 * 4);
const LOOP = new Uint16Array(64);

/**
 * A supporting feature: a cap's eight points, a side's two, or a rim's one. Two buffers, because
 * cylinder against cylinder has a feature on each side — and 32 points rather than eight, because
 * `clampFaceIntoCap` borrows the second one to carry a polytope face's loop.
 */
const FEAT_A = new Float64Array(32 * 3);
const FEAT_B = new Float64Array(32 * 3);
const FEAT_A_ID = new Int32Array(32);
const FEAT_B_ID = new Int32Array(32);

/** Clipping ping-pongs between these; a face may add a vertex per side plane it cuts. */
const CLIP_IN = new Float64Array(32 * 3);
const CLIP_OUT = new Float64Array(32 * 3);
const CLIP_IN_ID = new Int32Array(32);
const CLIP_OUT_ID = new Int32Array(32);

/** The winning separating axis of the last test, and its separation. */
let satSep = 0;
let satNx = 0;
let satNy = 1;
let satNz = 0;
/** How many world points and planes the polytope currently in `POLY_W` has. */
let polyPoints = 0;
let polyFaces = 0;

/**
 * Fill `out` for a pair where at least one shape is a cylinder. Returns whether they are within
 * `margin` of touching, exactly as `collideShapes` does — this is that function's fourth case.
 */
export function collideCylinder(
  shapeA: ConvexShape,
  poseA: ShapePose,
  shapeB: ConvexShape,
  poseB: ShapePose,
  margin: number,
  out: Manifold,
): boolean {
  out.count = 0;
  const radii = shapeA.radius + shapeB.radius;
  if (isCylinder(shapeA) && isCylinder(shapeB)) {
    readCylinder(shapeA, poseA, CYL_A);
    readCylinder(shapeB, poseB, CYL_B);
    return cylinderCylinder(margin, radii, out);
  }
  const cylinderIsA = isCylinder(shapeA);
  const other = cylinderIsA ? shapeB : shapeA;
  const otherPose = cylinderIsA ? poseB : poseA;
  readCylinder(cylinderIsA ? shapeA : shapeB, cylinderIsA ? poseA : poseB, CYL_A);
  // Everything below points cylinder-to-other; the manifold's normal points A-to-B.
  const flipped = !cylinderIsA;
  if (faceCount(other) === 0) return cylinderRound(other, otherPose, margin, radii, out, flipped);
  return cylinderPolytope(other, otherPose, margin, radii, out, flipped);
}

/* ---------- against a sphere or a capsule ---------- */

function cylinderRound(
  round: ConvexShape,
  pose: ShapePose,
  margin: number,
  radii: number,
  out: Manifold,
  flipped: boolean,
): boolean {
  const points = round.vertices.length / 3;
  const capacity = out.separations.length;
  let count = 0;
  let bestSep = Infinity;
  let nx = 0;
  let ny = 1;
  let nz = 0;
  for (let p = 0; p < points && count < capacity; p++) {
    rotate(
      pose,
      round.vertices[p * 3] ?? 0,
      round.vertices[p * 3 + 1] ?? 0,
      round.vertices[p * 3 + 2] ?? 0,
    );
    closestOnCylinder(CYL_A, ROT[0] + pose.x, ROT[1] + pose.y, ROT[2] + pose.z, CLOSEST);
    const separation = CLOSEST[6] - radii;
    if (separation > margin) continue;
    const sx = flipped ? -CLOSEST[3] : CLOSEST[3];
    const sy = flipped ? -CLOSEST[4] : CLOSEST[4];
    const sz = flipped ? -CLOSEST[5] : CLOSEST[5];
    if (separation < bestSep) {
      bestSep = separation;
      nx = sx;
      ny = sy;
      nz = sz;
    }
    out.points[count * 3] = CLOSEST[0];
    out.points[count * 3 + 1] = CLOSEST[1];
    out.points[count * 3 + 2] = CLOSEST[2];
    out.separations[count] = separation;
    // The round shape's own point, which is stable while it keeps its orientation.
    out.featureIds[count] = 0x50000000 | p;
    count++;
  }
  if (count === 0) return false;
  // Both surfaces are curved here: a ball or a capsule on one side, a cylinder on the other.
  out.curvedA = true;
  out.curvedB = true;
  out.nx = nx;
  out.ny = ny;
  out.nz = nz;
  out.count = count;
  return true;
}

/* ---------- against a polytope ---------- */

function cylinderPolytope(
  poly: ConvexShape,
  pose: ShapePose,
  margin: number,
  radii: number,
  out: Manifold,
  flipped: boolean,
): boolean {
  polyPoints = poly.vertices.length / 3;
  polyFaces = faceCount(poly);
  toWorld(poly, pose);
  toWorldPlanes(poly, pose);

  satSep = -Infinity;
  const ax = CYL_A[3] ?? 0;
  const ay = CYL_A[4] ?? 0;
  const az = CYL_A[5] ?? 0;
  for (let f = 0; f < polyFaces; f++) {
    fold(POLY_P[f * 4] ?? 0, POLY_P[f * 4 + 1] ?? 0, POLY_P[f * 4 + 2] ?? 0);
  }
  fold(ax, ay, az);

  // Every edge of the polytope crossed with the axis: the edge-against-side case.
  for (let f = 0; f < polyFaces; f++) {
    const n = faceVertices(poly, f, LOOP);
    for (let i = 0; i < n; i++) {
      const v0 = (LOOP[i] ?? 0) * 3;
      const v1 = (LOOP[(i + 1) % n] ?? 0) * 3;
      const ex = (POLY_W[v1] ?? 0) - (POLY_W[v0] ?? 0);
      const ey = (POLY_W[v1 + 1] ?? 0) - (POLY_W[v0 + 1] ?? 0);
      const ez = (POLY_W[v1 + 2] ?? 0) - (POLY_W[v0 + 2] ?? 0);
      fold(ey * az - ez * ay, ez * ax - ex * az, ex * ay - ey * ax);
    }
  }

  // Every vertex, twice: the direction out from the axis, and the direction to the nearest rim.
  const cx = CYL_A[0] ?? 0;
  const cy = CYL_A[1] ?? 0;
  const cz = CYL_A[2] ?? 0;
  const h = CYL_A[6] ?? 0;
  const r = CYL_A[7] ?? 0;
  for (let i = 0; i < polyPoints; i++) {
    const dx = (POLY_W[i * 3] ?? 0) - cx;
    const dy = (POLY_W[i * 3 + 1] ?? 0) - cy;
    const dz = (POLY_W[i * 3 + 2] ?? 0) - cz;
    const t = dx * ax + dy * ay + dz * az;
    const wx = dx - ax * t;
    const wy = dy - ay * t;
    const wz = dz - az * t;
    fold(wx, wy, wz);
    const rho = Math.sqrt(wx * wx + wy * wy + wz * wz);
    if (rho < 1e-9) continue;
    const side = t >= 0 ? h : -h;
    fold(
      dx - (ax * side + (wx / rho) * r),
      dy - (ay * side + (wy / rho) * r),
      dz - (az * side + (wz / rho) * r),
    );
  }

  if (satSep - radii > margin) return false;
  return polytopeContacts(poly, margin, radii, out, flipped);
}

/**
 * Turn the winning axis into contact points.
 *
 * **Which shape is the reference is decided by alignment, not by which is curved.** A cylinder
 * lying on a floor has the floor's face as its reference and its own side line as the incident
 * feature; a cylinder standing on a corner has its own cap as the reference and the corner as the
 * incident one. Getting that backwards produces a separation measured against a plane the contact
 * is nowhere near, which reads as a solver that will not settle.
 */
function polytopeContacts(
  poly: ConvexShape,
  margin: number,
  radii: number,
  out: Manifold,
  flipped: boolean,
): boolean {
  const nx = satNx;
  const ny = satNy;
  const nz = satNz;
  const cylCount = cylinderFeature(CYL_A, nx, ny, nz, FEAT_A, FEAT_A_ID);

  let face = 0;
  let opposed = Infinity;
  for (let f = 0; f < polyFaces; f++) {
    const d =
      (POLY_P[f * 4] ?? 0) * nx + (POLY_P[f * 4 + 1] ?? 0) * ny + (POLY_P[f * 4 + 2] ?? 0) * nz;
    if (d < opposed) {
      opposed = d;
      face = f;
    }
  }
  const capAligned =
    cylCount === CAP_POINTS
      ? Math.abs((CYL_A[3] ?? 0) * nx + (CYL_A[4] ?? 0) * ny + (CYL_A[5] ?? 0) * nz)
      : -1;

  let count: number;
  if (capAligned > Math.abs(opposed)) {
    count = clampFaceIntoCap(poly, face, nx, ny, nz);
  } else {
    count = clipFeatureAgainstFace(poly, face, cylCount);
    measureAgainstPlane(
      count,
      POLY_P[face * 4] ?? 0,
      POLY_P[face * 4 + 1] ?? 0,
      POLY_P[face * 4 + 2] ?? 0,
      POLY_P[face * 4 + 3] ?? 0,
    );
  }
  if (count === 0) return false;
  /*
   * A cap is flat and turns with the body, so its anchor belongs in the body's frame like any
   * face's. The side and the rim do not: a rolling cylinder touches the floor at its lowest point
   * however far it has spun, and an anchor that turns with it climbs the side. The polytope's own
   * anchor is never curved.
   */
  return emit(count, margin, radii, out, flipped, nx, ny, nz, cylCount !== CAP_POINTS, false);
}

/**
 * The polytope's incident face, carried into `clampIntoCap` through the second feature buffer.
 *
 * One function does the clamping for both cases — a polytope face resting on a cap, and another
 * cylinder's feature resting on one — because they differ only in where the points came from and
 * what their ids should say. A face loop longer than the buffer is truncated, which cannot happen
 * for any shape `hullShape` builds at the sizes it accepts.
 */
function clampFaceIntoCap(
  poly: ConvexShape,
  face: number,
  nx: number,
  ny: number,
  nz: number,
): number {
  const n = Math.min(faceVertices(poly, face, LOOP), 32);
  for (let i = 0; i < n; i++) {
    const v = (LOOP[i] ?? 0) * 3;
    FEAT_B[i * 3] = POLY_W[v] ?? 0;
    FEAT_B[i * 3 + 1] = POLY_W[v + 1] ?? 0;
    FEAT_B[i * 3 + 2] = POLY_W[v + 2] ?? 0;
    FEAT_B_ID[i] = (face << 8) | (LOOP[i] ?? 0);
  }
  return clampIntoCap(CYL_A, nx, ny, nz, FEAT_B, FEAT_B_ID, n, 0x51000000);
}

/** Signed distances of the clipped points from the reference plane, filled beside `CLIP_IN`. */
const SEPARATION = new Float64Array(32);

function measureAgainstPlane(count: number, nx: number, ny: number, nz: number, d: number): void {
  for (let i = 0; i < count; i++) {
    SEPARATION[i] =
      (CLIP_IN[i * 3] ?? 0) * nx +
      (CLIP_IN[i * 3 + 1] ?? 0) * ny +
      (CLIP_IN[i * 3 + 2] ?? 0) * nz -
      d;
  }
}

/**
 * Clip the cylinder's touching feature against the side planes of the polytope's incident face.
 *
 * Three shapes of feature, three clips: a cap disc is a closed polygon and takes Sutherland-
 * Hodgman; a side line is a segment and takes a parametric interval, which keeps both endpoints
 * meaningful where treating it as a two-vertex polygon would duplicate them; a rim point is kept
 * or dropped.
 */
function clipFeatureAgainstFace(poly: ConvexShape, face: number, cylCount: number): number {
  const refCount = faceVertices(poly, face, LOOP);
  const rnx = POLY_P[face * 4] ?? 0;
  const rny = POLY_P[face * 4 + 1] ?? 0;
  const rnz = POLY_P[face * 4 + 2] ?? 0;

  for (let i = 0; i < cylCount * 3; i++) CLIP_IN[i] = FEAT_A[i] ?? 0;
  for (let i = 0; i < cylCount; i++) CLIP_IN_ID[i] = 0x52000000 | (face << 8) | (FEAT_A_ID[i] ?? 0);
  let count = cylCount;
  let lo = 0;
  let hi = 1;

  for (let e = 0; e < refCount && count > 0; e++) {
    const v0 = (LOOP[e] ?? 0) * 3;
    const v1 = (LOOP[(e + 1) % refCount] ?? 0) * 3;
    const ex = (POLY_W[v1] ?? 0) - (POLY_W[v0] ?? 0);
    const ey = (POLY_W[v1 + 1] ?? 0) - (POLY_W[v0 + 1] ?? 0);
    const ez = (POLY_W[v1 + 2] ?? 0) - (POLY_W[v0 + 2] ?? 0);
    let sx = ey * rnz - ez * rny;
    let sy = ez * rnx - ex * rnz;
    let sz = ex * rny - ey * rnx;
    const len = Math.sqrt(sx * sx + sy * sy + sz * sz);
    if (len === 0) continue;
    sx /= len;
    sy /= len;
    sz /= len;
    const sd = sx * (POLY_W[v0] ?? 0) + sy * (POLY_W[v0 + 1] ?? 0) + sz * (POLY_W[v0 + 2] ?? 0);

    if (cylCount >= 3) {
      count = clipPolygon(count, sx, sy, sz, sd);
      continue;
    }
    const d0 = (CLIP_IN[0] ?? 0) * sx + (CLIP_IN[1] ?? 0) * sy + (CLIP_IN[2] ?? 0) * sz - sd;
    if (cylCount === 1) {
      if (d0 > 0) return 0;
      continue;
    }
    const d1 = (CLIP_IN[3] ?? 0) * sx + (CLIP_IN[4] ?? 0) * sy + (CLIP_IN[5] ?? 0) * sz - sd;
    if (d0 > 0 && d1 > 0) return 0;
    if (d0 !== d1) {
      const t = d0 / (d0 - d1);
      if (d0 > 0 && t > lo) lo = t;
      if (d1 > 0 && t < hi) hi = t;
    }
    if (lo > hi) return 0;
  }

  if (cylCount === 2 && count === 2) {
    const x0 = CLIP_IN[0] ?? 0;
    const y0 = CLIP_IN[1] ?? 0;
    const z0 = CLIP_IN[2] ?? 0;
    const dx = (CLIP_IN[3] ?? 0) - x0;
    const dy = (CLIP_IN[4] ?? 0) - y0;
    const dz = (CLIP_IN[5] ?? 0) - z0;
    CLIP_IN[0] = x0 + dx * lo;
    CLIP_IN[1] = y0 + dy * lo;
    CLIP_IN[2] = z0 + dz * lo;
    CLIP_IN[3] = x0 + dx * hi;
    CLIP_IN[4] = y0 + dy * hi;
    CLIP_IN[5] = z0 + dz * hi;
  }
  return count;
}

/** Sutherland-Hodgman against one side plane, in place over `CLIP_IN`. */
function clipPolygon(count: number, nx: number, ny: number, nz: number, d: number): number {
  let out = 0;
  for (let i = 0; i < count; i++) {
    const j = (i + 1) % count;
    const ax = CLIP_IN[i * 3] ?? 0;
    const ay = CLIP_IN[i * 3 + 1] ?? 0;
    const az = CLIP_IN[i * 3 + 2] ?? 0;
    const bx = CLIP_IN[j * 3] ?? 0;
    const by = CLIP_IN[j * 3 + 1] ?? 0;
    const bz = CLIP_IN[j * 3 + 2] ?? 0;
    const da = ax * nx + ay * ny + az * nz - d;
    const db = bx * nx + by * ny + bz * nz - d;
    if (da <= 0 && out < 32) {
      CLIP_OUT[out * 3] = ax;
      CLIP_OUT[out * 3 + 1] = ay;
      CLIP_OUT[out * 3 + 2] = az;
      CLIP_OUT_ID[out] = CLIP_IN_ID[i] ?? 0;
      out++;
    }
    if (da * db < 0 && out < 32) {
      const t = da / (da - db);
      CLIP_OUT[out * 3] = ax + (bx - ax) * t;
      CLIP_OUT[out * 3 + 1] = ay + (by - ay) * t;
      CLIP_OUT[out * 3 + 2] = az + (bz - az) * t;
      CLIP_OUT_ID[out] = CLIP_IN_ID[i] ?? 0;
      out++;
    }
  }
  for (let i = 0; i < out * 3; i++) CLIP_IN[i] = CLIP_OUT[i] ?? 0;
  for (let i = 0; i < out; i++) CLIP_IN_ID[i] = CLIP_OUT_ID[i] ?? 0;
  return out;
}

/* ---------- against another cylinder ---------- */

function cylinderCylinder(margin: number, radii: number, out: Manifold): boolean {
  satSep = -Infinity;
  const ax = CYL_A[3] ?? 0;
  const ay = CYL_A[4] ?? 0;
  const az = CYL_A[5] ?? 0;
  const bx = CYL_B[3] ?? 0;
  const by = CYL_B[4] ?? 0;
  const bz = CYL_B[5] ?? 0;
  foldPair(ax, ay, az);
  foldPair(bx, by, bz);
  foldPair(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx);
  axisClosest();
  foldPair(SEG[3] - SEG[0], SEG[4] - SEG[1], SEG[5] - SEG[2]);
  if (satSep - radii > margin) return false;

  const nx = satNx;
  const ny = satNy;
  const nz = satNz;
  const countA = cylinderFeature(CYL_A, nx, ny, nz, FEAT_A, FEAT_A_ID);
  const countB = cylinderFeature(CYL_B, -nx, -ny, -nz, FEAT_B, FEAT_B_ID);
  const alignA = countA === CAP_POINTS ? Math.abs(ax * nx + ay * ny + az * nz) : -1;
  const alignB = countB === CAP_POINTS ? Math.abs(bx * nx + by * ny + bz * nz) : -1;

  let count: number;
  if (alignA >= alignB && alignA >= 0) {
    count = clampIntoCap(CYL_A, nx, ny, nz, FEAT_B, FEAT_B_ID, countB, 0x53000000);
  } else if (alignB >= 0) {
    count = clampIntoCap(CYL_B, -nx, -ny, -nz, FEAT_A, FEAT_A_ID, countA, 0x53000000);
  } else {
    count = sideAgainstSide(countA, countB, radii);
  }
  if (count === 0) return false;
  return emit(
    count,
    margin,
    radii,
    out,
    false,
    nx,
    ny,
    nz,
    countA !== CAP_POINTS,
    countB !== CAP_POINTS,
  );
}

/**
 * A set of points pulled inside a cylinder's cap disc, with separations from that cap's plane.
 *
 * **A circle has no side planes to clip against**, so a point outside the disc is moved radially
 * onto its rim rather than dropped. *What that gives up* is a contact placed at the rim where the
 * true touching region ends slightly inside it, by at most the disc's curvature over one edge.
 * *What dropping it instead would give up* is the contact entirely, which is worse by a wide
 * margin.
 *
 * `dx, dy, dz` points from the cap's own cylinder toward whatever is resting on it, which is what
 * picks which of the two caps is doing the work. `kind` is the high byte of the feature ids, so a
 * contact made this way is never confused with one made another.
 */
function clampIntoCap(
  cyl: Float64Array,
  dx: number,
  dy: number,
  dz: number,
  feature: Float64Array,
  ids: Int32Array,
  featureCount: number,
  kind: number,
): number {
  const side = (cyl[3] ?? 0) * dx + (cyl[4] ?? 0) * dy + (cyl[5] ?? 0) * dz >= 0 ? 1 : -1;
  const ax = (cyl[3] ?? 0) * side;
  const ay = (cyl[4] ?? 0) * side;
  const az = (cyl[5] ?? 0) * side;
  const h = cyl[6] ?? 0;
  const r = cyl[7] ?? 0;
  const px = (cyl[0] ?? 0) + ax * h;
  const py = (cyl[1] ?? 0) + ay * h;
  const pz = (cyl[2] ?? 0) + az * h;
  const plane = px * ax + py * ay + pz * az;

  let count = 0;
  for (let i = 0; i < featureCount && count < 32; i++) {
    const qx = feature[i * 3] ?? 0;
    const qy = feature[i * 3 + 1] ?? 0;
    const qz = feature[i * 3 + 2] ?? 0;
    const t = (qx - px) * ax + (qy - py) * ay + (qz - pz) * az;
    let wx = qx - px - ax * t;
    let wy = qy - py - ay * t;
    let wz = qz - pz - az * t;
    const rho = Math.sqrt(wx * wx + wy * wy + wz * wz);
    if (rho > r && rho > 1e-9) {
      const scale = r / rho;
      wx *= scale;
      wy *= scale;
      wz *= scale;
    }
    CLIP_IN[count * 3] = px + wx + ax * t;
    CLIP_IN[count * 3 + 1] = py + wy + ay * t;
    CLIP_IN[count * 3 + 2] = pz + wz + az * t;
    CLIP_IN_ID[count] = kind | (ids[i] ?? 0);
    SEPARATION[count] =
      (CLIP_IN[count * 3] ?? 0) * ax +
      (CLIP_IN[count * 3 + 1] ?? 0) * ay +
      (CLIP_IN[count * 3 + 2] ?? 0) * az -
      plane;
    count++;
  }
  return count;
}

/**
 * Two curved sides meeting, which is one point unless the two axes are parallel.
 *
 * Parallel is the case worth two contacts: two pipes lying side by side hold each other steady
 * only if the contact has length. Crossed axes touch at exactly one point and reporting two would
 * invent a stability the geometry does not have.
 */
function sideAgainstSide(countA: number, countB: number, radii: number): number {
  const sep = satSep - radii;
  if (countA === 2 && countB === 2) {
    let ex = (FEAT_A[3] ?? 0) - (FEAT_A[0] ?? 0);
    let ey = (FEAT_A[4] ?? 0) - (FEAT_A[1] ?? 0);
    let ez = (FEAT_A[5] ?? 0) - (FEAT_A[2] ?? 0);
    const elen = Math.sqrt(ex * ex + ey * ey + ez * ez);
    let fx = (FEAT_B[3] ?? 0) - (FEAT_B[0] ?? 0);
    let fy = (FEAT_B[4] ?? 0) - (FEAT_B[1] ?? 0);
    let fz = (FEAT_B[5] ?? 0) - (FEAT_B[2] ?? 0);
    const flen = Math.sqrt(fx * fx + fy * fy + fz * fz);
    if (elen > 1e-9 && flen > 1e-9) {
      ex /= elen;
      ey /= elen;
      ez /= elen;
      fx /= flen;
      fy /= flen;
      fz /= flen;
      if (Math.abs(ex * fx + ey * fy + ez * fz) > 0.999) {
        // The overlap of B's segment on A's, in A's own parameter.
        const b0 =
          ((FEAT_B[0] ?? 0) - (FEAT_A[0] ?? 0)) * ex +
          ((FEAT_B[1] ?? 0) - (FEAT_A[1] ?? 0)) * ey +
          ((FEAT_B[2] ?? 0) - (FEAT_A[2] ?? 0)) * ez;
        const b1 =
          ((FEAT_B[3] ?? 0) - (FEAT_A[0] ?? 0)) * ex +
          ((FEAT_B[4] ?? 0) - (FEAT_A[1] ?? 0)) * ey +
          ((FEAT_B[5] ?? 0) - (FEAT_A[2] ?? 0)) * ez;
        const lo = Math.max(0, Math.min(b0, b1));
        const hi = Math.min(elen, Math.max(b0, b1));
        if (hi > lo) {
          for (let i = 0; i < 2; i++) {
            const t = i === 0 ? lo : hi;
            CLIP_IN[i * 3] = (FEAT_A[0] ?? 0) + ex * t;
            CLIP_IN[i * 3 + 1] = (FEAT_A[1] ?? 0) + ey * t;
            CLIP_IN[i * 3 + 2] = (FEAT_A[2] ?? 0) + ez * t;
            CLIP_IN_ID[i] = 0x54000000 | i;
            SEPARATION[i] = sep;
          }
          return 2;
        }
      }
    }
  }
  // One point, midway between the two supports, which is where the constraint should act.
  CLIP_IN[0] = ((FEAT_A[0] ?? 0) + (FEAT_B[0] ?? 0)) / 2;
  CLIP_IN[1] = ((FEAT_A[1] ?? 0) + (FEAT_B[1] ?? 0)) / 2;
  CLIP_IN[2] = ((FEAT_A[2] ?? 0) + (FEAT_B[2] ?? 0)) / 2;
  CLIP_IN_ID[0] = 0x55000000 | ((FEAT_A_ID[0] ?? 0) << 8) | (FEAT_B_ID[0] ?? 0);
  SEPARATION[0] = sep;
  return 1;
}

/* ---------- shared ---------- */

/**
 * Write the clipped points into the manifold, keeping the deepest where there are too many.
 *
 * `radii` is the uniform rounding both shapes may carry on top of their own geometry — a
 * Minkowski sum with a ball, which shifts every separation by a constant and nothing else. That is
 * the same treatment `polytopePolytope` gives it, and it is exact rather than an approximation.
 */
function emit(
  count: number,
  margin: number,
  radii: number,
  out: Manifold,
  flipped: boolean,
  nx: number,
  ny: number,
  nz: number,
  curvedCylinder: boolean,
  curvedOther: boolean,
): boolean {
  const capacity = out.separations.length;
  let kept = 0;
  for (let i = 0; i < count; i++) {
    const separation = (SEPARATION[i] ?? 0) - radii;
    if (separation > margin) continue;
    if (kept < capacity) {
      out.points[kept * 3] = CLIP_IN[i * 3] ?? 0;
      out.points[kept * 3 + 1] = CLIP_IN[i * 3 + 1] ?? 0;
      out.points[kept * 3 + 2] = CLIP_IN[i * 3 + 2] ?? 0;
      out.separations[kept] = separation;
      out.featureIds[kept] = CLIP_IN_ID[i] ?? 0;
      kept++;
      continue;
    }
    let worst = 0;
    for (let k = 1; k < capacity; k++) {
      if ((out.separations[k] ?? 0) > (out.separations[worst] ?? 0)) worst = k;
    }
    if (separation < (out.separations[worst] ?? 0)) {
      out.points[worst * 3] = CLIP_IN[i * 3] ?? 0;
      out.points[worst * 3 + 1] = CLIP_IN[i * 3 + 1] ?? 0;
      out.points[worst * 3 + 2] = CLIP_IN[i * 3 + 2] ?? 0;
      out.separations[worst] = separation;
      out.featureIds[worst] = CLIP_IN_ID[i] ?? 0;
    }
  }
  if (kept === 0) return false;
  out.nx = flipped ? -nx : nx;
  out.ny = flipped ? -ny : ny;
  out.nz = flipped ? -nz : nz;
  out.curvedA = flipped ? curvedOther : curvedCylinder;
  out.curvedB = flipped ? curvedCylinder : curvedOther;
  out.count = kept;
  return true;
}

/** Fold one candidate axis, both ways round, into the best separation seen. */
function fold(x: number, y: number, z: number): void {
  const len = Math.sqrt(x * x + y * y + z * z);
  if (len < 1e-9) return;
  const nx = x / len;
  const ny = y / len;
  const nz = z / len;
  let sep = polyMin(nx, ny, nz) - cylinderSupport(CYL_A, nx, ny, nz);
  if (sep > satSep) {
    satSep = sep;
    satNx = nx;
    satNy = ny;
    satNz = nz;
  }
  sep = cylinderMin(CYL_A, nx, ny, nz) - polyMax(nx, ny, nz);
  if (sep > satSep) {
    satSep = sep;
    satNx = -nx;
    satNy = -ny;
    satNz = -nz;
  }
}

/** The same, for two cylinders. */
function foldPair(x: number, y: number, z: number): void {
  const len = Math.sqrt(x * x + y * y + z * z);
  if (len < 1e-9) return;
  const nx = x / len;
  const ny = y / len;
  const nz = z / len;
  let sep = cylinderMin(CYL_B, nx, ny, nz) - cylinderSupport(CYL_A, nx, ny, nz);
  if (sep > satSep) {
    satSep = sep;
    satNx = nx;
    satNy = ny;
    satNz = nz;
  }
  sep = cylinderMin(CYL_A, nx, ny, nz) - cylinderSupport(CYL_B, nx, ny, nz);
  if (sep > satSep) {
    satSep = sep;
    satNx = -nx;
    satNy = -ny;
    satNz = -nz;
  }
}

function polyMin(nx: number, ny: number, nz: number): number {
  let lo = Infinity;
  for (let i = 0; i < polyPoints; i++) {
    const d =
      (POLY_W[i * 3] ?? 0) * nx + (POLY_W[i * 3 + 1] ?? 0) * ny + (POLY_W[i * 3 + 2] ?? 0) * nz;
    if (d < lo) lo = d;
  }
  return lo;
}

function polyMax(nx: number, ny: number, nz: number): number {
  let hi = -Infinity;
  for (let i = 0; i < polyPoints; i++) {
    const d =
      (POLY_W[i * 3] ?? 0) * nx + (POLY_W[i * 3 + 1] ?? 0) * ny + (POLY_W[i * 3 + 2] ?? 0) * nz;
    if (d > hi) hi = d;
  }
  return hi;
}

/** The two closest points of the cylinders' axis segments, written into `SEG`. */
const SEG = new Float64Array(6);

function axisClosest(): void {
  const px = (CYL_A[0] ?? 0) - (CYL_A[3] ?? 0) * (CYL_A[6] ?? 0);
  const py = (CYL_A[1] ?? 0) - (CYL_A[4] ?? 0) * (CYL_A[6] ?? 0);
  const pz = (CYL_A[2] ?? 0) - (CYL_A[5] ?? 0) * (CYL_A[6] ?? 0);
  const dx = (CYL_A[3] ?? 0) * 2 * (CYL_A[6] ?? 0);
  const dy = (CYL_A[4] ?? 0) * 2 * (CYL_A[6] ?? 0);
  const dz = (CYL_A[5] ?? 0) * 2 * (CYL_A[6] ?? 0);
  const qx = (CYL_B[0] ?? 0) - (CYL_B[3] ?? 0) * (CYL_B[6] ?? 0);
  const qy = (CYL_B[1] ?? 0) - (CYL_B[4] ?? 0) * (CYL_B[6] ?? 0);
  const qz = (CYL_B[2] ?? 0) - (CYL_B[5] ?? 0) * (CYL_B[6] ?? 0);
  const ex = (CYL_B[3] ?? 0) * 2 * (CYL_B[6] ?? 0);
  const ey = (CYL_B[4] ?? 0) * 2 * (CYL_B[6] ?? 0);
  const ez = (CYL_B[5] ?? 0) * 2 * (CYL_B[6] ?? 0);
  const rx = px - qx;
  const ry = py - qy;
  const rz = pz - qz;
  const a = dx * dx + dy * dy + dz * dz;
  const e = ex * ex + ey * ey + ez * ez;
  const f = ex * rx + ey * ry + ez * rz;
  let s = 0;
  let t = 0;
  if (a > 1e-12 || e > 1e-12) {
    if (a <= 1e-12) {
      t = clamp01(f / e);
    } else {
      const c = dx * rx + dy * ry + dz * rz;
      if (e <= 1e-12) {
        s = clamp01(-c / a);
      } else {
        const b = dx * ex + dy * ey + dz * ez;
        const denom = a * e - b * b;
        s = denom !== 0 ? clamp01((b * f - c * e) / denom) : 0;
        t = (b * s + f) / e;
        if (t < 0) {
          t = 0;
          s = clamp01(-c / a);
        } else if (t > 1) {
          t = 1;
          s = clamp01((b - c) / a);
        }
      }
    }
  }
  SEG[0] = px + dx * s;
  SEG[1] = py + dy * s;
  SEG[2] = pz + dz * s;
  SEG[3] = qx + ex * t;
  SEG[4] = qy + ey * t;
  SEG[5] = qz + ez * t;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

const ROT = new Float64Array(3);

function rotate(p: ShapePose, x: number, y: number, z: number): void {
  const tx = 2 * (p.qy * z - p.qz * y);
  const ty = 2 * (p.qz * x - p.qx * z);
  const tz = 2 * (p.qx * y - p.qy * x);
  ROT[0] = x + p.qw * tx + (p.qy * tz - p.qz * ty);
  ROT[1] = y + p.qw * ty + (p.qz * tx - p.qx * tz);
  ROT[2] = z + p.qw * tz + (p.qx * ty - p.qy * tx);
}

function toWorld(shape: ConvexShape, pose: ShapePose): void {
  for (let i = 0; i < polyPoints; i++) {
    rotate(
      pose,
      shape.vertices[i * 3] ?? 0,
      shape.vertices[i * 3 + 1] ?? 0,
      shape.vertices[i * 3 + 2] ?? 0,
    );
    POLY_W[i * 3] = ROT[0] + pose.x;
    POLY_W[i * 3 + 1] = ROT[1] + pose.y;
    POLY_W[i * 3 + 2] = ROT[2] + pose.z;
  }
}

function toWorldPlanes(shape: ConvexShape, pose: ShapePose): void {
  for (let f = 0; f < polyFaces; f++) {
    rotate(
      pose,
      shape.facePlanes[f * 4] ?? 0,
      shape.facePlanes[f * 4 + 1] ?? 0,
      shape.facePlanes[f * 4 + 2] ?? 0,
    );
    const v = (shape.faceVertexIndices[shape.faceVertexStart[f] ?? 0] ?? 0) * 3;
    POLY_P[f * 4] = ROT[0];
    POLY_P[f * 4 + 1] = ROT[1];
    POLY_P[f * 4 + 2] = ROT[2];
    POLY_P[f * 4 + 3] =
      ROT[0] * (POLY_W[v] ?? 0) + ROT[1] * (POLY_W[v + 1] ?? 0) + ROT[2] * (POLY_W[v + 2] ?? 0);
  }
}
