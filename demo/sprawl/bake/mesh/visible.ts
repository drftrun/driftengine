/**
 * What a building shows from outside: its copies drawn into five depth buffers in its own frame —
 * from each of its four sides and from above — each cell keeping the surface of the outermost face
 * that covers it.
 *
 * **Visibility, not area.** A building is stacked boxes: a facade runs up behind the panel wrapped
 * round it, and a box's top lies under the roof slab laid on it. Counted by area, the hidden face
 * counts as much as the one hiding it and wins as often — a roof came out wearing the concrete of
 * the box under it. Drawn from outside, it counts for nothing, which is what anyone looking sees.
 * **A face is drawn in the view it faces most**: a wall into the side its normal points to, a roof
 * — rising more than 60° from level — into the view from above; what faces down, nothing.
 *
 * **Cells are half a metre**, their edges on the half metres of the building's frame, so a part
 * narrower than a cell may reach no cell's centre and show nowhere: at a coarse level's 4 m error
 * that is noise. What it gives up: a face seen only at a slant — the underside of an overhang, a
 * courtyard's walls — is seen from none of the five.
 */
import type { MeshData } from '@driftengine/drft';

import type { CopyOf } from './kit.ts';

/** How far past its footprint and its height a building's views reach, for what juts out. */
const MARGIN = 4;
const CELL = 0.5;
/** How far outside a triangle a cell's centre may fall and still count as on its edge. */
const EDGE = 1e-9;
/** A face is a roof once its normal rises this far toward straight up. */
const ROOF = 0.5;

interface View {
  /** Along the view's first axis: the building's z for the two x views, its x otherwise. */
  readonly across: number;
  /** Up for a side view, the building's z from above. */
  readonly rows: number;
  readonly depth: Float32Array;
  readonly key: Int32Array;
  /** Where its rows start: the ground for a side, the far edge of the margin from above. */
  readonly rowOrigin: number;
}

export interface Frame {
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
  readonly w: number;
  readonly d: number;
  readonly h: number;
}

export class Elevation {
  private readonly cos: number;
  private readonly sin: number;
  /** Half the square every view spans across, on a whole number of cells. */
  private readonly half: number;
  /** +x, −x, +z, −z, then from above. */
  private readonly views: View[];

  constructor(private readonly frame: Frame) {
    this.cos = Math.cos(frame.yaw);
    this.sin = Math.sin(frame.yaw);
    this.half = Math.ceil((Math.max(frame.w, frame.d) / 2 + MARGIN) / CELL) * CELL;
    const across = Math.round((2 * this.half) / CELL);
    const up = Math.ceil((frame.h + MARGIN) / CELL);
    const view = (rows: number, rowOrigin: number): View => ({
      across,
      rows,
      depth: new Float32Array(across * rows).fill(-Infinity),
      key: new Int32Array(across * rows).fill(-1),
      rowOrigin,
    });
    this.views = [view(up, 0), view(up, 0), view(up, 0), view(up, 0), view(across, -this.half)];
  }

  /** Draw a copy's faces, each cell it wins taking `key`. */
  add(copy: CopyOf, piece: MeshData, key: number): void {
    const m = copy.matrix;
    const { positions: p, indices } = piece;
    const local = new Float64Array(9);
    for (let t = 0; t + 2 < indices.length; t += 3) {
      for (let v = 0; v < 3; v++) {
        const i = (indices[t + v] as number) * 3;
        const [px, py, pz] = [p[i] as number, p[i + 1] as number, p[i + 2] as number];
        const dx =
          (m[0] as number) * px +
          (m[3] as number) * py +
          (m[6] as number) * pz +
          (m[9] as number) -
          this.frame.x;
        const wy =
          (m[1] as number) * px + (m[4] as number) * py + (m[7] as number) * pz + (m[10] as number);
        const dz =
          (m[2] as number) * px +
          (m[5] as number) * py +
          (m[8] as number) * pz +
          (m[11] as number) -
          this.frame.z;
        /* Into the frame a yaw turns: its own x is (cos, −sin) in the world, its z (sin, cos). */
        local[v * 3] = this.cos * dx - this.sin * dz;
        local[v * 3 + 1] = wy;
        local[v * 3 + 2] = this.sin * dx + this.cos * dz;
      }
      const e1 = [0, 1, 2].map((a) => (local[3 + a] as number) - (local[a] as number));
      const e2 = [0, 1, 2].map((a) => (local[6 + a] as number) - (local[a] as number));
      /* The winding is the expansion's, which keeps a face facing out. */
      const mirrored = determinant(m) < 0;
      const sign = mirrored ? -1 : 1;
      const nx =
        sign * ((e1[1] as number) * (e2[2] as number) - (e1[2] as number) * (e2[1] as number));
      const ny =
        sign * ((e1[2] as number) * (e2[0] as number) - (e1[0] as number) * (e2[2] as number));
      const nz =
        sign * ((e1[0] as number) * (e2[1] as number) - (e1[1] as number) * (e2[0] as number));
      const length = Math.hypot(nx, ny, nz);
      if (length === 0) continue;
      if (ny > ROOF * length) this.draw(4, local, 0, 2, 1, 1, key);
      else if (ny >= -ROOF * length) {
        if (Math.abs(nx) >= Math.abs(nz))
          this.draw(nx > 0 ? 0 : 1, local, 2, 1, 0, nx > 0 ? 1 : -1, key);
        else this.draw(nz > 0 ? 2 : 3, local, 0, 1, 2, nz > 0 ? 1 : -1, key);
      }
    }
  }

