/**
 * The elevated road's lanes: each way along its polyline, each lane mitred at its corners, joined
 * segment to segment and turned round at both ends, since its ramps are not built.
 */
import { Edges, TURN_SPEED, mid } from './laneEdges';
import type { P } from './laneEdges';

export interface RouteData {
  /** x, y, z of each point, in order. */
  readonly points: readonly number[];
  readonly lanes: number;
  readonly laneWidth: number;
  readonly median: number;
  readonly speed: number;
}

/** A route's lanes each way, joined segment to segment and turned round at both ends. */
export function routeLanes(edges: Edges, r: RouteData): void {
  const n = r.points.length / 3;
  if (n < 2) return;
  const point = (i: number): P => [r.points[i * 3], r.points[i * 3 + 1], r.points[i * 3 + 2]] as P;
  const runs = new Map<string, number[]>();
  for (const dir of [1, -1]) {
    const line = Array.from({ length: n }, (_, i) => point(dir > 0 ? i : n - 1 - i));
    for (let k = 0; k < r.lanes; k++) {
      const off = r.median / 2 + (k + 0.5) * r.laneWidth;
      const at = line.map((_, o) => offsetAt(line, o, off));
      const run: number[] = [];
      for (let o = 0; o + 1 < at.length; o++) {
        const a = at[o] as P;
        const b = at[o + 1] as P;
        const e = edges.add(a, mid(a, b), b, r.speed, false);
        if (run.length > 0) edges.nexts[run[run.length - 1] as number]?.push(e);
        run.push(e);
      }
      runs.set(`${dir}|${k}`, run);
    }
  }
  for (const dir of [1, -1]) {
    for (let k = 0; k < r.lanes; k++) {
      const run = runs.get(`${dir}|${k}`) as number[];
      const back = runs.get(`${-dir}|${k}`) as number[];
      const last = run[run.length - 1] as number;
      const p0 = edges.end(last);
      const p2 = edges.start(back[0] as number);
      const s = edges.start(last);
      const len = Math.hypot(p0[0] - s[0], p0[2] - s[2]) || 1;
      const reach = Math.hypot(p2[0] - p0[0], p2[2] - p0[2]);
      const m = mid(p0, p2);
      const c: P = [
        m[0] + ((p0[0] - s[0]) / len) * reach,
        m[1],
        m[2] + ((p0[2] - s[2]) / len) * reach,
      ];
      const t = edges.add(p0, c, p2, TURN_SPEED, true);
      edges.nexts[last]?.push(t);
      edges.nexts[t]?.push(back[0] as number);
    }
  }
}

/** Point `o` of a polyline moved `off` to the right of travel, mitred at a corner. */
function offsetAt(points: readonly P[], o: number, off: number): P {
  const p = points[o] as P;
  const right = (a: P, b: P): [number, number] => {
    const len = Math.hypot(b[0] - a[0], b[2] - a[2]) || 1;
    return [-(b[2] - a[2]) / len, (b[0] - a[0]) / len];
  };
  const before = o > 0 ? right(points[o - 1] as P, p) : null;
  const after = o + 1 < points.length ? right(p, points[o + 1] as P) : null;
  const r1 = before ?? (after as [number, number]);
  const r2 = after ?? r1;
  const nx = r1[0] + r2[0];
  const nz = r1[1] + r2[1];
  const len = Math.hypot(nx, nz) || 1;
  const scale = off / Math.max(0.5, (nx / len) * r2[0] + (nz / len) * r2[1]);
  return [p[0] + (nx / len) * scale, p[1], p[2] + (nz / len) * scale];
}
