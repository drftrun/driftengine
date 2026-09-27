/**
 * A probe grid's sweeps: which layer a bake writes, when a sweep is whole, and how far the shading
 * has moved from the last whole sweep toward the newest.
 *
 * **A grid re-baked a probe a frame changes in steps.** Each probe holds the light of the moment it
 * was baked until its turn comes round again, a sweep later, and then jumps to the light of that
 * moment. Under a moving sun the jump is a pass of light across the scene once a sweep: reported as
 * "a pass every second or two", which at sixty-four probes a frame at 60 Hz is exactly one sweep.
 *
 * **So a crossfading grid keeps three sets of layers**: the last whole sweep, the newest whole
 * sweep, and the one being baked. The shading blends the first toward the second by how much of the
 * third has been baked, so it reaches the newest sweep at the moment the next one is whole, and the
 * light moves a sixty-fourth of a sweep a frame rather than a probe's worth at once. The set being
 * written is never one the shading reads.
 *
 * What it gives up is three times the layers, and a sweep of lag: the light shown is a blend of what
 * the grid saw one and two sweeps ago. What would make it wrong is a light that must follow a change
 * faster than a sweep, which a burst of bakes serves, since the blend follows the bakes rather than
 * the clock. A grid that does not crossfade is one set, ready once every probe is baked, as before.
 *
 * Backend-neutral, per the rule that a decision lives in one place and only the binding is per
 * backend: both renderers ask this where to write and what to upload.
 */
export class ProbeSweeps {
  /** Sets of layers the array holds: three for a crossfading grid, one otherwise. */
  readonly sets: 1 | 3;
  private readonly layers: number;
  /** Which probes the sweep being baked has reached, and how many. */
  private readonly reached: Uint8Array;
  private reachedCount = 0;
  private from = 0;
  private to = 0;
  private write = 0;
  /** Whether a whole sweep has been rotated in. */
  private whole = false;

  constructor(layers: number, crossfade: boolean) {
    this.layers = Math.max(1, Math.trunc(layers));
    this.sets = crossfade ? 3 : 1;
    this.reached = new Uint8Array(this.layers);
  }

  /** The array layer a bake of probe `layer` writes. */
  writeLayer(layer: number): number {
    return this.write * this.layers + layer;
  }

  /** Record that probe `layer` was baked into the set being written; a whole sweep rotates. */
  baked(layer: number): void {
    if (layer < 0 || layer >= this.layers || this.reached[layer] === 1) return;
    this.reached[layer] = 1;
    this.reachedCount++;
    if (this.reachedCount < this.layers) return;
    this.reached.fill(0);
    this.reachedCount = 0;
    if (this.sets === 1) {
      this.whole = true;
      return;
    }
    /* The newest is shown from now on; the first whole sweep is shown alone, blending into itself. */
    this.from = this.whole ? this.to : this.write;
    this.to = this.write;
    this.whole = true;
    /* The set neither end of the blend holds. */
    this.write = this.from === this.to ? (this.to + 1) % 3 : 3 - this.from - this.to;
  }

  /** Whether the shading may read the grid: once a sweep is whole. */
  get ready(): boolean {
    return this.whole;
  }

  /** The layer offsets of the two sets shown and the blend between them, into `out`. */
  uniforms(out: Float32Array): Float32Array {
    out[0] = this.from * this.layers;
    out[1] = this.to * this.layers;
    out[2] = this.sets === 1 ? 0 : this.reachedCount / this.layers;
    return out;
  }
}
