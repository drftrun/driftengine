import { createLineSegments } from './linePoints.ts';
import type { LineSegments } from './linePoints.ts';
import { coveredAbove } from '../physics/heightSurface.ts';
import { createSurfaceHit } from '../physics/ribbonSurface.ts';
import type { GroundSurface, SurfaceHit } from '../physics/ribbonSurface.ts';

/**
 * Falling rain, as streaks the line batch already draws.
 *
 * **A drop is a segment, not a billboard, and that is the whole design.** The particle pool draws
 * round sprites with a spin, which is right for smoke and grit and wrong for water: rain in a
 * photograph is a *streak*, because the drop moved while the shutter was open, and a round sprite
 * stretched by a shader would need a new attribute and a new branch in both backends' particle
 * programs. A segment from where a drop was to where it is says the same thing with geometry that
 * has shipped for a year — and it gets the angle for free, since the streak runs along the
 * velocity and the velocity is where the wind already is.
 *
 * **What was missing was never the mechanism.** `ParticlePool` and the line batch both ship; what
 * did not exist was anything that made falling water out of either, so a consumer whose weather
 * already wetted surfaces and raised their reflectivity had three of their four acceptance
 * criteria and no water anybody could see fall.
 *
 * **Drops do not fall through roofs**, which is the requirement that usually turns a rain effect
 * into a real one, and the query for it was already here: `GroundSurface.sampleBand` answers "is
 * there a face in this column between these two heights", which is exactly "is something over my
 * head". A drop under cover is not drawn. The same surface's `sample` is the floor it lands on, so
 * rain stops at the ground rather than continuing to the bottom of the slab.
 *
 * **Nothing here reads a clock or a random number.** A drop's place in the slab is a hash of its
 * index and how many times it has fallen, so the same viewer at the same instant sees the same
 * rain — the rule the dust field in `lightVolume.ts` is under, for the same reason.
 */
export interface RainFieldOptions {
  /** How many drops are in the air at once. */
  count: number;
  /** Half-width of the box of rain kept around the viewer, metres. */
  radiusM: number;
  /** How far above the viewer a drop starts, metres. Also the ceiling a roof is looked for under. */
  heightM: number;
  /**
   * Fall speed. Rain reaches about 9 m/s, drizzle is nearer 2, and hail comes down at about 14.
   *
   * The starting value only: `RainField.speedMps` moves it while the field is running, which is
   * what a weather state changing under a player needs.
   */
  speedMps?: number;
  /**
   * How much of a drop's own motion the streak shows, in seconds.
   *
   * It is a shutter time and behaves like one: 0.02 is a crisp dash, 0.1 is the smeared rain of a
   * long exposure. It does not affect where a drop is, only how long it looks.
   */
  streakSec?: number;
  /** The ground drops land on, and the roofs they do not fall through. */
  ground?: GroundSurface;
}

export class RainField {
  readonly segments: LineSegments;

  private readonly x: Float32Array;
  private readonly y: Float32Array;
  private readonly z: Float32Array;
  /** How many times each drop has been respawned, which is the other half of its hash. */
  private readonly cycle: Uint32Array;
  private readonly hit: SurfaceHit = createSurfaceHit();

  private readonly count: number;
  private readonly radiusM: number;
  private readonly heightM: number;
  /*
   * The two numbers a weather state moves, and they are public for a measured reason.
   *
   * **Both were `private readonly` until 2026-08-28**, and the report that ended it named the case
   * a constructor argument cannot serve: weather changes while a game runs. A consumer with a
   * hailstorm on one of its days had a field built at rain's nine metres a second and no way to
   * move it, so hail — which falls at about fourteen — was expressed as a wider, denser rain and
   * read as heavy rain.
   *
   * Plain fields rather than accessors because there is nothing to validate against and nothing to
   * invalidate: no array is sized by either, nothing caches a value derived from one, and both are
   * read fresh inside `update`. A write between updates costs an assignment.
   *
   * **What they give up** is that neither is checked, so a speed of zero hangs the rain in the air
   * and a negative one is *no* rain rather than rain rising — a drop that never reaches the floor
   * is never respawned. Both are visible in one frame, which is why a throw would be the worse
   * trade: this is a per-frame setter, and the engine does not throw in a frame loop. **What would
   * make it wrong** is either number gaining a consequence outside `update`.
   */
  /** Fall speed, metres a second. Rain is about 9, drizzle 2, hail 14. */
  speedMps: number;
  /**
   * The shutter time the streak shows, seconds: 0.02 is a crisp dash, 0.1 a long exposure.
   *
   * It changes how long a drop *looks* and never where it is, so a downpour can smear without
   * falling any faster.
   */
  streakSec: number;
  private readonly ground: GroundSurface | null;
  /** Drops not drawn this update because something was over them. */
  private sheltered = 0;
  /**
   * Whether the first update has spread the drops through the slab.
   *
   * **Without it the first second of rain is a curtain.** A drop respawns near the ceiling, which
   * is right for one that has just landed and wrong for all of them at once: a field built and
   * updated would hold every drop in the top few metres, and what arrives is a single sheet
   * descending rather than rain. So the first update spreads them through the whole height, and
   * every one after that respawns them at the top, where a drop that has just fallen belongs. It
   * cannot be done in the constructor because the slab is placed around a viewer this does not
   * know about until it is asked to draw.
   */
  private primed = false;

