/**
 * How much of a DriftLight field is in the frame, and the radius inside which the frame's exact
 * lights take over from it — the part every kind of field shares, kept once.
 *
 * **The radius shrinks at once and grows back slowly.** A pixel inside it that a left-out light
 * reaches would be shaded short, so it cannot lag a shrink; a pixel it has not reached yet takes the
 * summed light, which is only less exact, so a grow may ease. While nothing is summed the radius
 * simply follows. The presence fades in over `fadeSec` once the field is whole, so a field
 * completing in view does not pop — and a held clock never finishes a fade, so a field behind a
 * loading screen asks for none.
 */

/** How fast the shading radius grows back, per second, when the choice reaches further again. */
const RADIUS_GROWTH_PER_SEC = 2;

export class FieldPresence {
  /** Where the frame's choice was centred, which the shader measures the radius from. */
  readonly centre = new Float32Array(3);
  private eased = 0;
  private shown = 0;

  constructor(readonly fadeSec: number) {}

  /** The radius, in metres from `centre`, inside which lights are shaded exactly. */
  get radius(): number {
    return this.eased;
  }

  /** How much of the summed light is in the frame, 0 until the field is whole, then up to 1. */
  get presence(): number {
    return this.shown;
  }

  /** Follow the frame's choice: `complete` from the selection, centred at (x, y, z). */
  follow(ready: boolean, complete: number, x: number, y: number, z: number, dtSec: number): void {
    this.centre[0] = x;
    this.centre[1] = y;
    this.centre[2] = z;
    if (this.shown <= 0 || complete < this.eased) this.eased = complete;
    else this.eased += (complete - this.eased) * (1 - Math.exp(-RADIUS_GROWTH_PER_SEC * dtSec));
    if (ready) this.shown = this.fadeSec > 0 ? Math.min(1, this.shown + dtSec / this.fadeSec) : 1;
  }
}

/**
 * What a backend uploads and binds for a field of either kind, and what the uniforms are made of.
 *
 * A sparse field's index finds its bricks; a dense one brings a 1×1×1 index of nothing, so the
 * upload and the bind are one code path, and says it is dense by a negative spacing.
 */
export interface DriftLightVolumes {
  readonly ready: boolean;
  /** Nothing summed at all: nothing to upload. */
  readonly empty: boolean;
  readonly indexDims: readonly [number, number, number];
  readonly index: Uint32Array;
  readonly atlasSize: readonly [number, number, number];
  /** Half floats, four channels a texel, x fastest. */
  readonly atlas: Uint16Array;
  readonly presence: number;
  readonly radius: number;
  readonly band: number;
  readonly scale: number;
  readonly centre: Float32Array;
  /** The world position of the first sample. */
  readonly sampleOrigin: readonly [number, number, number];
  /** Metres between samples, negative for a dense volume: the shader's mode. */
  readonly signedSpacing: number;
}
