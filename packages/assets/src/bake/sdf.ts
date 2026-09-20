/** A signed distance field per object, baked offline, for tracing light through a world. */

import type { MeshData } from '@driftengine/drft';

/**
 * What an object's distance field is, and why it is baked rather than computed.
 *
 * **Indirect light needs to ask what is in a direction, and a triangle list cannot answer that
 * cheaply.** A ray against a mesh is a traversal; a ray against a distance field is a march that
 * steps by the field's own value and converges in a handful of steps, because the value *is* a
 * safe step. That is the whole of sphere tracing, and the one property it rests on is that the
 * field is a distance — gradient of unit length — rather than merely something with the right
 * sign. `sdf.test.ts` measures that property rather than assuming it.
 *
 * **Per object rather than per world**, because the world moves: `globalField.ts` composes these
 * into a field around the camera each frame, and an instance that rotates or streams in has to
 * bring its field with it. A world-scale bake would have to be redone whenever anything moved.
 */
export interface ObjectSdf {
  /** Distance in metres, negative inside. `x` fastest, then `y`, then `z`. */
  readonly field: Float32Array;
  /** Samples on each axis. The spacing is the same on all three; see `bakeObjectSdf`. */
  readonly dims: readonly [number, number, number];
  /** The field's own extent, `[minX, minY, minZ, maxX, maxY, maxZ]`. Padded past the mesh. */
  readonly bounds: Float32Array;
}

/**
 * Voxels of clearance around the mesh, on every axis.
 *
 * **A field that stops at the mesh cannot be marched into.** A ray approaching from outside needs
 * somewhere to take its first steps, and a gradient at the boundary needs a neighbour on both
 * sides — the central difference at an edge texel has neither. Two is the smallest number that
 * gives both and it is cheap on the thin axis of a wall, which is exactly where padding by a
 * fraction of the extent would cost the most.
 */
const PAD_VOXELS = 2;

/**
 * Voxels past a triangle's own box that get an exactly computed distance.
 *
 * Everything further away is filled by propagation, which carries the *closest triangle* outward
 * and recomputes the exact distance to it rather than accumulating a stepped approximation — so
 * the far field is exact wherever the nearest triangle is reachable from a neighbour, which for
 * anything short of a spiral is everywhere.
 */
const EXACT_BAND = 1;

/** Larger than any distance a padded grid can hold, and finite so arithmetic on it behaves. */
const UNREACHED = 1e30;

/**
 * Bake one mesh into a signed distance field.
 *
 * `resolution` is voxels along the mesh's **longest** axis; the other two get however many the
 * same spacing needs. **Cubic voxels are not tidiness** — a field with a different step per axis
 * has a gradient whose length varies with direction, which is the one property a sphere trace
 * depends on, and the failure is a march that overshoots along the coarse axis.
 *
 * **The sign comes from crossing parity, not from the winding.** A face normal, an
 * angle-weighted pseudonormal and a generalised winding number all flip when a mesh is exported
 * with its triangles the other way round, and importers disagree about that constantly — so a
 * model from the wrong tool would come back solid where it is empty. Counting how many times a
 * ray along `x` crosses the surface does not care which way a triangle faces.
 *
 * **The magnitude comes from exact point-to-triangle distance, not from voxelisation.** Marking
 * the cells a triangle passes through and flooding outward loses any wall thinner than a cell,
 * because no cell centre is inside it — and a wall thinner than a cell is most of them. This
 * measures the distance from every grid point in a band around each triangle to that triangle,
 * so a plate a fifth of a voxel thick is still a plate at a fifth of a voxel.
 */
