/**
 * The monorail: each line a closed loop through its waypoints, tracks side by side where lines
 * share an edge, corners rounded, one line climbing over another where they cross, and each stop
 * settled on a stretch its platform fits.
 *
 * **Where lines share an edge they run a corridor apart**: every edge of every line is given a
 * slot among the lines lying on it, `corridor` metres apart and centred on the waypoints, so two
 * loops sharing a street run as two tracks, as the reference's map draws them. The shifted edges
 * meet at their intersections, and each corner is filleted to the line's radius.
 *
 * **Where two tracks cross, the higher-ranked line climbs** `CLIMB` metres over the lower on ramps
 * of `RAMP` each side. **A stop's position is a hint**: it goes to the nearest point of its line
 * whose whole platform (`platform_half` each way) is straight and level, searched out to
 * `SEARCH`; a stop with no such stretch is dropped and reported, as the reference's own log
 * shows it doing ("found no clear platform").
 *
 * What gives: the climb and its ramps are ours — the scripts give a grade limit for the trains and
 * nothing for the structure — and a line that shares only part of an edge is shifted for all of it.
 */
import type { ScriptWorld } from '../script/world.ts';
import type { Vec2 } from './plane.ts';
import { row, rows } from './rows.ts';
import type { Row } from './rows.ts';

/** Height a crossing line rises over the one below, and the ramp either side. */
const CLIMB = 7;
const RAMP = 110;
/** How far along its line a stop may move from its hint to find a platform. */
const SEARCH = 140;
/** Samples along a straight run, so its heights can carry a ramp. */
const STRAIGHT_STEP = 10;

export interface RailLine {
  readonly name: string;
  readonly rank: number;
  readonly row: Row;
  /** The track's centre line, sampled; closed, the first point again at the end. */
  readonly path: readonly Vec2[];
  /** Distance along the path at each sample. */
  readonly along: readonly number[];
  /** Track height at each sample. */
  readonly height: number[];
  /** Whether each sample begins a straight piece (false inside a corner's arc). */
  readonly straight: readonly boolean[];
  readonly length: number;
}

export interface RailStop {
  readonly name: string;
  readonly line: string;
  readonly row: Row;
  readonly along: number;
  readonly position: Vec2;
  /** Direction of travel at the platform, as a yaw that points local +x along it. */
  readonly heading: number;
}

function slotOffsets(loops: readonly (readonly Vec2[])[], corridor: number): number[][] {
  const edges = loops.map((pts) =>
    pts.map((p, i) => [p, pts[(i + 1) % pts.length] as Vec2] as const),
  );
  return edges.map((mine, li) =>
    mine.map(([a, b]) => {
      const vertical = Math.abs(a[0] - b[0]) < 1e-3;
      const at = vertical ? a[0] : a[1];
      const [lo, hi] = vertical
        ? [Math.min(a[1], b[1]), Math.max(a[1], b[1])]
        : [Math.min(a[0], b[0]), Math.max(a[0], b[0])];
      const sharing: number[] = [];
      edges.forEach((theirs, lj) => {
        const shares = theirs.some(([c, d]) => {
          const v = Math.abs(c[0] - d[0]) < 1e-3;
          if (v !== vertical || Math.abs((v ? c[0] : c[1]) - at) > 1e-3) return false;
          const [clo, chi] = v
            ? [Math.min(c[1], d[1]), Math.max(c[1], d[1])]
            : [Math.min(c[0], d[0]), Math.max(c[0], d[0])];
          return clo < hi - 1e-3 && lo < chi - 1e-3;
        });
        if (shares) sharing.push(lj);
      });
      /* The slot's offset along a fixed normal (+x or +z), turned into this edge's own left: two
         loops sharing an edge run it in opposite directions, so "left" alone would stack them. */
      const k = sharing.indexOf(li);
      const across = (k - (sharing.length - 1) / 2) * corridor;
      const left: Vec2 = [-(b[1] - a[1]), b[0] - a[0]];
      return across * Math.sign(vertical ? left[0] : left[1]);
    }),
  );
}

/** The loop with each edge shifted `offsets[i]` to its left, meeting at the shifted corners. */
function shifted(pts: readonly Vec2[], offsets: readonly number[]): Vec2[] {
  const n = pts.length;
  const line = (i: number): { p: Vec2; d: Vec2 } => {
    const a = pts[i] as Vec2;
    const b = pts[(i + 1) % n] as Vec2;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const d: Vec2 = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    const o = offsets[i] as number;
    return { p: [a[0] - d[1] * o, a[1] + d[0] * o], d };
  };
  return pts.map((_, i) => {
    const e0 = line((i + n - 1) % n);
    const e1 = line(i);
    const cross = e0.d[0] * e1.d[1] - e0.d[1] * e1.d[0];
    if (Math.abs(cross) < 1e-9) return e1.p;
    const t = ((e1.p[0] - e0.p[0]) * e1.d[1] - (e1.p[1] - e0.p[1]) * e1.d[0]) / cross;
    return [e0.p[0] + e0.d[0] * t, e0.p[1] + e0.d[1] * t];
  });
}

