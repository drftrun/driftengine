/**
 * Which level of detail each region of a world is drawn at, and the crossfade between two.
 *
 * **A region is a box and one geometric error per level**, finest first: how far, in metres, that
 * level's surface may stand from the real one. A level is good enough once its error projects under
 * `pixelTolerance` pixels, so the distance it takes over at is `error · projectionScale / tolerance`
 * — the rule 3D Tiles uses, and the reason the file carries errors rather than distances: a
 * distance is a decision about one screen, and an error is a fact about the geometry.
 *
 * **A band around every switch, so a still eye can never flip.** A region coarsens only once the
 * eye is `1 + hysteresis` past the level's distance and refines only once it is `1 − hysteresis`
 * inside it, so an eye standing on a threshold — or wobbling across it by less than the band —
 * keeps the level it has. Distance is to the region's **box**, so the region under the eye is
 * always at its finest, whatever its size.
 *
 * **A change crossfades rather than pops.** Each draw carries a dither for `setDitherFade`: the
 * level arriving at `+t`, the one leaving at `−t`, which cover every pixel exactly once. `t` runs
 * over `fadeSec` of the caller's `dtSec`, never a clock — so **a held clock never finishes a fade**,
 * and a capture wants `fadeSec: 0`. A region nobody can see finishes any fade at once, and a region
 * just added fades in from nothing.
 *
 * What it gives up: a region is one decision, so a long one seen end-on is drawn at the level its
 * nearest corner asks for all the way along. Smaller regions are the lever.
 *
 * Nothing here allocates after construction except `add`, which is not per frame.
 */
import type { FrustumPlanes } from '../math/frustum.ts';
import { batchBoxVisible } from '../render/instanceCull.ts';
import type { BoxOccluder } from '../render/instanceCull.ts';

/** The level of a region drawn at none of its own: past `farDistance`, or not arrived yet. */
export const HLOD_NONE = 255;

export interface HlodOptions {
  /** The most regions the set holds at once. */
  readonly capacity: number;
  /** The most levels a region may carry. 4 unless stated. */
  readonly maxLevels?: number;
  /** How many pixels of geometric error a level may show before a finer one is drawn. 1.5 unless stated. */
  readonly pixelTolerance?: number;
  /** The band around each switch, as a fraction of its distance. 0.15 unless stated. */
  readonly hysteresis?: number;
  /** Seconds a crossfade takes. 0.4 unless stated; 0 switches at once. */
  readonly fadeSec?: number;
  /** Beyond this, a region is drawn at no level at all. Unbounded unless stated. */
  readonly farDistance?: number;
}

/** What `select` hands back: one entry per draw, a crossfading region taking two. */
export interface HlodDraws {
  count: number;
  /** The region's id, as it was added. */
  readonly region: Uint32Array;
  /** Which of its levels to draw. */
  readonly level: Uint8Array;
  /** What to pass `setDitherFade` for this draw: 0 whole, `+t` arriving, `−t` leaving. */
  readonly dither: Float32Array;
}

/** Room for every region of a set of this capacity, each crossfading at once. */
export function createHlodDraws(capacity: number): HlodDraws {
  return {
    count: 0,
    region: new Uint32Array(capacity * 2),
    level: new Uint8Array(capacity * 2),
    dither: new Float32Array(capacity * 2),
  };
}

/** Pixels a metre spans at one metre's distance: the screen's half of the switch distance. */
export function projectionScaleOf(fovYDeg: number, heightPx: number): number {
  return heightPx / (2 * Math.tan((fovYDeg * Math.PI) / 360));
}

export class HlodSet {
  readonly capacity: number;
  readonly maxLevels: number;
  private readonly tolerance: number;
  private readonly band: number;
  private readonly fadeSec: number;
  private readonly far: number;
  private readonly slots = new Map<number, number>();
  private readonly ids: Uint32Array;
  private readonly boxes: Float32Array;
  private readonly errors: Float32Array;
  private readonly levels: Uint8Array;
  /** The level each region is at, or arriving at. */
  private readonly level: Uint8Array;
  /** The level a crossfade is leaving. */
  private readonly from: Uint8Array;
  /** How far through its crossfade each region is; 1 is settled. */
  private readonly fade: Float32Array;
  private readonly box = new Float32Array(6);
  private count = 0;

