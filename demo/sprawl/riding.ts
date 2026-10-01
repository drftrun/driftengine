/**
 * Riding the monorail and the air taxis, at the reference's reach (`ride*` in the configuration).
 * **What the ride is in, and what a key or an arrival means for it, is `transit.drs`'s**: this
 * answers the questions about the world and acts on what the script decides.
 * E within 18 m of a platform — on it or in the street below — or 11.5 m of a skyport **waits** there;
 * the next train to stand at that platform, or the taxi parked on that deck, is **boarded**; the
 * ride goes to the chosen destination — `[` and `]` step through them — resolved to the stop on
 * that line nearest it, or the skyport nearest it; there the rider is **set down** 3.6 m from the
 * vehicle, on the platform's outside or by the deck's door. Esc gets off at the next stop, or stops
 * waiting.
 *
 * **The eye rides in the vehicle's seat**, at the ride camera the reference defines for it, and
 * looks wherever the walker looks. The train's seat numbers are read from a seat 2.3 m above the
 * car's origin — ours: the reference's are relative to a seat whose height its scripts do not give.
 */
import type { AirTaxis, SkyportData } from './airTaxis';
import type { CameraRow } from './data/life';
import { DWELL } from './monorail';
import type { Monorail } from './monorail';
import { ScriptHost } from './scriptHost';
import * as transit from './transit.drs';

export const WALK = 0;
export const WAIT_TRAIN = 1;
export const ON_TRAIN = 2;
export const WAIT_TAXI = 3;
export const ON_TAXI = 4;

/** The train seat the ride camera's numbers are read from, above the car's origin. */
const TRAIN_SEAT = 2.3;
/** The facts the host writes for a step, cleared once the ride has read them. */
const FACTS = ['askedTrain', 'askedTaxi', 'vehicleHere', 'atStop', 'cancel'] as const;
/** The car a train's rider sits in: the middle one. */
const RIDDEN_CAR = 1;

export interface RideConfig {
  readonly stationRadius: number;
  readonly stationHeight: number;
  readonly skyportRadius: number;
  readonly skyportHeight: number;
  readonly exit: number;
}

export function rideConfig(config: Readonly<Record<string, number>>): RideConfig {
  return {
    stationRadius: config.rideStationRadius ?? 18,
    stationHeight: config.rideStationHeight ?? 3.2,
    skyportRadius: config.rideSkyportRadius ?? 11.5,
    skyportHeight: config.rideSkyportHeight ?? 3,
    exit: config.rideExitOffset ?? 3.6,
  };
}

interface Stop {
  readonly line: number;
  /** Its place among its line's platforms, as the monorail counts them. */
  readonly index: number;
  readonly x: number;
  readonly z: number;
}

export class Riding {
  /** The destination asked for, by its index. */
  destination = 0;
  /** Set when a ride ends: where the walker stands now, which the caller takes and clears. */
  landed = false;
  readonly setDown = new Float32Array(3);
  private readonly stops: readonly Stop[];
  /** Each line's car floor above its beam's datum, as the trains are drawn. */
  private readonly lift: Float32Array;
  private at = -1;
  private vehicle = -1;
  /** The train or taxi a fact said is here, taken if the ride decides to board it. */
  private candidate = -1;
  private target = -1;
  private moved = false;
  private readonly script = new ScriptHost(
    transit as unknown as Record<string, unknown>,
    'transit',
    ['Ride'],
  );
  private readonly Ride = this.script.type('Ride');
  private readonly p = new Float32Array(5);
  private readonly q = new Float32Array(5);

  constructor(
    private readonly rail: Monorail,
    private readonly air: AirTaxis,
    stops: readonly {
      readonly line: string;
      readonly x: number;
      readonly z: number;
      readonly along: number;
    }[],
    private readonly ports: readonly SkyportData[],
    readonly destinations: readonly {
      readonly x: number;
      readonly z: number;
      readonly name: string;
    }[],
    private readonly config: RideConfig,
    private readonly cameras: Readonly<Record<string, CameraRow>>,
  ) {
    this.lift = Float32Array.from(
      rail.lines.map((l) => {
        let low = Infinity;
        for (let i = 0; i < l.track.count; i++) low = Math.min(low, l.track.y[i] as number);
        return l.data.deck - low;
      }),
    );
    this.stops = stops.flatMap((s) => {
      const line = rail.lines.findIndex((l) => l.data.name === s.line);
      const index =
        line < 0
          ? -1
          : Array.from((rail.lines[line] as { stops: Float32Array }).stops).indexOf(
              Math.fround(s.along),
            );
      return line < 0 || index < 0 ? [] : [{ line, index, x: s.x, z: s.z }];
    });
  }

