/**
 * Light bouncing into the arcades: a grid of 64 probes over the courtyard, re-baked a few faces
 * a frame as the sun moves.
 *
 * **The raster grid, on both backends.** Each probe renders the lit scene around it, and the grid's
 * irradiance replaces the hemispheric ambient once every probe is filled. So a ground floor at
 * golden hour, with no sun on it, is lit by the sunlit upper walls it can see. That is the one
 * image this courtyard is famous for.
 *
 * **Every bake after the first sweep bounces** (`ProbeBakeOptions.bounce`): what a probe sees is
 * lit by the grid rather than by the open-sky ambient. One bounce left the arcades about two stops
 * under Intel's own renders of this model, because an arcade is lit mostly at the second bounce and
 * later. A held hour sweeps the grid `SWEEPS` times. A running one converges by itself, about one
 * bounce per 64 frames.
 *
 * **8 × 2 × 4, the engine's ceiling of 64, and every probe in the air.** Along the long axis 2.6 m
 * apart from the lion-head wall to the far end, the ground floor and the gallery in the two layers,
 * and across the courtyard at ±1.6 m and in the middle of each arcade at ±4.8 m. Checked against
 * the baked field: every probe stands at least 0.75 m from a surface. The first layout was taken
 * from the census and put twenty of the sixty-four inside the end wall and the columns, where a
 * probe sees the back of the stone, traces black, and darkens everything it is blended into; the
 * courtyard came out as dark as with no bounce at all.
 *
 * **Round-robin a few faces a frame, and each sweep crossfaded into the next.** A moving sun makes
 * every probe stale, and re-baking all 64 at once is 384 scene submissions. A whole probe a frame was
 * six draws of eleven million triangles, 6.4 ms of a 14 ms frame at 1440p; so the grid is baked at
 * `FACES_PER_SEC` faces a second, whatever the frame rate, two a frame at 120 Hz, and a sweep takes
 * 1.6 s. Baked a probe at a time, each jumped to the light of its turn and the jumps crossed the
 * courtyard as a pass of light every second or two; crossfaded (`ProbeGridOptions.crossfade`), the
 * last whole sweep blends into the newest as the next is baked, so the light moves a little every
 * frame, a sweep behind the sun.
 */
import type { Camera, RendererApi, Vec3 } from '../../packages/core/src/index';

const ORIGIN: Vec3 = [-10.3, 1.6, -4.8];
const SPACING: Vec3 = [2.6, 5.8, 3.2];
const COUNTS: Vec3 = [8, 2, 4];
const LAYERS = COUNTS[0] * COUNTS[1] * COUNTS[2];
/**
 * Sweeps for a held hour: one by the ambient, then two bounces, and a fourth because a crossfading
 * grid shows the sweep before its newest until the next has begun, and a held hour bakes no
 * next. Stone at about 0.25 albedo adds a few per cent at the fourth, which the eye does not see.
 */
const SWEEPS = 4;
const BOUNCE = { bounce: true } as const;
/** Faces a second while the sun moves: a sweep of the grid in 1.6 s. */
const FACES_PER_SEC = 240;
const FACES = 6;

export class SponzaBounce {
  private readonly renderer: RendererApi;
  /** Whether the renderer accepted the grid: it refuses without a probe array. */
  readonly enabled: boolean;
  private next = 0;
  /** The next face of probe `next` to draw, and the faces owed since the last frame. */
  private face = 0;
  private owed = 0;
  /** The faces of a partial bake, rewritten in place so a frame allocates nothing. */
  private readonly partial: { bounce: true; faces: [number, number] } = {
    bounce: true,
    faces: [0, FACES],
  };
  private filled = false;
  /** Probes baked toward the first light, of `SWEEPS × LAYERS`. See `warm`. */
  private warmed = 0;

  constructor(renderer: RendererApi, enabled: boolean) {
    this.renderer = renderer;
    this.enabled =
      enabled &&
      renderer.setProbeGrid({ origin: ORIGIN, spacing: SPACING, counts: COUNTS, crossfade: true });
  }

  /** Whether every probe has been baked at least once, so the grid is lighting the frame. */
  get complete(): boolean {
    return this.filled;
  }

  /** How far the first light has come, 0 to 1, for the load screen. */
  get warmth(): number {
    return this.enabled ? this.warmed / (SWEEPS * LAYERS) : 1;
  }

  /**
   * The first light, `probes` at a time: `SWEEPS` sweeps of the grid, spread over frames behind the
   * veil. All at once it was 1,152 scene submissions in one frame, 1.7 s with the load screen held
   * at its last per cent, which reads as a hang however short. A grid the renderer refused has no
   * first light to wait for, and is complete at once.
   */
  warm(clear: Vec3, drawFace: (camera: Camera) => void, probes: number): void {
    const total = SWEEPS * LAYERS;
    for (let n = 0; this.enabled && n < probes && this.warmed < total; n++) {
      this.renderer.bakeProbe(this.warmed % LAYERS, clear, drawFace, BOUNCE);
      this.warmed++;
    }
    if (!this.enabled || this.warmed >= total) {
      this.filled = true;
      this.next = 0;
    }
  }

  /**
   * Whole probes in turn, `probes` of them: a burst after the light jumps. A probe part-drawn by
   * `drift` is started again, since a whole bake draws over the capture its faces are in.
   */
  step(clear: Vec3, drawFace: (camera: Camera) => void, probes: number): void {
    if (!this.enabled) return;
    this.face = 0;
    for (let n = 0; n < probes; n++) {
      this.renderer.bakeProbe(this.next, clear, drawFace, BOUNCE);
      this.advance();
    }
  }

  /**
   * The faces `dtSec` is worth at `rate` of the day's `FACES_PER_SEC`, while the light drifts: a
   * probe's faces over as many frames as the rate spreads them, and the next probe begun only once
   * the last is whole, because the faces share one capture.
   */
  drift(clear: Vec3, drawFace: (camera: Camera) => void, dtSec: number, rate: number): void {
    if (!this.enabled) return;
    this.owed = Math.min(this.owed + dtSec * FACES_PER_SEC * rate, FACES);
    while (this.owed >= 1) {
      const count = Math.min(Math.floor(this.owed), FACES - this.face);
      this.partial.faces[0] = this.face;
      this.partial.faces[1] = count;
      this.renderer.bakeProbe(this.next, clear, drawFace, this.partial);
      this.owed -= count;
      this.face += count;
      if (this.face === FACES) {
        this.face = 0;
        this.advance();
      }
    }
  }

  private advance(): void {
    this.next = (this.next + 1) % LAYERS;
    if (this.next === 0) this.filled = true;
  }
}
