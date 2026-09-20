/**
 * The frame's declared distance fields — what the renderer's indirect light may be traced against.
 *
 * **A consumer declares this, and the seam is `addOccluder`'s for `addOccluder`'s reason.** A
 * distance field is the shape of a thing it is *safe* to be traced against, and only the consumer
 * knows which of its objects that is true of: the terrain and the walls, not the leaves, not the
 * water, not the thing that is about to be deleted. `quality.occlusionCulling` already makes that
 * sentence about occluders and culls nothing until somebody declares one. This makes it about
 * light, and lights nothing until somebody declares a field.
 *
 * **A field and its placement are separate arguments on purpose.** Forty identical pillars are one
 * baked field and forty matrices: the samples are megabytes and the matrices are bytes. So a source
 * declared twice in a frame is two instances sharing one packed copy of its samples, and the queue
 * is what knows the difference.
 *
 * **The transform is copied and the samples are not.** A consumer holds a matrix and moves it —
 * that is what a matrix is for — so a queue that kept the reference would replay every field
 * wearing the last pose written, which is `DecalQueue`'s recorded mistake and is the dangerous
 * kind: a plausible picture rather than a broken one. A `FieldSource`, by contrast, is baked and
 * does not move, and copying its samples once a frame would move the whole field across the bus to
 * say the same thing.
 *
 * **Records are pooled and never released**, per `AGENTS.md`: `reset` returns the count to zero
 * and keeps the storage, so a steady scene allocates on its first frame and never again.
 */

import { assertCubicVoxels } from './globalField.ts';

import type { ReadonlyMat4 } from 'gl-matrix';
import type { FieldSource } from './globalField.ts';

/**
 * How many placed fields one frame may declare.
 *
 * **Thirty-two, which is what `composeGlobalField` was measured against** — 707 ms on the CPU for
 * thirty-two instances over four cascades, and the number the device composition has carried since.
 * The cost is not in the count itself but in the instance buffer being sized once and bound for
 * every cascade's dispatch, so it is a cap rather than a growth.
 */
export const MAX_DISTANCE_FIELDS = 32;

/**
 * How many samples the frame's distinct sources may add up to, across all of them.
 *
 * Four million floats is sixteen megabytes on the device, which is a 160-cubed field or two
 * hundred 27-cubed ones. **The budget is over the distinct sources rather than the instances**,
 * because that is what is actually uploaded.
 */
export const MAX_DISTANCE_FIELD_SAMPLES = 1 << 22;

/** One placed field. `transform` is this queue's own copy; `source` is the consumer's object. */
export interface DistanceFieldInstance {
  /** The baked field. Shared by reference: it does not move and it is the large thing. */
  source: FieldSource;
  /** World from object, copied at the moment it was declared. Uniform scale only. */
  readonly transform: Float32Array;
  /**
   * What colour this placement's surface is, copied like the transform. White where none was given.
   *
   * **A ray that lands on a wall needs to know what colour it is**, because what leaves a surface
   * is the light arriving times its albedo — and a composed distance field is a union that has
   * already forgotten which instance won. `demo/dev/bounce.html` is what made it necessary: a
   * trace without it returned the same answer for a red wall and a white one.
   *
   * On the placement rather than the field, because the same baked shape is placed many times and
   * two pillars cut from one mould may be painted differently.
   */
  readonly albedo: Float32Array;
}

function newRecord(): DistanceFieldInstance {
  return {
    source: EMPTY_SOURCE,
    transform: new Float32Array(16),
    albedo: Float32Array.from([1, 1, 1]),
  };
}

/** A placeholder a pooled record holds before its first use, so `source` is never null. */
const EMPTY_SOURCE: FieldSource = {
  field: new Float32Array(0),
  dims: [0, 0, 0],
  bounds: new Float32Array(6),
};

export class DistanceFieldScene {
  private readonly pool: DistanceFieldInstance[] = [];
  private count = 0;

  /** The distinct sources of this frame, in the order they were first declared. */
  private readonly distinct: FieldSource[] = [];
  /** Where each distinct source's samples start in the packed upload, in floats. */
  private readonly offsets = new Map<FieldSource, number>();
  private samples = 0;

  /** The distinct sources of the frame that `reset` last ended, for `packingChanged`. */
  private packed: FieldSource[] = [];

  /** Set once when a budget is first reached, so a scene over it says so and then draws. */
  private warnedInstances = false;
  private warnedSamples = false;

  /** How many placed fields this frame has recorded. */
  get length(): number {
    return this.count;
  }

  /** How many records are pooled, which a test uses to assert a steady scene stops allocating. */
  get capacity(): number {
    return this.pool.length;
  }

  /** This frame's distinct sources, in the order their samples are packed. */
  get sources(): readonly FieldSource[] {
    return this.distinct;
  }

  /** Floats the packed upload holds — the sum of the distinct sources' fields. */
  get sampleCount(): number {
    return this.samples;
  }

  /**
   * Whether the samples have to be uploaded again, or the placements alone will do.
   *
   * True when this frame's distinct sources are not the last frame's in the same order, since the
   * offsets are positional. A scene whose fields never change answers false from its second frame
   * on, which is what keeps a sixteen-megabyte upload out of the frame loop.
   */
  get packingChanged(): boolean {
    if (this.distinct.length !== this.packed.length) return true;
    for (let i = 0; i < this.distinct.length; i += 1) {
      if (this.distinct[i] !== this.packed[i]) return true;
    }
    return false;
  }