  constructor(options: HlodOptions) {
    this.capacity = options.capacity;
    this.maxLevels = options.maxLevels ?? 4;
    if (this.maxLevels < 1 || this.maxLevels >= HLOD_NONE) {
      throw new Error(`HlodSet: maxLevels must be 1 to ${HLOD_NONE - 1}, not ${this.maxLevels}`);
    }
    this.tolerance = options.pixelTolerance ?? 1.5;
    this.band = options.hysteresis ?? 0.15;
    this.fadeSec = options.fadeSec ?? 0.4;
    this.far = options.farDistance ?? Number.POSITIVE_INFINITY;
    this.ids = new Uint32Array(this.capacity);
    this.boxes = new Float32Array(this.capacity * 6);
    this.errors = new Float32Array(this.capacity * this.maxLevels);
    this.levels = new Uint8Array(this.capacity);
    this.level = new Uint8Array(this.capacity);
    this.from = new Uint8Array(this.capacity);
    this.fade = new Float32Array(this.capacity);
  }

  get size(): number {
    return this.count;
  }

  has(id: number): boolean {
    return this.slots.has(id);
  }

  /** The level a region is at or arriving at, or `HLOD_NONE`. -1 for a region not in the set. */
  levelOf(id: number): number {
    const slot = this.slots.get(id);
    return slot === undefined ? -1 : (this.level[slot] as number);
  }

  /**
   * Add a region: its box as min then max, and one geometric error per level, finest first and
   * never shrinking. It arrives at no level and fades into the one the next `select` picks.
   */
  add(id: number, box: ArrayLike<number>, errors: ArrayLike<number>): void {
    if (this.slots.has(id)) throw new Error(`HlodSet: region ${id} is already in the set`);
    if (this.count >= this.capacity) {
      throw new Error(`HlodSet: the set holds ${this.capacity} regions and is full`);
    }
    if (errors.length < 1 || errors.length > this.maxLevels) {
      throw new Error(
        `HlodSet: region ${id} has ${errors.length} levels; 1 to ${this.maxLevels} are allowed`,
      );
    }
    for (let i = 1; i < errors.length; i++) {
      if ((errors[i] as number) < (errors[i - 1] as number)) {
        throw new Error(`HlodSet: region ${id}'s level ${i} is finer than level ${i - 1}`);
      }
    }
    const slot = this.count++;
    this.slots.set(id, slot);
    this.ids[slot] = id;
    for (let i = 0; i < 6; i++) this.boxes[slot * 6 + i] = box[i] as number;
    for (let i = 0; i < errors.length; i++) {
      this.errors[slot * this.maxLevels + i] = errors[i] as number;
    }
    this.levels[slot] = errors.length;
    this.level[slot] = HLOD_NONE;
    this.from[slot] = HLOD_NONE;
    this.fade[slot] = 1;
  }

  /** Remove a region; nothing if it is not there. The last region takes its slot. */
  remove(id: number): void {
    const slot = this.slots.get(id);
    if (slot === undefined) return;
    this.slots.delete(id);
    const last = --this.count;
    if (slot === last) return;
    const moved = this.ids[last] as number;
    this.slots.set(moved, slot);
    this.ids[slot] = moved;
    this.boxes.copyWithin(slot * 6, last * 6, last * 6 + 6);
    this.errors.copyWithin(
      slot * this.maxLevels,
      last * this.maxLevels,
      (last + 1) * this.maxLevels,
    );
    this.levels[slot] = this.levels[last] as number;
    this.level[slot] = this.level[last] as number;
    this.from[slot] = this.from[last] as number;
    this.fade[slot] = this.fade[last] as number;
  }