export function bakeObjectSdf(mesh: MeshData, resolution: number): ObjectSdf {
  const positions = mesh.positions;
  const indices = mesh.indices;
  const triangles = Math.floor(indices.length / 3);
  if (triangles < 1) {
    throw new Error('bakeObjectSdf: the mesh has no triangle; a field of nothing has no surface.');
  }
  const voxels = Math.trunc(resolution);
  if (!(voxels >= 2)) {
    throw new Error(
      `bakeObjectSdf: resolution is ${String(resolution)} and the minimum is 2. One sample on an ` +
        'axis has no neighbour to take a gradient against.',
    );
  }

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let at = 0; at + 2 < positions.length; at += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const value = positions[at + axis] as number;
      if (value < (min[axis] as number)) min[axis] = value;
      if (value > (max[axis] as number)) max[axis] = value;
    }
  }

  /*
   * A degenerate axis still needs a step, and the longest axis is what sets it. A perfectly flat
   * quad has zero extent on one axis and is a completely ordinary thing to bake.
   */
  const span = Math.max(
    (max[0] as number) - (min[0] as number),
    (max[1] as number) - (min[1] as number),
    (max[2] as number) - (min[2] as number),
  );
  if (!(span > 0)) {
    throw new Error('bakeObjectSdf: the mesh has no extent on any axis; there is nothing to bake.');
  }
  const step = span / voxels;
  const pad = PAD_VOXELS * step;

  const origin = new Float32Array(3);
  const dims: [number, number, number] = [0, 0, 0];
  for (let axis = 0; axis < 3; axis++) {
    origin[axis] = (min[axis] as number) - pad;
    const reach = (max[axis] as number) + pad - (origin[axis] as number);
    dims[axis] = Math.ceil(reach / step) + 1;
  }
  const [nx, ny, nz] = dims;
  const bounds = new Float32Array([
    origin[0] as number,
    origin[1] as number,
    origin[2] as number,
    (origin[0] as number) + (nx - 1) * step,
    (origin[1] as number) + (ny - 1) * step,
    (origin[2] as number) + (nz - 1) * step,
  ]);

  const count = nx * ny * nz;
  const field = new Float32Array(count).fill(UNREACHED);
  /** The triangle each grid point's distance was measured to, and -1 where none has reached. */
  const closest = new Int32Array(count).fill(-1);
  /** How many times the surface is crossed between grid point `i - 1` and `i` along `x`. */
  const crossings = new Int32Array(count);

  const ox = origin[0] as number;
  const oy = origin[1] as number;
  const oz = origin[2] as number;

  for (let tri = 0; tri < triangles; tri++) {
    const ia = (indices[tri * 3] as number) * 3;
    const ib = (indices[tri * 3 + 1] as number) * 3;
    const ic = (indices[tri * 3 + 2] as number) * 3;
    const ax = positions[ia] as number;
    const ay = positions[ia + 1] as number;
    const az = positions[ia + 2] as number;
    const bx = positions[ib] as number;
    const by = positions[ib + 1] as number;
    const bz = positions[ib + 2] as number;
    const cx = positions[ic] as number;
    const cy = positions[ic + 1] as number;
    const cz = positions[ic + 2] as number;

    const i0 = clampIndex(Math.floor((Math.min(ax, bx, cx) - ox) / step) - EXACT_BAND, nx);
    const i1 = clampIndex(Math.ceil((Math.max(ax, bx, cx) - ox) / step) + EXACT_BAND, nx);
    const j0 = clampIndex(Math.floor((Math.min(ay, by, cy) - oy) / step) - EXACT_BAND, ny);
    const j1 = clampIndex(Math.ceil((Math.max(ay, by, cy) - oy) / step) + EXACT_BAND, ny);
    const k0 = clampIndex(Math.floor((Math.min(az, bz, cz) - oz) / step) - EXACT_BAND, nz);
    const k1 = clampIndex(Math.ceil((Math.max(az, bz, cz) - oz) / step) + EXACT_BAND, nz);

    for (let k = k0; k <= k1; k++) {
      const gz = oz + k * step;
      for (let j = j0; j <= j1; j++) {
        const gy = oy + j * step;
        for (let i = i0; i <= i1; i++) {
          const gx = ox + i * step;
          const distance = pointTriangleDistance(gx, gy, gz, ax, ay, az, bx, by, bz, cx, cy, cz);
          const index = i + nx * (j + ny * k);
          if (distance < (field[index] as number)) {
            field[index] = distance;
            closest[index] = tri;
          }
        }
      }
    }

    /*
     * Where a ray along `x` through each grid column crosses this triangle. Recorded at the first
     * grid point past the crossing, so a scan along `x` accumulating these counts knows, at every
     * point, how many surfaces stand between it and the grid's `-x` face.
     */
    for (let k = clampIndex(Math.ceil((Math.min(az, bz, cz) - oz) / step), nz); k < nz; k++) {
      const gz = oz + k * step;
      if (gz > Math.max(az, bz, cz)) break;
      for (let j = clampIndex(Math.ceil((Math.min(ay, by, cy) - oy) / step), ny); j < ny; j++) {
        const gy = oy + j * step;
        if (gy > Math.max(ay, by, cy)) break;
        const bary = barycentric2d(gy, gz, ay, az, by, bz, cy, cz);
        if (bary === null) continue;
        const x = bary[0] * ax + bary[1] * bx + bary[2] * cx;
        const i = Math.ceil((x - ox) / step);
        /*
         * **Unreachable while `PAD_VOXELS` is at least one, and kept because it is a constant.**
         * The grid reaches two voxels past the mesh on every axis, so no crossing can land past
         * the `+x` face; with no padding one could, and clamping it would mark the last grid point
         * as having one more surface behind it than it does — flipping the parity of a point that
         * is outside. A crossing before the `-x` face is clamped to zero, where it is true: the
         * grid's first point really does have that surface behind it.
         */
        if (i >= nx) continue;
        crossings[Math.max(0, i) + nx * (j + ny * k)]++;
      }
    }
  }

  /*
   * Carry the closest triangle outward and recompute against it, eight directions twice. Two
   * passes rather than one because a point whose nearest triangle lies around a corner is reached
   * by a sweep that has itself only just been filled, and the second pass is what lets that
   * propagate the rest of the way.
   */
  for (let pass = 0; pass < 2; pass++) {
    for (const [dx, dy, dz] of SWEEPS) {
      sweep(field, closest, positions, indices, dims, origin, step, dx, dy, dz);
    }
  }

  /* Anything nothing ever reached is as far away as the grid can express, not a sentinel. */
  const reach = step * (nx + ny + nz);
  for (let index = 0; index < count; index++) {
    if ((field[index] as number) >= UNREACHED) field[index] = reach;
  }

  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      let total = 0;
      const row = nx * (j + ny * k);
      for (let i = 0; i < nx; i++) {
        total += crossings[row + i] as number;
        if (total % 2 === 1) field[row + i] = -(field[row + i] as number);
      }
    }
  }

  return { field, dims, bounds };
}