/** The closed loop with every corner filleted to `radius`, arcs sampled every `step` metres. */
function filleted(
  pts: readonly Vec2[],
  radius: number,
  step: number,
): { path: Vec2[]; straight: boolean[] } {
  const n = pts.length;
  const path: Vec2[] = [];
  const straight: boolean[] = [];
  for (let i = 0; i < n; i += 1) {
    const prev = pts[(i + n - 1) % n] as Vec2;
    const at = pts[i] as Vec2;
    const next = pts[(i + 1) % n] as Vec2;
    const u: Vec2 = [prev[0] - at[0], prev[1] - at[1]];
    const v: Vec2 = [next[0] - at[0], next[1] - at[1]];
    const lu = Math.hypot(u[0], u[1]);
    const lv = Math.hypot(v[0], v[1]);
    const cos = Math.max(-1, Math.min(1, (u[0] * v[0] + u[1] * v[1]) / (lu * lv)));
    const half = Math.acos(cos) / 2;
    const cut = Math.min(radius / Math.tan(half), lu / 2, lv / 2);
    const r = cut * Math.tan(half);
    const a: Vec2 = [at[0] + (u[0] / lu) * cut, at[1] + (u[1] / lu) * cut];
    const b: Vec2 = [at[0] + (v[0] / lv) * cut, at[1] + (v[1] / lv) * cut];
    const bis: Vec2 = [u[0] / lu + v[0] / lv, u[1] / lu + v[1] / lv];
    const lb = Math.hypot(bis[0], bis[1]);
    const centre: Vec2 = [
      at[0] + (bis[0] / lb) * (r / Math.sin(half)),
      at[1] + (bis[1] / lb) * (r / Math.sin(half)),
    ];
    const a0 = Math.atan2(a[1] - centre[1], a[0] - centre[0]);
    let a1 = Math.atan2(b[1] - centre[1], b[0] - centre[0]);
    while (a1 - a0 > Math.PI) a1 -= 2 * Math.PI;
    while (a0 - a1 > Math.PI) a1 += 2 * Math.PI;
    /* The straight run from the previous arc's end, sampled so a ramp on it has heights. */
    const from = path[path.length - 1];
    if (from !== undefined) {
      const runs = Math.floor(Math.hypot(a[0] - from[0], a[1] - from[1]) / STRAIGHT_STEP);
      for (let k = 1; k < runs; k += 1) {
        path.push([
          from[0] + ((a[0] - from[0]) * k) / runs,
          from[1] + ((a[1] - from[1]) * k) / runs,
        ]);
        straight.push(true);
      }
    }
    const pieces = Math.max(1, Math.ceil((Math.abs(a1 - a0) * r) / step));
    for (let k = 0; k <= pieces; k += 1) {
      const angle = a0 + ((a1 - a0) * k) / pieces;
      path.push([centre[0] + Math.cos(angle) * r, centre[1] + Math.sin(angle) * r]);
      /* The last point of an arc begins the straight run to the next corner. */
      straight.push(k === pieces);
    }
  }
  const first = path[0] as Vec2;
  const last = path[path.length - 1] as Vec2;
  const closing = Math.floor(Math.hypot(first[0] - last[0], first[1] - last[1]) / STRAIGHT_STEP);
  for (let k = 1; k < closing; k += 1) {
    path.push([
      last[0] + ((first[0] - last[0]) * k) / closing,
      last[1] + ((first[1] - last[1]) * k) / closing,
    ]);
    straight.push(true);
  }
  path.push(first);
  straight.push(false);
  return { path, straight };
}

