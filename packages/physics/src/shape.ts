import type { Aabb } from './collide/index.ts';
import type { TriangleMesh } from './meshShape.ts';

/**
 * Convex collision shapes: the volume an element actually occupies, rather than
 * a world-axis box around it.
 *
 * One representation covers every convex solid — a point cloud plus two kinds of
 * rounding. A box is its eight corners; a sphere is one point and a radius; a
 * stretch of banked track is its own drawn cross-sections, so the geometry a
 * player sees is the geometry that stops them. Face normals and edge directions
 * are enumerated once, at build time, because they are the separating-axis
 * candidates the sweep in `collide.ts` tests — a fixed, data-driven axis list
 * per shape pair is what lets two machines replay the same run bit for bit,
 * where an iterate-to-tolerance method would not.
 *
 * **Two kinds of rounding rather than one, as of 2026-08-27.** `radius` grows a
 * shape by a ball and is what makes a sphere and a capsule; `sideRadius` grows
 * it by a disc perpendicular to the segment through its first two points, and is
 * what makes a cylinder. The second exists because the first cannot express a
 * cylinder at all: a uniform radius rounds the rim along with the side, and the
 * rim is what a wheel rolls on. Everything that consumes a shape reads both, and
 * a shape carrying neither is a plain polytope, which is most of them.
 *
 * Build-time only: nothing here may be called per frame or per tick. The hull
 * builder is O(n^4) in the point count — trivial for the intended n (a slab is
 * 8–16 points, a body part 8), wrong for a render mesh, hence the cap. Shapes
 * come from the few points that *define* an element, not from its triangles.
 */

export interface ConvexShape {
  /**
   * xyz-packed points whose convex hull is the shape. Local space for a body's
   * shape, world space for a static collider's — the sweep never needs to know
   * which, because bodies carry a frame and colliders are baked.
   */
  readonly vertices: Float32Array;
  /** xyz-packed unit face normals, one per direction (a line: n and −n once). */
  readonly faceNormals: Float32Array;
  /** xyz-packed unit edge directions, one per direction. */
  readonly edgeDirs: Float32Array;
  /** Rounding grown around the points — a sphere is one point and this. */
  readonly radius: number;
  /**
   * Rounding grown around the points **only perpendicular to the segment through them**, in
   * metres. Zero for everything but a cylinder, which is what it exists for.
   *
   * `radius` grows a shape uniformly, which is why it cannot express a cylinder: it would round
   * the rim as well as the side. This one grows a shape by a disc rather than by a ball, so the
   * two points of `cylinderShape` become two flat cap discs joined by a curved side, with a sharp
   * rim between them. The two are independent and compose — a shape with both is a cylinder with
   * a filleted rim — and every constructor but `cylinderShape` leaves this at zero.
   *
   * The axis is the shape's own first two points, not a stored vector, so a cylinder baked into
   * world space by a collider carries its orientation the same way its position is carried.
   */
  readonly sideRadius: number;
  /** Distance from the local origin enclosing the whole shape, for broad bounds. */
  readonly boundRadius: number;
  /**
   * xyzw-packed outward face planes, four floats per face: normal then offset, so a point `p` lies
   * on the face when `dot(n, p) === d`.
   *
   * **One entry per face, where `faceNormals` has one per direction.** A box has six here and three
   * there, and they are separate arrays because conflating them is what left the gap: SAT wants
   * directions, while clipping and an inertia tensor want faces. Empty for a shape with no faces.
   */
  readonly facePlanes: Float32Array;
  /** CSR offsets into `faceVertexIndices`, length `faceCount + 1`. Empty when there are no faces. */
  readonly faceVertexStart: Uint16Array;
  /** Vertex indices, each face's loop wound counter-clockwise seen from outside. */
  readonly faceVertexIndices: Uint16Array;
  /**
   * A **static triangle mesh**, where this shape is one, or absent where it is a convex solid.
   *
   * **The one thing in this file that is not convex, and it is a field rather than a second type
   * on purpose.** A union would put a narrowing at every call site that takes a shape — the broad
   * phase, the bounds, the collider set, the sweep, the mass, the queries, the cloth — for a shape
   * only the narrow phase and the raycast can act on, and every one of those narrowings would be a
   * place to forget one. A discriminating field is what `sideRadius` already is, one line up, and
   * this reads the same way: the shape carries what it is and the two places that care ask.
   *
   * A mesh's `vertices` are the eight corners of its bounding box, so everything that measures a
   * shape measures the right box; its `faceNormals` and `edgeDirs` are **empty**, so nothing
   * mistakes a hollow level for a solid brick. See `meshShape`.
   */
  readonly triangles?: TriangleMesh;
}

