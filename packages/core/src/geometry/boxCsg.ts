/**
 * Booleans on axis-aligned boxes, exactly and with as few faces as the result has.
 *
 * **Why beside `csg.ts` rather than in it.** A BSP boolean splits every face along every plane that
 * crosses it, unrelated cutters included, and never re-merges: a wall of seven boxes with twenty
 * window openings cut out of it came back as 325,187 triangles and took a minute. Boxes that share
 * their axes need none of that. Every face of the result lies on a plane some box already has, so
 * the space splits into the grid of all their coordinates, each cell is in or out by applying the
 * operations to its centre in order, and the surface is the faces between cells that differ —
 * merged greedily into the largest rectangles that fit. The same wall is a few hundred triangles,
 * in milliseconds.
 *
 * **What it gives up.** Only boxes, only on the three axes: a box turned off them is the BSP's.
 * Merged rectangles meet with T-junctions, as the BSP's pieces do, so the result is closed as a
 * surface — its volume exact — but not edge for edge. Texture coordinates run 0..1 across the
 * result's own extent on each face's plane, which is what `solidBox` gives a single box. The grid
 * costs a byte a cell, so a caller with hundreds of boxes should check `boxBooleanCells` first.
 */
import type { Solid } from './solid.ts';
import { emptySolid } from './solid.ts';
import { SolidWriter } from './solidWriter.ts';

export interface BoxOperation {
  /** Minimum and maximum corners: `[x0, y0, z0, x1, y1, z1]`. */
  readonly box: readonly [number, number, number, number, number, number];
  readonly op: 'union' | 'subtract' | 'intersect';
}

/** Coordinates within this distance are one. */
const SAME = 1e-6;

function axis(operations: readonly BoxOperation[], a: number): number[] {
  const values = operations
    .flatMap((o) => [o.box[a] as number, o.box[a + 3] as number])
    .sort((p, q) => p - q);
  const out: number[] = [];
  for (const v of values)
    if (out.length === 0 || v - (out[out.length - 1] as number) > SAME) out.push(v);
  return out;
}

/** How many grid cells `solidBoxBoolean` would allocate for `operations`. */
export function boxBooleanCells(operations: readonly BoxOperation[]): number {
  return (
    (axis(operations, 0).length - 1) *
    (axis(operations, 1).length - 1) *
    (axis(operations, 2).length - 1)
  );
}

/** The solid the operations make, applied left to right from nothing. */
export function solidBoxBoolean(operations: readonly BoxOperation[]): Solid {
  if (operations.length === 0) return emptySolid();
  const xs = axis(operations, 0);
  const ys = axis(operations, 1);
  const zs = axis(operations, 2);
  const nx = xs.length - 1;
  const ny = ys.length - 1;
  const nz = zs.length - 1;
  if (nx <= 0 || ny <= 0 || nz <= 0) return emptySolid();
  const inside = new Uint8Array(nx * ny * nz);
  const at = (i: number, j: number, k: number): number => (k * ny + j) * nx + i;
  for (let k = 0; k < nz; k += 1) {
    const cz = ((zs[k] as number) + (zs[k + 1] as number)) / 2;
    for (let j = 0; j < ny; j += 1) {
      const cy = ((ys[j] as number) + (ys[j + 1] as number)) / 2;
      for (let i = 0; i < nx; i += 1) {
        const cx = ((xs[i] as number) + (xs[i + 1] as number)) / 2;
        let state = false;
        for (const o of operations) {
          const b = o.box;
          const hit = cx > b[0] && cx < b[3] && cy > b[1] && cy < b[4] && cz > b[2] && cz < b[5];
          if (o.op === 'union') state ||= hit;
          else if (o.op === 'subtract') state &&= !hit;
          else state &&= hit;
        }
        inside[at(i, j, k)] = state ? 1 : 0;
      }
    }
  }
  const filled = (i: number, j: number, k: number): boolean =>
    i >= 0 && j >= 0 && k >= 0 && i < nx && j < ny && k < nz && inside[at(i, j, k)] === 1;
  const out = new SolidWriter();
  const coords = [xs, ys, zs];
  const counts = [nx, ny, nz];
  const lo = [xs[0] as number, ys[0] as number, zs[0] as number];
  const span = [
    (xs[nx] as number) - (lo[0] as number),
    (ys[ny] as number) - (lo[1] as number),
    (zs[nz] as number) - (lo[2] as number),
  ];
  for (let d = 0; d < 3; d += 1) {
    /* The face plane's two in-plane axes, ordered so (u × v) is +d. */
    const u = (d + 1) % 3;
    const v = (d + 2) % 3;
    const nu = counts[u] as number;
    const nv = counts[v] as number;
    for (let s = 0; s <= (counts[d] as number); s += 1) {
      for (const sign of [1, -1]) {
        /* Faces on plane s facing `sign`: the cell behind is in, the one in front is out. */
        const mask = new Uint8Array(nu * nv);
        for (let b = 0; b < nv; b += 1) {
          for (let a = 0; a < nu; a += 1) {
            const cell = [0, 0, 0];
            cell[u] = a;
            cell[v] = b;
            cell[d] = sign > 0 ? s - 1 : s;
            const front = [...cell];
            front[d] = sign > 0 ? s : s - 1;
            const inCell = filled(cell[0] as number, cell[1] as number, cell[2] as number);
            const inFront = filled(front[0] as number, front[1] as number, front[2] as number);
            if (inCell && !inFront) mask[b * nu + a] = 1;
          }
        }
        for (let b = 0; b < nv; b += 1) {
          for (let a = 0; a < nu; a += 1) {
            if (mask[b * nu + a] !== 1) continue;
            let a1 = a + 1;
            while (a1 < nu && mask[b * nu + a1] === 1) a1 += 1;
            let b1 = b + 1;
            grow: while (b1 < nv) {
              for (let x = a; x < a1; x += 1) if (mask[b1 * nu + x] !== 1) break grow;
              b1 += 1;
            }
            for (let y = b; y < b1; y += 1) for (let x = a; x < a1; x += 1) mask[y * nu + x] = 0;
            quad(
              out,
              d,
              u,
              v,
              sign,
              (coords[d] as number[])[s] as number,
              [
                (coords[u] as number[])[a] as number,
                (coords[u] as number[])[a1] as number,
                (coords[v] as number[])[b] as number,
                (coords[v] as number[])[b1] as number,
              ],
              lo,
              span,
            );
          }
        }
      }
    }
  }
  return out.finish();
}

function quad(
  out: SolidWriter,
  d: number,
  u: number,
  v: number,
  sign: number,
  plane: number,
  [u0, u1, v0, v1]: [number, number, number, number],
  lo: number[],
  span: number[],
): void {
  const corner = (cu: number, cv: number): number => {
    const p = [0, 0, 0];
    p[d] = plane;
    p[u] = cu;
    p[v] = cv;
    const n = [0, 0, 0];
    n[d] = sign;
    return out.vertex(
      p[0] as number,
      p[1] as number,
      p[2] as number,
      n[0] as number,
      n[1] as number,
      n[2] as number,
      (cu - (lo[u] as number)) / ((span[u] as number) || 1),
      (cv - (lo[v] as number)) / ((span[v] as number) || 1),
    );
  };
  const a = corner(u0, v0);
  const b = corner(u1, v0);
  const c = corner(u1, v1);
  const e = corner(u0, v1);
  /* Counter-clockwise from outside: (u × v) is +d, so a facing +d winds a b c, a facing −d reverses. */
  if (sign > 0) out.quad(a, b, c, e);
  else out.quad(a, e, c, b);
}
