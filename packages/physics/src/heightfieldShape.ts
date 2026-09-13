import type { Aabb } from './collide/index.ts';
import type { ConvexShape } from './shape.ts';

/**
 * A heightfield as a collision shape: the samples, and every triangle generated from them.
 *
 * **The whole of this is a memory argument.** Terrain already collides, as a static triangle mesh —
 * `meshShape` takes exactly the arrays a heightfield renderer hands back, so the geometry drawn is
 * the geometry collided with, which is the property that matters most and the reason that path is
 * still the right one for a level. What it costs is the triangles: measured on a 129-square field,
 * the positions and indices alone are more than five times the bytes of the heights they were built
 * from, before the tree over them is counted at all.
 *
 * A heightfield needs none of it. The samples *are* the geometry, the cell under a body is an index
 * rather than a tree query, and every triangle, plane and edge classification is arithmetic on four
 * numbers. So this carries the heights and nothing else.
 *
 * **What it is not is a second narrow phase.** `meshContact.ts` owns the contact rules — many
 * manifolds rather than one, one-sided triangles, the interior-edge filter that stops a box
 * stumbling on a flat seam — and this changes none of them. It is a *source of triangles*, and the
 * only thing it replaces is where they come from: an index range instead of a tree, and four
 * samples instead of an index buffer. That split is the 2026-08-13 rule applied to the one file in
 * this package it would be most expensive to have two of.
 *
 * **The triangulation is stated here and mirrored in `@driftengine/terrain`**, which draws the
 * picture this collides with. It has to be: `@driftengine/physics` imports no other engine package,
 * so the rule cannot be shared as code. What is shared instead is an assertion — that package's
 * `terrainCollision.test.ts` compares the two — which is the same arrangement `glDepthFunc` has with
 * `DEPTH_COMPARE` for the same reason. Track L already paid once for two copies of this rule
 * disagreeing, when a mesh was split one way and its query read the other, so the mirror is guarded
 * rather than trusted.
 */

export interface Heightfield {
  /** Samples across x. At least two, since one sample is not a cell. */
  readonly width: number;
  /** Samples across z. */
  readonly depth: number;
  /** Metres between samples, the same both ways. */
  readonly spacingM: number;
  /** `width * depth` heights, row-major with x running fastest. Kept, not copied. */
  readonly heights: Float32Array;
  /**
   * World position of sample `(0, 0)`, or nothing for a field at the origin. Its own y is added to
   * every height.
   *
   * **Three numbers in an array rather than three fields, and that is the boundary doing its work.**
   * `@driftengine/physics` imports no other engine package, so it cannot know what a `Terrain` is —
   * but a `Terrain` *is* one of these, structurally: same names, same meanings, an `origin` that is
   * a `Float32Array`. So `heightfieldShape(terrain)` type-checks with no import in either
   * direction, and the seam is a shape rather than a dependency.
   */
  readonly origin?: ArrayLike<number>;
}

/** How many cells a field has across x, which is one fewer than its samples. */
function cellsX(field: Heightfield): number {
  return field.width - 1;
}

function cellsZ(field: Heightfield): number {
  return field.depth - 1;
}

/** One sample, by grid index, clamped — a query at the rim reads the rim. */
function sample(field: Heightfield, ix: number, iz: number): number {
  const x = ix < 0 ? 0 : ix > field.width - 1 ? field.width - 1 : ix;
  const z = iz < 0 ? 0 : iz > field.depth - 1 ? field.depth - 1 : iz;
  return (field.origin?.[1] ?? 0) + (field.heights[z * field.width + x] ?? 0);
}

/** Where sample `(0, 0)` stands, along x and z. */
function originX(field: Heightfield): number {
  return field.origin?.[0] ?? 0;
}

function originZ(field: Heightfield): number {
  return field.origin?.[2] ?? 0;
}

/** Whether a lattice point is inside the field, which is what says an edge has a neighbour. */
function inside(field: Heightfield, ix: number, iz: number): boolean {
  return ix >= 0 && iz >= 0 && ix < field.width && iz < field.depth;
}