/** What a shape with no faces carries: a sphere, a capsule, or any cloud too flat to bound one. */
const EMPTY_FACES = {
  facePlanes: new Float32Array(0),
  faceVertexStart: new Uint16Array(0),
  faceVertexIndices: new Uint16Array(0),
};

/**
 * Hard cap on hull input size. The builder is O(n^4); at 64 points that is a
 * few million build-time operations, and anything larger is a sign the caller
 * is feeding it a render mesh instead of an element's defining points.
 */
const MAX_POINTS = 64;
/** Points closer than this are the same point. */
const POINT_EPS = 1e-6;
/** Distance within which a point counts as lying on a plane, metres. */
const COPLANAR_M = 1e-4;
/** Dot product above which two directions are the same line. */
const DIR_DEDUP = 1 - 1e-7;

/** The exact shape `MeshBuilder.addBox` draws: eight corners, three axes. */
export function boxShape(hx: number, hy: number, hz: number): ConvexShape {
  const vertices = new Float32Array(24);
  let v = 0;
  for (let i = 0; i < 8; i++) {
    vertices[v++] = i & 1 ? hx : -hx;
    vertices[v++] = i & 2 ? hy : -hy;
    vertices[v++] = i & 4 ? hz : -hz;
  }
  const axes = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  /*
   * Six faces, where `axes` above is three directions. Corner `i` has bit 0 for +x, bit 1 for +y
   * and bit 2 for +z, so each face is the four corners sharing one bit, listed counter-clockwise
   * seen from outside. Written out rather than derived because the loop that derives it is longer
   * than the table and this is build-time code that runs once per shape.
   */
  const facePlanes = new Float32Array([
    1,
    0,
    0,
    hx,
    -1,
    0,
    0,
    hx,
    0,
    1,
    0,
    hy,
    0,
    -1,
    0,
    hy,
    0,
    0,
    1,
    hz,
    0,
    0,
    -1,
    hz,
  ]);
  const faceVertexIndices = new Uint16Array([
    1, 3, 7, 5, 4, 6, 2, 0, 2, 6, 7, 3, 0, 1, 5, 4, 4, 5, 7, 6, 0, 2, 3, 1,
  ]);
  const faceVertexStart = new Uint16Array([0, 4, 8, 12, 16, 20, 24]);
  return {
    vertices,
    faceNormals: axes,
    edgeDirs: axes,
    radius: 0,
    sideRadius: 0,
    boundRadius: Math.sqrt(hx * hx + hy * hy + hz * hz),
    facePlanes,
    faceVertexStart,
    faceVertexIndices,
  };
}

/** A ball: one point, all radius. It separates on other shapes' features. */
export function sphereShape(radius: number): ConvexShape {
  return {
    vertices: new Float32Array(3),
    faceNormals: new Float32Array(0),
    edgeDirs: new Float32Array(0),
    radius,
    sideRadius: 0,
    boundRadius: radius,
    ...EMPTY_FACES,
  };
}

