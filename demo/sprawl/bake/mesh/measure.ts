/**
 * What a region's coarse level needs to know about a copy without expanding it: how large it
 * stands in the world, and how much of it faces sideways and how much up. And, from a mesh that is
 * expanded, how often its picture repeats along a wall and up it — so a building's box can wear its
 * facade at the facade's own density.
 *
 * **A copy's faces are its piece's, carried by the copy's matrix**: an area vector goes by the
 * matrix's cofactor, and a mirrored copy — which the expansion winds back — by its negative, so a
 * face keeps facing out. **A copy's size is the sides of its box in the world**, and the level's
 * error is compared with the middle one: a rail or a kerb is long, but from where the coarse
 * level is drawn it is its width that shows, and the width is less than the error. **Density is per metre along and up a wall** — the picture's rate along the wall's
 * horizontal and along its slope — **and one rate on a roof**, the square root of how many
 * repeats a square metre holds, since a roof's picture has no up to keep.
 */
import type { MeshData } from '@driftengine/drft';

import type { CopyOf } from './kit.ts';

/** How much of a copy faces sideways and how much up, in square metres. */
export interface Facing {
  side: number;
  up: number;
}

/** A face is a wall until its normal rises more than 60° from level, a roof past that. */
const ROOF = 0.5;

export class PieceMeasures {
  private readonly bounds = new Map<number, Float64Array>();
  private readonly areas = new Map<number, Float64Array>();

  constructor(private readonly pieces: readonly MeshData[]) {}

  private boundsOf(piece: number): Float64Array {
    let b = this.bounds.get(piece);
    if (b === undefined) {
      const p = (this.pieces[piece] as MeshData).positions;
      b = new Float64Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
      for (let i = 0; i < p.length; i += 3) {
        for (let a = 0; a < 3; a++) {
          const v = p[i + a] as number;
          if (v < (b[a] as number)) b[a] = v;
          if (v > (b[3 + a] as number)) b[3 + a] = v;
        }
      }
      this.bounds.set(piece, b);
    }
    return b;
  }

  /** Each triangle's area vector — half its edges' cross product — in the piece's own space. */
  private areasOf(piece: number): Float64Array {
    let out = this.areas.get(piece);
    if (out === undefined) {
      const { positions: p, indices } = this.pieces[piece] as MeshData;
      out = new Float64Array(indices.length);
      for (let t = 0; t + 2 < indices.length; t += 3) {
        const a = (indices[t] as number) * 3;
        const b = (indices[t + 1] as number) * 3;
        const c = (indices[t + 2] as number) * 3;
        const ux = (p[b] as number) - (p[a] as number);
        const uy = (p[b + 1] as number) - (p[a + 1] as number);
        const uz = (p[b + 2] as number) - (p[a + 2] as number);
        const vx = (p[c] as number) - (p[a] as number);
        const vy = (p[c + 1] as number) - (p[a + 1] as number);
        const vz = (p[c + 2] as number) - (p[a + 2] as number);
        out[t] = (uy * vz - uz * vy) / 2;
        out[t + 1] = (uz * vx - ux * vz) / 2;
        out[t + 2] = (ux * vy - uy * vx) / 2;
      }
      this.areas.set(piece, out);
    }
    return out;
  }

  /** The copy's box in the world: its three sides, in metres, longest first. */
  sides(copy: CopyOf): [number, number, number] {
    const b = this.boundsOf(copy.piece);
    const m = copy.matrix;
    const out: number[] = [];
    for (let axis = 0; axis < 3; axis++) {
      let size = 0;
      for (let c = 0; c < 3; c++)
        size += Math.abs(m[c * 3 + axis] as number) * ((b[3 + c] as number) - (b[c] as number));
      out.push(size);
    }
    return out.sort((a, b) => b - a) as [number, number, number];
  }

  /** How much of the copy faces sideways and how much up, in the world. */
  facing(copy: CopyOf): Facing {
    const out: Facing = { side: 0, up: 0 };
    const n = this.areasOf(copy.piece);
    const facing = this.facingOf(copy);
    for (let t = 0; t + 2 < n.length; t += 3) {
      const w = facing(n[t] as number, n[t + 1] as number, n[t + 2] as number);
      const area = Math.hypot(w[0], w[1], w[2]);
      if (w[1] > ROOF * area) out.up += area;
      else if (w[1] >= -ROOF * area) out.side += area;
    }
    return out;
  }

