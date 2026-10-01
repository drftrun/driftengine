/**
 * The roads' lanes as one graph the traffic drives: every lane of every open street each way, the
 * turns joining them across the junctions, and the elevated road's lanes — each edge a quadratic
 * curve, in typed arrays built once at load.
 *
 * **Right-hand traffic.** A street's lanes run right of its centre line, the innermost beside the
 * median. A lane ends where the widest street at its junction begins, and a turn carries a car
 * across: straight on from any lane, right from the kerbside lane, left from the innermost, never
 * back the way it came; a lane with none of those — the middle lane of a stem meeting a cross
 * street — may turn either way. Where only two streets meet every lane keeps its place, and a lane
 * no junction serves turns round onto its own street.
 *
 * **Signals stand where three streets or more meet**, as the bake stands their heads; a lane's end
 * there waits on its axis's phase (`signals.ts`).
 *
 * What gives: the elevated road is a graph of its own, turning round at both ends, because its
 * ramps are not built; and the diagonal carries no lanes, since it crosses the grid at grade with
 * no junction to meet it at. Cars keep their lane: none changes lane along a street.
 */
import { Edges, TURN_SPEED, mid, pack } from './laneEdges';
import type { LaneGraph, P } from './laneEdges';
import { routeLanes } from './routeLanes';
import type { RouteData } from './routeLanes';
import { createSignals } from './signals';

export interface StreetData {
  readonly vertical: boolean;
  readonly at: number;
  readonly from: number;
  readonly to: number;
  readonly lanes: number;
  readonly laneWidth: number;
  readonly median: number;
  readonly sidewalk: number;
  readonly speed: number;
  readonly closed: boolean;
  readonly green: number;
  readonly y: number;
}

export interface JunctionData {
  readonly x: number;
  readonly z: number;
  readonly streets: readonly number[];
}

interface Lane {
  readonly edge: number;
  readonly street: number;
  readonly dir: number;
  readonly k: number;
  /** Unit direction of travel. */
  readonly ux: number;
  readonly uz: number;
  readonly startJ: number;
  readonly endJ: number;
}

