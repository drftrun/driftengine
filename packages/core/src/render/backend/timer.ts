import type { GpuSample, GpuSlot } from '../gpuTimer.ts';

/**
 * What a frame timer has to answer, with no backend in the question.
 *
 * `GpuTimer` is built on `WebGLQuery` and the `EXT_disjoint_timer_query_webgl2` extension,
 * which most mobile browsers do not have. WebGPU answers the same question through timestamp
 * queries, with a different shape and a different availability story again. So the shared
 * surface takes the *question* rather than either answer.
 *
 * **`null` from `lastFrameMs` means unmeasured, not free.** Reporting a confident 0.0 is the
 * worst number available to invent: a frame meter that reads zero where it cannot measure
 * makes the GPU look idle exactly when somebody is trying to find out why it is not, which
 * is the failure that cost thirteen milliseconds a frame for six weeks (`AGENTS.md`,
 * 2026-08-07). An honest absence is what lets a reader distinguish "fast" from "unknown".
 */
export interface FrameTimer {
  /** Whether this timer can measure at all on the device in front of it. */
  readonly available: boolean;

  /** Whether the frame being drawn is one of the sampled ones. */
  readonly sampling: boolean;

  /**
   * Whether this frame is measured. Called once per frame, before any `begin`.
   *
   * **The brackets are on this interface rather than under it, because their names are the
   * engine's own passes and not WebGL's.** `shadows`, `reflection` and `rest` describe what
   * this renderer draws, so a second backend measuring the same frame owes the same three
   * numbers; what differs between the APIs is only how the measurement is taken.
   */
  beginFrame(): boolean;

  /** Close the frame and queue it for reading. */
  endFrame(): void;

  /** Open a bracket. Never two at once. */
  begin(slot: GpuSlot): void;

  /** Close the open bracket. */
  end(): void;

  /**
   * The oldest finished sample, or null. **Never blocks**: a diagnostic that stalls the
   * pipeline in order to measure it is measuring itself.
   */
  poll(): GpuSample | null;

  /**
   * Milliseconds the GPU spent on the most recently *resolved* frame, or null.
   *
   * Resolved rather than current: results arrive some frames after the work, because reading
   * them back any sooner would stall the pipeline the timer exists to observe.
   */
  lastFrameMs(): number | null;

  /** Release whatever the timer holds. */
  dispose(): void;
}