/** The eight diagonal orders a propagation runs in, so every direction has one that follows it. */
const SWEEPS: readonly (readonly [number, number, number])[] = [
  [1, 1, 1],
  [-1, -1, -1],
  [1, 1, -1],
  [-1, -1, 1],
  [1, -1, 1],
  [-1, 1, -1],
  [1, -1, -1],
  [-1, 1, 1],
];

/** One propagation pass: every point takes its neighbours' triangles if one of them is nearer. */
function sweep(
  field: Float32Array,
  closest: Int32Array,
  positions: Float32Array,
  indices: Uint32Array,
  dims: readonly [number, number, number],
  origin: Float32Array,
  step: number,
  dx: number,
  dy: number,
  dz: number,
): void {
  const [nx, ny, nz] = dims;
  const i0 = dx > 0 ? 1 : nx - 2;
  const i1 = dx > 0 ? nx : -1;
  const j0 = dy > 0 ? 1 : ny - 2;
  const j1 = dy > 0 ? ny : -1;
  const k0 = dz > 0 ? 1 : nz - 2;
  const k1 = dz > 0 ? nz : -1;

  for (let k = k0; k !== k1; k += dz) {
    const gz = (origin[2] as number) + k * step;
    for (let j = j0; j !== j1; j += dy) {
      const gy = (origin[1] as number) + j * step;
      for (let i = i0; i !== i1; i += dx) {
        const gx = (origin[0] as number) + i * step;
        const index = i + nx * (j + ny * k);
        /* The three already-visited axis neighbours. See `NEIGHBOURS` for why three and not seven. */
        for (const [ni, nj, nk] of NEIGHBOURS) {
          const at = i - ni * dx + nx * (j - nj * dy + ny * (k - nk * dz));
          const triangle = closest[at] as number;
          if (triangle < 0) continue;
          const ia = (indices[triangle * 3] as number) * 3;
          const ib = (indices[triangle * 3 + 1] as number) * 3;
          const ic = (indices[triangle * 3 + 2] as number) * 3;
          const distance = pointTriangleDistance(
            gx,
            gy,
            gz,
            positions[ia] as number,
            positions[ia + 1] as number,
            positions[ia + 2] as number,
            positions[ib] as number,
            positions[ib + 1] as number,
            positions[ib + 2] as number,
            positions[ic] as number,
            positions[ic + 1] as number,
            positions[ic + 2] as number,
          );
          if (distance < (field[index] as number)) {
            field[index] = distance;
            closest[index] = triangle;
          }
        }
      }
    }
  }
}

