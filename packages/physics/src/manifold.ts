import { isCylinder } from './cylinder.ts';
import { collideCylinder } from './cylinderContact.ts';
import { faceCount, faceVertices } from './faces.ts';
import type { ConvexShape } from './shape.ts';

/**
 * Contact manifolds: which way two shapes separate, by how much, and where they touch.
 *
 * **Three cases, not one, and the split is what makes each of them exact.** A `ConvexShape` is a
 * point cloud plus a rounding radius, so a shape with faces is a polytope and one with a point or
 * two is a sphere or a capsule. Separating-axis tests are exact for two polytopes and *not* exact
 * for a rounded shape against one, because the Minkowski sum of a polytope and a ball is curved
 * wherever the polytope has an edge or a vertex, and no enumerated axis points along that curve.
 * So:
 *
 * - **polytope against polytope** is SAT over the axes the shape already enumerates, then
 *   Sutherland-Hodgman clipping of the incident face against the reference face's side planes;
 * - **sphere or capsule against polytope** is the closest point on the polytope to each of the one
 *   or two points, which the face loops make exact and which needs no axis list at all;
 * - **sphere or capsule against either** is the closest points of two segments.
 *
 * **A fourth case joined them on 2026-08-27 and lives next door**: a cylinder has a curved side, so
 * no list of axes read off the shape can be exact for it, and `cylinderContact.ts` builds one
 * against the *other* shape instead. It is dispatched first below, before anything reads a face
 * count, because a cylinder has no faces and would otherwise be mistaken for a capsule.
 *
 * A capsule against a face produces two contacts, one per endpoint, which is what stops a capsule
 * lying on the ground from rocking. **What that gives up** is a capsule crossing an edge at an
 * angle, where two endpoint contacts approximate a contact that is really along the edge. **What
 * would make it wrong** is a consumer rolling capsules over rough terrain and seeing them catch;
 * the answer then is a segment-against-polytope clip rather than two point queries.
 *
 * **Every contact point carries a feature id**, and that is the load-bearing part. It is how a
 * manifold is matched to the previous tick's so accumulated impulses warm-start the next solve.
 * Matching by proximity within a tolerance is the usual alternative and is both order-dependent
 * and tolerance-dependent, which the determinism contract forbids twice over.
 */

/** Where a shape sits: a position and a unit quaternion. */
export interface ShapePose {
  x: number;
  y: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
}

/** At most four points survive reduction, which is enough to hold a face flat. */
export const MAX_CONTACTS = 4;

export interface Manifold {
  /** Unit, pointing from A to B. */
  nx: number;
  ny: number;
  nz: number;
  count: number;
  /** World contact points, xyz-packed, `count` of them. */
  points: Float32Array;
  /** Signed gap per point. Negative is overlap. */
  separations: Float32Array;
  /** Stable per contact across ticks, which is what warm starting needs. */
  featureIds: Int32Array;
  /**
   * Whether the contact rides a **curved** part of A's surface, and the same for B.
   *
   * The solver stores each anchor in its body's own frame and rotates it forward through the
   * substeps, which is exact for a face or a corner and wrong for a ball: the point where a rolling
   * sphere touches the floor stays at the bottom, and an anchor that turns with the body climbs the
   * side instead. **Measured before it was fixed**: a sphere of radius 1 rolling at 6 rad/s sank
   * 28 mm into the floor and stayed there, because every step's anchor drift read as a gap the
   * solver then let close. A cylinder did the same, and a box did not.
   *
   * So a curved anchor is held in **world** frame instead, where a constant offset from the centre
   * is the right answer for the whole tick. **What that gives up** is the tangential correction for
   * a body that genuinely turns under the contact within one step — second order over a sixtieth of
   * a second, against a first-order error the other way. **What would make it wrong** is a
   * consumer stepping at a rate slow enough for a body to turn appreciably inside one step, where
   * the answer is a narrowphase per substep and a much larger bill.
   *
   * A cylinder sets these per *feature*: its cap is flat and turns with the body, so a cap contact
   * is not curved, while its side and its rim are.
   */
  curvedA: boolean;
  curvedB: boolean;
}