/**
 * A capsule: a segment along y with a rounding radius.
 *
 * **No new representation.** Point-cloud-plus-radius already expresses a capsule exactly, so this
 * is a named constructor over `hullShape` rather than a shape type. A named thing is discoverable
 * and an idiom is not. It stands along y because that is the axis a character capsule uses, and a
 * rotation nobody has to apply is a rotation nobody gets wrong.
 *
 * At `halfHeight` zero the two points dedupe to one and the result *is* a sphere, which is the
 * right degenerate case rather than an error.
 *
 * **A cylinder is a different shape and has its own constructor**, `cylinderShape` below. The
 * rounding radius here grows uniformly around every feature, so applying it to a segment can only
 * ever give a capsule: it would round a cylinder's rim as well as its side. `sideRadius` is the
 * field that expresses the difference, and it was added on 2026-08-27 with the second condition
 * this file had been recording — a wheel rim, a rolling barrel — as its reason.
 *
 * The advice until then was "build one as an n-gon prism with `hullShape` and accept the facets",
 * and it had a measured ceiling: `hullShape` refuses more than 64 points, a prism spends two a
 * side, so thirty-two sides was the wall, and a thirty-two-sided wheel of radius 1 rolling at
 * 6 m/s bobbed 16 mm that no side count could reduce. `prismRoll.test.ts` still measures that,
 * beside the same wheel built as a cylinder, because the comparison is the reason the shape kind
 * exists.
 */
export function capsuleShape(radius: number, halfHeight: number): ConvexShape {
  if (!(radius > 0)) throw new Error(`capsuleShape: radius must be positive, got ${radius}`);
  if (!(halfHeight >= 0)) {
    throw new Error(`capsuleShape: halfHeight must not be negative, got ${halfHeight}`);
  }
  return hullShape([0, -halfHeight, 0, 0, halfHeight, 0], radius);
}

/**
 * A cylinder: a segment along y, grown by a disc rather than by a ball.
 *
 * **The one shape a point cloud plus a rounding radius cannot express**, and the reason it needed
 * a second kind of rounding rather than a second shape type. `radius` grows a shape uniformly, so
 * applying it to a segment gives a capsule; `sideRadius` grows it only perpendicular to that
 * segment, which gives two flat cap discs, a curved side, and a sharp rim between them. That rim
 * is the whole difference, and it is what a wheel rolls on.
 *
 * **What this replaces is an n-gon prism with a measured floor.** `prismRoll.test.ts` had the
 * numbers: `hullShape` refuses more than 64 points, a prism spends two a side, so thirty-two sides
 * was the wall, and a thirty-two-sided wheel of radius 1 rolling at 6 m/s bobbed **16 mm** — which
 * no side count could reduce. A cylinder's support along any direction perpendicular to its axis
 * is exactly `sideRadius`, at every angle, so the same wheel bobs by nothing at all. The same test
 * file now measures both and compares them.
 *
 * It stands along y for `capsuleShape`'s reason: a rotation nobody has to apply is a rotation
 * nobody gets wrong. A wheel wants its axis across the vehicle, and the body carries a quaternion
 * for exactly that. A static collider baked into world space carries its axis in its own two
 * points, so nothing stores a direction that could disagree with them.
 *
 * **`halfHeight` must be positive**, unlike `capsuleShape`, whose zero case degenerates into a
 * sphere and is right. A cylinder of zero height is a disc: a shape with no interior, whose mass
 * properties are zero and whose contact normal is undefined on its rim. Refused rather than
 * silently produced.
 */
export function cylinderShape(radius: number, halfHeight: number): ConvexShape {
  if (!(radius > 0)) throw new Error(`cylinderShape: radius must be positive, got ${radius}`);
  if (!(halfHeight > 0)) {
    throw new Error(`cylinderShape: halfHeight must be positive, got ${halfHeight}`);
  }
  /*
   * One axis in `faceNormals` and in `edgeDirs`, which is the honest answer for both: the caps are
   * the only planar faces a cylinder has, and they share one direction, while the axis is the only
   * straight edge direction on it. The curved side has neither, and the contact code reaches it
   * through `sideRadius` rather than through an enumerated axis — which is the point of the field.
   */
  const axis = new Float32Array([0, 1, 0]);
  return {
    vertices: new Float32Array([0, -halfHeight, 0, 0, halfHeight, 0]),
    faceNormals: axis,
    edgeDirs: axis,
    radius: 0,
    sideRadius: radius,
    boundRadius: Math.sqrt(halfHeight * halfHeight + radius * radius),
    ...EMPTY_FACES,
  };
}

