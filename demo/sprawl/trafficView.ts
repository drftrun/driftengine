/**
 * The fleet as a frame draws it: each car between its last two ticks on `alpha`, its full body
 * within 95 m and the shared distant body — stretched to its kind — out to 380 m, the reference's
 * two nearer levels (`trafficLodNear`, `trafficLodFar`); nothing past.
 *
 * **Paint as the reference paints**: a civilian car one of the ten paints its spawn drew, a taxi
 * the taxi yellow; the underglow one of the four glows fixed by the car's number, a taxi's its own.
 *
 * What gives: the third level, a white point ahead and a red one behind out to 1,500 m, is not
 * drawn, so traffic past 380 m is absent rather than a string of lamps.
 */
import { pointAt } from './laneEdges';
import type { LaneGraph } from './laneEdges';
import type { LifeData, Rgb } from './data/life';
import { createTints } from './movers';
import type { MoverBatches } from './movers';
import type { Traffic } from './traffic';

/** `trafficLodNear` and `trafficLodFar`. */
export const FULL_M = 95;
export const LITE_M = 380;

export class TrafficView {
  /** Cars the last `fill` added: full bodies, and distant ones. */
  near = 0;
  far = 0;
  private readonly body: Int32Array;
  private readonly lite: number;
  private readonly stretch: Float32Array;
  private readonly taxi: Uint8Array;
  private readonly tints = createTints();
  private readonly model = new Float32Array(16);
  private readonly a = new Float32Array(5);
  private readonly b = new Float32Array(5);

  constructor(
    private readonly traffic: Traffic,
    private readonly graph: LaneGraph,
    private readonly batches: MoverBatches,
    private readonly data: LifeData,
  ) {
    const rows = data.vehicles;
    this.body = Int32Array.from(rows.map((r) => batches.indexOf(r.template)));
    this.lite = batches.indexOf('VehicleLite');
    this.stretch = Float32Array.from(rows.flatMap((r) => [...r.lite]));
    this.taxi = Uint8Array.from(rows.map((r) => (r.taxi ? 1 : 0)));
  }

  /** Add every car within `LITE_M` of (x, z) to the batches, `alpha` of the way to its latest tick. */
  fill(x: number, z: number, alpha: number): void {
    const { traffic, graph, a, b, model, tints, data } = this;
    this.near = 0;
    this.far = 0;
    for (let i = 0; i < traffic.count; i++) {
      pointAt(graph, traffic.edge[i] as number, traffic.s[i] as number, b);
      const dx = (b[0] as number) - x;
      const dz = (b[2] as number) - z;
      const far = dx * dx + dz * dz;
      if (far > LITE_M * LITE_M) continue;
      pointAt(graph, traffic.prevEdge[i] as number, traffic.prevS[i] as number, a);
      const kind = traffic.kind[i] as number;
      const full = far <= FULL_M * FULL_M;
      const sx = full ? 1 : (this.stretch[kind * 3] as number);
      const sy = full ? 1 : (this.stretch[kind * 3 + 1] as number);
      const sz = full ? 1 : (this.stretch[kind * 3 + 2] as number);
      /* Local +z along the heading; x across it. */
      const hx = b[3] as number;
      const hz = b[4] as number;
      model[0] = hz * sx;
      model[2] = -hx * sx;
      model[5] = sy;
      model[8] = hx * sz;
      model[10] = hz * sz;
      model[12] = (a[0] as number) + ((b[0] as number) - (a[0] as number)) * alpha;
      model[13] = (a[1] as number) + ((b[1] as number) - (a[1] as number)) * alpha;
      model[14] = (a[2] as number) + ((b[2] as number) - (a[2] as number)) * alpha;
      model[15] = 1;
      const taxi = this.taxi[kind] === 1;
      put(tints.paint, taxi ? data.palette.taxi_paint : data.paints[traffic.paint[i] as number]);
      put(tints.glow, taxi ? data.palette.taxi_glow : data.glows[i % data.glows.length]);
      this.batches.add(full ? (this.body[kind] as number) : this.lite, model, tints, 0);
      if (full) this.near++;
      else this.far++;
    }
  }
}

function put(out: Float32Array, c: Rgb | undefined): void {
  out[0] = c?.[0] ?? 1;
  out[1] = c?.[1] ?? 1;
  out[2] = c?.[2] ?? 1;
}
