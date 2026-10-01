/**
 * The pavements as a graph people walk: a node at each corner of every junction, where two
 * pavements meet, joined along both sides of every open street and across every arm of every
 * junction — a crossing where a street leaves by that arm, a plain walk round the corner where none
 * does. A street end no junction serves joins its two sides across the road.
 *
 * **A crossing at a signalled junction waits for the phase that stops the traffic it crosses**:
 * across a street running along z, the phase of the streets along x. A person at its kerb waits for
 * that green, as the reference's walk phase has them (`PedSignalStyle`).
 *
 * **Routes are shortest walks** (`router.ts`), so a trip allocates nothing. What gives: a pavement's centre line jogs where a narrower street meets a junction sized
 * by a wider one, and nobody walks the diagonal or the elevated road.
 */
import type { JunctionData, StreetData } from './lanes';
import { Router } from './router';

/** Metres a cell of the nearest-node grid spans. */
const CELL = 50;

export class PavementGraph {
  readonly count: number;
  readonly x: Float32Array;
  readonly z: Float32Array;
  /** Node `n`'s neighbours are `next[first[n]]` up to `next[first[n + 1]]`, `length` apart. */
  readonly first: Uint32Array;
  readonly next: Uint32Array;
  readonly length: Float32Array;
  /** Per step: the signal a crossing waits on, or −1, and the phase that lets it go. */
  readonly signal: Int32Array;
  readonly phase: Uint8Array;
  private readonly cells: Map<number, number[]>;
  private readonly router: Router;

  constructor(
    streets: readonly StreetData[],
    junctions: readonly JunctionData[],
    junctionSignal: ArrayLike<number>,
  ) {
    const xs: number[] = [];
    const zs: number[] = [];
    const steps: [number, number, number, number][] = [];
    const node = (x: number, z: number): number => {
      xs.push(x);
      zs.push(z);
      return xs.length - 1;
    };
    const join = (a: number, b: number, signal = -1, phase = 0): void => {
      steps.push([a, b, signal, phase], [b, a, signal, phase]);
    };
    const off = (s: StreetData): number => s.lanes * s.laneWidth + s.median / 2 + s.sidewalk / 2;
    const open = (i: number): boolean => streets[i]?.closed === false;
    /* Each junction's corners, NE NW SW SE, and which of its arms a street leaves by. */
    const corners = junctions.map((j, ji) => {
      let ox = 0;
      let oz = 0;
      const arms = [false, false, false, false];
      for (const i of j.streets) {
        if (!open(i)) continue;
        const s = streets[i] as StreetData;
        if (s.vertical) ox = Math.max(ox, off(s));
        else oz = Math.max(oz, off(s));
        const along = s.vertical ? j.z : j.x;
        const leaves = Math.abs(along - s.from) < 0.5;
        /* North, east, south, west. */
        arms[s.vertical ? (leaves ? 0 : 2) : leaves ? 1 : 3] = true;
      }
      const c = [
        node(j.x + ox, j.z + oz),
        node(j.x - ox, j.z + oz),
        node(j.x - ox, j.z - oz),
        node(j.x + ox, j.z - oz),
      ];
      const signal = junctionSignal[ji] ?? -1;
      /* Across the north and south arms is across a street along z: it goes on the x phase. */
      const across = (a: number, b: number, arm: number): void =>
        arms[arm]
          ? join(c[a] as number, c[b] as number, signal, arm % 2 === 0 ? 1 : 0)
          : join(c[a] as number, c[b] as number);
      across(1, 0, 0);
      across(0, 3, 1);
      across(2, 3, 2);
      across(1, 2, 3);
      return c;
    });
    /* Which junction stands at each end of each street. */
    const ends = streets.map(() => [-1, -1]);
    junctions.forEach((j, ji) => {
      for (const i of j.streets) {
        const s = streets[i] as StreetData;
        const along = s.vertical ? j.z : j.x;
        const e = ends[i] as number[];
        if (Math.abs(along - s.from) < 0.5) e[0] = ji;
        else if (Math.abs(along - s.to) < 0.5) e[1] = ji;
      }
    });
    streets.forEach((s, i) => {
      if (s.closed) return;
      const [a, b] = ends[i] as number[];
      const o = off(s);
      /* Each side's node at the street's `from` end and at its `to` end: the junction's corner, or
         an end of its own joined across the road. */
      const endNodes = (j: number, at: number, from: boolean): [number, number] => {
        if (j >= 0) {
          const c = corners[j] as number[];
          /* Leaving a junction northward, the east side is its NE corner; arriving, its SE. */
          if (s.vertical)
            return from ? [c[0] as number, c[1] as number] : [c[3] as number, c[2] as number];
          return from ? [c[0] as number, c[3] as number] : [c[1] as number, c[2] as number];
        }
        const one = s.vertical ? node(s.at + o, at) : node(at, s.at + o);
        const two = s.vertical ? node(s.at - o, at) : node(at, s.at - o);
        join(one, two);
        return [one, two];
      };
      const start = endNodes(a as number, s.from, true);
      const finish = endNodes(b as number, s.to, false);
      join(start[0], finish[0]);
      join(start[1], finish[1]);
    });
    const n = xs.length;
    this.count = n;
    this.x = Float32Array.from(xs);
    this.z = Float32Array.from(zs);
    steps.sort((p, q) => p[0] - q[0]);
    this.first = new Uint32Array(n + 1);
    for (const [a] of steps) this.first[a + 1] = (this.first[a + 1] as number) + 1;
    for (let i = 0; i < n; i++)
      this.first[i + 1] = (this.first[i + 1] as number) + (this.first[i] as number);
    this.next = Uint32Array.from(steps.map((p) => p[1]));
    this.length = Float32Array.from(
      steps.map(([a, b]) =>
        Math.hypot((xs[b] as number) - (xs[a] as number), (zs[b] as number) - (zs[a] as number)),
      ),
    );
    this.signal = Int32Array.from(steps.map((p) => p[2]));
    this.phase = Uint8Array.from(steps.map((p) => p[3]));
    this.cells = new Map();
    for (let i = 0; i < n; i++) {
      const k = cellOf(xs[i] as number, zs[i] as number);
      const list = this.cells.get(k) ?? [];
      list.push(i);
      this.cells.set(k, list);
    }
    this.router = new Router(this.first, this.next, this.length);
  }

