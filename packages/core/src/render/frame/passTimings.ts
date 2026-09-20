/**
 * Where a frame's milliseconds went, one row per graph pass.
 *
 * **Not a widening of `gpuTimer.ts`, and that is deliberate.** That class is a WebGL2 query pool
 * over `TIME_ELAPSED_EXT`, partitioning a frame into three fixed brackets — shadows, reflection,
 * rest — and it is right for what it measures. A graph pass is not one of three brackets: there
 * are as many as the frame composes, they are named at record time, and on WebGPU the sample
 * comes from a timestamp query rather than an elapsed-time extension. Two different measurements
 * with two different shapes; widening one into the other would leave a class that does neither
 * well.
 *
 * **What it does inherit from that class is its best rule: unmeasured is not zero.** A device
 * without timestamp queries, or a pass that ran no work, must not read as "took no time" — a
 * profiler that cannot distinguish those two is a profiler that sends somebody optimising a pass
 * that never ran. `passMs` returns null for unmeasured and a number for measured, including zero.
 *
 * **Labels persist and timings reset.** A pass that did nothing this frame keeps its name and
 * reports unmeasured, so the profiler's rows stop jumping about as quality settings toggle
 * passes on and off — which is exactly when somebody is reading it.
 */
export interface PassTimings {
  /** Accumulated milliseconds per pass for the current frame. */
  ms: Float64Array;
  /** Whether each pass received a sample this frame. */
  measured: Uint8Array;
  /** Name per pass, kept across frames. */
  labels: string[];
}

export function createPassTimings(capacity: number): PassTimings {
  return {
    ms: new Float64Array(capacity),
    measured: new Uint8Array(capacity),
    labels: Array.from({ length: capacity }, () => ''),
  };
}

/** Start a frame: timings go, labels stay. See the header for why they are treated differently. */
export function resetPassTimings(timings: PassTimings): void {
  timings.ms.fill(0);
  timings.measured.fill(0);
}

/**
 * Add one sample to a pass.
 *
 * Accumulates rather than replaces, because a pass may be sampled more than once in a frame — a
 * shadow pass runs per cascade — and the row a reader wants is what that pass cost altogether.
 */
export function recordPassSample(timings: PassTimings, pass: number, ms: number): void {
  if (pass < 0 || pass >= timings.ms.length) return;
  timings.ms[pass] = (timings.ms[pass] ?? 0) + ms;
  timings.measured[pass] = 1;
}

export function recordPassLabel(timings: PassTimings, pass: number, label: string): void {
  if (pass < 0 || pass >= timings.labels.length) return;
  timings.labels[pass] = label;
}

/** Milliseconds this pass cost, or null where nothing measured it. Null is not zero. */
export function passMs(timings: PassTimings, pass: number): number | null {
  if (pass < 0 || pass >= timings.ms.length) return null;
  return timings.measured[pass] === 1 ? (timings.ms[pass] ?? 0) : null;
}

export function passLabel(timings: PassTimings, pass: number): string {
  return timings.labels[pass] ?? '';
}