  /** The ride's state, as `transit.drs` keeps it. */
  get state(): number {
    return this.script.read(this.Ride, 'state');
  }

  /** E at (x, y, z): wait at the platform or deck within reach; true if it did. */
  board(x: number, y: number, z: number): boolean {
    if (this.state !== WALK) return false;
    const c = this.config;
    let best = -1;
    let bestD = c.stationRadius;
    this.stops.forEach((s, i) => {
      const deck = (this.rail.lines[s.line] as { data: { deck: number } }).data.deck;
      const d = Math.hypot(s.x - x, s.z - z);
      if (d <= bestD && y <= deck + c.stationHeight) {
        best = i;
        bestD = d;
      }
    });
    if (best >= 0) {
      this.at = best;
      this.script.write(this.Ride, 'askedTrain', 1);
      this.decide();
      return true;
    }
    this.ports.forEach((p, i) => {
      if (Math.hypot(p.x - x, p.z - z) <= c.skyportRadius && y <= p.deck + c.skyportHeight)
        best = i;
    });
    if (best < 0) return false;
    this.at = best;
    this.script.write(this.Ride, 'askedTaxi', 1);
    this.decide();
    return true;
  }

  /** `[` and `]`: the previous or next destination. */
  choose(step: number): void {
    const n = this.destinations.length;
    if (n > 0) this.destination = (((this.destination + step) % n) + n) % n;
  }

  /** Esc: what it means is the ride's to decide. */
  leave(): void {
    this.script.write(this.Ride, 'cancel', 1);
    this.decide();
  }

  /** One fixed step: the facts of the world for the ride, then what it decides. */
  step(): void {
    const state = this.state;
    if (state === WAIT_TRAIN) this.candidate = this.trainHere();
    else if (state === WAIT_TAXI) this.candidate = this.air.parkedAt(this.at);
    if ((state === WAIT_TRAIN || state === WAIT_TAXI) && this.candidate >= 0) {
      this.script.write(this.Ride, 'vehicleHere', 1);
    }
    if ((state === ON_TRAIN && this.trainAtStop()) || (state === ON_TAXI && this.taxiAtStop())) {
      this.script.write(this.Ride, 'atStop', 1);
    }
    this.decide();
  }

  /** Step `transit.drs`, act on what it decided, and clear the facts it was given. */
  private decide(): void {
    const { script, Ride } = this;
    const waiting = this.state;
    script.step();
    if (script.read(Ride, 'boarded') === 1) this.take(waiting);
    if (script.read(Ride, 'getOffNext') === 1) this.target = this.rail.next[this.vehicle] as number;
    if (script.read(Ride, 'landed') === 1) {
      this.landed = true;
      this.vehicle = -1;
    }
    for (const fact of FACTS) script.write(Ride, fact, 0);
  }

  /** Board what was here: a train, bound for the stop the destination resolves to; or a taxi,
      hired there. */
  private take(waiting: number): void {
    this.vehicle = this.candidate;
    if (waiting === WAIT_TRAIN) {
      const s = this.stops[this.at] as Stop;
      this.target = this.nearestStop(s.line, s.index);
      return;
    }
    this.moved = false;
    this.target = this.nearestPort(this.at);
    this.air.hire(this.vehicle, this.target, 2);
  }

  /** The rider's eye in its seat, `alpha` of the way to the latest tick; false when walking. */
  eye(alpha: number, out: Float32Array): boolean {
    const { p, q } = this;
    if (this.state === ON_TRAIN) {
      const i = this.vehicle;
      const line = this.rail.lines[this.rail.line[i] as number];
      if (line === undefined) return false;
      const back = line.data.carLength * (RIDDEN_CAR + 0.5);
      line.track.pointAt((this.rail.prevS[i] as number) - back, q);
      line.track.pointAt((this.rail.s[i] as number) - back, p);
      const lift = this.lift[this.rail.line[i] as number] as number;
      seat(out, q, p, alpha, lift + TRAIN_SEAT, this.cameras.SeatMonorail);
      return true;
    }
    if (this.state === ON_TAXI) {
      const i = this.vehicle;
      const a = this.air;
      q[0] = a.px[i] as number;
      q[1] = a.py[i] as number;
      q[2] = a.pz[i] as number;
      p[0] = a.x[i] as number;
      p[1] = a.y[i] as number;
      p[2] = a.z[i] as number;
      p[3] = q[3] = Math.sin(a.heading[i] as number);
      p[4] = q[4] = Math.cos(a.heading[i] as number);
      seat(out, q, p, alpha, 0, this.cameras.SeatAirTaxi);
      return true;
    }
    return false;
  }

