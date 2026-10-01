/**
 * The fleet: every car on the lane graph, simulated every tick — following what is ahead of it by
 * `idm`, stopping at a signal's line, slowing for the turn it will take, and choosing its next lane
 * at random where it has a choice. State is typed arrays, and a tick allocates nothing.
 *
 * **What is ahead** is the next car on its edge, else the rearmost on the edge it takes next and,
 * when that is a turn, on the lane the turn joins. **A car on a turn yields to one nearer the end
 * of another turn into the same lane**: a zipper merge. **A queue behind a red light is held**, and
 * a car stopped 18 s without being held (`trafficBlockTimeout`) is lifted onto an open stretch of
 * lane — gridlock rescued rather than prevented. Where a car's own step would carry it into what is
 * ahead, the step stops short: the model keeps its gap and the clamp only catches its overshoot.
 *
 * What gives: crossing turns do not see each other, so a left turn passes through oncoming straight
 * traffic inside a junction; no car changes lane; and a kind is drawn by its weights summed over the
 * districts, since a street does not say which district it runs through.
 */
import { mulberry32 } from '../../packages/core/src/index';
import { EdgeBuckets } from './buckets';
import { FleetGraph } from './fleetGraph';
import { FAR, MIN_GAP, idm, turnBraking } from './idm';
import type { LaneGraph } from './laneEdges';
import { GREEN, RED, lightAt } from './signals';

export interface VehicleKind {
  readonly length: number;
  readonly maxSpeed: number;
  readonly accel: number;
  readonly brake: number;
  /** Its share of the civilian fleet; 0 for a kind only placed by name, as a taxi is. */
  readonly weight: number;
}

/** `trafficStopLine`, `trafficSpawnGap` and `trafficBlockTimeout`. */
export const STOP_LINE = 2;
export const SPAWN_GAP = 12;
export const BLOCK_SEC = 18;
/** No car is closer to what is ahead than this after a step, whatever the model asked for. */
const CLAMP = 0.1;
/** Who holds a car: nothing, a red light, or another car. */
const BY_RED = -2;

export class Traffic {
  readonly count: number;
  readonly edge: Int32Array;
  readonly s: Float32Array;
  readonly v: Float32Array;
  /** Where each car was a tick ago, for drawing between the two on `alpha`. */
  readonly prevEdge: Int32Array;
  readonly prevS: Float32Array;
  /** The edge each car takes next, chosen as it enters its current one. */
  readonly next: Int32Array;
  readonly kind: Uint8Array;
  readonly paint: Uint8Array;
  readonly braking: Uint8Array;
  private readonly accel: Float32Array;
  private readonly gap: Float32Array;
  private readonly lead: Float32Array;
  private readonly held: Uint8Array;
  private readonly stuck: Float32Array;
  private readonly buckets: EdgeBuckets;
  private readonly fleet: FleetGraph;
  private readonly random: () => number;

  constructor(
    private readonly graph: LaneGraph,
    private readonly kinds: readonly VehicleKind[],
    civil: number,
    taxis: number,
    taxiKind: number,
    paints: number,
    seed: number,
  ) {
    const n = civil + taxis;
    this.count = n;
    this.edge = new Int32Array(n);
    this.s = new Float32Array(n);
    this.v = new Float32Array(n);
    this.prevEdge = new Int32Array(n);
    this.prevS = new Float32Array(n);
    this.next = new Int32Array(n);
    this.kind = new Uint8Array(n);
    this.paint = new Uint8Array(n);
    this.braking = new Uint8Array(n);
    this.accel = new Float32Array(n);
    this.gap = new Float32Array(n);
    this.lead = new Float32Array(n);
    this.held = new Uint8Array(n);
    this.stuck = new Float32Array(n);
    this.buckets = new EdgeBuckets(graph.count, n);
    this.random = mulberry32(seed);
    this.fleet = new FleetGraph(graph);
    let total = 0;
    for (const k of kinds) total += k.weight;
    for (let i = 0; i < n; i++) {
      let kind = taxiKind;
      if (i < civil) {
        let pick = this.random() * total;
        kind = 0;
        while (kind < kinds.length - 1 && pick >= (kinds[kind] as VehicleKind).weight) {
          pick -= (kinds[kind] as VehicleKind).weight;
          kind++;
        }
      }
      this.kind[i] = kind;
      this.paint[i] = Math.floor(this.random() * paints);
      this.drop(i, i, true);
    }
  }

  /** Put car `i` on lane edge `edge` at `s`, moving at `v`, and choose where it goes next. */
  place(i: number, edge: number, s: number, v: number): void {
    this.edge[i] = edge;
    this.s[i] = s;
    this.v[i] = v;
    this.prevEdge[i] = edge;
    this.prevS[i] = s;
    this.stuck[i] = 0;
    this.next[i] = this.choose(edge);
  }

