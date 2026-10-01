/**
 * The air taxis between the skyports, at the reference's numbers (`airTaxi*` in the configuration):
 * a taxi **parked** on a deck dwells 20–40 s, scaled by its kind; it **climbs** at 10 m/s to its
 * cruise, 120–160 m plus its kind's bias; **cruises** toward another skyport at its kind's speed,
 * accelerating at 7 m/s² and turning at most 1.6 rad/s, easing to the 9 m/s drift over the last of
 * the way; over the deck it **descends** at 6.5 m/s if the deck is free, and otherwise **holds** 40 m
 * above it, stacked 15 m a taxi, at most four, moving down the stack as the deck clears — and goes
 * elsewhere after 30 s. One taxi on a deck at a time.
 *
 * Typed arrays, one seeded draw stream; a tick allocates nothing.
 */
import { mulberry32 } from '../../packages/core/src/index';
import type { TaxiRow } from './data/life';

export const PARKED = 0;
export const CLIMBING = 1;
export const CRUISING = 2;
export const HOLDING = 3;
export const DESCENDING = 4;

export interface SkyportData {
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
  readonly deck: number;
}

/** The numbers a flight keeps, by the configuration's names. */
export interface TaxiConfig {
  readonly count: number;
  readonly cruiseLow: number;
  readonly cruiseHigh: number;
  readonly climb: number;
  readonly descend: number;
  readonly drift: number;
  readonly accel: number;
  readonly turn: number;
  readonly dwellMin: number;
  readonly dwellMax: number;
  readonly holdHeight: number;
  readonly holdStack: number;
  readonly holdQueue: number;
  readonly patience: number;
}

export function taxiConfig(config: Readonly<Record<string, number>>): TaxiConfig {
  const n = (name: string, fallback: number): number => config[name] ?? fallback;
  return {
    count: n('airTaxiCount', 50),
    cruiseLow: n('airTaxiCruiseLow', 120),
    cruiseHigh: n('airTaxiCruiseHigh', 160),
    climb: n('airTaxiClimbSpeed', 10),
    descend: n('airTaxiDescendSpeed', 6.5),
    drift: n('airTaxiDriftSpeed', 9),
    accel: n('airTaxiAccel', 7),
    turn: n('airTaxiTurnRate', 1.6),
    dwellMin: n('airTaxiDwellMin', 20),
    dwellMax: n('airTaxiDwellMax', 40),
    holdHeight: n('airTaxiHoldHeight', 40),
    holdStack: n('airTaxiHoldStack', 15),
    holdQueue: n('airTaxiHoldQueue', 4),
    patience: n('airTaxiHoldPatience', 30),
  };
}

export class AirTaxis {
  readonly count: number;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly z: Float32Array;
  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  readonly heading: Float32Array;
  readonly speed: Float32Array;
  /** How fast each is turning, radians a second, for its bank. */
  readonly turning: Float32Array;
  readonly kind: Uint8Array;
  readonly phase: Uint8Array;
  /** The skyport each is bound for, or is on. */
  readonly target: Int16Array;
  /** A skyport a rider asked for, which the next departure flies to, or −1. */
  readonly hired: Int16Array;
  private readonly cruise: Float32Array;
  private readonly wait: Float32Array;
  /** Who is on each deck, or −1; and who holds over it, in order, `queue[port × holdQueue + k]`. */
  private readonly occupant: Int16Array;
  private readonly queue: Int16Array;
  private readonly random: () => number;