  /**
   * Decide every region's level for this view and write what to draw into `out`, returning how
   * many draws that is. `projectionScale` is `projectionScaleOf(fov, height)`; `occluder` may be
   * the renderer, asked after this frame's occluders are declared.
   */
  select(
    eye: ArrayLike<number>,
    projectionScale: number,
    frustum: FrustumPlanes,
    occluder: BoxOccluder | null,
    dtSec: number,
    out: HlodDraws,
  ): number {
    const ex = eye[0] as number;
    const ey = eye[1] as number;
    const ez = eye[2] as number;
    const perError = projectionScale / this.tolerance;
    const step = this.fadeSec > 0 ? dtSec / this.fadeSec : 1;
    let n = 0;
    for (let slot = 0; slot < this.count; slot++) {
      const b = slot * 6;
      const dx = Math.max((this.boxes[b] as number) - ex, 0, ex - (this.boxes[b + 3] as number));
      const dy = Math.max(
        (this.boxes[b + 1] as number) - ey,
        0,
        ey - (this.boxes[b + 4] as number),
      );
      const dz = Math.max(
        (this.boxes[b + 2] as number) - ez,
        0,
        ez - (this.boxes[b + 5] as number),
      );
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const target = this.levelFor(slot, d, perError);
      this.move(slot, target);

      for (let i = 0; i < 6; i++) this.box[i] = this.boxes[b + i] as number;
      if (!batchBoxVisible(this.box, frustum, occluder)) {
        this.fade[slot] = 1;
        continue;
      }
      let t = this.fade[slot] as number;
      if (t < 1) {
        t = Math.min(1, t + step);
        this.fade[slot] = t;
      }
      const level = this.level[slot] as number;
      const id = this.ids[slot] as number;
      if (t >= 1) {
        if (level !== HLOD_NONE) n = this.emit(out, n, id, level, 0);
        continue;
      }
      /* Nothing of the arriving level at t = 0, and a dither of 0 would draw it whole. */
      if (level !== HLOD_NONE && t > 0) n = this.emit(out, n, id, level, t);
      const from = this.from[slot] as number;
      if (from !== HLOD_NONE) n = this.emit(out, n, id, from, -t);
    }
    out.count = n;
    return n;
  }

  /** The level a region at distance `d` should be at, from where it is, through the bands. */
  private levelFor(slot: number, d: number, perError: number): number {
    const count = this.levels[slot] as number;
    const current = this.level[slot] as number;
    /* NONE counts as the level past the coarsest, whose distance is the far limit. */
    let at = current === HLOD_NONE ? count : current;
    while (at < count && d > this.switchAt(slot, at + 1, count, perError) * (1 + this.band)) at++;
    while (at > 0 && d < this.switchAt(slot, at, count, perError) * (1 - this.band)) at--;
    return at === count ? HLOD_NONE : at;
  }

  /** The distance level `index` takes over at; the level past the coarsest is the far limit. */
  private switchAt(slot: number, index: number, count: number, perError: number): number {
    if (index >= count) return this.far;
    return (this.errors[slot * this.maxLevels + index] as number) * perError;
  }

  /** Begin, reverse or redirect a crossfade toward `target`. */
  private move(slot: number, target: number): void {
    const level = this.level[slot] as number;
    if (target === level) return;
    const fade = this.fade[slot] as number;
    if (fade >= 1) {
      this.from[slot] = level;
      this.fade[slot] = 0;
    } else if (target === this.from[slot]) {
      /* Back the way it came, at the share each level already covers rather than from the start.
         The cells swap — the arriving level always takes the low ones — so a reversal changes the
         grain for a frame and never the balance. */
      this.from[slot] = level;
      this.fade[slot] = 1 - fade;
    } else {
      /* A third level: leave from whichever of the two covers more of the region. */
      this.from[slot] = fade < 0.5 ? (this.from[slot] as number) : level;
      this.fade[slot] = 0;
    }
    this.level[slot] = target;
    if (this.fadeSec <= 0) this.fade[slot] = 1;
  }

  private emit(out: HlodDraws, n: number, id: number, level: number, dither: number): number {
    out.region[n] = id;
    out.level[n] = level;
    out.dither[n] = dither;
    return n + 1;
  }
}
