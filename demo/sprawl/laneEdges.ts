/**
 * The lane graph's storage: its edges as quadratic curves while it is built, and the typed arrays
 * they are packed into once, which is all the traffic reads.
 */
import type { Signals } from './signals';

export interface LaneGraph {
  readonly count: number;
  /** Nine floats an edge: its start, its control point and its end. */
  readonly curve: Float32Array;
  readonly length: Float32Array;
  readonly speed: Float32Array;
  /** 1 for a turn across a junction, 0 for a lane. */
  readonly turn: Uint8Array;
  /** The street a lane runs along, its direction (±1) and its lane from the centre; −1 for the rest. */
  readonly street: Int32Array;
  readonly dir: Int8Array;
  readonly lane: Uint8Array;
  /** What a car may take next: `next[first[e]]` up to `next[first[e + 1]]`. */
  readonly first: Uint32Array;
  readonly next: Uint32Array;
  /** The signal holding a lane's end, or −1, and the phase that lets it go: 0 along z, 1 along x. */
  readonly signal: Int32Array;
  readonly phase: Uint8Array;
  readonly signals: Signals;
  /** Each junction's signal, by its index among the scene's, or −1 where none stands. */
  readonly junctionSignal: Int32Array;
}

/** A turn's pace, `trafficTurnSpeed`. */
export const TURN_SPEED = 6.5;

export type P = [number, number, number];

export class Edges {
  readonly curve: number[] = [];
  readonly length: number[] = [];
  readonly speed: number[] = [];
  readonly turn: number[] = [];
  readonly street: number[] = [];
  readonly dir: number[] = [];
  readonly lane: number[] = [];
  readonly signal: number[] = [];
  readonly phase: number[] = [];
  readonly nexts: number[][] = [];

  add(a: P, c: P, b: P, speed: number, turn: boolean, street = -1, dir = 0, lane = 0): number {
    this.curve.push(...a, ...c, ...b);
    this.length.push(curveLength(a, c, b));
    this.speed.push(speed);
    this.turn.push(turn ? 1 : 0);
    this.street.push(street);
    this.dir.push(dir);
    this.lane.push(lane);
    this.signal.push(-1);
    this.phase.push(0);
    this.nexts.push([]);
    return this.length.length - 1;
  }

  start(e: number): P {
    return [this.curve[e * 9], this.curve[e * 9 + 1], this.curve[e * 9 + 2]] as P;
  }

  end(e: number): P {
    return [this.curve[e * 9 + 6], this.curve[e * 9 + 7], this.curve[e * 9 + 8]] as P;
  }
}

export const mid = (a: P, b: P): P => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];

/** A quadratic curve's length, as eight chords. */
function curveLength(a: P, c: P, b: P): number {
  let sum = 0;
  let px = a[0];
  let py = a[1];
  let pz = a[2];
  for (let i = 1; i <= 8; i++) {
    const t = i / 8;
    const u = 1 - t;
    const x = u * u * a[0] + 2 * u * t * c[0] + t * t * b[0];
    const y = u * u * a[1] + 2 * u * t * c[1] + t * t * b[1];
    const z = u * u * a[2] + 2 * u * t * c[2] + t * t * b[2];
    sum += Math.hypot(x - px, y - py, z - pz);
    px = x;
    py = y;
    pz = z;
  }
  return sum;
}

export function pack(edges: Edges, signals: Signals, junctionSignal: Int32Array): LaneGraph {
  const count = edges.length.length;
  const first = new Uint32Array(count + 1);
  for (let e = 0; e < count; e++)
    first[e + 1] = (first[e] as number) + (edges.nexts[e]?.length ?? 0);
  const next = new Uint32Array(first[count] as number);
  for (let e = 0; e < count; e++) next.set(edges.nexts[e] as number[], first[e] as number);
  return {
    count,
    curve: Float32Array.from(edges.curve),
    length: Float32Array.from(edges.length),
    speed: Float32Array.from(edges.speed),
    turn: Uint8Array.from(edges.turn),
    street: Int32Array.from(edges.street),
    dir: Int8Array.from(edges.dir),
    lane: Uint8Array.from(edges.lane),
    first,
    next,
    signal: Int32Array.from(edges.signal),
    phase: Uint8Array.from(edges.phase),
    signals,
    junctionSignal,
  };
}

/**
 * Where `s` metres along edge `e` is, into `out`: x, y, z, then the unit heading's x and z. The
 * curve's parameter stands in for its length, which on these gentle curves moves a car's pace
 * through a turn by a few per cent and nothing else.
 */
export function pointAt(graph: LaneGraph, e: number, s: number, out: Float32Array): void {
  const c = graph.curve;
  const o = e * 9;
  const t = Math.min(1, Math.max(0, s / (graph.length[e] as number)));
  const u = 1 - t;
  for (let a = 0; a < 3; a++) {
    const p0 = c[o + a] as number;
    const p1 = c[o + 3 + a] as number;
    const p2 = c[o + 6 + a] as number;
    out[a] = u * u * p0 + 2 * u * t * p1 + t * t * p2;
  }
  const dx =
    2 * u * ((c[o + 3] as number) - (c[o] as number)) +
    2 * t * ((c[o + 6] as number) - (c[o + 3] as number));
  const dz =
    2 * u * ((c[o + 5] as number) - (c[o + 2] as number)) +
    2 * t * ((c[o + 8] as number) - (c[o + 5] as number));
  const len = Math.hypot(dx, dz) || 1;
  out[3] = dx / len;
  out[4] = dz / len;
}