/**
 * The three corners of a triangle, in the field's own space.
 *
 * **The cell is split along `a`-`c`**, the diagonal from its own sample to the one across it, and
 * the two halves are `a, d, c` and `a, c, b` — wound so the face normal points up. That is the same
 * split `@driftengine/terrain`'s `heightfieldPatch` emits, and it has to be: a collider split the
 * other way disagrees with the picture by up to the height of a cell everywhere but the
 * anti-diagonal, and nothing about that failure is visible.
 *
 * `out` takes nine numbers.
 */
export function fieldCorners(field: Heightfield, triangle: number, out: Float64Array): void {
  const across = cellsX(field);
  const cell = triangle >> 1;
  const half = triangle & 1;
  const cx = cell % across;
  const cz = (cell - cx) / across;
  const step = field.spacingM;
  const x0 = originX(field) + cx * step;
  const x1 = x0 + step;
  const z0 = originZ(field) + cz * step;
  const z1 = z0 + step;

  if (half === 0) {
    /* a, d, c */
    out[0] = x0;
    out[1] = sample(field, cx, cz);
    out[2] = z0;
    out[3] = x0;
    out[4] = sample(field, cx, cz + 1);
    out[5] = z1;
    out[6] = x1;
    out[7] = sample(field, cx + 1, cz + 1);
    out[8] = z1;
    return;
  }
  /* a, c, b */
  out[0] = x0;
  out[1] = sample(field, cx, cz);
  out[2] = z0;
  out[3] = x1;
  out[4] = sample(field, cx + 1, cz + 1);
  out[5] = z1;
  out[6] = x1;
  out[7] = sample(field, cx + 1, cz);
  out[8] = z0;
}

/** Scratch for a plane derived from corners, so nothing here allocates in the tick. */
const CORNERS = new Float64Array(9);

/**
 * The triangle's outward plane as `nx, ny, nz, d`, with `d = n · v0`.
 *
 * Normalised, and pointing up: a heightfield has no overhangs, so every face of it faces the sky.
 * A degenerate triangle — two samples at the same place, which a spacing of zero would give and
 * nothing else does — writes a zero normal, which the contact code skips exactly as it does for a
 * degenerate mesh triangle.
 */
export function fieldPlane(field: Heightfield, triangle: number, out: Float64Array): void {
  fieldCorners(field, triangle, CORNERS);
  const ax = CORNERS[0] ?? 0;
  const ay = CORNERS[1] ?? 0;
  const az = CORNERS[2] ?? 0;
  const ux = (CORNERS[3] ?? 0) - ax;
  const uy = (CORNERS[4] ?? 0) - ay;
  const uz = (CORNERS[5] ?? 0) - az;
  const vx = (CORNERS[6] ?? 0) - ax;
  const vy = (CORNERS[7] ?? 0) - ay;
  const vz = (CORNERS[8] ?? 0) - az;
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (length > 1e-12) {
    nx /= length;
    ny /= length;
    nz /= length;
  } else {
    nx = 0;
    ny = 0;
    nz = 0;
  }
  out[0] = nx;
  out[1] = ny;
  out[2] = nz;
  out[3] = nx * ax + ny * ay + nz * az;
}

/** How far a neighbour's opposite sample must sit below the plane before the fold has a direction. */
const COPLANAR_M = 1e-5;

/** Scratch for the classification, which runs per candidate triangle inside the tick. */
const PLANE = new Float64Array(4);