  constructor(
    private readonly ports: readonly SkyportData[],
    private readonly kinds: readonly TaxiRow[],
    private readonly config: TaxiConfig,
    seed: number,
  ) {
    const n = ports.length > 1 ? config.count : 0;
    this.count = n;
    const f = (): Float32Array => new Float32Array(n);
    this.x = f();
    this.y = f();
    this.z = f();
    this.px = f();
    this.py = f();
    this.pz = f();
    this.heading = f();
    this.speed = f();
    this.turning = f();
    this.cruise = f();
    this.wait = f();
    this.kind = new Uint8Array(n);
    this.phase = new Uint8Array(n);
    this.target = new Int16Array(n);
    this.hired = new Int16Array(n).fill(-1);
    this.occupant = new Int16Array(ports.length).fill(-1);
    this.queue = new Int16Array(ports.length * config.holdQueue).fill(-1);
    this.random = mulberry32(seed);
    let total = 0;
    for (const k of kinds) total += k.weight;
    for (let i = 0; i < n; i++) {
      let pick = this.random() * total;
      let k = 0;
      while (k < kinds.length - 1 && pick >= (kinds[k] as TaxiRow).weight)
        pick -= (kinds[k++] as TaxiRow).weight;
      this.kind[i] = k;
      /* One parked on every deck; the rest already on their way somewhere. */
      if (i < ports.length) this.park(i, i, this.random() * this.dwell(i));
      else {
        const from = ports[Math.floor(this.random() * ports.length)] as SkyportData;
        this.x[i] = from.x;
        this.z[i] = from.z;
        this.heading[i] = this.random() * 2 * Math.PI;
        this.depart(i, -1);
        this.y[i] = this.cruise[i] as number;
        this.phase[i] = CRUISING;
      }
      this.px[i] = this.x[i] as number;
      this.py[i] = this.y[i] as number;
      this.pz[i] = this.z[i] as number;
    }
  }

  /** Hire parked taxi `i` for skyport `to`: it leaves in `soon` seconds and flies there. */
  hire(i: number, to: number, soon: number): void {
    this.hired[i] = to;
    if (this.phase[i] === PARKED) this.wait[i] = Math.min(this.wait[i] as number, soon);
  }

  /** Who is parked on skyport `p`'s deck, or −1. */
  parkedAt(p: number): number {
    const i = this.occupant[p] as number;
    return i >= 0 && this.phase[i] === PARKED ? i : -1;
  }

  /** Put taxi `i` at (x, y, z), cruising for skyport `to`. */
  place(i: number, x: number, y: number, z: number, to: number): void {
    const from = this.target[i] as number;
    if (this.occupant[from] === i) this.occupant[from] = -1;
    this.x[i] = this.px[i] = x;
    this.y[i] = this.py[i] = y;
    this.z[i] = this.pz[i] = z;
    this.cruise[i] = y;
    this.target[i] = to;
    this.phase[i] = CRUISING;
  }

  /** One fixed step of `dt`. */
  step(dt: number): void {
    const c = this.config;
    for (let i = 0; i < this.count; i++) {
      this.px[i] = this.x[i] as number;
      this.py[i] = this.y[i] as number;
      this.pz[i] = this.z[i] as number;
      this.turning[i] = 0;
      const port = this.ports[this.target[i] as number] as SkyportData;
      switch (this.phase[i]) {
        case PARKED:
          this.wait[i] = (this.wait[i] as number) - dt;
          if ((this.wait[i] as number) <= 0) this.depart(i, this.target[i] as number);
          break;
        case CLIMBING:
          this.y[i] = Math.min(this.cruise[i] as number, (this.y[i] as number) + c.climb * dt);
          if (this.y[i] === this.cruise[i]) this.phase[i] = CRUISING;
          break;
        case CRUISING:
          if (this.fly(i, port, dt)) this.arrive(i);
          break;
        case HOLDING: {
          const slot = this.slotOf(i);
          const height = port.deck + c.holdHeight + c.holdStack * slot;
          const y = this.y[i] as number;
          this.y[i] =
            y > height ? Math.max(height, y - c.descend * dt) : Math.min(height, y + c.climb * dt);
          this.wait[i] = (this.wait[i] as number) - dt;
          if (slot === 0 && this.occupant[this.target[i] as number] === -1) {
            this.leaveQueue(i);
            this.occupant[this.target[i] as number] = i;
            this.phase[i] = DESCENDING;
          } else if ((this.wait[i] as number) <= 0) {
            this.leaveQueue(i);
            this.depart(i, this.target[i] as number);
          }
          break;
        }
        default:
          this.y[i] = Math.max(port.deck, (this.y[i] as number) - c.descend * dt);
          /* The height is stored in 32 bits: compared with the deck as it would be stored. */
          if ((this.y[i] as number) <= Math.fround(port.deck)) {
            this.park(i, this.target[i] as number, this.dwell(i));
          }
      }
    }
  }

