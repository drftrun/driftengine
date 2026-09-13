/** Throttled DOM frame profiler for development builds. */

export interface FpsMeterOptions {
  parent?: HTMLElement;
  id?: string;
  updateIntervalMs?: number;
  sampleWindow?: number;
  frameBudgetMs?: number;
  overBudgetClass?: string;
}

export class FpsMeter {
  private readonly element: HTMLElement;
  private readonly samples: Float32Array;
  private readonly updateIntervalMs: number;
  private readonly frameBudgetMs: number;
  private readonly overBudgetClass: string;
  private index = 0;
  private filled = 0;
  private lastUpdate = 0;
  private lastText = '';
  private lastFps = 0;
  private lastMeanMs = 0;
  private lastWorstMs = 0;

  constructor(options: FpsMeterOptions = {}) {
    const sampleWindow = options.sampleWindow ?? 60;
    if (!Number.isInteger(sampleWindow) || sampleWindow <= 0) {
      throw new Error(`FpsMeter.sampleWindow must be a positive integer, got ${sampleWindow}`);
    }
    this.samples = new Float32Array(sampleWindow);
    this.updateIntervalMs = options.updateIntervalMs ?? 250;
    this.frameBudgetMs = options.frameBudgetMs ?? 16.7;
    this.overBudgetClass = options.overBudgetClass ?? 'over-budget';

    const element = document.createElement('div');
    element.id = options.id ?? 'fps-meter';
    (options.parent ?? document.body).append(element);
    this.element = element;
  }

  /**
   * The rate this meter last computed, for a caller that wants the number as well as the panel.
   *
   * **Reported from outside**, by a consumer that had to keep its own average beside this one to
   * say "the preview is below rate, the export is unaffected". A class that owns an element and
   * refuses to say what it wrote in it makes every caller measure the same thing twice.
   *
   * These are what was last *displayed*, so they move at `updateIntervalMs` rather than per frame,
   * which is the point: a figure that changes sixty times a second is not one a person reads, and
   * a caller comparing against a budget wants the same smoothed number the panel shows.
   *
   * Zero until the first update, which is a real state and not a rate.
   */
  get fps(): number {
    return this.lastFps;
  }

  /** Mean frame time in milliseconds over the window, as last displayed. See `fps`. */
  get meanMs(): number {
    return this.lastMeanMs;
  }

  /** The slowest frame in the window in milliseconds, as last displayed. See `fps`. */
  get worstMs(): number {
    return this.lastWorstMs;
  }

  /** Call once per rendered frame with duration in seconds. */
  sample(frameDt: number, nowMs: number): void {
    this.samples[this.index] = frameDt * 1000;
    this.index = (this.index + 1) % this.samples.length;
    if (this.filled < this.samples.length) this.filled++;

    if (nowMs - this.lastUpdate < this.updateIntervalMs) return;
    this.lastUpdate = nowMs;

    let total = 0;
    let worst = 0;
    for (let sample = 0; sample < this.filled; sample++) {
      const ms = this.samples[sample] ?? 0;
      total += ms;
      if (ms > worst) worst = ms;
    }
    const meanMs = total / Math.max(this.filled, 1);
    const fps = meanMs > 0 ? 1000 / meanMs : 0;
    this.lastFps = fps;
    this.lastMeanMs = meanMs;
    this.lastWorstMs = worst;
    // Throttled and change-gated: the one sanctioned hot-path string/DOM write.
    const text = `${fps.toFixed(0)} fps · ${meanMs.toFixed(1)} ms · worst ${worst.toFixed(1)} ms`;
    if (text === this.lastText) return;
    this.lastText = text;
    this.element.textContent = text;
    this.element.classList.toggle(this.overBudgetClass, worst > this.frameBudgetMs * 1.5);
  }

  dispose(): void {
    this.element.remove();
  }
}