/**
 * Which of a triangle's three edges a contact normal may come off, as three bits.
 *
 * **Computed rather than precomputed, and that is the saving.** `meshShape` walks every edge of a
 * level once at build time and stores three bits per triangle; a field's answer is four samples and
 * a subtraction, so there is nothing to store. Edge `i` runs from local vertex `i` to `(i + 1) % 3`,
 * matching `TriangleMesh.convexEdges` exactly, because `meshContact.ts` reads both the same way.
 *
 * The rule is `meshShape`'s: an edge is convex where the neighbouring triangle's opposite vertex
 * sits *below* this triangle's plane, and where the edge has no neighbour at all. A coplanar seam is
 * **not** convex, which is the whole of the interior-edge filter — a flat floor made of triangles
 * must not push a body back along the joins.
 *
 * Each of the five edges a cell has meets its neighbour at a single lattice point, and the
 * neighbour exists exactly when that point is inside the field:
 *
 * - half 0: edge 0 at `(cx - 1, cz)`, edge 1 at `(cx + 1, cz + 2)`, edge 2 — the diagonal — at
 *   `(cx + 1, cz)`, which is the other half's own third corner.
 * - half 1: edge 0 — the same diagonal — at `(cx, cz + 1)`, edge 1 at `(cx + 2, cz + 1)`, edge 2 at
 *   `(cx, cz - 1)`.
 */
export function fieldConvexEdges(field: Heightfield, triangle: number): number {
  const across = cellsX(field);
  const cell = triangle >> 1;
  const half = triangle & 1;
  const cx = cell % across;
  const cz = (cell - cx) / across;
  fieldPlane(field, triangle, PLANE);

  let bits = 0b111;
  for (let e = 0; e < 3; e++) {
    let ox = 0;
    let oz = 0;
    if (half === 0) {
      if (e === 0) {
        ox = cx - 1;
        oz = cz;
      } else if (e === 1) {
        ox = cx + 1;
        oz = cz + 2;
      } else {
        ox = cx + 1;
        oz = cz;
      }
    } else if (e === 0) {
      ox = cx;
      oz = cz + 1;
    } else if (e === 1) {
      ox = cx + 2;
      oz = cz + 1;
    } else {
      ox = cx;
      oz = cz - 1;
    }

    /* No neighbour is a boundary edge, and a boundary edge is convex: there is nothing on the other
       side for a body to be caught between. */
    if (!inside(field, ox, oz)) continue;

    const px = originX(field) + ox * field.spacingM;
    const py = sample(field, ox, oz);
    const pz = originZ(field) + oz * field.spacingM;
    const height =
      px * (PLANE[0] ?? 0) + py * (PLANE[1] ?? 0) + pz * (PLANE[2] ?? 0) - (PLANE[3] ?? 0);
    if (!(height < -COPLANAR_M)) bits &= ~(1 << e);
  }
  return bits;
}

/**
 * The triangles a box could touch, written into `out`, as a count.
 *
 * **An index range rather than a tree**, which is the other half of what a heightfield buys: the
 * cells a box covers are `(minX - originX) / spacing` to `(maxX - originX) / spacing`, and the same
 * in z. There is no structure to build, to keep, or to rebuild when the field changes.
 *
 * **And a height test per cell, which is most of the saving in practice.** A body on a hillside
 * covers a wide footprint in x and z and touches almost none of it, the rest being metres above or
 * below — so a cell whose four samples all sit outside the box's own y range is skipped before the
 * narrow phase ever sees it.
 *
 * Fills to `out.length` and stops, exactly as `DynamicTree.query` does, so the caller's grow-and-
 * retry loop works unchanged.
 */
export function fieldCandidates(field: Heightfield, box: Aabb, out: Int32Array): number {
  const step = field.spacingM;
  const across = cellsX(field);
  const down = cellsZ(field);
  const ox = originX(field);
  const oz = originZ(field);
  const fromX = Math.max(0, Math.floor((box.minX - ox) / step));
  const toX = Math.min(across - 1, Math.floor((box.maxX - ox) / step));
  const fromZ = Math.max(0, Math.floor((box.minZ - oz) / step));
  const toZ = Math.min(down - 1, Math.floor((box.maxZ - oz) / step));

  let count = 0;
  for (let cz = fromZ; cz <= toZ; cz++) {
    for (let cx = fromX; cx <= toX; cx++) {
      const a = sample(field, cx, cz);
      const b = sample(field, cx + 1, cz);
      const c = sample(field, cx + 1, cz + 1);
      const d = sample(field, cx, cz + 1);
      const low = Math.min(a, b, c, d);
      const high = Math.max(a, b, c, d);
      if (high < box.minY || low > box.maxY) continue;
      const cell = cz * across + cx;
      if (count === out.length) return count;
      out[count++] = cell * 2;
      if (count === out.length) return count;
      out[count++] = cell * 2 + 1;
    }
  }
  return count;
}

