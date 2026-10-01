/**
 * People as a frame draws them: every resident out of doors and every one of the crowd, between
 * their last two ticks on `alpha`, standing on the pavement — the full body with its limbs swinging
 * to its stride within 26 m, the shared distant body without limbs out to 140 m, none past. Each
 * wears its palette: skin, two cloths, hair and an accent.
 */
import type { PersonRow, Rgb } from './data/life';
import type { Crowd } from './crowd';
import { createTints } from './movers';
import type { MoverBatches } from './movers';
import type { Residents } from './residents';
import { IDLE } from './walkers';
import type { Walkers } from './walkers';

/** Where full bodies give way to distant ones, and those to nothing: ours, from the reference's LOD. */
export const FULL_M = 26;
export const LITE_M = 140;
/** The pavement's top: the walk slab's 0.68 m, centred on the ground. */
const WALK_TOP = 0.34;

export class PeopleView {
  near = 0;
  far = 0;
  private readonly body: Int32Array;
  private readonly lite: Int32Array;
  private readonly tints = createTints();
  private readonly model = new Float32Array(16);

  constructor(
    private readonly walkers: Walkers,
    private readonly residents: Residents,
    private readonly crowd: Crowd,
    private readonly rows: readonly PersonRow[],
    private readonly batches: MoverBatches,
  ) {
    this.body = Int32Array.from(rows.map((r) => batches.indexOf(r.body)));
    this.lite = Int32Array.from(rows.map((r) => batches.indexOf(r.lite)));
  }

  /** Add everyone out of doors within `LITE_M` of (x, z), `alpha` of the way to their latest tick. */
  fill(x: number, z: number, alpha: number): void {
    const { walkers, residents, crowd, model, tints } = this;
    this.near = 0;
    this.far = 0;
    for (let i = 0; i < walkers.count; i++) {
      const own = i < residents.count;
      if (own && residents.shown[i] === 0) continue;
      const wx = walkers.x[i] as number;
      const wz = walkers.z[i] as number;
      const d2 = (wx - x) * (wx - x) + (wz - z) * (wz - z);
      if (d2 > LITE_M * LITE_M) continue;
      const c = i - crowd.first;
      const kind = own ? (residents.kind[i] as number) : (crowd.kind[c] as number);
      const row = this.rows[kind] as PersonRow;
      const palette =
        row.palettes[own ? (residents.palette[i] as number) : (crowd.palette[c] as number)];
      const full = d2 <= FULL_M * FULL_M;
      const k = full ? (this.body[kind] as number) : (this.lite[kind] as number);
      if (k < 0) continue;
      const yaw = walkers.yaw[i] as number;
      const s = row.scale;
      const sin = Math.sin(yaw) * s;
      const cos = Math.cos(yaw) * s;
      model[0] = cos;
      model[2] = -sin;
      model[5] = s;
      model[8] = sin;
      model[10] = cos;
      model[12] = (walkers.px[i] as number) + (wx - (walkers.px[i] as number)) * alpha;
      model[13] = WALK_TOP;
      model[14] = (walkers.pz[i] as number) + (wz - (walkers.pz[i] as number)) * alpha;
      model[15] = 1;
      put(tints.skin, palette?.skin);
      put(tints.cloth, palette?.cloth);
      put(tints.cloth2, palette?.cloth2);
      put(tints.hair, palette?.hair);
      put(tints.accent, palette?.accent);
      const stride = walkers.mode[i] === IDLE ? 0 : (walkers.stride[i] as number);
      this.batches.add(k, model, tints, stride);
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