/**
 * The convex hull of a point cloud, with its separating features enumerated.
 *
 * Brute force by design: every point triple proposes a plane, and a plane with
 * every point on one side is a face. Edges are point pairs lying on two
 * distinct faces. No incremental hull, no floating-point pivoting — the same
 * input yields the same features in the same order on every machine, which the
 * replay contract needs from anything that feeds collision.
 *
 * **Every length here is `Math.sqrt` of a sum of squares rather than `Math.hypot`**, and that is
 * what makes the sentence above true rather than merely intended. ECMAScript declines to specify
 * `hypot` precisely, so two engines may differ by an ulp — and an ulp here is not a slightly
 * different axis. `proposePlane`'s normal classifies every point against `COPLANAR_M`, so it
 * decides whether a plane becomes a face at all; `appendDirection`'s is compared against
 * `DIR_DEDUP`, so it decides how many separating axes exist and in what order. SAT then takes a
 * minimum over that list.
 *
 * `hypot` is the more accurate of the two, guarding against intermediate overflow at magnitudes a
 * collision shape does not reach. **What would make this wrong** is a shape built at astronomical
 * or atomic scale, where that guard is worth more than the reproducibility; the answer then is an
 * explicit rescale rather than the call back. Asserted by `scripts/determinism.test.mjs`.
 */
export function hullShape(points: ArrayLike<number>, radius = 0): ConvexShape {
  const pts = dedupePoints(points);
  const n = pts.length / 3;
  if (n === 0) throw new Error('hullShape: no points');
  if (n > MAX_POINTS) {
    throw new Error(
      `hullShape: ${n} points exceeds ${MAX_POINTS} — derive shapes from defining points, not meshes`,
    );
  }

  let boundRadius = 0;
  for (let i = 0; i < n; i++) {
    const px = pts[i * 3] ?? 0;
    const py = pts[i * 3 + 1] ?? 0;
    const pz = pts[i * 3 + 2] ?? 0;
    const d = Math.sqrt(px * px + py * py + pz * pz);
    if (d > boundRadius) boundRadius = d;
  }
  boundRadius += radius;

  // Every plane that supports the hull: (nx, ny, nz, offset), outward.
  const planes: number[] = [];
  for (let i = 0; i < n - 2; i++) {
    for (let j = i + 1; j < n - 1; j++) {
      for (let k = j + 1; k < n; k++) {
        proposePlane(pts, n, i, j, k, planes);
      }
    }
  }

  const faceNormals = dedupeDirections(planes, 4);
  const edgeDirs =
    planes.length >= 8
      ? hullEdges(pts, n, planes)
      : // Flat or degenerate cloud (one plane or none): there are no two faces
        // to intersect, so every pairwise direction stands in for the rim.
        pairwiseDirections(pts, n);

  /*
   * The planes are what `proposePlane` already found; only their offsets were being discarded. A
   * face is one plane plus the points lying on it, ordered around the normal — which is what
   * clipping and an inertia tensor both need, and what `faceNormals` cannot give, being deduped
   * directions rather than faces.
   */
  const faces = planes.length >= 4 ? buildFaces(pts, n, planes) : EMPTY_FACES;

  return { vertices: pts, faceNormals, edgeDirs, radius, sideRadius: 0, boundRadius, ...faces };
}

/**
 * World-axis bounds of a shape as placed (its points are its placement).
 *
 * **`radius` and `sideRadius` grow the box differently, and the second one is not `sideRadius` on
 * every axis.** A ball grows a box by its radius along all three; a disc perpendicular to a unit
 * axis `a` grows it by `sideRadius * sqrt(1 - a[i]^2)` along axis `i` — the disc's own extent seen
 * down that axis, which is the full radius across the axis and exactly nothing along it. Using
 * `sideRadius` on all three instead would bound a lying cylinder as if it were a sphere, which is
 * conservative and therefore not wrong, and would cost the broad phase the difference on every
 * cylinder in the world.
 */
