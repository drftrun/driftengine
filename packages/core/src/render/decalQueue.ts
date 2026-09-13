import type { DecalProjector } from './decalProjector.ts';

/**
 * The frame's drawn decals, held until the pass that reads the depth buffer can run.
 *
 * **The pass cannot run where the call is made.** A projected decal is decided from the depth the
 * frame has drawn, so it has to happen once the opaque world is finished — and a consumer submits
 * a mark wherever in its own frame the thing that made the mark lives. So `drawDecal` records and
 * the renderer replays, exactly as `TranslucentQueue` does for the order-independent passes.
 *
 * **Everything is copied, and that is the whole correctness of this file.** A projector is an
 * object a consumer keeps and moves: it is submitted, then moved to follow whatever it is stuck
 * to, and submitted again next frame. A queue holding the reference would replay every mark
 * wearing the last pose written — one wheel's skid under every wheel — which is a plausible
 * picture rather than an obviously broken one, and that is the kind that gets blamed on the pass.
 *
 * **Records are pooled and never released**, for the reason `AGENTS.md` gives: `reset` returns the
 * count to zero and keeps the storage, so a steady scene allocates on its first frame and never
 * again.
 */

/**
 * How many marks one frame may draw.
 *
 * **A cap rather than an open number**, because each is a scissored pass of its own with a uniform
 * slot behind it, and the slots are one buffer written before the passes are recorded. Thirty-two
 * is more than a scene has needed: a mark is a projector kept alive per frame, and a world with
 * more than thirty-two of them in view at once wants `projectDecal`, which costs nothing per frame
 * and is what the static half of this row is for.
 */
export const MAX_DRAWN_DECALS = 32;

/** One recorded mark. Every field is a copy of what the projector held when it was submitted. */
export interface DrawnDecal {
  readonly worldToDecal: Float32Array;
  readonly decalToWorld: Float32Array;
  readonly axis: Float32Array;
  readonly color: Float32Array;
  opacity: number;
  facingCos: number;
  softness: number;
}

function newRecord(): DrawnDecal {
  return {
    worldToDecal: new Float32Array(16),
    decalToWorld: new Float32Array(16),
    axis: new Float32Array(3),
    color: new Float32Array(3),
    opacity: 1,
    facingCos: 0.1,
    softness: 0.25,
  };
}

export class DecalQueue {
  private readonly pool: DrawnDecal[] = [];
  private count = 0;
  /** Set once when the cap is first reached, so a scene over it says so and then draws. */
  private warned = false;

  /** How many marks this frame has recorded. */
  get length(): number {
    return this.count;
  }

  /** How many records are pooled, which a test uses to assert a steady scene stops allocating. */
  get capacity(): number {
    return this.pool.length;
  }

  record(projector: DecalProjector): void {
    if (this.count >= MAX_DRAWN_DECALS) {
      if (!this.warned) {
        this.warned = true;
        console.warn(
          `driftengine: more than ${MAX_DRAWN_DECALS} drawn decals in one frame, so the rest are ` +
            'dropped. A mark that never moves is cheaper as projectDecal, which builds it once.',
        );
      }
      return;
    }

    let record = this.pool[this.count];
    if (record === undefined) {
      record = newRecord();
      this.pool.push(record);
    }
    record.worldToDecal.set(projector.worldToDecal);
    record.decalToWorld.set(projector.decalToWorld);
    record.axis.set(projector.axis);
    record.color.set(projector.color);
    record.opacity = Math.min(1, Math.max(0, projector.opacity));
    record.facingCos = projector.facingCos;
    record.softness = Math.min(1, Math.max(0, projector.softness));
    this.count++;
  }

  replay(each: (decal: DrawnDecal) => void): void {
    for (let i = 0; i < this.count; i++) {
      const record = this.pool[i];
      if (record !== undefined) each(record);
    }
  }

  /** Empty it for the next frame, keeping the storage. */
  reset(): void {
    this.count = 0;
  }
}
