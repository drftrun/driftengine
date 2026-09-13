import type { ReadonlyMat4 } from 'gl-matrix';

/* Type-only, and from the backend that declares it — the same import `backend/api.ts` makes,
   for the same reason: the shape belongs to the draw verb and erases at compile time. */
import type { TranslucentMeshOptions } from './backend/webgl2/renderer.ts';

/**
 * The frame's translucent draws, held so they can be submitted more than once.
 *
 * **Order-independent transparency needs the same geometry in two passes** — one accumulating
 * weighted colour, one multiplying revealage — and they are two blend states, which a single pass
 * cannot hold without a second fragment output. Writing both from one pass would mean another
 * `flatFrag` permutation, measured at about 247 KB gzipped and paid by every consumer whether or
 * not they enable the effect. So the geometry is submitted twice instead, and this is what makes
 * that possible in a renderer that otherwise draws immediately.
 *
 * **Everything a draw carries is copied, and that is the whole correctness of this file.** Callers
 * build their model matrix into a scratch they reuse — `rings.ts` submits the same `Float32Array` a
 * thousand times with different contents — so a queue holding the reference would replay every
 * draw wearing the last transform. That is a plausible picture rather than an obviously broken
 * one, which is the kind that gets blamed on the blending.
 *
 * **Records are pooled and never released.** A translucent set is submitted every frame and
 * `AGENTS.md` forbids allocating in the frame loop, so `reset` returns the count to zero and keeps
 * the storage: a steady scene allocates on its first frame and never again.
 */

/** One recorded draw. The fields are the arguments `drawTranslucentMesh` was called with. */
export interface TranslucentDraw {
  /** The mesh handle, held by reference — the caller does not rebuild one per frame. */
  mesh: unknown;
  /** A copy, for the reason this file exists. */
  readonly model: Float32Array;
  opacity: number;
  lit: boolean;
  fog: boolean;
  toneMapped: boolean;
  depthWrite: boolean;
  depthLayer: number;
  /** Null where the draw asked for no tint; otherwise a copy, like the matrix. */
  tint: Float32Array | null;
  /**
   * How far this draw bends what is behind it, 0 for not at all.
   *
   * **Carried rather than dropped, and that is what this field is for.** Order-independent
   * transparency replays this set twice; a queue that forgot these would give a pane that refracts
   * under sorted blending and stands clear under OIT, which reads as a bug in the transparency
   * mode rather than as a queue that lost a field.
   */
  refraction: number;
  /** What survives one metre of the medium. Null where the draw named none; otherwise a copy. */
  refractTint: Float32Array | null;
  thicknessM: number;
}

/** A record with its storage, reused across frames. */
interface PooledDraw extends TranslucentDraw {
  /** Allocated once and pointed at by `tint` when a draw has one. */
  readonly tintStore: Float32Array;
  /** The same arrangement for the refraction tint: allocated once, never released. */
  readonly refractTintStore: Float32Array;
}

function newRecord(): PooledDraw {
  return {
    mesh: null,
    model: new Float32Array(16),
    opacity: 1,
    lit: true,
    fog: true,
    toneMapped: true,
    depthWrite: true,
    depthLayer: 0,
    tint: null,
    tintStore: new Float32Array(3),
    refraction: 0,
    refractTint: null,
    thicknessM: 0,
    refractTintStore: new Float32Array(3),
  };
}

export class TranslucentQueue {
  private readonly pool: PooledDraw[] = [];
  private count = 0;

  /** How many draws this frame has recorded. */
  get length(): number {
    return this.count;
  }

  /** How many records are pooled, which a test uses to assert a steady scene stops allocating. */
  get capacity(): number {
    return this.pool.length;
  }

  /**
   * Take a copy of one draw.
   *
   * The defaults match `drawTranslucentMesh`'s own, so a queued draw and an immediate one are the
   * same draw — a divergence here would be a scene that changes when the effect is switched on for
   * reasons that have nothing to do with transparency.
   */
  record(
    mesh: unknown,
    model: ReadonlyMat4,
    opacity: number,
    options: TranslucentMeshOptions,
  ): void {
    let record = this.pool[this.count];
    if (record === undefined) {
      record = newRecord();
      this.pool.push(record);
    }
    record.mesh = mesh;
    record.model.set(model as ArrayLike<number>);
    record.opacity = Math.min(opacity, 1);
    record.lit = options.lit ?? true;
    record.fog = options.fog ?? true;
    record.toneMapped = options.toneMapped ?? true;
    record.depthWrite = options.depthWrite ?? true;
    record.depthLayer = options.depthLayer ?? 0;
    const tint = options.tint ?? null;
    if (tint === null) {
      record.tint = null;
    } else {
      record.tintStore.set(tint);
      record.tint = record.tintStore;
    }
    record.refraction = options.refraction ?? 0;
    record.thicknessM = options.thicknessM ?? 0;
    const refractTint = options.refractTint ?? null;
    if (refractTint === null) {
      record.refractTint = null;
    } else {
      record.refractTintStore.set(refractTint);
      record.refractTint = record.refractTintStore;
    }
    this.count++;
  }

  /**
   * Walk what was recorded, in the order it arrived.
   *
   * **Walkable more than once**, which is the reason this exists: the accumulation and the
   * revealage are two passes over the same set, and a queue that could only be drained once would
   * give the second a different set from the first. Order is preserved for determinism rather than
   * for correctness — the whole point of the effect is that the result does not depend on it.
   */
  replay(each: (draw: TranslucentDraw) => void): void {
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