export function buildLanes(
  streets: readonly StreetData[],
  junctions: readonly JunctionData[],
  routes: readonly RouteData[],
): LaneGraph {
  const edges = new Edges();
  const width = (s: StreetData): number => 2 * s.lanes * s.laneWidth + s.median + 2 * s.sidewalk;
  const open = junctions.map((j) => j.streets.filter((i) => streets[i]?.closed === false));
  const widest = open.map((ids) => Math.max(0, ...ids.map((i) => width(streets[i] as StreetData))));
  /* Which junction stands at each end of each street. */
  const fromJ = streets.map(() => -1);
  const toJ = streets.map(() => -1);
  junctions.forEach((j, ji) => {
    for (const i of j.streets) {
      const s = streets[i] as StreetData;
      const along = s.vertical ? j.z : j.x;
      if (Math.abs(along - s.from) < 0.5) fromJ[i] = ji;
      else if (Math.abs(along - s.to) < 0.5) toJ[i] = ji;
    }
  });
  const back = (j: number): number =>
    j >= 0 && (open[j]?.length ?? 0) >= 2 ? (widest[j] as number) / 2 : 0;

  const lanes: Lane[] = [];
  streets.forEach((s, i) => {
    if (s.closed) return;
    for (const dir of [1, -1]) {
      const ux = s.vertical ? 0 : dir;
      const uz = s.vertical ? dir : 0;
      const startJ = dir > 0 ? (fromJ[i] as number) : (toJ[i] as number);
      const endJ = dir > 0 ? (toJ[i] as number) : (fromJ[i] as number);
      const a0 = dir > 0 ? s.from + back(startJ) : s.to - back(startJ);
      const a1 = dir > 0 ? s.to - back(endJ) : s.from + back(endJ);
      for (let k = 0; k < s.lanes; k++) {
        const off = s.median / 2 + (k + 0.5) * s.laneWidth;
        /* Right of travel: (−uz, ux). */
        const at = (a: number): P =>
          s.vertical ? [s.at - uz * off, s.y, a] : [a, s.y, s.at + ux * off];
        const a = at(a0);
        const b = at(a1);
        const edge = edges.add(a, mid(a, b), b, s.speed, false, i, dir, k);
        lanes.push({ edge, street: i, dir, k, ux, uz, startJ, endJ });
      }
    }
  });

  /* The turns, and the signals where three streets or more meet. */
  const leaving = junctions.map((): Lane[] => []);
  for (const l of lanes) if (l.startJ >= 0) leaving[l.startJ]?.push(l);
  const green: number[] = [];
  let signals = 0;
  const signalOf = junctions.map((_, j) => ((open[j]?.length ?? 0) >= 3 ? signals++ : -1));
  junctions.forEach((_, j) => {
    if ((signalOf[j] as number) < 0) return;
    for (const phase of [0, 1]) {
      const along = (open[j] ?? []).filter(
        (i) => (streets[i] as StreetData).vertical === (phase === 0),
      );
      green.push(Math.max(0, ...along.map((i) => (streets[i] as StreetData).green)) || 14);
    }
  });
  for (const a of lanes) {
    const na = (streets[a.street] as StreetData).lanes;
    /* Where only two streets meet — a bend, or one street going on as another — every lane
       keeps its place, as straight on. */
    const through = a.endJ >= 0 && open[a.endJ]?.length === 2;
    const exits: [Lane, number][] = [];
    const fallback: [Lane, number][] = [];
    for (const b of a.endJ >= 0 ? (leaving[a.endJ] as Lane[]) : []) {
      const nb = (streets[b.street] as StreetData).lanes;
      const dot = a.ux * b.ux + a.uz * b.uz;
      const side = b.ux * -a.uz + b.uz * a.ux;
      if (dot < -0.5) continue;
      const straight = dot > 0.5;
      const kept = straight || through;
      const want = kept ? Math.min(a.k, nb - 1) : side > 0 ? nb - 1 : 0;
      if (b.k !== want) continue;
      if (kept || (side > 0 && a.k === na - 1) || (side < 0 && a.k === 0)) exits.push([b, dot]);
      else fallback.push([b, dot]);
    }
    const chosen = exits.length > 0 ? exits : fallback;
    const p0 = edges.end(a.edge);
    for (const [b, dot] of chosen) {
      const p2 = edges.start(b.edge);
      /* A turn bends at where the two lanes' lines cross; straight on, it is a line. */
      const c: P =
        dot > 0.5
          ? mid(p0, p2)
          : a.ux !== 0
            ? [p2[0], (p0[1] + p2[1]) / 2, p0[2]]
            : [p0[0], (p0[1] + p2[1]) / 2, p2[2]];
      const speed = dot > 0.5 ? (streets[b.street] as StreetData).speed : TURN_SPEED;
      const t = edges.add(p0, c, p2, speed, true);
      edges.nexts[a.edge]?.push(t);
      edges.nexts[t]?.push(b.edge);
    }
    if (chosen.length === 0) {
      /* Round onto the same street, the same lane back. */
      const b = lanes.find((l) => l.street === a.street && l.dir === -a.dir && l.k === a.k) as Lane;
      const p2 = edges.start(b.edge);
      const reach = Math.hypot(p2[0] - p0[0], p2[2] - p0[2]);
      const m = mid(p0, p2);
      const t = edges.add(
        p0,
        [m[0] + a.ux * reach, m[1], m[2] + a.uz * reach],
        p2,
        TURN_SPEED,
        true,
      );
      edges.nexts[a.edge]?.push(t);
      edges.nexts[t]?.push(b.edge);
    }
    const signal = a.endJ >= 0 ? (signalOf[a.endJ] as number) : -1;
    edges.signal[a.edge] = signal;
    edges.phase[a.edge] = a.uz !== 0 ? 0 : 1;
  }
  for (const r of routes) routeLanes(edges, r);
  return pack(edges, createSignals(green), Int32Array.from(signalOf));
}