  /** What turns a piece's area vector into the world's for this copy: the cofactor, mirrored back. */
  private facingOf(copy: CopyOf): (nx: number, ny: number, nz: number) => [number, number, number] {
    const m = copy.matrix;
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = [0, 1, 2, 3, 4, 5, 6, 7, 8].map(
      (i) => m[i] as number,
    ) as [number, number, number, number, number, number, number, number, number];
    const k = [
      by * cz - bz * cy,
      bz * cx - bx * cz,
      bx * cy - by * cx,
      cy * az - cz * ay,
      cz * ax - cx * az,
      cx * ay - cy * ax,
      ay * bz - az * by,
      az * bx - ax * bz,
      ax * by - ay * bx,
    ] as const;
    const sign = ax * k[0] + ay * k[1] + az * k[2] < 0 ? -1 : 1;
    return (nx, ny, nz) => [
      sign * (k[0] * nx + k[3] * ny + k[6] * nz),
      sign * (k[1] * nx + k[4] * ny + k[7] * nz),
      sign * (k[2] * nx + k[5] * ny + k[8] * nz),
    ];
  }
}

/**
 * How often an expanded mesh's picture repeats a metre: along and up its walls, or on its roofs,
 * weighted by area. Zero where it has none of the kind asked for.
 */
export function rates(mesh: MeshData, kind: 'side' | 'up'): { ru: number; rv: number } {
  const { positions: p, indices } = mesh;
  const uv = mesh.uvs;
  if (uv === undefined) return { ru: 0, rv: 0 };
  let [su, sv, total] = [0, 0, 0];
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const [a, b, c] = [indices[t] as number, indices[t + 1] as number, indices[t + 2] as number];
    const e1 = [0, 1, 2].map((i) => (p[b * 3 + i] as number) - (p[a * 3 + i] as number)) as V3;
    const e2 = [0, 1, 2].map((i) => (p[c * 3 + i] as number) - (p[a * 3 + i] as number)) as V3;
    const n = cross(e1, e2);
    const twice = Math.hypot(...n);
    if (twice < 1e-12) continue;
    const ny = n[1] / twice;
    const roof = ny > ROOF;
    if (roof !== (kind === 'up') || ny < -ROOF) continue;
    /* Two axes in the face: level across it and along its slope for a wall; any two for a roof. */
    const unit: V3 = [n[0] / twice, ny, n[2] / twice];
    const level = norm(roof ? cross(unit, [0, 0, 1]) : cross(unit, [0, 1, 0]));
    const slope = cross(unit, level);
    const [a1, b1, a2, b2] = [dot(e1, level), dot(e1, slope), dot(e2, level), dot(e2, slope)];
    const det = a1 * b2 - a2 * b1;
    const du1 = (uv[b * 2] as number) - (uv[a * 2] as number);
    const dv1 = (uv[b * 2 + 1] as number) - (uv[a * 2 + 1] as number);
    const du2 = (uv[c * 2] as number) - (uv[a * 2] as number);
    const dv2 = (uv[c * 2 + 1] as number) - (uv[a * 2 + 1] as number);
    /* The picture's change a metre along each axis: its edges' change over the edges' span. */
    const uA = (du1 * b2 - du2 * b1) / det;
    const vA = (dv1 * b2 - dv2 * b1) / det;
    const uB = (du2 * a1 - du1 * a2) / det;
    const vB = (dv2 * a1 - dv1 * a2) / det;
    const area = twice / 2;
    if (roof) {
      const r = Math.sqrt(Math.abs(uA * vB - uB * vA));
      su += r * area;
      sv += r * area;
    } else {
      su += Math.hypot(uA, vA) * area;
      sv += Math.hypot(uB, vB) * area;
    }
    total += area;
  }
  return total === 0 ? { ru: 0, rv: 0 } : { ru: su / total, rv: sv / total };
}

type V3 = [number, number, number];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V3): V3 => {
  const l = Math.hypot(...a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