  /**
   * A triangle into view `v`: its `a` coordinate across, `b` along the rows, and `sign` times its
   * `c` coordinate as depth, nearer the viewer the larger.
   */
  private draw(
    v: number,
    local: Float64Array,
    a: number,
    b: number,
    c: number,
    sign: number,
    key: number,
  ): void {
    const view = this.views[v] as View;
    const pa = [local[a] as number, local[3 + a] as number, local[6 + a] as number];
    const pb = [local[b] as number, local[3 + b] as number, local[6 + b] as number];
    const pd = [
      sign * (local[c] as number),
      sign * (local[3 + c] as number),
      sign * (local[6 + c] as number),
    ];
    const area =
      ((pa[1] as number) - (pa[0] as number)) * ((pb[2] as number) - (pb[0] as number)) -
      ((pa[2] as number) - (pa[0] as number)) * ((pb[1] as number) - (pb[0] as number));
    if (Math.abs(area) < 1e-12) return;
    const i0 = Math.max(0, Math.floor((Math.min(...pa) + this.half) / CELL));
    const i1 = Math.min(view.across - 1, Math.floor((Math.max(...pa) + this.half) / CELL));
    const j0 = Math.max(0, Math.floor((Math.min(...pb) - view.rowOrigin) / CELL));
    const j1 = Math.min(view.rows - 1, Math.floor((Math.max(...pb) - view.rowOrigin) / CELL));
    for (let j = j0; j <= j1; j++) {
      const cb = view.rowOrigin + (j + 0.5) * CELL;
      for (let i = i0; i <= i1; i++) {
        const ca = -this.half + (i + 0.5) * CELL;
        /* Barycentric weights from the edges' signed areas; all of one sign inside. */
        const w0 =
          (((pa[1] as number) - ca) * ((pb[2] as number) - cb) -
            ((pa[2] as number) - ca) * ((pb[1] as number) - cb)) /
          area;
        const w1 =
          (((pa[2] as number) - ca) * ((pb[0] as number) - cb) -
            ((pa[0] as number) - ca) * ((pb[2] as number) - cb)) /
          area;
        const w2 = 1 - w0 - w1;
        /* A centre on the diagonal two triangles share is inside both, within a rounding. */
        if (w0 < -EDGE || w1 < -EDGE || w2 < -EDGE) continue;
        const depth = w0 * (pd[0] as number) + w1 * (pd[1] as number) + w2 * (pd[2] as number);
        const cell = j * view.across + i;
        if (depth > (view.depth[cell] as number)) {
          view.depth[cell] = depth;
          view.key[cell] = key;
        }
      }
    }
  }

  /**
   * What the walls show, band by band `band` metres up: each key's area a band, and where the walls
   * stand in each band in the building's frame — least and most x, then z, four slots a band. Where
   * is the median of what each side shows there, not its outermost: an awning or a sign juts out
   * over a pavement from a wall that does not. And how high they rise, to the cell.
   */
  walls(band: number): { bands: Map<number, number[]>; reach: number[]; top: number } {
    const bands = new Map<number, number[]>();
    const depths: number[][] = [];
    let top = 0;
    for (let v = 0; v < 4; v++) {
      const view = this.views[v] as View;
      /* Which slot of a band's four this view's depth bounds, and whether it bounds from below. */
      const slot = [1, 0, 3, 2][v] as number;
      const least = v === 1 || v === 3;
      for (let j = 0; j < view.rows; j++) {
        const b = Math.floor(((j + 0.5) * CELL) / band);
        for (let i = 0; i < view.across; i++) {
          const cell = j * view.across + i;
          const key = view.key[cell] as number;
          if (key < 0) continue;
          const list = bands.get(key) ?? [];
          while (list.length <= b) list.push(0);
          list[b] = (list[b] as number) + CELL * CELL;
          bands.set(key, list);
          while (depths.length < (b + 1) * 4) depths.push([]);
          const depth = view.depth[cell] as number;
          (depths[b * 4 + slot] as number[]).push(least ? -depth : depth);
          top = Math.max(top, (j + 1) * CELL);
        }
      }
    }
    const reach = depths.map((list, at) => {
      if (list.length === 0) return at % 2 === 0 ? Infinity : -Infinity;
      list.sort((a, b) => a - b);
      return list[Math.floor((list.length - 1) / 2)] as number;
    });
    return { bands, reach, top };
  }

  /** What shows from above: each key's area. */
  roof(): Map<number, number> {
    const view = this.views[4] as View;
    const out = new Map<number, number>();
    for (let cell = 0; cell < view.key.length; cell++) {
      const key = view.key[cell] as number;
      if (key >= 0) out.set(key, (out.get(key) ?? 0) + CELL * CELL);
    }
    return out;
  }
}

function determinant(m: ArrayLike<number>): number {
  const [a, b, c, d, e, f, g, h, k] = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => m[i] as number) as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  return a * (e * k - f * h) - d * (b * k - c * h) + g * (b * f - c * e);
}
