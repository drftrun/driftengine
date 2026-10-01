/**
 * The drones: 1,000 (`droneCount`) between the depots' charging slots and the kerbside pads, at
 * the reference's numbers. A drone **climbs** at 7.5 m/s to the flight level its heading keys —
 * 44 m going east, 52 west, 60 north, 68 south, ±2.4 m, plus its kind's offset — **cruises**
 * toward its target turning at most 2.4 rad/s, **descends** at 6 m/s to hover over a pad, **hovers**
 * 5–10 s while its cargo goes down, then goes home to a free slot 45% of the time and on to another
 * pad otherwise; **docked**, it charges 40–180 s and spins up for 1.8 s before it lifts.
 *
 * Typed arrays, one seeded draw stream, a tick allocating nothing.
 *
 * What gives: north is +z, which the scripts do not say; the cargo rig is not drawn and the winch
 * not wound; and a drone finding every slot taken goes on to another pad rather than queueing.
 */
import { mulberry32 } from '../../packages/core/src/index';
import type { DroneRow } from './data/life';

/** `droneClimb`, `droneDescend`, `droneTurn`, `droneArrive`. */
const CLIMB = 7.5;
const DESCEND = 6;
const TURN = 2.4;
const ARRIVE = 1.6;
/** `droneLevelEast`…`droneLevelSouth` and `droneLevelJitter`. */
const LEVELS = [44, 52, 60, 68] as const;
const LEVEL_JITTER = 2.4;
/** `droneHoverMin`/`Max`, `droneDockMin`/`Max`, `droneReturnChance`, `droneSpinUp`. */
const HOVER_MIN = 5;
const HOVER_MAX = 10;
const DOCK_MIN = 40;
const DOCK_MAX = 180;
const RETURN_CHANCE = 0.45;
const SPIN_UP = 1.8;

export const DOCKED = 0;
export const CLIMBING = 1;
export const CRUISING = 2;
export const DESCENDING = 3;
export const HOVERING = 4;

export interface Depot {
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
  readonly deck: number;
  readonly slots: number;
  readonly pitch: number;
}

export interface Pad {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** The flight level a leg of (dx, dz) keys: east, west, north, south by its larger component. */
export function levelFor(dx: number, dz: number): number {
  if (Math.abs(dx) >= Math.abs(dz)) return dx >= 0 ? LEVELS[0] : LEVELS[1];
  return dz >= 0 ? LEVELS[2] : LEVELS[3];
}

export class Drones {
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly z: Float32Array;
  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  readonly heading: Float32Array;
  readonly speed: Float32Array;
  readonly kind: Uint8Array;
  readonly phase: Uint8Array;
  private readonly tx: Float32Array;
  private readonly ty: Float32Array;
  private readonly tz: Float32Array;
  private readonly level: Float32Array;
  private readonly wait: Float32Array;
  /** The slot a drone holds or is flying to, `depot × per + slot`, or −1. */
  private readonly slot: Int32Array;
  private readonly taken: Int32Array;
  private readonly per: number;
  private readonly random: () => number;

  constructor(
    readonly count: number,
    private readonly kinds: readonly DroneRow[],
    private readonly depots: readonly Depot[],
    private readonly pads: readonly Pad[],
    seed: number,
  ) {
    const f = (): Float32Array => new Float32Array(count);
    this.x = f();
    this.y = f();
    this.z = f();
    this.px = f();
    this.py = f();
    this.pz = f();
    this.heading = f();
    this.speed = f();
    this.tx = f();
    this.ty = f();
    this.tz = f();
    this.level = f();
    this.wait = f();
    this.kind = new Uint8Array(count);
    this.phase = new Uint8Array(count);
    this.slot = new Int32Array(count).fill(-1);
    this.per = Math.max(0, ...depots.map((d) => d.slots * d.slots));
    this.taken = new Int32Array(depots.length * this.per).fill(-1);
    this.random = mulberry32(seed);
    let total = 0;
    for (const k of kinds) total += k.weight;
    for (let i = 0; i < count; i++) {
      let pick = this.random() * total;
      let k = 0;
      while (k < kinds.length - 1 && pick >= (kinds[k] as DroneRow).weight)
        pick -= (kinds[k++] as DroneRow).weight;
      this.kind[i] = k;
      const row = kinds[k] as DroneRow;
      this.speed[i] = row.speed + (this.random() * 2 - 1) * row.speedVar;
      /* Docked where a slot is free, else already on its way somewhere over the city. */
      if (!this.dock(i, Math.floor(this.random() * Math.max(1, depots.length)), true)) {
        const pad = pads[Math.floor(this.random() * pads.length)];
        const from = pads[Math.floor(this.random() * pads.length)];
        if (pad === undefined || from === undefined) continue;
        this.x[i] = from.x;
        this.z[i] = from.z;
        this.heading[i] = this.random() * 2 * Math.PI;
        this.toPad(i, pad);
        this.y[i] = this.level[i] as number;
        this.phase[i] = CRUISING;
      }
      this.px[i] = this.x[i] as number;
      this.py[i] = this.y[i] as number;
      this.pz[i] = this.z[i] as number;
    }
  }

  /** Put drone `i` at (x, y, z), off to `pad`. */
  place(i: number, x: number, y: number, z: number, pad: Pad): void {
    const held = this.slot[i] as number;
    if (held >= 0) this.taken[held] = -1;
    this.slot[i] = -1;
    this.x[i] = this.px[i] = x;
    this.y[i] = this.py[i] = y;
    this.z[i] = this.pz[i] = z;
    this.toPad(i, pad);
    this.phase[i] = CLIMBING;
  }

