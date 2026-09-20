/**
 * The world as a sparse grid of cells: the unit that streams, freezes and rebases.
 *
 * **A position on a boundary belongs to exactly one cell, and which one is decided by `Math.floor`
 * rather than by rounding.** Both sides, or neither, are the two ways this goes wrong, and both
 * present as an entity that flickers between cells while standing still — which then flickers
 * between loaded and unloaded.
 *
 * **Negative coordinates work.** A naive bit-packing of the grid coordinate breaks below zero and
 * the symptom is a world that is fine in one quadrant, which is the quadrant anybody tests in.
 */

import { mat4 } from 'gl-matrix';
import { boxInFrustum, frustumFromViewProjection } from '../math/frustum.ts';

/**
 * Bits per axis in a packed cell identifier.
 *
 * Seventeen gives ±65,536 cells an axis, and three of them multiply to 2.25e15 — inside the
 * 9.01e15 an integer stays exact in a double. At a 256-metre cell that is ±16,777 km an axis,
 * which is more world than anybody has; at one metre it is still ±65 km.
 */
const AXIS_BITS = 17;
const AXIS_SPAN = 1 << AXIS_BITS;
const AXIS_BIAS = AXIS_SPAN >> 1;

/** The grid coordinate a world coordinate falls in. */
export function cellCoord(value: number, size: number): number {
  return Math.floor(value / size);
}

/** Whether these grid coordinates fit the packing. See `AXIS_BITS` for the range. */
export function cellCoordInRange(c: number): boolean {
  return Number.isInteger(c) && c >= -AXIS_BIAS && c < AXIS_BIAS;
}

/**
 * Pack grid coordinates into one identifier.
 *
 * **Out of range throws rather than wrapping**, and the reason is what wrapping does: a coordinate
 * past the bias produces an identifier belonging to a different, real cell, so two distant places
 * in the world silently become the same cell. That is a corruption with no symptom near where it
 * happened. This is a streaming-time path, not a per-vertex one, so the check costs nothing that
 * matters.
 */
export function cellIdFrom(cx: number, cy: number, cz: number): number {
  if (!cellCoordInRange(cx) || !cellCoordInRange(cy) || !cellCoordInRange(cz)) {
    throw new RangeError(
      `cell coordinate (${cx}, ${cy}, ${cz}) is outside the ±${AXIS_BIAS} the packing holds`,
    );
  }
  const x = cx + AXIS_BIAS;
  const y = cy + AXIS_BIAS;
  const z = cz + AXIS_BIAS;
  /* Multiplication rather than shifts: a shift in JavaScript is 32-bit and would wrap here. */
  return (x * AXIS_SPAN + y) * AXIS_SPAN + z;
}

export function cellIdFor(x: number, y: number, z: number, size: number): number {
  return cellIdFrom(cellCoord(x, size), cellCoord(y, size), cellCoord(z, size));
}

export function cellCoordsOf(id: number, out: Int32Array): void {
  const z = id % AXIS_SPAN;
  const rest = (id - z) / AXIS_SPAN;
  const y = rest % AXIS_SPAN;
  const x = (rest - y) / AXIS_SPAN;
  out[0] = x - AXIS_BIAS;
  out[1] = y - AXIS_BIAS;
  out[2] = z - AXIS_BIAS;
}

const COORDS = new Int32Array(3);

/** Minimum corner and size, in world units. */
export function cellBounds(id: number, size: number, out: Float64Array): void {
  cellCoordsOf(id, COORDS);
  out[0] = (COORDS[0] as number) * size;
  out[1] = (COORDS[1] as number) * size;
  out[2] = (COORDS[2] as number) * size;
  out[3] = size;
}

/**
 * Every cell within `radius` of a point, appended to `out`.
 *
 * Symmetric about the centre and conservative: a cell the sphere merely touches is included,
 * because the cost of an extra cell is a wasted load and the cost of a missing one is a hole.
 */
export function cellsInRadius(
  x: number,
  y: number,
  z: number,
  radius: number,
  size: number,
  out: number[],
): number {
  out.length = 0;
  const lo = [
    cellCoord(x - radius, size),
    cellCoord(y - radius, size),
    cellCoord(z - radius, size),
  ];
  const hi = [
    cellCoord(x + radius, size),
    cellCoord(y + radius, size),
    cellCoord(z + radius, size),
  ];
  for (let cx = lo[0] as number; cx <= (hi[0] as number); cx += 1) {
    for (let cy = lo[1] as number; cy <= (hi[1] as number); cy += 1) {
      for (let cz = lo[2] as number; cz <= (hi[2] as number); cz += 1) {
        out.push(cellIdFrom(cx, cy, cz));
      }
    }
  }
  return out.length;
}

