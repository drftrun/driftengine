/**
 * How long the GPU actually spent, in three parts.
 *
 * Wall clock cannot answer this. It is vsync-capped long before a GPU is saturated, so
 * every configuration from Low to 4K High reads the same on a clock while the GPU times
 * behind them span 13.5x. That gap is the difference between a machine with headroom and
 * one running the game at 3 fps.
 *
 * **The frame is partitioned, not nested.** `TIME_ELAPSED_EXT` cannot nest, so there is
 * no whole-frame query wrapped around two inner ones — three sequential brackets sum to
 * the frame instead, and `rest` earns its slot by being the number that says *this one
 * is not shadows*.
 *
 * Sampled one frame in eight. Seven samples a second is ample for a distribution, and it
 * removes any argument about query overhead on drivers nobody here owns.
 */
import type { FrameTimer } from './backend/timer.ts';

export const GPU_SLOTS = ['shadows', 'reflection', 'rest'] as const;

export type GpuSlot = (typeof GPU_SLOTS)[number];

/** Milliseconds per bracket. */
export interface GpuSample {
  readonly shadows: number;
  readonly reflection: number;
  readonly rest: number;
}

interface TimerExtension {
  readonly TIME_ELAPSED_EXT: number;
  readonly GPU_DISJOINT_EXT: number;
}

/** In flight at once. Past this a frame is skipped rather than allocating. */
const POOL_DEPTH = 4;

const NS_PER_MS = 1e6;

export class GpuTimer implements FrameTimer {
  /** False where the extension is missing or disabled, which is a normal state. */
  readonly available: boolean;

  /** Samples the driver said were untrustworthy. Reported, never silently dropped. */
  disjointDrops = 0;

  /**
   * The last sample `poll` resolved, held so `lastFrameMs` can answer without re-reading.
   *
   * Null until one resolves, and null is the honest answer for a device with no extension:
   * unmeasured is not zero.
   */
  private lastSample: GpuSample | null = null;

  private readonly ext: TimerExtension | null;
  private readonly sampleEvery: number;
  /** Completed triples waiting to be read, oldest first. */
  private readonly inFlight: { queries: WebGLQuery[]; slots: GpuSlot[] }[] = [];
  private current: { queries: WebGLQuery[]; slots: GpuSlot[] } | null = null;
  private open = false;
  private frame = 0;
  private measuring = false;
  /** Whether `beginFrame` said yes for the frame being drawn. */
  get sampling(): boolean {
    return this.measuring;
  }

  constructor(
    private readonly gl: WebGL2RenderingContext,
    sampleEvery = 8,
  ) {
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExtension | null;
    this.available = this.ext !== null;
    this.sampleEvery = Math.max(1, Math.floor(sampleEvery));
  }

  /**
   * Whether this frame is measured. Call once per frame, before any `begin`.
   *
   * `begin` and `end` do nothing on an unmeasured frame, so the skipped frames really
   * are free rather than merely cheap.
   */
  beginFrame(): boolean {
    if (this.ext === null) return false;
    const measured = this.frame % this.sampleEvery === 0;
    this.frame++;
    this.measuring = measured && this.inFlight.length < POOL_DEPTH;
    if (this.measuring) this.current = { queries: [], slots: [] };
    return this.measuring;
  }

  /**
   * Close the frame and queue it for reading.
   *
   * Explicit rather than counting to three, because the shadow pass runs **several
   * times a frame** — static, the depth peel, then dynamic — and the reflection pass
   * may not run at all when water is off. A frame is over when the caller says so,
   * and `poll` sums the brackets per slot, so three shadow passes are one shadow
   * number rather than three partial ones.
   */
  endFrame(): void {
    if (!this.measuring || this.current === null) return;
    if (this.current.queries.length > 0) this.inFlight.push(this.current);
    this.current = null;
    this.measuring = false;
  }

  /**
   * Open a bracket. Never two at once — `TIME_ELAPSED_EXT` cannot nest, and the
   * partition is what guarantees `end` runs before the next `begin`.
   */
  begin(slot: GpuSlot): void {
    if (!this.measuring || this.ext === null || this.open) return;
    const query = this.gl.createQuery();
    if (query === null) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query);
    this.current?.queries.push(query);
    this.current?.slots.push(slot);
    this.open = true;
  }

  end(): void {
    if (!this.measuring || this.ext === null || !this.open) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.open = false;
  }

  /**
   * The oldest finished sample, or null. Never blocks and never waits for a result:
   * a diagnostic that stalls the pipeline to measure it is measuring itself.
   */
  poll(): GpuSample | null {
    if (this.ext === null) return null;
    const oldest = this.inFlight[0];
    if (oldest === undefined) return null;

    for (const query of oldest.queries) {
      const ready = this.gl.getQueryParameter(query, this.gl.QUERY_RESULT_AVAILABLE) as boolean;
      if (!ready) return null;
    }
    this.inFlight.shift();

    const disjoint = this.gl.getParameter(this.ext.GPU_DISJOINT_EXT) as boolean;
    if (disjoint) {
      this.disjointDrops++;
      for (const query of oldest.queries) this.gl.deleteQuery(query);
      return null;
    }

    // Summed per slot, not assigned: the shadow pass runs once per layer, so a frame
    // holds several `shadows` brackets and the answer is their total.
    const parts: Record<GpuSlot, number> = { shadows: 0, reflection: 0, rest: 0 };
    for (let i = 0; i < oldest.queries.length; i++) {
      const query = oldest.queries[i] as WebGLQuery;
      const slot = oldest.slots[i] as GpuSlot;
      parts[slot] += (this.gl.getQueryParameter(query, this.gl.QUERY_RESULT) as number) / NS_PER_MS;
      this.gl.deleteQuery(query);
    }
    this.lastSample = parts;
    return parts;
  }

  /**
   * The whole of the last resolved frame, in milliseconds, or null where nothing measured.
   *
   * The three brackets are summed because they partition the frame rather than overlapping:
   * `shadows` and `reflection` are the passes drawn before the scene, `rest` is everything
   * after. A caller wanting the breakdown reads `poll`, which is what the frame meter does.
   */
  lastFrameMs(): number | null {
    if (this.lastSample === null) return null;
    return this.lastSample.shadows + this.lastSample.reflection + this.lastSample.rest;
  }

  dispose(): void {
    for (const pending of this.inFlight) {
      for (const query of pending.queries) this.gl.deleteQuery(query);
    }
    this.inFlight.length = 0;
    this.current = null;
  }
}