/**
 * The already-visited neighbours of a point, in the sweep's own frame.
 *
 * **Three, and the reference implementation this follows uses seven.** The other four are the face
 * and body diagonals, and the argument for them is that a field propagating along the axes alone
 * acquires a plus-shaped bias. **That argument does not survive being measured here**, because the
 * diagonals are already carried by the eight *sweep orders*: a unit sphere at resolution 40 comes
 * out with a worst error against the analytic distance of 9.6e-3 either way — the same number to
 * two digits — while the seven-neighbour version takes 1123 ms against 529 ms.
 *
 * What does move is the worst gradient error, 4.0e-2 to 4.6e-2, both of them dominated by the
 * tessellation's own facets and both far under what a march needs. **Reproduce** by adding the
 * four diagonals back and running `sdf.test.ts`, which passes either way and is why this is a
 * measurement rather than a test.
 */
const NEIGHBOURS: readonly (readonly [number, number, number])[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

/** A whole index forced inside a grid, for a triangle's box which may hang over an edge. */
function clampIndex(value: number, count: number): number {
  return value < 0 ? 0 : value > count - 1 ? count - 1 : value;
}

/**
 * Where a point stands in a triangle projected onto one plane, or null if it stands outside.
 *
 * **The tie-break is what stops a shared edge being counted twice or not at all.** A grid column
 * passing exactly along the edge two triangles share is inside both or neither depending on the
 * sign of a zero, and either answer flips the parity of an entire row. Breaking the tie on the
 * coordinates themselves makes the choice consistent between the two triangles: whichever way it
 * goes, exactly one of them claims the column.
 */
function barycentric2d(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): [number, number, number] | null {
  const bxr = bx - px;
  const byr = by - py;
  const cxr = cx - px;
  const cyr = cy - py;
  const axr = ax - px;
  const ayr = ay - py;

  const areaA = orientation(bxr, byr, cxr, cyr);
  if (areaA.sign === 0) return null;
  const areaB = orientation(cxr, cyr, axr, ayr);
  if (areaB.sign !== areaA.sign) return null;
  const areaC = orientation(axr, ayr, bxr, byr);
  if (areaC.sign !== areaA.sign) return null;

  const sum = areaA.area + areaB.area + areaC.area;
  if (sum === 0) return null;
  return [areaA.area / sum, areaB.area / sum, areaC.area / sum];
}

/** Twice the signed area of a triangle with the origin, with zero broken deterministically. */
function orientation(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): { sign: number; area: number } {
  const area = y1 * x2 - x1 * y2;
  if (area > 0) return { sign: 1, area };
  if (area < 0) return { sign: -1, area };
  if (y2 > y1) return { sign: 1, area };
  if (y2 < y1) return { sign: -1, area };
  if (x1 > x2) return { sign: 1, area };
  if (x1 < x2) return { sign: -1, area };
  return { sign: 0, area };
}

/**
 * The distance from a point to the nearest point of a triangle.
 *
 * The seven regions of Voronoi space around a triangle — three vertices, three edges, the face —
 * tested in the order that lets each test assume the ones before it failed. Written out rather
 * than solved as a projection with a clamp, because the clamped projection is wrong outside the
 * face's own region and the error is largest exactly at the silhouette, which is where a marching
 * ray spends its time.
 */
function pointTriangleDistance(
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
): number {
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
  if (d1 <= 0 && d2 <= 0) return Math.hypot(apx, apy, apz);

  const bpx = px - bx;
  const bpy = py - by;
  const bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return Math.hypot(bpx, bpy, bpz);

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return Math.hypot(apx - v * abx, apy - v * aby, apz - v * abz);
  }

  const cpx = px - cx;
  const cpy = py - cy;
  const cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return Math.hypot(cpx, cpy, cpz);

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return Math.hypot(apx - w * acx, apy - w * acy, apz - w * acz);
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return Math.hypot(bpx - w * (cx - bx), bpy - w * (cy - by), bpz - w * (cz - bz));
  }

  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  return Math.hypot(
    apx - (v * abx + w * acx),
    apy - (v * aby + w * acy),
    apz - (v * abz + w * acz),
  );
}