export function shapeBounds(shape: ConvexShape, out: Aabb): Aabb {
  const v = shape.vertices;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < v.length; i += 3) {
    const x = v[i] ?? 0;
    const y = v[i + 1] ?? 0;
    const z = v[i + 2] ?? 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  let growX = shape.radius;
  let growY = shape.radius;
  let growZ = shape.radius;
  if (shape.sideRadius > 0) {
    const ax = (v[3] ?? 0) - (v[0] ?? 0);
    const ay = (v[4] ?? 0) - (v[1] ?? 0);
    const az = (v[5] ?? 0) - (v[2] ?? 0);
    const length = Math.sqrt(ax * ax + ay * ay + az * az) || 1;
    const ux = ax / length;
    const uy = ay / length;
    const uz = az / length;
    growX += shape.sideRadius * Math.sqrt(Math.max(0, 1 - ux * ux));
    growY += shape.sideRadius * Math.sqrt(Math.max(0, 1 - uy * uy));
    growZ += shape.sideRadius * Math.sqrt(Math.max(0, 1 - uz * uz));
  }
  out.minX = minX - growX;
  out.minY = minY - growY;
  out.minZ = minZ - growZ;
  out.maxX = maxX + growX;
  out.maxY = maxY + growY;
  out.maxZ = maxZ + growZ;
  return out;
}

function dedupePoints(points: ArrayLike<number>): Float32Array {
  const kept: number[] = [];
  for (let i = 0; i + 2 < points.length; i += 3) {
    const x = points[i] ?? 0;
    const y = points[i + 1] ?? 0;
    const z = points[i + 2] ?? 0;
    let duplicate = false;
    for (let k = 0; k < kept.length; k += 3) {
      if (
        Math.abs((kept[k] ?? 0) - x) < POINT_EPS &&
        Math.abs((kept[k + 1] ?? 0) - y) < POINT_EPS &&
        Math.abs((kept[k + 2] ?? 0) - z) < POINT_EPS
      ) {
        duplicate = true;
        break;
      }
    }
    if (!duplicate) kept.push(x, y, z);
  }
  return new Float32Array(kept);
}

/** If the triple (i, j, k) spans a supporting plane, record it outward in `planes`. */
function proposePlane(
  pts: Float32Array,
  n: number,
  i: number,
  j: number,
  k: number,
  planes: number[],
): void {
  const ax = pts[i * 3] ?? 0;
  const ay = pts[i * 3 + 1] ?? 0;
  const az = pts[i * 3 + 2] ?? 0;
  const ux = (pts[j * 3] ?? 0) - ax;
  const uy = (pts[j * 3 + 1] ?? 0) - ay;
  const uz = (pts[j * 3 + 2] ?? 0) - az;
  const vx = (pts[k * 3] ?? 0) - ax;
  const vy = (pts[k * 3 + 1] ?? 0) - ay;
  const vz = (pts[k * 3 + 2] ?? 0) - az;
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len < 1e-9) return;
  nx /= len;
  ny /= len;
  nz /= len;

  let above = 0;
  let below = 0;
  for (let p = 0; p < n; p++) {
    const d =
      ((pts[p * 3] ?? 0) - ax) * nx +
      ((pts[p * 3 + 1] ?? 0) - ay) * ny +
      ((pts[p * 3 + 2] ?? 0) - az) * nz;
    if (d > COPLANAR_M) above++;
    else if (d < -COPLANAR_M) below++;
    if (above > 0 && below > 0) return;
  }
  // Outward means every other point sits behind the plane.
  if (above === 0) recordPlane(planes, nx, ny, nz, nx * ax + ny * ay + nz * az);
  if (below === 0) recordPlane(planes, -nx, -ny, -nz, -(nx * ax + ny * ay + nz * az));
}

function recordPlane(planes: number[], nx: number, ny: number, nz: number, d: number): void {
  for (let p = 0; p < planes.length; p += 4) {
    const dot = (planes[p] ?? 0) * nx + (planes[p + 1] ?? 0) * ny + (planes[p + 2] ?? 0) * nz;
    if (dot > DIR_DEDUP && Math.abs((planes[p + 3] ?? 0) - d) < COPLANAR_M) return;
  }
  planes.push(nx, ny, nz, d);
}