export function createManifold(): Manifold {
  return {
    nx: 0,
    ny: 1,
    nz: 0,
    count: 0,
    points: new Float32Array(MAX_CONTACTS * 3),
    separations: new Float32Array(MAX_CONTACTS),
    featureIds: new Int32Array(MAX_CONTACTS),
    curvedA: false,
    curvedB: false,
  };
}

/** Module scratch. Nothing here allocates per call. */
const MAX_POINTS = 64;
const worldA = new Float32Array(MAX_POINTS * 3);
const worldB = new Float32Array(MAX_POINTS * 3);
const planesA = new Float32Array(MAX_POINTS * 4);
const planesB = new Float32Array(MAX_POINTS * 4);
const loop = new Uint16Array(MAX_POINTS);
const clipIn = new Float32Array(MAX_POINTS * 3);
const clipOut = new Float32Array(MAX_POINTS * 3);
const clipInId = new Int32Array(MAX_POINTS);
const clipOutId = new Int32Array(MAX_POINTS);
const rot = new Float32Array(9);

/**
 * Fill `out` and return whether the shapes are within `margin` of touching.
 *
 * A positive separation inside the margin is a **speculative** contact: the constraint will permit
 * approach up to exactly that gap and no further, which is what gives continuous collision without
 * a separate time-of-impact pass.
 */
export function collideShapes(
  shapeA: ConvexShape,
  poseA: ShapePose,
  shapeB: ConvexShape,
  poseB: ShapePose,
  margin: number,
  out: Manifold,
): boolean {
  out.count = 0;
  if (isCylinder(shapeA) || isCylinder(shapeB)) {
    return collideCylinder(shapeA, poseA, shapeB, poseB, margin, out);
  }
  const facesA = faceCount(shapeA);
  const facesB = faceCount(shapeB);
  // A faceless shape is a ball or a capsule, and every point of it that can touch anything is
  // curved. A polytope's contacts are on faces, edges and corners, all of which turn with it.
  out.curvedA = facesA === 0;
  out.curvedB = facesB === 0;
  toWorld(shapeA, poseA, worldA);
  toWorld(shapeB, poseB, worldB);

  if (facesA === 0 && facesB === 0) return roundRound(shapeA, shapeB, margin, out);
  if (facesA === 0) return roundPolytope(shapeA, shapeB, poseB, margin, out, false);
  if (facesB === 0) return roundPolytope(shapeB, shapeA, poseA, margin, out, true);

  planesToWorld(shapeA, poseA, worldA, planesA);
  planesToWorld(shapeB, poseB, worldB, planesB);
  return polytopePolytope(shapeA, shapeB, facesA, facesB, margin, out);
}

/* ---------- sphere or capsule against sphere or capsule ---------- */

function roundRound(a: ConvexShape, b: ConvexShape, margin: number, out: Manifold): boolean {
  const na = a.vertices.length / 3;
  const nb = b.vertices.length / 3;
  const ax = worldA[0] ?? 0;
  const ay = worldA[1] ?? 0;
  const az = worldA[2] ?? 0;
  const bx = na > 1 ? (worldA[3] ?? 0) : ax;
  const by = na > 1 ? (worldA[4] ?? 0) : ay;
  const bz = na > 1 ? (worldA[5] ?? 0) : az;
  const cx = worldB[0] ?? 0;
  const cy = worldB[1] ?? 0;
  const cz = worldB[2] ?? 0;
  const dx = nb > 1 ? (worldB[3] ?? 0) : cx;
  const dy = nb > 1 ? (worldB[4] ?? 0) : cy;
  const dz = nb > 1 ? (worldB[5] ?? 0) : cz;

  segmentClosest(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz);
  let ux = CLOSEST[3] - CLOSEST[0];
  let uy = CLOSEST[4] - CLOSEST[1];
  let uz = CLOSEST[5] - CLOSEST[2];
  let d = Math.sqrt(ux * ux + uy * uy + uz * uz);
  if (d === 0) {
    /*
     * The axes intersect, so there is no direction *between* them. Any unit vector is as good as
     * another and world up is the stable choice; the distance stays **zero**, which is what it is.
     *
     * Setting it to one instead — as this did — fabricates a separation of a whole metre and makes
     * two fully overlapped capsules report no contact at all. Found by a test whose own geometry
     * was wrong, which is the only reason the case was reached.
     */
    ux = 0;
    uy = 1;
    uz = 0;
  } else {
    ux /= d;
    uy /= d;
    uz /= d;
  }
  const separation = d - a.radius - b.radius;
  if (separation > margin) return false;
  out.nx = ux;
  out.ny = uy;
  out.nz = uz;
  out.count = 1;
  // Midway between the two surfaces, which is where the constraint should act.
  out.points[0] = CLOSEST[0] + ux * (a.radius + separation / 2);
  out.points[1] = CLOSEST[1] + uy * (a.radius + separation / 2);
  out.points[2] = CLOSEST[2] + uz * (a.radius + separation / 2);
  out.separations[0] = separation;
  out.featureIds[0] = 0;
  return true;
}

