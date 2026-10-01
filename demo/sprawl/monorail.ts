/**
 * The monorail's trains on their one-way loops, each line's numbers its own: every train starts
 * evenly spaced round its line, accelerates at the line's figure up to what the track allows
 * (`track.ts`), brakes to stop its middle car at the next platform's centre, stands there the dwell
 * and its doors' time each way, and keeps the line's minimum gap behind the train ahead — no
 * faster at any moment than it could still brake from for the platform, the train ahead or a curve
 * under any of its cars.
 *
 * Typed arrays over every train of every line; a tick allocates nothing.
 *
 * What gives: lines are separate tracks here, so the reference's arbitration where two lines share
 * one never arises; a grade is not slowed for.
 */
import type { LineData } from './scene';
import { Track } from './track';

export const RUN = 0;
export const DWELL = 1;
/** How much harder than its line's figure a train may brake when it must: an emergency's margin. */
const HARD = 2;

interface Line {
  readonly track: Track;
  readonly data: LineData;
  /** Its platforms' distances along the track, in order. */
  readonly stops: Float32Array;
  /** Its trains are `first` up to `first + count`, in order round the loop. */
  readonly first: number;
  readonly count: number;
  readonly trainLength: number;
}

export class Monorail {
  readonly lines: readonly Line[];
  readonly count: number;
  readonly line: Uint8Array;
  /** Where each train's front is along its track, and a tick ago. */
  readonly s: Float32Array;
  readonly prevS: Float32Array;
  readonly v: Float32Array;
  readonly phase: Uint8Array;
  /** The platform each is bound for, by its index among its line's. */
  readonly next: Uint16Array;
  private readonly wait: Float32Array;

  constructor(
    lines: readonly LineData[],
    stops: readonly { readonly line: string; readonly along: number }[],
  ) {
    let first = 0;
    this.lines = lines.map((data) => {
      const track = new Track(data.path, data.curveAccel, data.brake, data.cruise);
      const along = stops
        .filter((s) => s.line === data.name)
        .map((s) => s.along)
        .sort((a, b) => a - b);
      const line = {
        track,
        data,
        stops: Float32Array.from(along),
        first,
        count: data.trains,
        trainLength: data.cars.length * data.carLength,
      };
      first += data.trains;
      return line;
    });
    this.count = first;
    this.line = new Uint8Array(first);
    this.s = new Float32Array(first);
    this.prevS = new Float32Array(first);
    this.v = new Float32Array(first);
    this.phase = new Uint8Array(first);
    this.next = new Uint16Array(first);
    this.wait = new Float32Array(first);
    this.lines.forEach((l, li) => {
      for (let k = 0; k < l.count; k++) {
        const i = l.first + k;
        const s = (k * l.track.length) / l.count;
        this.line[i] = li;
        this.s[i] = this.prevS[i] = s;
        /* Bound for the first platform whose stopping point is still ahead. */
        let n = 0;
        while (n < l.stops.length && (l.stops[n] as number) + l.trainLength / 2 <= s) n++;
        this.next[i] = n % Math.max(1, l.stops.length);
      }
    });
  }

  /** One fixed step of `dt`. */
  step(dt: number): void {
    for (let li = 0; li < this.lines.length; li++) {
      const l = this.lines[li] as Line;
      for (let k = 0; k < l.count; k++)
        this.move(l, l.first + k, l.first + ((k + 1) % l.count), dt);
    }
  }

  private move(l: Line, i: number, ahead: number, dt: number): void {
    const { s, v } = this;
    this.prevS[i] = s[i] as number;
    if (this.phase[i] === DWELL) {
      this.wait[i] = (this.wait[i] as number) - dt;
      if ((this.wait[i] as number) > 0) return;
      this.phase[i] = RUN;
      this.next[i] = ((this.next[i] as number) + 1) % Math.max(1, l.stops.length);
    }
    const d = l.data;
    const length = l.track.length;
    const si = s[i] as number;
    const stop =
      l.stops.length > 0
        ? wrap((l.stops[this.next[i] as number] as number) + l.trainLength / 2 - si, length)
        : Infinity;
    const gap = ahead === i ? Infinity : wrap((s[ahead] as number) - l.trainLength - si, length);
    const want = Math.min(
      d.cruise,
      l.track.limitAt(si),
      l.track.limitAt(si - l.trainLength / 2),
      l.track.limitAt(si - l.trainLength),
      stoppable(stop, d.brake, dt),
      stoppable(Math.max(0, gap - d.minGap), d.brake, dt),
    );
    const vi = v[i] as number;
    const next =
      want > vi ? Math.min(want, vi + d.accel * dt) : Math.max(want, vi - HARD * d.brake * dt);
    const step = next * dt;
    /* The step that would reach the platform ends there: from the last of the braking curve,
       under a millimetre's slack. */
    if (step >= stop - 1e-3) {
      s[i] = wrap(si + stop, length);
      v[i] = 0;
      this.phase[i] = DWELL;
      this.wait[i] = d.dwell + 2 * d.doorTime;
      return;
    }
    s[i] = wrap(si + step, length);
    v[i] = next;
  }
}

/** `x` round a loop `length` long, into [0, length). */
function wrap(x: number, length: number): number {
  return ((x % length) + length) % length;
}

/**
 * The fastest a train may go this tick and still stop within `d` at braking `b`, counting the
 * tick's own travel: `v · dt + v² / 2b = d`. Without that tick the approach steepens as it ends.
 */
function stoppable(d: number, b: number, dt: number): number {
  const bdt = b * dt;
  return -bdt + Math.sqrt(bdt * bdt + 2 * b * d);
}
