/**
 * The monorail and the air taxis as a frame draws them. **A train is its cars**, each posed at its
 * own place on the track — the lead car's front at the train's `s`, each car one length further
 * back, a flipped cab turned round — so a train bends through a corner; its cars ride the beam with
 * their floors at the platforms' deck, and wear their line's colour. Drawn within 900 m
 * (`monoCarRange`). **A taxi** banks into its turns and noses down into its speed — 0.055 of a
 * radian per 10 m/s of speed at a radian a second of turn, and 0.035 per 10 m/s, both ours from
 * the reference's figures (`airTaxiBank`, `airTaxiTilt`), whose units it does not state — drawn
 * within 1.5 km.
 */
import type { AirTaxis } from './airTaxis';
import { createTints, pose } from './movers';
import type { MoverBatches } from './movers';
import type { Monorail } from './monorail';

const CAR_M = 900;
const TAXI_M = 1500;
const BANK = 0.055 / 10;
const TILT = 0.035 / 10;
const MOST_BANK = 0.5;

export class TransitView {
  cars = 0;
  taxis = 0;
  private readonly kinds: Int32Array[];
  private readonly flipped: Uint8Array[];
  /** Each line's car floor above its beam, and its colour, linear. */
  private readonly lift: Float32Array;
  private readonly tint: Float32Array;
  private readonly taxiKind: Int32Array;
  private readonly tints = createTints();
  private readonly model = new Float32Array(16);
  private readonly a = new Float32Array(5);
  private readonly b = new Float32Array(5);

  constructor(
    private readonly rail: Monorail,
    private readonly air: AirTaxis,
    taxiPrefabs: readonly string[],
    private readonly batches: MoverBatches,
  ) {
    this.kinds = rail.lines.map((l) =>
      Int32Array.from(l.data.cars.map((c) => batches.indexOf(c.kind))),
    );
    this.flipped = rail.lines.map((l) =>
      Uint8Array.from(l.data.cars.map((c) => (c.flipped ? 1 : 0))),
    );
    this.lift = Float32Array.from(
      rail.lines.map((l) => {
        let low = Infinity;
        for (let i = 0; i < l.track.count; i++) low = Math.min(low, l.track.y[i] as number);
        /* The beam's lowest is its datum; the cars' floors meet the platforms' deck above it. */
        return l.data.deck - low;
      }),
    );
    this.tint = Float32Array.from(
      rail.lines.flatMap((l) => [24, 16, 8].map((shift) => linear((l.data.tint >>> shift) & 255))),
    );
    this.taxiKind = Int32Array.from(taxiPrefabs.map((p) => batches.indexOf(p)));
  }

  /** Add every car and taxi near (x, y, z), `alpha` of the way to its latest tick. */
  fill(x: number, y: number, z: number, alpha: number): void {
    const { rail, air, a, b, model, tints } = this;
    this.cars = 0;
    this.taxis = 0;
    for (let i = 0; i < rail.count; i++) {
      const li = rail.line[i] as number;
      const line = rail.lines[li];
      if (line === undefined) continue;
      const kinds = this.kinds[li] as Int32Array;
      const flipped = this.flipped[li] as Uint8Array;
      tints.paint[0] = this.tint[li * 3] as number;
      tints.paint[1] = this.tint[li * 3 + 1] as number;
      tints.paint[2] = this.tint[li * 3 + 2] as number;
      for (let c = 0; c < kinds.length; c++) {
        const back = line.data.carLength * (c + 0.5);
        line.track.pointAt((rail.s[i] as number) - back, b);
        const dx = (b[0] as number) - x;
        const dz = (b[2] as number) - z;
        if (dx * dx + dz * dz > CAR_M * CAR_M || (kinds[c] as number) < 0) continue;
        line.track.pointAt((rail.prevS[i] as number) - back, a);
        const yaw = Math.atan2(b[3] as number, b[4] as number) + (flipped[c] === 1 ? Math.PI : 0);
        pose(
          model,
          lerp(a[0] as number, b[0] as number, alpha),
          lerp(a[1] as number, b[1] as number, alpha) + (this.lift[li] as number),
          lerp(a[2] as number, b[2] as number, alpha),
          yaw,
          0,
          0,
          1,
        );
        this.batches.add(kinds[c] as number, model, tints, 0);
        this.cars++;
      }
    }
    for (let i = 0; i < air.count; i++) {
      const tx = air.x[i] as number;
      const ty = air.y[i] as number;
      const tz = air.z[i] as number;
      if ((tx - x) ** 2 + (ty - y) ** 2 + (tz - z) ** 2 > TAXI_M * TAXI_M) continue;
      const k = this.taxiKind[air.kind[i] as number] as number;
      if (k < 0) continue;
      const v = air.speed[i] as number;
      const roll = Math.max(
        -MOST_BANK,
        Math.min(MOST_BANK, -BANK * v * (air.turning[i] as number)),
      );
      pose(
        model,
        lerp(air.px[i] as number, tx, alpha),
        lerp(air.py[i] as number, ty, alpha),
        lerp(air.pz[i] as number, tz, alpha),
        air.heading[i] as number,
        TILT * v,
        roll,
        1,
      );
      this.batches.add(k, model, tints, 0);
      this.taxis++;
    }
  }
}

const lerp = (a: number, b: number, f: number): number => a + (b - a) * f;

/** An sRGB byte as a linear value. */
function linear(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}