/* ---------- sphere or capsule against a polytope ---------- */

function roundPolytope(
  round: ConvexShape,
  poly: ConvexShape,
  polyPose: ShapePose,
  margin: number,
  out: Manifold,
  flipped: boolean,
): boolean {
  // `worldA` holds whichever shape was passed first, so read the round one from the right buffer.
  const roundWorld = flipped ? worldB : worldA;
  const polyWorld = flipped ? worldA : worldB;
  planesToWorld(poly, polyPose, polyWorld, planesB);

  const points = round.vertices.length / 3;
  const faces = faceCount(poly);
  let count = 0;
  let bestSep = Infinity;
  let nx = 0;
  let ny = 1;
  let nz = 0;

  for (let p = 0; p < points; p++) {
    const px = roundWorld[p * 3] ?? 0;
    const py = roundWorld[p * 3 + 1] ?? 0;
    const pz = roundWorld[p * 3 + 2] ?? 0;
    closestOnPolytope(poly, polyWorld, planesB, faces, px, py, pz);
    let ux = px - CLOSEST[0];
    let uy = py - CLOSEST[1];
    let uz = pz - CLOSEST[2];
    let d = Math.sqrt(ux * ux + uy * uy + uz * uz);
    if (CLOSEST[6] < 0) {
      // Inside: the closest face's outward normal is the direction, and depth is its plane distance.
      ux = CLOSEST[3];
      uy = CLOSEST[4];
      uz = CLOSEST[5];
      d = CLOSEST[6];
    } else if (d === 0) {
      ux = CLOSEST[3];
      uy = CLOSEST[4];
      uz = CLOSEST[5];
    } else {
      ux /= d;
      uy /= d;
      uz /= d;
    }
    const separation = d - round.radius - poly.radius;
    if (separation > margin) continue;
    if (count >= MAX_CONTACTS) break;
    // Normal points from the round shape toward the polytope, then flipped if A was the polytope.
    const sx = flipped ? ux : -ux;
    const sy = flipped ? uy : -uy;
    const sz = flipped ? uz : -uz;
    if (separation < bestSep) {
      bestSep = separation;
      nx = sx;
      ny = sy;
      nz = sz;
    }
    const at = count * 3;
    out.points[at] = CLOSEST[0];
    out.points[at + 1] = CLOSEST[1];
    out.points[at + 2] = CLOSEST[2];
    out.separations[count] = separation;
    // The endpoint that produced it, which is stable while the capsule keeps its orientation.
    out.featureIds[count] = 0x40000000 | p;
    count++;
  }
  if (count === 0) return false;
  out.nx = nx;
  out.ny = ny;
  out.nz = nz;
  out.count = count;
  return true;
}

/* ---------- polytope against polytope ---------- */