/**
 * Build a heightfield collision shape.
 *
 * Returns a `ConvexShape` whose `triangles` names the field — so every existing test of "is this a
 * mesh" answers yes and every rule that follows from it holds: refused as a kinematic collider,
 * refused on anything but a static body, and given a static body's own zero mass tensor. Its
 * `vertices` are the eight corners of the field's bounds, so the broad phase measures the right box,
 * and its `faceNormals` and `edgeDirs` are empty for the reason `meshShape` gives: a field has no
 * separating axes worth enumerating, and handing the kinematic sweep the box's three would make a
 * hillside a solid brick.
 *
 * **The heights are kept and not copied**, the same bargain `meshShape` makes with a level's
 * vertices: a field is the thing being avoided allocating twice. A caller must not go on mutating
 * them, which is stated here because nothing enforces it — and unlike a mesh there is nothing to
 * rebuild if they do, so a caller who *wants* a changing field may mutate and the collider follows.
 */
export function heightfieldShape(field: Heightfield): ConvexShape {
  if (!(field.width >= 2)) {
    throw new Error(`heightfieldShape: width must be at least 2, got ${field.width}`);
  }
  if (!(field.depth >= 2)) {
    throw new Error(`heightfieldShape: depth must be at least 2, got ${field.depth}`);
  }
  if (!(field.spacingM > 0)) {
    throw new Error(`heightfieldShape: spacing must be above zero, got ${field.spacingM}`);
  }
  if (field.heights.length !== field.width * field.depth) {
    throw new Error(
      `heightfieldShape: ${field.width} by ${field.depth} needs ${field.width * field.depth} ` +
        `heights, got ${field.heights.length}`,
    );
  }

  let low = Infinity;
  let high = -Infinity;
  for (let i = 0; i < field.heights.length; i++) {
    const h = field.heights[i] ?? 0;
    if (h < low) low = h;
    if (h > high) high = h;
  }
  const baseX = originX(field);
  const baseY = field.origin?.[1] ?? 0;
  const baseZ = originZ(field);
  const minX = baseX;
  const maxX = baseX + cellsX(field) * field.spacingM;
  const minY = baseY + low;
  const maxY = baseY + high;
  const minZ = baseZ;
  const maxZ = baseZ + cellsZ(field) * field.spacingM;

  return {
    vertices: new Float32Array([
      minX,
      minY,
      minZ,
      maxX,
      minY,
      minZ,
      minX,
      maxY,
      minZ,
      maxX,
      maxY,
      minZ,
      minX,
      minY,
      maxZ,
      maxX,
      minY,
      maxZ,
      minX,
      maxY,
      maxZ,
      maxX,
      maxY,
      maxZ,
    ]),
    faceNormals: new Float32Array(0),
    edgeDirs: new Float32Array(0),
    radius: 0,
    sideRadius: 0,
    boundRadius: Math.sqrt(
      Math.max(minX * minX, maxX * maxX) +
        Math.max(minY * minY, maxY * maxY) +
        Math.max(minZ * minZ, maxZ * maxZ),
    ),
    facePlanes: new Float32Array(0),
    faceVertexStart: new Uint16Array(0),
    faceVertexIndices: new Uint16Array(0),
    triangles: {
      positions: new Float32Array(0),
      indices: new Uint32Array(0),
      triangleCount: cellsX(field) * cellsZ(field) * 2,
      planes: new Float32Array(0),
      convexEdges: new Uint8Array(0),
      tree: null,
      field,
    },
  };
}
