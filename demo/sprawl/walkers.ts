/**
 * People on the pavements, moving: each walks a straight leg at a time — from where it stands to
 * the nearest corner, corner to corner along its route, and at the end straight to its door — or
 * wanders, a random way at every corner but never straight back. **At a crossing's kerb it waits
 * for the green** its step waits on (`pavements.ts`). Places, headings and strides in typed arrays;
 * a tick allocates nothing.
 *
 * **Out of sight a walk keeps the day's pace**, 72 times a walk and waiting at no kerb: the city's
 * hour is 50 s, so a commute at walking pace would take most of a working day, and nobody past the
 * distance people are drawn to can see the difference. In sight, everyone walks.
 *
 * Callers decide where people go and what they do on arrival (`residents.ts`, `crowd.ts`); this
 * only moves them, and says who reached a door this tick.
 */
import type { PavementGraph } from './pavements';
import { GREEN, lightAt } from './signals';
import type { Signals } from './signals';

export const IDLE = 0;
export const PATH = 1;
export const DOOR = 2;
export const WANDER = 3;
/** The most corners a route keeps; a longer one is walked to its last and routed again. */
export const MAX_PATH = 96;
/** Metres of one full swing of the legs: two paces. */
const STRIDE_M = 1.4;
/**
 * How far from the eye a walk is out of sight — past the 140 m people are drawn to, with room to
 * slow before coming into it — and how much faster it goes there: the day's own compression, an
 * hour in 50 s (`clock.ts`), 3,600 / 50.
 */
export const UNSEEN_M = 160;
export const DAY_PACE = 72;

export class Walkers {
  readonly x: Float32Array;
  readonly z: Float32Array;
  /** Where each was a tick ago, for drawing between the two on `alpha`. */
  readonly px: Float32Array;
  readonly pz: Float32Array;
  readonly yaw: Float32Array;
  /** How far into its swing each one's legs are, radians. */
  readonly stride: Float32Array;
  readonly speed: Float32Array;
  readonly mode: Uint8Array;
  /** Set when a walk reaches its door; the caller reads it and clears it. */
  readonly arrived: Uint8Array;
  /** The corner each last reached or is walking to, and the one before it. */
  readonly node: Int32Array;
  private readonly came: Int32Array;
  private readonly ax: Float32Array;
  private readonly az: Float32Array;
  private readonly bx: Float32Array;
  private readonly bz: Float32Array;
  private readonly s: Float32Array;
  private readonly leg: Float32Array;
  private readonly path: Uint16Array;
  private readonly pathLen: Uint8Array;
  private readonly pathAt: Uint8Array;
  private readonly doorX: Float32Array;
  private readonly doorZ: Float32Array;
  private readonly goal: Int32Array;

  constructor(
    private readonly graph: PavementGraph,
    readonly count: number,
    private readonly random: () => number,
  ) {
    const f = (): Float32Array => new Float32Array(count);
    this.x = f();
    this.z = f();
    this.px = f();
    this.pz = f();
    this.yaw = f();
    this.stride = f();
    this.speed = f();
    this.ax = f();
    this.az = f();
    this.bx = f();
    this.bz = f();
    this.s = f();
    this.leg = f();
    this.doorX = f();
    this.doorZ = f();
    this.mode = new Uint8Array(count);
    this.arrived = new Uint8Array(count);
    this.node = new Int32Array(count);
    this.goal = new Int32Array(count);
    this.came = new Int32Array(count).fill(-1);
    this.path = new Uint16Array(count * MAX_PATH);
    this.pathLen = new Uint8Array(count);
    this.pathAt = new Uint8Array(count);
  }

  /** Stand person `i` still at (x, z), its nearest corner `node`. */
  standAt(i: number, x: number, z: number, node: number): void {
    this.x[i] = this.px[i] = x;
    this.z[i] = this.pz[i] = z;
    this.node[i] = node;
    this.came[i] = -1;
    this.mode[i] = IDLE;
  }

  /** Walk `i` from where it stands to the door at (x, z), whose nearest corner is `goal`. */
  go(i: number, goal: number, x: number, z: number): void {
    this.doorX[i] = x;
    this.doorZ[i] = z;
    this.goal[i] = goal;
    this.pathLen[i] = this.graph.route(
      this.node[i] as number,
      goal,
      this.path,
      i * MAX_PATH,
      MAX_PATH,
    );
    this.pathAt[i] = 0;
    this.mode[i] = PATH;
    /* First to its own corner, a few metres off. */
    const n = this.node[i] as number;
    this.begin(i, this.graph.x[n] as number, this.graph.z[n] as number);
  }