/** Unique directions (as lines) from a packed list with the given stride. */
function dedupeDirections(packed: number[], stride: number): Float32Array {
  const dirs: number[] = [];
  for (let p = 0; p < packed.length; p += stride) {
    const x = packed[p] ?? 0;
    const y = packed[p + 1] ?? 0;
    const z = packed[p + 2] ?? 0;
    appendDirection(dirs, x, y, z);
  }
  return new Float32Array(dirs);
}

function appendDirection(dirs: number[], x: number, y: number, z: number): void {
  const len = Math.sqrt(x * x + y * y + z * z);
  if (len < 1e-9) return;
  const nx = x / len;
  const ny = y / len;
  const nz = z / len;
  for (let d = 0; d < dirs.length; d += 3) {
    const dot = (dirs[d] ?? 0) * nx + (dirs[d + 1] ?? 0) * ny + (dirs[d + 2] ?? 0) * nz;
    if (Math.abs(dot) > DIR_DEDUP) return;
  }
  dirs.push(nx, ny, nz);
}

/** Edge directions: point pairs lying on at least two distinct supporting planes. */
function hullEdges(pts: Float32Array, n: number, planes: number[]): Float32Array {
  const dirs: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 1; j < n; j++) {
      let shared = 0;
      for (let p = 0; p < planes.length && shared < 2; p += 4) {
        const nx = planes[p] ?? 0;
        const ny = planes[p + 1] ?? 0;
        const nz = planes[p + 2] ?? 0;
        const d = planes[p + 3] ?? 0;
        const di =
          (pts[i * 3] ?? 0) * nx + (pts[i * 3 + 1] ?? 0) * ny + (pts[i * 3 + 2] ?? 0) * nz - d;
        if (Math.abs(di) > COPLANAR_M) continue;
        const dj =
          (pts[j * 3] ?? 0) * nx + (pts[j * 3 + 1] ?? 0) * ny + (pts[j * 3 + 2] ?? 0) * nz - d;
        if (Math.abs(dj) > COPLANAR_M) continue;
        shared++;
      }
      if (shared < 2) continue;
      appendDirection(
        dirs,
        (pts[j * 3] ?? 0) - (pts[i * 3] ?? 0),
        (pts[j * 3 + 1] ?? 0) - (pts[i * 3 + 1] ?? 0),
        (pts[j * 3 + 2] ?? 0) - (pts[i * 3 + 2] ?? 0),
      );
    }
  }
  return new Float32Array(dirs);
}

function pairwiseDirections(pts: Float32Array, n: number): Float32Array {
  const dirs: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 1; j < n; j++) {
      appendDirection(
        dirs,
        (pts[j * 3] ?? 0) - (pts[i * 3] ?? 0),
        (pts[j * 3 + 1] ?? 0) - (pts[i * 3 + 1] ?? 0),
        (pts[j * 3 + 2] ?? 0) - (pts[i * 3 + 2] ?? 0),
      );
    }
  }
  return new Float32Array(dirs);
}

/**
 * Group the supporting planes into faces and order each face's points around its normal.
 *
 * `proposePlane` records one plane per point triple, so a square face arrives four times over. The
 * dedupe here is by *direction and offset together*, unlike `appendDirection`, which folds a plane
 * into its opposite because a separating axis has no sign. A face does.
 *
 * **What this gives up:** a face with fewer than three points on it is dropped, so a shape flat
 * enough to have no interior yields no faces and falls back to the empty set. **What would make it
 * wrong** is a caller expecting a degenerate cloud to clip, which it cannot: there is no volume to
 * clip against.
 */