  /** Toward the port's deck at cruise, turning at most the turn rate; true once over it. */
  private fly(i: number, port: SkyportData, dt: number): boolean {
    const c = this.config;
    const dx = port.x - (this.x[i] as number);
    const dz = port.z - (this.z[i] as number);
    const d = Math.hypot(dx, dz);
    const cruise = (this.kinds[this.kind[i] as number] as TaxiRow).cruise;
    /* Ease to the drift over the last of the way, from as far out as the acceleration needs. */
    const want = Math.min(
      cruise,
      Math.max(c.drift * Math.min(1, d / 10), Math.sqrt(2 * c.accel * d)),
    );
    const v = this.speed[i] as number;
    const speed = want > v ? Math.min(want, v + c.accel * dt) : Math.max(want, v - c.accel * dt);
    this.speed[i] = speed;
    const step = speed * dt;
    if (d <= Math.max(1, step)) {
      this.x[i] = port.x;
      this.z[i] = port.z;
      this.speed[i] = 0;
      return true;
    }
    let turn = Math.atan2(dx, dz) - (this.heading[i] as number);
    turn = Math.atan2(Math.sin(turn), Math.cos(turn));
    const most = c.turn * dt;
    const done = Math.max(-most, Math.min(most, turn));
    this.heading[i] = (this.heading[i] as number) + done;
    this.turning[i] = done / dt;
    /* Slow in a turn it cannot make, so it does not circle the deck for ever. */
    const pace = Math.abs(turn) > Math.PI / 2 ? 0.3 : 1;
    this.x[i] = (this.x[i] as number) + Math.sin(this.heading[i] as number) * step * pace;
    this.z[i] = (this.z[i] as number) + Math.cos(this.heading[i] as number) * step * pace;
    return false;
  }

  /** Over the deck: down if it is free and nobody holds for it, into the stack if there is room. */
  private arrive(i: number): void {
    const p = this.target[i] as number;
    const q = this.config.holdQueue;
    if (this.occupant[p] === -1 && this.queue[p * q] === -1) {
      this.occupant[p] = i;
      this.phase[i] = DESCENDING;
      return;
    }
    for (let k = 0; k < q; k++) {
      if (this.queue[p * q + k] !== -1) continue;
      this.queue[p * q + k] = i;
      this.phase[i] = HOLDING;
      this.wait[i] = this.config.patience;
      return;
    }
    this.depart(i, p);
  }

  /** Off to another skyport than `from`, at a cruise of its own. */
  private depart(i: number, from: number): void {
    if (from >= 0 && this.occupant[from] === i) this.occupant[from] = -1;
    const c = this.config;
    /* Where its rider asked, or any port but the one it leaves: a draw among the others. */
    let to = Math.floor(this.random() * (from >= 0 ? this.ports.length - 1 : this.ports.length));
    if (from >= 0 && to >= from) to++;
    const hired = this.hired[i] as number;
    this.target[i] = hired >= 0 && hired !== from ? hired : to;
    this.hired[i] = -1;
    this.cruise[i] =
      c.cruiseLow +
      this.random() * (c.cruiseHigh - c.cruiseLow) +
      (this.kinds[this.kind[i] as number] as TaxiRow).bias;
    this.phase[i] = (this.y[i] as number) < (this.cruise[i] as number) ? CLIMBING : CRUISING;
  }

  private park(i: number, p: number, wait: number): void {
    const port = this.ports[p] as SkyportData;
    this.target[i] = p;
    this.occupant[p] = i;
    this.x[i] = port.x;
    this.y[i] = port.deck;
    this.z[i] = port.z;
    this.speed[i] = 0;
    this.phase[i] = PARKED;
    this.wait[i] = wait;
  }

  private dwell(i: number): number {
    const c = this.config;
    return (
      (c.dwellMin + this.random() * (c.dwellMax - c.dwellMin)) *
      (this.kinds[this.kind[i] as number] as TaxiRow).dwellScale
    );
  }

  private slotOf(i: number): number {
    const p = this.target[i] as number;
    const q = this.config.holdQueue;
    for (let k = 0; k < q; k++) if (this.queue[p * q + k] === i) return k;
    return 0;
  }

  /** Out of its port's stack, those above it moving down a place. */
  private leaveQueue(i: number): void {
    const p = this.target[i] as number;
    const q = this.config.holdQueue;
    let k = this.slotOf(i);
    for (; k < q - 1; k++) this.queue[p * q + k] = this.queue[p * q + k + 1] as number;
    this.queue[p * q + q - 1] = -1;
  }
}