function polytopePolytope(
  a: ConvexShape,
  b: ConvexShape,
  facesA: number,
  facesB: number,
  margin: number,
  out: Manifold,
): boolean {
  const na = a.vertices.length / 3;
  const nb = b.vertices.length / 3;
  const radii = a.radius + b.radius;

  let best = -Infinity;
  let bestFace = -1;
  let bestFromA = true;
  for (let f = 0; f < facesA; f++) {
    const s = separationAlong(
      planesA[f * 4] ?? 0,
      planesA[f * 4 + 1] ?? 0,
      planesA[f * 4 + 2] ?? 0,
      na,
      nb,
    );
    if (s > best) {
      best = s;
      bestFace = f;
      bestFromA = true;
    }
  }
  for (let f = 0; f < facesB; f++) {
    // B's outward normal points from B to A, so negate it to keep every axis A-to-B.
    const s = separationAlong(
      -(planesB[f * 4] ?? 0),
      -(planesB[f * 4 + 1] ?? 0),
      -(planesB[f * 4 + 2] ?? 0),
      na,
      nb,
    );
    if (s > best) {
      best = s;
      bestFace = f;
      bestFromA = false;
    }
  }
  if (best - radii > margin) return false;

  const sign = bestFromA ? 1 : -1;
  const rp = bestFromA ? planesA : planesB;
  const nx = sign * (rp[bestFace * 4] ?? 0);
  const ny = sign * (rp[bestFace * 4 + 1] ?? 0);
  const nz = sign * (rp[bestFace * 4 + 2] ?? 0);

  const refShape = bestFromA ? a : b;
  const incShape = bestFromA ? b : a;
  const refWorld = bestFromA ? worldA : worldB;
  const incWorld = bestFromA ? worldB : worldA;
  const refPlanes = bestFromA ? planesA : planesB;
  const incPlanes = bestFromA ? planesB : planesA;
  const incFaces = bestFromA ? facesB : facesA;

  // The incident face is the one most anti-parallel to the reference normal.
  let incFace = 0;
  let mostOpposed = Infinity;
  for (let f = 0; f < incFaces; f++) {
    const d =
      (incPlanes[f * 4] ?? 0) * nx +
      (incPlanes[f * 4 + 1] ?? 0) * ny +
      (incPlanes[f * 4 + 2] ?? 0) * nz;
    const signed = bestFromA ? d : -d;
    if (signed < mostOpposed) {
      mostOpposed = signed;
      incFace = f;
    }
  }

  // Clip the incident loop against every side plane of the reference face.
  let count = faceVertices(incShape, incFace, loop);
  for (let i = 0; i < count; i++) {
    const v = (loop[i] ?? 0) * 3;
    clipIn[i * 3] = incWorld[v] ?? 0;
    clipIn[i * 3 + 1] = incWorld[v + 1] ?? 0;
    clipIn[i * 3 + 2] = incWorld[v + 2] ?? 0;
    clipInId[i] = featureId(0, bestFace, incFace, loop[i] ?? 0);
  }

  const refCount = faceVertices(refShape, bestFace, loop);
  const rnx = refPlanes[bestFace * 4] ?? 0;
  const rny = refPlanes[bestFace * 4 + 1] ?? 0;
  const rnz = refPlanes[bestFace * 4 + 2] ?? 0;
  const rd = refPlanes[bestFace * 4 + 3] ?? 0;
  for (let e = 0; e < refCount && count > 0; e++) {
    const v0 = (loop[e] ?? 0) * 3;
    const v1 = (loop[(e + 1) % refCount] ?? 0) * 3;
    const ex = (refWorld[v1] ?? 0) - (refWorld[v0] ?? 0);
    const ey = (refWorld[v1 + 1] ?? 0) - (refWorld[v0 + 1] ?? 0);
    const ez = (refWorld[v1 + 2] ?? 0) - (refWorld[v0 + 2] ?? 0);
    // Outward side plane: the face normal crossed with the edge, pointing away from the polygon.
    let sx = ey * rnz - ez * rny;
    let sy = ez * rnx - ex * rnz;
    let sz = ex * rny - ey * rnx;
    const len = Math.sqrt(sx * sx + sy * sy + sz * sz);
    if (len === 0) continue;
    sx /= len;
    sy /= len;
    sz /= len;
    const sd =
      sx * (refWorld[v0] ?? 0) + sy * (refWorld[v0 + 1] ?? 0) + sz * (refWorld[v0 + 2] ?? 0);
    count = clipAgainst(sx, sy, sz, sd, count, e, incFace);
  }

  // Keep what is close enough to the reference plane, at most four, deepest first.
  let kept = 0;
  for (let i = 0; i < count; i++) {
    const px = clipIn[i * 3] ?? 0;
    const py = clipIn[i * 3 + 1] ?? 0;
    const pz = clipIn[i * 3 + 2] ?? 0;
    const separation = px * rnx + py * rny + pz * rnz - rd - radii;
    if (separation > margin) continue;
    if (kept < MAX_CONTACTS) {
      const at = kept * 3;
      out.points[at] = px;
      out.points[at + 1] = py;
      out.points[at + 2] = pz;
      out.separations[kept] = separation;
      out.featureIds[kept] = clipInId[i] ?? 0;
      kept++;
    } else {
      // Replace the shallowest, so four points describe the deepest corners of the overlap.
      let worst = 0;
      for (let k = 1; k < MAX_CONTACTS; k++) {
        if ((out.separations[k] ?? 0) > (out.separations[worst] ?? 0)) worst = k;
      }
      if (separation < (out.separations[worst] ?? 0)) {
        const at = worst * 3;
        out.points[at] = px;
        out.points[at + 1] = py;
        out.points[at + 2] = pz;
        out.separations[worst] = separation;
        out.featureIds[worst] = clipInId[i] ?? 0;
      }
    }
  }
  if (kept === 0) return false;
  out.nx = nx;
  out.ny = ny;
  out.nz = nz;
  out.count = kept;
  return true;
}