function buildFaces(pts: Float32Array, n: number, planes: readonly number[]): typeof EMPTY_FACES {
  const kept: number[] = [];
  const loops: number[][] = [];

  for (let p = 0; p + 3 < planes.length; p += 4) {
    const nx = planes[p] ?? 0;
    const ny = planes[p + 1] ?? 0;
    const nz = planes[p + 2] ?? 0;
    const d = planes[p + 3] ?? 0;

    let seen = false;
    for (let k = 0; k + 3 < kept.length; k += 4) {
      const dot = (kept[k] ?? 0) * nx + (kept[k + 1] ?? 0) * ny + (kept[k + 2] ?? 0) * nz;
      if (dot > DIR_DEDUP && Math.abs((kept[k + 3] ?? 0) - d) < COPLANAR_M) {
        seen = true;
        break;
      }
    }
    if (seen) continue;

    const on: number[] = [];
    for (let i = 0; i < n; i++) {
      const x = pts[i * 3] ?? 0;
      const y = pts[i * 3 + 1] ?? 0;
      const z = pts[i * 3 + 2] ?? 0;
      if (Math.abs(nx * x + ny * y + nz * z - d) < COPLANAR_M) on.push(i);
    }
    if (on.length < 3) continue;

    kept.push(nx, ny, nz, d);
    loops.push(orderAroundNormal(pts, on, nx, ny, nz));
  }

  if (loops.length === 0) return EMPTY_FACES;

  const starts = new Uint16Array(loops.length + 1);
  let total = 0;
  for (let i = 0; i < loops.length; i++) {
    starts[i] = total;
    total += loops[i]?.length ?? 0;
  }
  starts[loops.length] = total;

  const indices = new Uint16Array(total);
  let at = 0;
  for (const loop of loops) for (const index of loop) indices[at++] = index;

  return {
    facePlanes: new Float32Array(kept),
    faceVertexStart: starts,
    faceVertexIndices: indices,
  };
}

/**
 * Sort a face's points counter-clockwise about its outward normal.
 *
 * A comparison sort on a key computed from the two in-plane axes, **not `Math.atan2`** — the
 * determinism gate bans that outright, and the ordering only has to be *consistent*, which a
 * pseudo-angle gives for free. `Array.prototype.sort` is stable by specification, and `on` is built
 * in ascending index order, so two coincident points keep a defined order.
 */
function orderAroundNormal(
  pts: Float32Array,
  on: readonly number[],
  nx: number,
  ny: number,
  nz: number,
): number[] {
  // Any axis not parallel to the normal gives an in-plane basis.
  const ax = Math.abs(nx) < 0.5 ? 1 : 0;
  const ay = Math.abs(nx) < 0.5 ? 0 : 1;
  let ux = ay * nz;
  let uy = -ax * nz;
  let uz = ax * ny - ay * nx;
  const ulen = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;
  ux /= ulen;
  uy /= ulen;
  uz /= ulen;
  const vx = ny * uz - nz * uy;
  const vy = nz * ux - nx * uz;
  const vz = nx * uy - ny * ux;

  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const i of on) {
    cx += pts[i * 3] ?? 0;
    cy += pts[i * 3 + 1] ?? 0;
    cz += pts[i * 3 + 2] ?? 0;
  }
  cx /= on.length;
  cy /= on.length;
  cz /= on.length;

  const key = new Map<number, number>();
  for (const i of on) {
    const dx = (pts[i * 3] ?? 0) - cx;
    const dy = (pts[i * 3 + 1] ?? 0) - cy;
    const dz = (pts[i * 3 + 2] ?? 0) - cz;
    key.set(i, pseudoAngle(dx * ux + dy * uy + dz * uz, dx * vx + dy * vy + dz * vz));
  }
  // A copy, because `on` is the caller's and sorting in place would surprise it.
  return [...on].sort((p, q) => (key.get(p) ?? 0) - (key.get(q) ?? 0));
}

/** A monotonic stand-in for `atan2`, in [0, 4), costing one divide and no transcendental. */
function pseudoAngle(x: number, y: number): number {
  const sum = Math.abs(x) + Math.abs(y);
  if (sum === 0) return 0;
  const t = y / sum;
  return x < 0 ? 2 - t : t < 0 ? 4 + t : t;
}
