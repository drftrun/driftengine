/**
 * Rain falling about the walker, at the reference's numbers: drops fall at 15 m/s from 11 m up over
 * 15 m either side, about 1,200 in the air in full rain (its 1,300 a second, each 0.9 s aloft), and
 * the wind it drifts on, (1.4, 0.3).
 *
 * **How hard it rains is how many are drawn**: the field keeps every drop falling and the frame
 * draws the first share of them, which — each drop's place a hash of its index — is an even share
 * of the box. Streaks, not sprites (`RainField`), fogged as the frame is. **A stroke is not lit**, so
 * its colour is darkened by the city's night itself: at the day's grey, a midnight downpour drew as
 * white lines over a dark city, where the reference's rain is a faint shimmer.
 *
 * What it gives up: shelter — a drop is drawn under an awning — until the regions' collision is
 * offered to the field as the roofs it looks for.
 */
import { RainField } from '../../packages/core/src/index';
import type {
  Camera,
  Environment,
  LineHandle,
  RendererApi,
  Vec3,
} from '../../packages/core/src/index';

const DROPS = 1200;
const WIND_X = 1.4;
const WIND_Z = 0.3;
const COLOR: Vec3 = [0.62, 0.68, 0.78];
/** How much of its colour the rain keeps at full night. */
const NIGHT_KEEPS = 0.3;
const WIDTH_M = 0.006;
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

export class CityRain {
  private readonly field = new RainField({
    count: DROPS,
    radiusM: 15,
    heightM: 11,
    speedMps: 15,
    streakSec: 0.06,
  });
  private readonly lines: LineHandle;

  constructor(private readonly renderer: RendererApi) {
    this.lines = renderer.createLines(DROPS, 'sprawl.rain');
  }

  /** Fall `dt` seconds about (x, y, z), drawing `rain` of the drops. */
  update(dt: number, x: number, y: number, z: number, rain: number): void {
    this.field.update(dt, x, y, z, WIND_X, WIND_Z);
    const segments = this.field.segments;
    segments.count = Math.floor(segments.count * Math.min(1, Math.max(0, rain)));
  }

  private readonly colour: Vec3 = [COLOR[0], COLOR[1], COLOR[2]];

  draw(camera: Camera, env: Environment): void {
    if (this.field.segments.count === 0) return;
    const keep = 1 - (1 - NIGHT_KEEPS) * env.nightFactor;
    for (let c = 0; c < 3; c++) this.colour[c] = (COLOR[c] as number) * keep;
    this.renderer.drawLines(
      this.lines,
      this.field.segments,
      IDENTITY,
      camera,
      env,
      this.colour,
      WIDTH_M,
      0.7,
      0.4,
    );
  }
}