/**
 * Pack a contact's identity: which kind of feature it is, and which two features made it.
 *
 * **A kept incident vertex and a point cut from the edge leaving it are different contacts**, and
 * naming them both after that vertex is how two of four points ended up sharing an id — which
 * silently gives one contact another's accumulated impulse the next tick. A cut is named by the
 * *reference edge* that cut it and the incident edge it sat on; a kept vertex by the reference face
 * and its own index.
 */
function featureId(kind: number, refIndex: number, incFace: number, incVertex: number): number {
  return (kind << 30) | ((refIndex & 0xff) << 16) | ((incFace & 0xff) << 8) | (incVertex & 0xff);
}

/** Sutherland-Hodgman against one plane, in place. Returns the surviving count. */
function clipAgainst(
  nx: number,
  ny: number,
  nz: number,
  d: number,
  count: number,
  refEdge: number,
  incFace: number,
): number {
  let out = 0;
  for (let i = 0; i < count; i++) {
    const j = (i + 1) % count;
    const ax = clipIn[i * 3] ?? 0;
    const ay = clipIn[i * 3 + 1] ?? 0;
    const az = clipIn[i * 3 + 2] ?? 0;
    const bx = clipIn[j * 3] ?? 0;
    const by = clipIn[j * 3 + 1] ?? 0;
    const bz = clipIn[j * 3 + 2] ?? 0;
    const da = ax * nx + ay * ny + az * nz - d;
    const db = bx * nx + by * ny + bz * nz - d;
    if (da <= 0) {
      clipOut[out * 3] = ax;
      clipOut[out * 3 + 1] = ay;
      clipOut[out * 3 + 2] = az;
      clipOutId[out] = clipInId[i] ?? 0;
      out++;
    }
    if (da * db < 0) {
      const t = da / (da - db);
      clipOut[out * 3] = ax + (bx - ax) * t;
      clipOut[out * 3 + 1] = ay + (by - ay) * t;
      clipOut[out * 3 + 2] = az + (bz - az) * t;
      // Named by the reference edge that cut it and the incident edge it sat on, not by a vertex.
      clipOutId[out] = featureId(1, refEdge, incFace, (clipInId[i] ?? 0) & 0xff);
      out++;
    }
  }
  for (let i = 0; i < out * 3; i++) clipIn[i] = clipOut[i] ?? 0;
  for (let i = 0; i < out; i++) clipInId[i] = clipOutId[i] ?? 0;
  return out;
}

/** Support separation of B beyond A along one axis, both shapes already in world. */
function separationAlong(nx: number, ny: number, nz: number, na: number, nb: number): number {
  let maxA = -Infinity;
  for (let i = 0; i < na; i++) {
    const d =
      (worldA[i * 3] ?? 0) * nx + (worldA[i * 3 + 1] ?? 0) * ny + (worldA[i * 3 + 2] ?? 0) * nz;
    if (d > maxA) maxA = d;
  }
  let minB = Infinity;
  for (let i = 0; i < nb; i++) {
    const d =
      (worldB[i * 3] ?? 0) * nx + (worldB[i * 3 + 1] ?? 0) * ny + (worldB[i * 3 + 2] ?? 0) * nz;
    if (d < minB) minB = d;
  }
  return minB - maxA;
}