  /** What the readout says of the ride. */
  describe(): string {
    const to = this.destinations[this.destination]?.name.replace(/_/g, ' ') ?? '';
    const states = [
      '',
      'waiting for a train',
      'on the train',
      'waiting for an air taxi',
      'in the air',
    ];
    return this.state === WALK ? `to ${to}` : `${states[this.state]} to ${to}`;
  }

  /** A train of the waited-for line standing at the platform, or −1. */
  private trainHere(): number {
    const s = this.stops[this.at] as Stop;
    const line = this.rail.lines[s.line] as { first: number; count: number };
    for (let i = line.first; i < line.first + line.count; i++) {
      if (this.rail.phase[i] === DWELL && this.rail.next[i] === s.index) return i;
    }
    return -1;
  }

  /* A train is never asked to stop where it was boarded, so standing at its target is arriving. */
  private trainAtStop(): boolean {
    const i = this.vehicle;
    if (this.rail.phase[i] !== DWELL || this.rail.next[i] !== this.target) return false;
    this.setDownFromTrain(i);
    return true;
  }

  /** The taxi parked at its target, having flown there: by the deck's door, the tower's −z. */
  private taxiAtStop(): boolean {
    const i = this.vehicle;
    const parked = this.air.parkedAt(this.air.target[i] as number) === i;
    if (!parked) {
      this.moved = true;
      return false;
    }
    if (!this.moved) return false;
    const port = this.ports[this.air.target[i] as number] as SkyportData;
    this.setDown[0] = port.x - Math.sin(port.yaw) * this.config.exit;
    this.setDown[1] = port.deck;
    this.setDown[2] = port.z - Math.cos(port.yaw) * this.config.exit;
    return true;
  }

  /** Down on the platform's outside, away from the middle of the loop. */
  private setDownFromTrain(i: number): void {
    const li = this.rail.line[i] as number;
    const line = this.rail.lines[li];
    if (line === undefined) return;
    line.track.pointAt(line.stops[this.target] as number as number, this.p);
    const { p } = this;
    let cx = 0;
    let cz = 0;
    for (let k = 0; k < line.track.count; k++) {
      cx += line.track.x[k] as number;
      cz += line.track.z[k] as number;
    }
    cx /= line.track.count;
    cz /= line.track.count;
    /* Right of travel, (−hz, hx), or its opposite: whichever points out of the loop. */
    let nx = -(p[4] as number);
    let nz = p[3] as number;
    if (nx * ((p[0] as number) - cx) + nz * ((p[2] as number) - cz) < 0) {
      nx = -nx;
      nz = -nz;
    }
    this.setDown[0] = (p[0] as number) + nx * this.config.exit;
    this.setDown[1] = line.data.deck;
    this.setDown[2] = (p[2] as number) + nz * this.config.exit;
  }

  /** The stop on `line` nearest the destination; the next one when that is where it boards. */
  private nearestStop(line: number, from: number): number {
    const d = this.destinations[this.destination];
    let best = -1;
    let bestD = Infinity;
    for (const s of this.stops) {
      if (s.line !== line || d === undefined) continue;
      const dist = Math.hypot(s.x - d.x, s.z - d.z);
      if (dist < bestD) {
        bestD = dist;
        best = s.index;
      }
    }
    const count = (this.rail.lines[line] as { stops: Float32Array }).stops.length;
    return best < 0 || best === from ? (from + 1) % count : best;
  }

  /** The skyport nearest the destination; another when that is where it boards. */
  private nearestPort(from: number): number {
    const d = this.destinations[this.destination];
    let best = (from + 1) % this.ports.length;
    let bestD = Infinity;
    this.ports.forEach((p, i) => {
      const dist = d === undefined ? 0 : Math.hypot(p.x - d.x, p.z - d.z);
      if (i !== from && dist < bestD) {
        bestD = dist;
        best = i;
      }
    });
    return best;
  }
}

/** A seat's eye into `out`: between two poses on `alpha`, the camera's numbers in the body's frame. */
function seat(
  out: Float32Array,
  q: Float32Array,
  p: Float32Array,
  alpha: number,
  up: number,
  camera: CameraRow | undefined,
): void {
  const hx = p[3] as number;
  const hz = p[4] as number;
  const side = camera?.side ?? 0;
  const forward = camera?.forward ?? 0;
  const eye = up + (camera?.eye ?? 1.6);
  /* The body's x is (hz, −hx) and its z the heading, as `pose` turns them. */
  out[0] =
    (q[0] as number) + ((p[0] as number) - (q[0] as number)) * alpha + hz * side + hx * forward;
  out[1] = (q[1] as number) + ((p[1] as number) - (q[1] as number)) * alpha + eye;
  out[2] =
    (q[2] as number) + ((p[2] as number) - (q[2] as number)) * alpha - hx * side + hz * forward;
}