  /** One fixed step of `dt`. */
  step(dt: number): void {
    for (let i = 0; i < this.count; i++) {
      this.px[i] = this.x[i] as number;
      this.py[i] = this.y[i] as number;
      this.pz[i] = this.z[i] as number;
      switch (this.phase[i]) {
        case DOCKED:
          this.wait[i] = (this.wait[i] as number) - dt;
          if ((this.wait[i] as number) <= 0) this.leave(i);
          break;
        case CLIMBING:
          this.y[i] = Math.min(this.level[i] as number, (this.y[i] as number) + CLIMB * dt);
          if (this.y[i] === this.level[i]) this.phase[i] = CRUISING;
          break;
        case CRUISING:
          this.cruise(i, dt);
          break;
        case DESCENDING:
          this.y[i] = Math.max(this.ty[i] as number, (this.y[i] as number) - DESCEND * dt);
          if (this.y[i] === this.ty[i]) this.arrive(i);
          break;
        default:
          this.wait[i] = (this.wait[i] as number) - dt;
          if ((this.wait[i] as number) <= 0) this.leave(i);
      }
    }
  }

  /** Steer toward the target at the drone's pace, turning no faster than the reference lets it. */
  private cruise(i: number, dt: number): void {
    const dx = (this.tx[i] as number) - (this.x[i] as number);
    const dz = (this.tz[i] as number) - (this.z[i] as number);
    const d = Math.hypot(dx, dz);
    const step = (this.speed[i] as number) * dt;
    if (d <= Math.max(ARRIVE, step)) {
      this.x[i] = this.tx[i] as number;
      this.z[i] = this.tz[i] as number;
      this.phase[i] = DESCENDING;
      return;
    }
    const want = Math.atan2(dx, dz);
    let turn = want - (this.heading[i] as number);
    turn = Math.atan2(Math.sin(turn), Math.cos(turn));
    const most = TURN * dt;
    this.heading[i] = (this.heading[i] as number) + Math.max(-most, Math.min(most, turn));
    /* Slow in a tight turn so the circle it flies stays inside the arrival radius's reach. */
    const pace = d < (3 * step) / (TURN * dt) ? Math.max(0.2, Math.cos(turn)) : 1;
    this.x[i] = (this.x[i] as number) + Math.sin(this.heading[i] as number) * step * pace;
    this.z[i] = (this.z[i] as number) + Math.cos(this.heading[i] as number) * step * pace;
  }

  /** Down: over a pad it hovers; on a deck it docks. */
  private arrive(i: number): void {
    if ((this.slot[i] as number) >= 0) {
      this.phase[i] = DOCKED;
      this.wait[i] = DOCK_MIN + this.random() * (DOCK_MAX - DOCK_MIN) + SPIN_UP;
      return;
    }
    this.phase[i] = HOVERING;
    this.wait[i] = HOVER_MIN + this.random() * (HOVER_MAX - HOVER_MIN);
  }

  /** Off again: home to a free slot now and then, else to another pad. */
  private leave(i: number): void {
    const held = this.slot[i] as number;
    if (held >= 0 && this.phase[i] === DOCKED) {
      this.taken[held] = -1;
      this.slot[i] = -1;
    }
    const home = this.random() < RETURN_CHANCE && this.phase[i] !== DOCKED;
    if (!(
      home && this.dock(i, Math.floor(this.random() * Math.max(1, this.depots.length)), false)
    )) {
      const pad = this.pads[Math.floor(this.random() * this.pads.length)];
      if (pad !== undefined) this.toPad(i, pad);
    }
    this.phase[i] = CLIMBING;
  }

  /** Aim `i` at a pad, at the level that leg's heading keys. */
  private toPad(i: number, pad: Pad): void {
    this.aim(i, pad.x, pad.y + (this.kinds[this.kind[i] as number] as DroneRow).hover, pad.z);
  }

  /**
   * Reserve a free slot at depot `d` — or, failing that, at the next depots round — and aim `i` at
   * it; placed there already when `now`. False when every slot is taken.
   */
  private dock(i: number, d: number, now: boolean): boolean {
    const depots = this.depots;
    for (let k = 0; k < depots.length; k++) {
      const di = (d + k) % depots.length;
      const depot = depots[di] as Depot;
      for (let s = 0; s < depot.slots * depot.slots; s++) {
        const id = di * this.per + s;
        if ((this.taken[id] as number) >= 0) continue;
        this.taken[id] = i;
        this.slot[i] = id;
        /* The charging grid, centred on the deck and turned with its yard. */
        const u = ((s % depot.slots) - (depot.slots - 1) / 2) * depot.pitch;
        const v = (Math.floor(s / depot.slots) - (depot.slots - 1) / 2) * depot.pitch;
        const c = Math.cos(depot.yaw);
        const sn = Math.sin(depot.yaw);
        const x = depot.x + c * u + sn * v;
        const z = depot.z - sn * u + c * v;
        if (now) {
          this.x[i] = x;
          this.y[i] = depot.deck;
          this.z[i] = z;
          this.heading[i] = depot.yaw;
          this.phase[i] = DOCKED;
          this.wait[i] = this.random() * DOCK_MAX;
        }
        this.aim(i, x, depot.deck, z);
        return true;
      }
    }
    return false;
  }

  private aim(i: number, x: number, y: number, z: number): void {
    this.tx[i] = x;
    this.ty[i] = y;
    this.tz[i] = z;
    const row = this.kinds[this.kind[i] as number] as DroneRow;
    this.level[i] =
      levelFor(x - (this.x[i] as number), z - (this.z[i] as number)) +
      (this.random() * 2 - 1) * LEVEL_JITTER +
      row.altitude;
  }
}