  /** Set `i` down `f` of the way from corner `n` to its neighbour `m`, wandering on toward `m`. */
  setDown(i: number, n: number, m: number, f: number): void {
    const g = this.graph;
    const x = (g.x[n] as number) + ((g.x[m] as number) - (g.x[n] as number)) * f;
    const z = (g.z[n] as number) + ((g.z[m] as number) - (g.z[n] as number)) * f;
    this.standAt(i, x, z, m);
    this.came[i] = n;
    this.mode[i] = WANDER;
    this.begin(i, g.x[m] as number, g.z[m] as number);
  }

  /** Let `i` wander from its corner. */
  wander(i: number): void {
    this.mode[i] = WANDER;
    const n = this.node[i] as number;
    this.begin(i, this.graph.x[n] as number, this.graph.z[n] as number);
  }

  /** One fixed step of `dt` at `t` on the signals' clock. */
  step(dt: number, t: number, signals: Signals, eyeX: number, eyeZ: number): void {
    for (let i = 0; i < this.count; i++) {
      this.px[i] = this.x[i] as number;
      this.pz[i] = this.z[i] as number;
      if (this.mode[i] === IDLE) continue;
      const dx = (this.x[i] as number) - eyeX;
      const dz = (this.z[i] as number) - eyeZ;
      const unseen = dx * dx + dz * dz > UNSEEN_M * UNSEEN_M;
      const leg = this.leg[i] as number;
      let s = (this.s[i] as number) + (this.speed[i] as number) * dt * (unseen ? DAY_PACE : 1);
      if (s >= leg) {
        s = leg;
        this.x[i] = this.bx[i] as number;
        this.z[i] = this.bz[i] as number;
        this.s[i] = s;
        this.next(i, t, signals, unseen);
        continue;
      }
      this.s[i] = s;
      const f = leg > 0 ? s / leg : 1;
      this.x[i] = (this.ax[i] as number) + ((this.bx[i] as number) - (this.ax[i] as number)) * f;
      this.z[i] = (this.az[i] as number) + ((this.bz[i] as number) - (this.az[i] as number)) * f;
      this.stride[i] =
        ((this.stride[i] as number) + ((this.speed[i] as number) * dt * 2 * Math.PI) / STRIDE_M) %
        (2 * Math.PI);
    }
  }

  /** A leg is done: take the next one, or wait at the kerb, or stop at the door. */
  private next(i: number, t: number, signals: Signals, unseen: boolean): void {
    const g = this.graph;
    const mode = this.mode[i];
    if (mode === DOOR) {
      this.mode[i] = IDLE;
      this.arrived[i] = 1;
      return;
    }
    const at = this.node[i] as number;
    let to = -1;
    if (mode === PATH) {
      if ((this.pathAt[i] as number) >= (this.pathLen[i] as number)) {
        /* A route cut at its limit is routed again from where it ended. */
        if (at !== this.goal[i]) {
          this.pathLen[i] = g.route(at, this.goal[i] as number, this.path, i * MAX_PATH, MAX_PATH);
          this.pathAt[i] = 0;
          if (this.pathLen[i] !== 0) return;
        }
        this.mode[i] = DOOR;
        this.begin(i, this.doorX[i] as number, this.doorZ[i] as number);
        return;
      }
      to = this.path[i * MAX_PATH + (this.pathAt[i] as number)] as number;
    } else {
      const lo = g.first[at] as number;
      const n = (g.first[at + 1] as number) - lo;
      if (n === 0) return;
      /* Any way but back: a draw among the others, the one drawn as back swapped for the last. */
      const back = this.came[i] as number;
      to = g.next[lo + Math.floor(this.random() * (n > 1 && back >= 0 ? n - 1 : n))] as number;
      if (n > 1 && to === back) to = g.next[lo + n - 1] as number;
    }
    const step = g.stepOf(at, to);
    const signal = step >= 0 ? (g.signal[step] as number) : -1;
    if (!unseen && signal >= 0 && lightAt(signals, signal, g.phase[step] as number, t) !== GREEN) {
      return;
    }
    if (mode === PATH) this.pathAt[i] = (this.pathAt[i] as number) + 1;
    this.came[i] = at;
    this.node[i] = to;
    this.begin(i, g.x[to] as number, g.z[to] as number);
  }

  /** A straight leg from where `i` stands to (x, z). */
  private begin(i: number, x: number, z: number): void {
    const x0 = this.x[i] as number;
    const z0 = this.z[i] as number;
    this.ax[i] = x0;
    this.az[i] = z0;
    this.bx[i] = x;
    this.bz[i] = z;
    this.s[i] = 0;
    const leg = Math.hypot(x - x0, z - z0);
    this.leg[i] = leg;
    if (leg > 1e-3) this.yaw[i] = Math.atan2(x - x0, z - z0);
  }
}