  /** Where a source's samples start in the packed upload, or -1 if it is not in this frame. */
  offsetOf(source: FieldSource): number {
    return this.offsets.get(source) ?? -1;
  }

  /**
   * Declare a field, placed.
   *
   * **A source whose samples do not fit is refused whole rather than clipped.** Half a field on the
   * device is not a coarser field; it is a field whose far half reads whatever the buffer held, and
   * that composes as surfaces that are not there — the failure Wave 4A already paid for once, where
   * a phantom surface passed 111,907 parity samples and was found by looking at a picture.
   */
  record(source: FieldSource, model: ReadonlyMat4, albedo?: ArrayLike<number>): void {
    /*
     * **Before anything else, because a malformed source is not a budget.** The two warnings below
     * are a frame asking for more than it can carry and dropping the surplus is the honest answer;
     * there is none to a source the composer cannot read. The renderer composes on the device and
     * never reaches `composeGlobalField`, so its own check protects only the reference path.
     */
    assertCubicVoxels(source);
    if (this.count >= MAX_DISTANCE_FIELDS) {
      if (!this.warnedInstances) {
        this.warnedInstances = true;
        console.warn(
          `driftengine: more than ${MAX_DISTANCE_FIELDS} distance fields were declared in one ` +
            'frame, so the rest are not traced against. Fields that never move are cheaper baked ' +
            'into one source, which is composed as a single instance.',
        );
      }
      return;
    }

    const known = this.offsets.get(source);
    if (known === undefined) {
      if (this.samples + source.field.length > MAX_DISTANCE_FIELD_SAMPLES) {
        if (!this.warnedSamples) {
          this.warnedSamples = true;
          console.warn(
            `driftengine: the frame's distance fields exceed ${MAX_DISTANCE_FIELD_SAMPLES} ` +
              'samples, so this one is not traced against at all. A field composed in part reads ' +
              'whatever the buffer held beyond it, which is surfaces that are not there.',
          );
        }
        return;
      }
      this.offsets.set(source, this.samples);
      this.distinct.push(source);
      this.samples += source.field.length;
    }

    let record = this.pool[this.count];
    if (record === undefined) {
      record = newRecord();
      this.pool.push(record);
    }
    record.source = source;
    for (let at = 0; at < 16; at += 1) record.transform[at] = model[at] ?? 0;
    /* Copied like the transform, and white where none was declared. */
    for (let at = 0; at < 3; at += 1) record.albedo[at] = (albedo?.[at] as number | undefined) ?? 1;
    this.count += 1;
  }

  replay(each: (instance: DistanceFieldInstance) => void): void {
    for (let i = 0; i < this.count; i += 1) {
      const record = this.pool[i];
      if (record !== undefined) each(record);
    }
  }

  /** Empty it for the next frame, keeping the storage and remembering what was packed. */
  reset(): void {
    this.packed = this.distinct.slice();
    this.count = 0;
    this.distinct.length = 0;
    this.offsets.clear();
    this.samples = 0;
  }
}

/**
 * The world extent of everything a frame declared, into vectors the caller owns.
 *
 * **This is what a probe grid is fitted to when a scene declared none.** A renderer asked for
 * indirect light has to put its probes somewhere, and the only description of the world it holds is
 * the set of fields a consumer said its light may be traced against. That is also the *right*
 * description: a grid sized to include everything drawn would spend its probes on the inside of the
 * sky sphere, while a grid sized to the traceable geometry is a grid around the room.
 *
 * **Every corner is transformed, not the box.** A rotated box's axis-aligned extent is decided by
 * where its corners went; transforming the two extremes and taking their min and max gives a box
 * that is too small wherever a rotation is not a multiple of a quarter turn, and too small is a
 * probe grid that stops short of the wall it is meant to surround.
 *
 * False when the frame declared nothing, rather than an empty box at the origin — which
 * `fitProbeGrid` would answer with a plausible grid of one standing in a place no scene chose.
 */
export function distanceFieldBounds(
  scene: DistanceFieldScene,
  min: Float32Array,
  max: Float32Array,
): boolean {
  if (scene.length === 0) return false;
  for (let axis = 0; axis < 3; axis += 1) {
    min[axis] = Infinity;
    max[axis] = -Infinity;
  }
  scene.replay((instance) => {
    const box = instance.source.bounds;
    const m = instance.transform;
    for (let corner = 0; corner < 8; corner += 1) {
      const x = box[(corner & 1) === 0 ? 0 : 3] as number;
      const y = box[(corner & 2) === 0 ? 1 : 4] as number;
      const z = box[(corner & 4) === 0 ? 2 : 5] as number;
      for (let axis = 0; axis < 3; axis += 1) {
        const value =
          (m[axis] as number) * x +
          (m[4 + axis] as number) * y +
          (m[8 + axis] as number) * z +
          (m[12 + axis] as number);
        if (value < (min[axis] as number)) min[axis] = value;
        if (value > (max[axis] as number)) max[axis] = value;
      }
    }
  });
  return true;
}