function crossing(a: Vec2, b: Vec2, c: Vec2, d: Vec2): number | null {
  const r: Vec2 = [b[0] - a[0], b[1] - a[1]];
  const s: Vec2 = [d[0] - c[0], d[1] - c[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den;
  const u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
}

export function buildMonorail(world: ScriptWorld): {
  lines: RailLine[];
  stops: RailStop[];
  dropped: string[];
} {
  const defs = rows(world, 'MonorailLine').sort((a, b) => a.n('index') - b.n('index'));
  const loops = defs.map((d) =>
    d.entity.children
      .filter((c) => c.components.has('RailPoint'))
      .map((c) => row(c, 'RailPoint'))
      .sort((a, b) => a.n('index') - b.n('index'))
      .map((p): Vec2 => [p.n('x'), p.n('z')]),
  );
  const corridor = defs[0]?.n('corridor', 9) ?? 9;
  const offsets = slotOffsets(loops, corridor);
  const lines: RailLine[] = defs.map((d, i) => {
    const { path, straight } = filleted(
      shifted(loops[i] as Vec2[], offsets[i] as number[]),
      d.n('corner_radius'),
      d.n('arc_span_length', 4),
    );
    const along = [0];
    for (let k = 1; k < path.length; k += 1) {
      const p = path[k - 1] as Vec2;
      const q = path[k] as Vec2;
      along.push((along[k - 1] as number) + Math.hypot(q[0] - p[0], q[1] - p[1]));
    }
    return {
      name: d.entity.name,
      rank: d.n('rank'),
      row: d,
      path,
      along,
      height: path.map(() => d.n('track_y')),
      straight,
      length: along[along.length - 1] as number,
    };
  });
  /* Crossings: the higher rank climbs. */
  for (const upper of lines) {
    for (const lower of lines) {
      if (upper.rank <= lower.rank) continue;
      for (let i = 0; i + 1 < upper.path.length; i += 1) {
        for (let j = 0; j + 1 < lower.path.length; j += 1) {
          const t = crossing(
            upper.path[i] as Vec2,
            upper.path[i + 1] as Vec2,
            lower.path[j] as Vec2,
            lower.path[j + 1] as Vec2,
          );
          if (t === null) continue;
          const s =
            (upper.along[i] as number) +
            t * ((upper.along[i + 1] as number) - (upper.along[i] as number));
          upper.along.forEach((a, k) => {
            const gap = Math.min(Math.abs(a - s), upper.length - Math.abs(a - s));
            const rise = gap < RAMP ? CLIMB * (0.5 + 0.5 * Math.cos((Math.PI * gap) / RAMP)) : 0;
            upper.height[k] = Math.max(upper.height[k] as number, upper.row.n('track_y') + rise);
          });
        }
      }
    }
  }
  const stops: RailStop[] = [];
  const dropped: string[] = [];
  for (const s of rows(world, 'MonorailStop')) {
    const line = lines.find((l) => l.name === s.s('line'));
    if (line === undefined) continue;
    const hint: Vec2 = [s.n('x'), s.n('z')];
    const at = placeOnLine(line, hint);
    const half = line.row.n('platform_half');
    const fits = (a: number): boolean => {
      for (let k = 0; k + 1 < line.path.length; k += 1) {
        const a0 = line.along[k] as number;
        const a1 = line.along[k + 1] as number;
        if (a1 < a - half || a0 > a + half) continue;
        if (
          !line.straight[k] ||
          Math.abs((line.height[k] as number) - line.row.n('track_y')) > 1e-6
        )
          return false;
      }
      return a - half >= 0 && a + half <= line.length;
    };
    let chosen: number | null = null;
    for (let step = 0; step <= SEARCH && chosen === null; step += 2) {
      if (fits(at + step)) chosen = at + step;
      else if (fits(at - step)) chosen = at - step;
    }
    if (chosen === null) {
      dropped.push(
        `${s.entity.name}: no clear platform within ${SEARCH} m of (${hint[0]}, ${hint[1]})`,
      );
      continue;
    }
    const [position, heading] = pointAt(line, chosen);
    stops.push({ name: s.entity.name, line: line.name, row: s, along: chosen, position, heading });
  }
  return { lines, stops, dropped };
}

/** The distance along `line` of its point nearest `p`. */
function placeOnLine(line: RailLine, p: Vec2): number {
  let best = Infinity;
  let at = 0;
  for (let k = 0; k + 1 < line.path.length; k += 1) {
    const a = line.path[k] as Vec2;
    const b = line.path[k + 1] as Vec2;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const l2 = dx * dx + dz * dz;
    const t =
      l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2));
    const d = Math.hypot(a[0] + dx * t - p[0], a[1] + dz * t - p[1]);
    if (d < best) {
      best = d;
      at = (line.along[k] as number) + t * Math.sqrt(l2);
    }
  }
  return at;
}

/** The point at distance `s` along `line`, and the yaw that points local +x along it there. */
export function pointAt(line: RailLine, s: number): [Vec2, number] {
  for (let k = 0; k + 1 < line.path.length; k += 1) {
    const a0 = line.along[k] as number;
    const a1 = line.along[k + 1] as number;
    if (s > a1 && k + 2 < line.path.length) continue;
    const a = line.path[k] as Vec2;
    const b = line.path[k + 1] as Vec2;
    const t = a1 === a0 ? 0 : (s - a0) / (a1 - a0);
    return [
      [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
      Math.atan2(-(b[1] - a[1]), b[0] - a[0]),
    ];
  }
  return [line.path[0] as Vec2, 0];
}