  /** One fixed step of `dt` at `t` seconds on the signals' clock. */
  step(dt: number, t: number): void {
    const { graph, buckets, edge, s, v, kinds } = this;
    buckets.build(edge, s, this.count);
    for (let i = 0; i < this.count; i++) {
      const e = edge[i] as number;
      const k = kinds[this.kind[i] as number] as VehicleKind;
      const comfort = k.brake / 2;
      const length = graph.length[e] as number;
      const left = length - (s[i] as number);
      const vi = v[i] as number;
      const ne = this.next[i] as number;
      const v0 = Math.min(k.maxSpeed, graph.speed[e] as number);
      let gap = FAR;
      let lead = 0;
      let by = -1;
      const ahead = buckets.ahead(i, e);
      if (ahead >= 0) {
        gap = (s[ahead] as number) - this.lengthOf(ahead) - (s[i] as number);
        lead = v[ahead] as number;
        by = ahead;
      } else {
        let dist = left;
        let ee = ne;
        for (let hop = 0; hop < 2; hop++) {
          const j = buckets.rearmost(ee);
          if (j >= 0) {
            gap = dist + (s[j] as number) - this.lengthOf(j);
            lead = v[j] as number;
            by = j;
            break;
          }
          if (graph.turn[ee] === 0) break;
          dist += graph.length[ee] as number;
          ee = graph.next[graph.first[ee] as number] as number;
        }
      }
      if (graph.turn[e] === 1) {
        const { feedFirst, feed } = this.fleet;
        for (let f = feedFirst[ne] as number; f < (feedFirst[ne + 1] as number); f++) {
          const other = feed[f] as number;
          if (other === e) continue;
          const j = buckets.foremost(other);
          if (j < 0) continue;
          const theirs = (graph.length[other] as number) - (s[j] as number);
          if (theirs > left || (theirs === left && j > i)) continue;
          const g = left - theirs - this.lengthOf(j);
          if (g < gap) {
            gap = g;
            lead = v[j] as number;
            by = j;
          }
        }
      }
      const signal = graph.signal[e] as number;
      if (signal >= 0) {
        const stop = left - STOP_LINE;
        /* Over the line and still moving is committed; standing at it, however close, waits. */
        const committed = stop < 0 && vi > 1;
        const light = committed
          ? GREEN
          : lightAt(graph.signals, signal, graph.phase[e] as number, t);
        if (light === RED || (light !== GREEN && vi * vi <= 2 * comfort * stop)) {
          if (stop + MIN_GAP < gap) {
            gap = stop + MIN_GAP;
            lead = 0;
            by = BY_RED;
          }
        }
      }
      const free = idm(vi, v0, gap, lead, k.accel, comfort);
      const turning = turnBraking(vi, graph.speed[ne] as number, left, comfort / 2);
      this.accel[i] = turning < 0 ? Math.min(free, turning) : free;
      this.gap[i] = gap;
      this.lead[i] = lead;
      this.held[i] = by === BY_RED ? 1 : by >= 0 ? (this.held[by] as number) : 0;
    }
    for (let i = 0; i < this.count; i++) this.advance(i, dt);
  }

  private advance(i: number, dt: number): void {
    const { graph, s, v, edge } = this;
    this.prevEdge[i] = edge[i] as number;
    this.prevS[i] = s[i] as number;
    const a = this.accel[i] as number;
    const v1 = Math.max(0, (v[i] as number) + a * dt);
    let ds = 0.5 * ((v[i] as number) + v1) * dt;
    const room = Math.max(0, (this.gap[i] as number) - CLAMP);
    let vNext = v1;
    if (ds > room) {
      ds = room;
      vNext = Math.min(v1, this.lead[i] as number);
    }
    v[i] = vNext;
    s[i] = (s[i] as number) + ds;
    this.braking[i] = a < -1 ? 1 : 0;
    const stopped = vNext < 0.1 && this.held[i] === 0;
    this.stuck[i] = stopped ? (this.stuck[i] as number) + dt : 0;
    while ((s[i] as number) >= (graph.length[edge[i] as number] as number)) {
      s[i] = (s[i] as number) - (graph.length[edge[i] as number] as number);
      const e = this.next[i] as number;
      edge[i] = e;
      this.next[i] = this.choose(e);
    }
    if ((this.stuck[i] as number) > BLOCK_SEC) this.drop(i, this.count, false);
  }

  /**
   * Car `i` onto an open stretch of lane, clear of the first `placed` cars; if none is found, left
   * where it is to try again, unless it must be placed somewhere now.
   */
  private drop(i: number, placed: number, force: boolean): void {
    const { graph } = this;
    const len = this.lengthOf(i);
    for (let tries = 0; tries < 40; tries++) {
      const e = this.fleet.laneAt(this.random());
      const at = len + this.random() * Math.max(0, (graph.length[e] as number) - len);
      let clear = true;
      for (let j = 0; j < placed && clear; j++) {
        if (j !== i && this.edge[j] === e)
          clear = Math.abs((this.s[j] as number) - at) >= SPAWN_GAP + len;
      }
      if (clear || (force && tries === 39)) {
        this.place(i, e, at, 0);
        return;
      }
    }
  }

  private choose(e: number): number {
    const lo = this.graph.first[e] as number;
    const n = (this.graph.first[e + 1] as number) - lo;
    return this.graph.next[lo + (n > 1 ? Math.floor(this.random() * n) : 0)] as number;
  }

  private lengthOf(i: number): number {
    return (this.kinds[this.kind[i] as number] as VehicleKind).length;
  }
}