/* ---------- geometry helpers, all of them allocation-free ---------- */

/** `[cx, cy, cz, nx, ny, nz, signedDistance]`, or the two closest points for a segment pair. */
const CLOSEST = new Float64Array(7);

/**
 * The closest point on a convex polytope to `p`, exactly.
 *
 * Inside every face plane means the point is inside the solid, and the answer is then the least
 * penetrating face rather than a surface point: `CLOSEST[6]` comes back negative to say so.
 */
function closestOnPolytope(
  shape: ConvexShape,
  world: Float32Array,
  planes: Float32Array,
  faces: number,
  px: number,
  py: number,
  pz: number,
): void {
  let inside = true;
  let bestPlane = 0;
  let bestPlaneDist = -Infinity;
  for (let f = 0; f < faces; f++) {
    const d =
      px * (planes[f * 4] ?? 0) +
      py * (planes[f * 4 + 1] ?? 0) +
      pz * (planes[f * 4 + 2] ?? 0) -
      (planes[f * 4 + 3] ?? 0);
    if (d > 0) inside = false;
    if (d > bestPlaneDist) {
      bestPlaneDist = d;
      bestPlane = f;
    }
  }
  if (inside) {
    const nx = planes[bestPlane * 4] ?? 0;
    const ny = planes[bestPlane * 4 + 1] ?? 0;
    const nz = planes[bestPlane * 4 + 2] ?? 0;
    CLOSEST[0] = px - nx * bestPlaneDist;
    CLOSEST[1] = py - ny * bestPlaneDist;
    CLOSEST[2] = pz - nz * bestPlaneDist;
    CLOSEST[3] = nx;
    CLOSEST[4] = ny;
    CLOSEST[5] = nz;
    CLOSEST[6] = bestPlaneDist;
    return;
  }

  let bestD2 = Infinity;
  for (let f = 0; f < faces; f++) {
    const n = faceVertices(shape, f, loop);
    const a = (loop[0] ?? 0) * 3;
    for (let i = 1; i + 1 < n; i++) {
      const b = (loop[i] ?? 0) * 3;
      const c = (loop[i + 1] ?? 0) * 3;
      closestOnTriangle(
        px,
        py,
        pz,
        world[a] ?? 0,
        world[a + 1] ?? 0,
        world[a + 2] ?? 0,
        world[b] ?? 0,
        world[b + 1] ?? 0,
        world[b + 2] ?? 0,
        world[c] ?? 0,
        world[c + 1] ?? 0,
        world[c + 2] ?? 0,
      );
      const dx = px - TRI[0];
      const dy = py - TRI[1];
      const dz = pz - TRI[2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bestD2) {
        bestD2 = d2;
        CLOSEST[0] = TRI[0];
        CLOSEST[1] = TRI[1];
        CLOSEST[2] = TRI[2];
        CLOSEST[3] = planes[f * 4] ?? 0;
        CLOSEST[4] = planes[f * 4 + 1] ?? 0;
        CLOSEST[5] = planes[f * 4 + 2] ?? 0;
      }
    }
  }
  CLOSEST[6] = Math.sqrt(bestD2);
}

const TRI = new Float64Array(3);

/** Closest point on a triangle to `p`, by the standard barycentric region test. */
function closestOnTriangle(
  px: number,
  py: number,
  pz: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
): void {
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const acx = cx - ax;
  const acy = cy - ay;
  const acz = cz - az;
  const apx = px - ax;
  const apy = py - ay;
  const apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) {
    TRI[0] = ax;
    TRI[1] = ay;
    TRI[2] = az;
    return;
  }
  const bpx = px - bx;
  const bpy = py - by;
  const bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) {
    TRI[0] = bx;
    TRI[1] = by;
    TRI[2] = bz;
    return;
  }
  const cpx = px - cx;
  const cpy = py - cy;
  const cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) {
    TRI[0] = cx;
    TRI[1] = cy;
    TRI[2] = cz;
    return;
  }
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const t = d1 / (d1 - d3);
    TRI[0] = ax + abx * t;
    TRI[1] = ay + aby * t;
    TRI[2] = az + abz * t;
    return;
  }
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const t = d2 / (d2 - d6);
    TRI[0] = ax + acx * t;
    TRI[1] = ay + acy * t;
    TRI[2] = az + acz * t;
    return;
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const t = (d4 - d3) / (d4 - d3 + (d5 - d6));
    TRI[0] = bx + (cx - bx) * t;
    TRI[1] = by + (cy - by) * t;
    TRI[2] = bz + (cz - bz) * t;
    return;
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  TRI[0] = ax + abx * v + acx * w;
  TRI[1] = ay + aby * v + acy * w;
  TRI[2] = az + abz * v + acz * w;
}