  constructor(options: RainFieldOptions) {
    if (!(options.count > 0))
      throw new Error(`RainField: count must be positive, got ${options.count}`);
    if (!(options.radiusM > 0))
      throw new Error(`RainField: radiusM must be positive, got ${options.radiusM}`);
    if (!(options.heightM > 0))
      throw new Error(`RainField: heightM must be positive, got ${options.heightM}`);
    this.count = options.count;
    this.radiusM = options.radiusM;
    this.heightM = options.heightM;
    this.speedMps = options.speedMps ?? 9;
    this.streakSec = options.streakSec ?? 0.04;
    this.ground = options.ground ?? null;
    this.segments = createLineSegments(options.count);
    this.x = new Float32Array(options.count);
    this.y = new Float32Array(options.count);
    this.z = new Float32Array(options.count);
    this.cycle = new Uint32Array(options.count);
    for (let i = 0; i < options.count; i++) this.cycle[i] = i;
  }

  /** Drops that were over the viewer's head and under something else, last update. */
  get shelteredCount(): number {
    return this.sheltered;
  }

  /**
   * Fall for `dt`, then rebuild the streaks around a viewer.
   *
   * `windX` and `windZ` are metres per second sideways, and the same numbers the rest of the scene
   * is answering to: rain leaning one way while the smoke beside it leans another is the failure
   * this parameter exists to prevent, and it is why the wind is passed in rather than owned here.
   */
  update(
    dt: number,
    viewerX: number,
    viewerY: number,
    viewerZ: number,
    windX = 0,
    windZ = 0,
  ): void {
    const span = this.radiusM * 2;
    const top = viewerY + this.heightM;
    this.segments.count = 0;
    this.sheltered = 0;

    for (let i = 0; i < this.count; i++) {
      let dropY = (this.y[i] ?? 0) - this.speedMps * dt;
      let dropX = (this.x[i] ?? 0) + windX * dt;
      let dropZ = (this.z[i] ?? 0) + windZ * dt;

      /*
       * A drop that has left the slab comes back at the top in a new column, and a drop that never
       * had a position starts the same way — which is what makes construction free of a spawn loop.
       * The floor is the surface where there is one, so rain stops at the ground rather than
       * falling to the bottom of a box nobody can see.
       */
      let floor = viewerY - this.heightM;
      if (this.ground !== null && this.ground.sample(dropX, dropZ, this.hit, dropY)) {
        floor = this.hit.y;
      }
      const outside =
        dropY <= floor ||
        Math.abs(dropX - viewerX) > this.radiusM ||
        Math.abs(dropZ - viewerZ) > this.radiusM;
      if (outside || !this.primed) {
        this.cycle[i] = ((this.cycle[i] ?? 0) + this.count) >>> 0;
        const c = this.cycle[i] ?? 0;
        dropX = viewerX - this.radiusM + hash(i, c) * span;
        dropZ = viewerZ - this.radiusM + hash(i, c + 1) * span;
        /*
         * On the first update, anywhere between the floor and the ceiling: rain that is already
         * falling when you look up. Afterwards, near the ceiling but not exactly at it, so drops
         * that wrapped on the same frame do not descend in step.
         */
        dropY = this.primed
          ? top - hash(i, c + 2) * this.speedMps * 0.5
          : floor + hash(i, c + 2) * (top - floor);
      }

      this.x[i] = dropX;
      this.y[i] = dropY;
      this.z[i] = dropZ;

      /*
       * Under cover: anything solid in this column between the drop and the ceiling is a roof, and
       * a drop below a roof was never rained on. It keeps falling — it is simply not drawn, which
       * costs one query and means a viewer stepping into a doorway sees the rain stop over them
       * rather than through them.
       *
       * **A hole in the roof rains, and nothing here arranges that.** `coveredAbove` asks whether
       * the surface has a face in the column, so a gap between two pads, a stretch of `holes` in a
       * ribbon, or the edge of a bounded field are all open sky already — cut once, in the
       * geometry, rather than described a second time here where the two could disagree.
       */
      if (this.ground !== null && coveredAbove(this.ground, dropX, dropZ, dropY, top, this.hit)) {
        this.sheltered++;
        continue;
      }

      const at = this.segments.count;
      this.segments.from[at * 3] = dropX;
      this.segments.from[at * 3 + 1] = dropY;
      this.segments.from[at * 3 + 2] = dropZ;
      /* Where it was a shutter-time ago, which is the streak: down by its fall and back along the
         wind, so a gust leans every drop at the same angle without anything trigonometric. */
      this.segments.to[at * 3] = dropX - windX * this.streakSec;
      this.segments.to[at * 3 + 1] = dropY + this.speedMps * this.streakSec;
      this.segments.to[at * 3 + 2] = dropZ - windZ * this.streakSec;
      this.segments.count = at + 1;
    }
    this.primed = true;
  }
}

/**
 * A number in [0, 1) from two integers, with no state and no clock.
 *
 * The same construction the particle pool hashes a spin with. It is not a good generator and does
 * not need to be: what it has to avoid is neighbouring drops sharing a column, and a sine hash
 * decorrelates adjacent integers well enough that a thousand of them look like rain.
 */
function hash(a: number, b: number): number {
  const value = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
  return value - Math.floor(value);
}
