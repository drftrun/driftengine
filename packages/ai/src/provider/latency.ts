/**
 * A p90 that revises as it measures, and says so before it knows.
 *
 * The continuation watermark issues the next request when the current intent's
 * remaining extent falls to this number. Measuring it rather than configuring it is
 * what removes the tuning constant that would be wrong on every device, and wrong
 * again the moment a consumer switched providers.
 *
 * **p90 rather than p50 or p99.** At p50 half the continuations land late and the
 * agent visibly drops to its floor mid-behaviour. At p99 the lead is long enough that
 * the context goes stale for the tail. *What would make this wrong:* a provider whose
 * latency is bimodal — a cache hit at 40ms and a miss at 3s — has a p90 that describes
 * neither, and the answer there is a per-request estimate from the request's own
 * shape, not a different percentile.
 */
export class LatencyEstimator {
  private readonly window: Float64Array;
  private readonly scratch: Float64Array;
  private readonly minSamples: number;

  private cursor = 0;
  private filled = 0;

  constructor(capacity = 64, minSamples = 8) {
    const slots = Math.max(1, capacity | 0);
    this.window = new Float64Array(slots);
    /* Sorted into a buffer owned once rather than allocated per read. The watermark
       asks for this on the tick an intent starts, which is a per-intent path. */
    this.scratch = new Float64Array(slots);
    this.minSamples = Math.max(1, minSamples | 0);
  }

  get samples(): number {
    return this.filled;
  }

  /** `-1` until `minSamples` are in, which the watermark reads as "issue immediately". */
  get p90(): number {
    if (this.filled < this.minSamples) return -1;

    for (let i = 0; i < this.filled; i++) {
      const value = this.window[i];
      this.scratch[i] = value === undefined ? 0 : value;
    }
    const view = this.scratch.subarray(0, this.filled);
    view.sort();

    const index = Math.min(this.filled - 1, Math.ceil(this.filled * 0.9) - 1);
    return view[Math.max(0, index)] ?? -1;
  }

  record(ms: number): void {
    this.window[this.cursor] = ms;
    this.cursor = (this.cursor + 1) % this.window.length;
    if (this.filled < this.window.length) this.filled++;
  }
}
