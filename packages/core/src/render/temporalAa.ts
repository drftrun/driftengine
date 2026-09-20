import { mat4 } from 'gl-matrix';
import type { ReadonlyMat4 } from 'gl-matrix';

import { jitterTable } from './recon/jitter.ts';

/**
 * The sub-pixel sequence a temporal resolve samples along, and the state that says whether there
 * is anything to resolve *against* yet.
 *
 * **Antialiasing by moving the camera rather than by taking more samples.** A frame is rasterised
 * with the projection shifted a fraction of a pixel, so an edge that fell one side of a pixel
 * centre falls the other side next frame, and blending the two puts the edge where it actually
 * is. What MSAA buys per frame this buys across frames, at one extra texture and one extra pass
 * instead of a multiplied fill rate — which is the trade a browser target wants.
 *
 * **This file holds only the parts that are arithmetic**, so they can be asserted without a
 * device: where the next sample sits, what that does to a projection matrix, and whether the
 * history is usable this frame. The resolve itself is a shader and belongs to each backend.
 */

/**
 * How many frames the sequence takes to come back round.
 *
 * Eight rather than sixteen: the accumulation converges in eight frames instead of sixteen, and
 * every frame of history is a frame of ghosting a moving object has to be clipped out of. The
 * sequence is the deciding factor rather than the count — eight *distinct* low-discrepancy
 * positions beat sixteen that clump.
 */
export const JITTER_PERIOD = 8;

/**
 * How much of the clipped history each resolved frame keeps.
 *
 * Nine parts history to one part this frame, which gives the accumulation an effective window of
 * about ten frames — a little longer than the eight-frame period, so every offset in the sequence
 * still contributes to what is on screen. Higher holds a ghost for longer wherever the
 * neighbourhood clip does not catch it; lower stops converging before the period is out and leaves
 * the crawl this exists to remove.
 */
export const TEMPORAL_HISTORY_BLEND = 0.9;

/**
 * The period's offsets, centred so they sum to zero — `recon/jitter.ts`'s sequence at eight phases.
 *
 * **One sequence for the temporal resolve and for reconstruction**, and these are the numbers the
 * resolve has always used: Halton in bases two and three, each period centred on its own mean,
 * because accumulating towards an off-centre mean resolves to a picture displaced from the depth
 * it was tested against.
 */
const OFFSETS = jitterTable(JITTER_PERIOD);

/** Where in its pixel frame `frameIndex` samples, in pixels, centred on zero. */
export function jitterOffset(frameIndex: number): readonly [number, number] {
  const at = ((frameIndex % JITTER_PERIOD) + JITTER_PERIOD) % JITTER_PERIOD;
  return [OFFSETS[at * 2] as number, OFFSETS[at * 2 + 1] as number];
}

/**
 * `source` shifted by `offsetX`, `offsetY` pixels on a `width` by `height` target.
 *
 * **A clip-space translation scaled by w, and not an edit to the projection's third column.** The
 * usual trick adds the offset to the third column, where it is multiplied by view z and the
 * perspective divide then cancels it — which is exact, and only for a bare perspective projection.
 * This engine's single funnel for geometry is `viewProjFor`, which carries a *combined*
 * view-projection: there the third column multiplies world z instead of view z, and the jitter
 * would swim with the scene's own depth. An orthographic matrix breaks it too, its w being 1.
 *
 * Adding `offset * w` to clip x and y is what those two cases have in common. It survives the
 * divide as a constant screen offset at every distance, whatever produced the clip position, so
 * this may be handed a projection or a view-projection and is correct for both — which is the
 * property the near-and-far test beside this pins.
 *
 * **A zero offset returns the matrix unchanged, bit for bit.** Every published capture is taken
 * with this off, and a jitter of zero that still ran the arithmetic would move pixels by whatever
 * it rounded to.
 */