/** Closest points of two segments, written into `CLOSEST[0..5]`. */
function segmentClosest(
  p0x: number,
  p0y: number,
  p0z: number,
  p1x: number,
  p1y: number,
  p1z: number,
  q0x: number,
  q0y: number,
  q0z: number,
  q1x: number,
  q1y: number,
  q1z: number,
): void {
  const dx = p1x - p0x;
  const dy = p1y - p0y;
  const dz = p1z - p0z;
  const ex = q1x - q0x;
  const ey = q1y - q0y;
  const ez = q1z - q0z;
  const rx = p0x - q0x;
  const ry = p0y - q0y;
  const rz = p0z - q0z;
  const a = dx * dx + dy * dy + dz * dz;
  const e = ex * ex + ey * ey + ez * ez;
  const f = ex * rx + ey * ry + ez * rz;
  let s = 0;
  let t = 0;
  if (a <= 1e-12 && e <= 1e-12) {
    // Two points.
  } else if (a <= 1e-12) {
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
  CLOSEST[0] = p0x + dx * s;
  CLOSEST[1] = p0y + dy * s;
  CLOSEST[2] = p0z + dz * s;
  CLOSEST[3] = q0x + ex * t;
  CLOSEST[4] = q0y + ey * t;
  CLOSEST[5] = q0z + ez * t;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Write a pose's rotation matrix into `rot`, row-major. */
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

function toWorld(shape: ConvexShape, pose: ShapePose, out: Float32Array): void {
  poseRotation(pose);
  const n = shape.vertices.length / 3;
  for (let i = 0; i < n; i++) {
    const x = shape.vertices[i * 3] ?? 0;
    const y = shape.vertices[i * 3 + 1] ?? 0;
    const z = shape.vertices[i * 3 + 2] ?? 0;
    out[i * 3] = (rot[0] ?? 0) * x + (rot[1] ?? 0) * y + (rot[2] ?? 0) * z + pose.x;
    out[i * 3 + 1] = (rot[3] ?? 0) * x + (rot[4] ?? 0) * y + (rot[5] ?? 0) * z + pose.y;
    out[i * 3 + 2] = (rot[6] ?? 0) * x + (rot[7] ?? 0) * y + (rot[8] ?? 0) * z + pose.z;
  }
}

/** Rotate every face plane and re-anchor its offset on a world vertex of that face. */
function planesToWorld(
  shape: ConvexShape,
  pose: ShapePose,
  world: Float32Array,
  out: Float32Array,
): void {
  poseRotation(pose);
  const faces = faceCount(shape);
  for (let f = 0; f < faces; f++) {
    const x = shape.facePlanes[f * 4] ?? 0;
    const y = shape.facePlanes[f * 4 + 1] ?? 0;
    const z = shape.facePlanes[f * 4 + 2] ?? 0;
    const nx = (rot[0] ?? 0) * x + (rot[1] ?? 0) * y + (rot[2] ?? 0) * z;
    const ny = (rot[3] ?? 0) * x + (rot[4] ?? 0) * y + (rot[5] ?? 0) * z;
    const nz = (rot[6] ?? 0) * x + (rot[7] ?? 0) * y + (rot[8] ?? 0) * z;
    const v = (shape.faceVertexIndices[shape.faceVertexStart[f] ?? 0] ?? 0) * 3;
    out[f * 4] = nx;
    out[f * 4 + 1] = ny;
    out[f * 4 + 2] = nz;
    out[f * 4 + 3] = nx * (world[v] ?? 0) + ny * (world[v + 1] ?? 0) + nz * (world[v + 2] ?? 0);
  }
}