/**
 * The grid a query walks: its cell, and the most cells one query may walk.
 *
 * **The limit is stated rather than discovered.** A view's frustum is bounded by its far plane, and
 * a far plane a thousand cells away is a million-cell walk per predicted frame — a frame-time cliff
 * that looks like a hang. A query that would walk more than `maxCells` refuses and says how many.
 */
export interface CellGrid {
  /** Cell edge length, world units. */
  readonly size: number;
  readonly maxCells: number;
}

export function createCellGrid(size: number, maxCells = 65_536): CellGrid {
  if (!(size > 0 && size < Infinity)) {
    throw new RangeError(`a cell of ${String(size)} units is not a cell`);
  }
  if (!(Number.isInteger(maxCells) && maxCells >= 1)) {
    throw new RangeError(`a limit of ${String(maxCells)} cells is not a limit`);
  }
  return { size, maxCells };
}

/* Double precision throughout: a world past 2^24 units is what this grid is for. */
const PLANES = new Float64Array(24);
const INVERSE = new Float64Array(16);
const CORNER_LOW = new Float64Array(3);
const CORNER_HIGH = new Float64Array(3);

/**
 * Every cell the view looks into, into `out`, in coordinate order. Returns how many.
 *
 * `viewProj` is column-major and OpenGL-convention, as `gl-matrix` builds one, and in absolute
 * world units — **in double precision if the world is past 2^24**, because a plane's offset out there
 * is not a number a single float holds to the metre.
 *
 * **Conservative, as `cellsInRadius` is**: a cell is left out only when it lies wholly beyond one of
 * the view's planes, so every point the view can see is in a returned cell, and a cell near a
 * corner of the view can be returned without being seen. The cells walked are those inside the
 * box round the view's eight corners, which is why a view with no far plane is refused: its box has
 * no far side.
 */
export function cellsInFrustum(grid: CellGrid, viewProj: ArrayLike<number>, out: number[]): number {
  out.length = 0;
  const matrix = viewProj as Float64Array;
  if (mat4.invert(INVERSE, matrix) === null) {
    throw new RangeError('cellsInFrustum: a view with no inverse has no far plane to bound it');
  }
  CORNER_LOW.fill(Infinity);
  CORNER_HIGH.fill(-Infinity);
  for (let corner = 0; corner < 8; corner += 1) {
    const x = corner & 1 ? 1 : -1;
    const y = corner & 2 ? 1 : -1;
    const z = corner & 4 ? 1 : -1;
    const m = INVERSE;
    const w =
      (m[3] as number) * x + (m[7] as number) * y + (m[11] as number) * z + (m[15] as number);
    /*
     * A corner at or behind the eye's plane is a corner at infinity: the view has no far side.
     * **This is the only check the corners need.** A lens deep enough for a corner to overflow has
     * its far plane at infinity in double precision, where this is exactly zero, and a matrix small
     * enough to overflow its inverse has a determinant that has already underflowed to none.
     */
    if (!(w > 0)) {
      throw new RangeError('cellsInFrustum: a view whose far plane is at infinity bounds no cells');
    }
    for (let axis = 0; axis < 3; axis += 1) {
      const value =
        ((m[axis] as number) * x +
          (m[4 + axis] as number) * y +
          (m[8 + axis] as number) * z +
          (m[12 + axis] as number)) /
        w;
      CORNER_LOW[axis] = Math.min(CORNER_LOW[axis] as number, value);
      CORNER_HIGH[axis] = Math.max(CORNER_HIGH[axis] as number, value);
    }
  }
  const size = grid.size;
  const x0 = cellCoord(CORNER_LOW[0] as number, size);
  const y0 = cellCoord(CORNER_LOW[1] as number, size);
  const z0 = cellCoord(CORNER_LOW[2] as number, size);
  const x1 = cellCoord(CORNER_HIGH[0] as number, size);
  const y1 = cellCoord(CORNER_HIGH[1] as number, size);
  const z1 = cellCoord(CORNER_HIGH[2] as number, size);
  const span = (x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1);
  if (span > grid.maxCells) {
    throw new RangeError(
      `cellsInFrustum: this view spans ${String(span)} cells, more than the ${String(grid.maxCells)} its grid allows`,
    );
  }

  frustumFromViewProjection(matrix, PLANES);
  for (let cx = x0; cx <= x1; cx += 1) {
    for (let cy = y0; cy <= y1; cy += 1) {
      for (let cz = z0; cz <= z1; cz += 1) {
        if (
          boxInFrustum(
            PLANES,
            cx * size,
            cy * size,
            cz * size,
            (cx + 1) * size,
            (cy + 1) * size,
            (cz + 1) * size,
          )
        ) {
          out.push(cellIdFrom(cx, cy, cz));
        }
      }
    }
  }
  return out.length;
}