export function jitterProjection(
  out: mat4,
  source: ReadonlyMat4,
  offsetX: number,
  offsetY: number,
  width: number,
  height: number,
): mat4 {
  mat4.copy(out, source);
  if (offsetX === 0 && offsetY === 0) return out;
  const ndcX = (2 * offsetX) / width;
  const ndcY = (2 * offsetY) / height;
  /* Row 0 gains `ndcX` times row 3, and row 1 `ndcY` times it, which is `T * source` for a T
     translating in clip space — done in place because that product touches nothing else. */
  for (let column = 0; column < 4; column++) {
    const w = source[column * 4 + 3];
    out[column * 4 + 0] += ndcX * w;
    out[column * 4 + 1] += ndcY * w;
  }
  return out;
}

/** A colour the resolve is working on, as three numbers rather than a texture fetch. */
export type Rgb = [number, number, number];

/**
 * `history` pulled into the box `min`..`max`, along the line towards the box's centre.
 *
 * **This is what separates a temporal resolve from a long exposure.** Reprojection finds where a
 * pixel *was*; nothing in it knows whether what was there is what is there now. A character
 * walking in front of a wall reprojects onto wall, and blending nine parts of that history is a
 * smear that follows them about. The colours actually present around the pixel this frame bound
 * what the history is allowed to be, and anything outside those bounds is a sample of something
 * that has gone.
 *
 * **Clipped towards the centre rather than clamped per channel.** A clamp moves each channel
 * independently, so a history that is merely brighter than its surroundings lands on a corner of
 * the box and comes back a different hue, which reads as coloured fringing along every moving
 * edge. Shortening the whole offset by one ratio keeps the direction and changes only the length.
 *
 * The same arithmetic is in `TEMPORAL_RESOLVE_FRAG`, and the shader test asserts the shader still
 * spells it this way.
 */
export function clipToNeighbourhood(
  out: Rgb,
  history: readonly [number, number, number],
  min: readonly [number, number, number],
  max: readonly [number, number, number],
): Rgb {
  const centre: Rgb = [0, 0, 0];
  const offset: Rgb = [0, 0, 0];
  let ratio = 0;

  for (let c = 0; c < 3; c++) {
    centre[c] = (min[c] + max[c]) * 0.5;
    offset[c] = history[c] - centre[c];
    const extent = (max[c] - min[c]) * 0.5;
    /*
     * A channel with no extent cannot bound anything, so a history that differs from it at all is
     * infinitely outside and collapses to the neighbourhood — which is the honest answer for a
     * flat region, and the alternative is a division by zero.
     */
    if (extent > 1e-7) ratio = Math.max(ratio, Math.abs(offset[c]) / extent);
    else if (Math.abs(offset[c]) > 1e-7) ratio = Number.POSITIVE_INFINITY;
  }

  if (!(ratio > 1)) {
    out[0] = history[0];
    out[1] = history[1];
    out[2] = history[2];
    return out;
  }

  const scale = Number.isFinite(ratio) ? 1 / ratio : 0;
  out[0] = centre[0] + offset[0] * scale;
  out[1] = centre[1] + offset[1] * scale;
  out[2] = centre[2] + offset[2] * scale;
  return out;
}

/**
 * Whether the last frame left a picture this one may sample, and where the jitter has got to.
 *
 * **Two calls a frame, and the split is the point.** `openFrame` answers a question about the
 * state *before* this frame writes anything, and the resolve needs that answer before it writes;
 * `accumulated` reports that a picture now exists. One call cannot do both.
 */
export class TemporalHistory {
  /** How many frames have been opened, which is what indexes the jitter. */
  frameIndex = 0;

  private picture = false;
  private width = 0;
  private height = 0;

  /**
   * Open a frame at this target size, and answer whether the history may be sampled.
   *
   * **The jitter advances whether or not it may be.** Holding the sequence still on the frames a
   * resize or a cut discarded would sample the same position twice running, which is one sample
   * and not two.
   */
  openFrame(width: number, height: number): boolean {
    this.frameIndex++;
    const usable = this.picture && width === this.width && height === this.height;
    if (!usable) this.picture = false;
    this.width = width;
    this.height = height;
    return usable;
  }

  /** A resolved picture is now in the history, at the size the frame was opened with. */
  accumulated(): void {
    this.picture = true;
  }

  /** Forget it — a cut, a teleport, or anything else that makes the last frame a different scene. */
  invalidate(): void {
    this.picture = false;
  }
}