  /** The node nearest (x, z), looking out ring by ring until one is found. */
  nearest(x: number, z: number): number {
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    let best = -1;
    let bestD = Infinity;
    for (let ring = 0; ring < 64 && best < 0; ring++) {
      for (let gx = cx - ring; gx <= cx + ring; gx++) {
        for (let gz = cz - ring; gz <= cz + ring; gz++) {
          if (Math.max(Math.abs(gx - cx), Math.abs(gz - cz)) !== ring) continue;
          for (const i of this.cells.get(key(gx, gz)) ?? NONE) {
            const d = Math.hypot((this.x[i] as number) - x, (this.z[i] as number) - z);
            if (d < bestD) {
              bestD = d;
              best = i;
            }
          }
        }
      }
    }
    return best;
  }

  /** The shortest walk from `from` to `to` into `out` at `at`, at most `max` nodes (`Router`). */
  route(from: number, to: number, out: Uint16Array, at: number, max: number): number {
    return this.router.route(from, to, out, at, max);
  }

  /** The step from node `a` to its neighbour `b`, or −1. */
  stepOf(a: number, b: number): number {
    for (let e = this.first[a] as number; e < (this.first[a + 1] as number); e++) {
      if (this.next[e] === b) return e;
    }
    return -1;
  }
}

const NONE: readonly number[] = [];
const key = (gx: number, gz: number): number => (gx + 1024) * 4096 + (gz + 1024);
const cellOf = (x: number, z: number): number => key(Math.floor(x / CELL), Math.floor(z / CELL));
