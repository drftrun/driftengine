/**
 * The drones as a frame draws them: between their last two ticks on `alpha`, bobbing 0.14 m at
 * 2.3 Hz (`droneBob`, `droneBobRate`) each on its own beat, nosed down a little into their speed
 * (`droneSway`), the full airframe within 160 m and the distant one out to 900 m
 * (`droneLodNear`, `droneLodFar`); none past.
 */
import type { DroneRow } from './data/life';
import { CRUISING, DOCKED } from './drones';
import type { Drones } from './drones';
import { blinkOn, createTints } from './movers';
import type { MoverBatches } from './movers';

export const FULL_M = 160;
export const LITE_M = 900;
const BOB = 0.14;
const BOB_HZ = 2.3;
/** Radians of nose-down per metre a second of speed. */
const SWAY = 0.055 / 10;

export class DronesView {
  near = 0;
  far = 0;
  private readonly body: Int32Array;
  private readonly lite: Int32Array;
  private readonly tints = createTints();
  private readonly model = new Float32Array(16);

  constructor(
    private readonly drones: Drones,
    private readonly rows: readonly DroneRow[],
    private readonly batches: MoverBatches,
  ) {
    this.body = Int32Array.from(rows.map((r) => batches.indexOf(r.body)));
    this.lite = Int32Array.from(rows.map((r) => batches.indexOf(r.lite)));
  }

  /** Add every drone within `LITE_M` of (x, y, z), `alpha` of the way to its latest tick, at `t`. */
  fill(x: number, y: number, z: number, alpha: number, t: number): void {
    const { drones, model } = this;
    this.near = 0;
    this.far = 0;
    for (let i = 0; i < drones.count; i++) {
      const dx = (drones.x[i] as number) - x;
      const dy = (drones.y[i] as number) - y;
      const dz = (drones.z[i] as number) - z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > LITE_M * LITE_M) continue;
      const kind = drones.kind[i] as number;
      const full = d2 <= FULL_M * FULL_M;
      const k = full ? (this.body[kind] as number) : (this.lite[kind] as number);
      if (k < 0) continue;
      const s = (this.rows[kind] as DroneRow).scale;
      const yaw = drones.heading[i] as number;
      const tilt = drones.phase[i] === CRUISING ? (drones.speed[i] as number) * SWAY : 0;
      const sy = Math.sin(yaw);
      const cy = Math.cos(yaw);
      const st = Math.sin(tilt);
      const ct = Math.cos(tilt);
      /* Heading about y, then the nose pitched down about the drone's own x. */
      model[0] = cy * s;
      model[1] = 0;
      model[2] = -sy * s;
      model[4] = sy * st * s;
      model[5] = ct * s;
      model[6] = cy * st * s;
      model[8] = sy * ct * s;
      model[9] = -st * s;
      model[10] = cy * ct * s;
      const bob = drones.phase[i] === DOCKED ? 0 : BOB * Math.sin(2 * Math.PI * BOB_HZ * t + i);
      model[12] =
        (drones.px[i] as number) + ((drones.x[i] as number) - (drones.px[i] as number)) * alpha;
      model[13] =
        (drones.py[i] as number) +
        ((drones.y[i] as number) - (drones.py[i] as number)) * alpha +
        bob;
      model[14] =
        (drones.pz[i] as number) + ((drones.z[i] as number) - (drones.pz[i] as number)) * alpha;
      model[15] = 1;
      /* Its strobe on its own beat: the golden ratio spreads a fleet's phases evenly. */
      const blink = this.batches.blinkOf(k);
      if (blink !== null) {
        this.tints.blink.fill(blinkOn(t, blink[0], blink[1], i * 0.6180339887) ? 1 : 0);
      }
      this.batches.add(k, model, this.tints, 0);
      if (full) this.near++;
      else this.far++;
    }
  }
}
