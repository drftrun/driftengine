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
 * **The anti-flicker: a still pixel's neighbourhood widened by its own flicker.**
 *
 * A thread, a crack of light round a door, a leaf finer than a pixel: the jitter catches it in some
 * phases and misses it in others, and in a phase that misses it the nine taps round a pixel can all
 * miss it at once. The box collapses onto the background, the history — which had settled on the
 * thread's share of the pixel — is clipped out, and it grows back a tenth a frame until the next
 * miss. That is a paused frame flashing at every fine edge, and the clip is doing its job: nothing
 * in one frame says the thread is still there.
 *
 * What does say so is the pixel's own record. **A still camera over a still scene samples every pixel
 * the same way every period of the jitter, exactly**, so aliasing repeats itself; a surface that moves
 * across the pixel, a flame, a light that shimmers, does not. So each pixel keeps the mean of its
 * samples over the last period, the sum it is gathering for this one, how many periods running have
 * repeated, and the running mean of how far its samples land from their period's mean — and its box
 * widens by that spread only once two periods running have repeated. Measured on the samples rather
 * than against the history, because the history is what the clip cuts. **And a sample farther from
 * its period's mean than the box would widen to is not the flicker the pixel has shown**: something
 * has arrived, and the count starts again on that frame rather than at the end of the period. **Two, and a mean rather than
 * one sample**, because one sample repeats by coincidence: stripes sliding across a pixel land on the
 * same colour at two period starts about as often as not.
 *
 * **What it gives up.** A surface arriving over a pixel that was flickering is held back until the
 * period ends and fails to repeat — at most eight frames, fading a tenth a frame meanwhile; a still
 * pixel needs three periods before it is helped at all; and a pixel that flickers in a scene that is
 * itself moving is not helped, since nothing repeats there. Nothing moving past a twentieth of a
 * pixel a frame is touched, since the reprojection is then what decides.
 *
 * **A moving camera had a weaker proof of its own, and it was taken out.** It widened a pixel's box
 * while its samples swung both ways about their mean, with the record carried through the
 * reprojection. Measured on a moving courtyard it removed a twentieth of what flickered, and it broke
 * a sun's shadow line on the floor into dashes that were not there before: the record is read at the
 * nearest texel, so under sub-pixel motion one pixel widened and its neighbour did not. The resolve
 * already removes nineteen twentieths of a moving frame's flicker without it. **What would make it wrong** is a jitter
 * whose sequence does not repeat, where no period is the same twice however still the scene is.
 */

/** This frame's share of the running spread, and of a period's mean: one period of the jitter. */
export const FLICKER_MEMORY = 1 / JITTER_PERIOD;

/**
 * How many spreads a flickering pixel's box widens by. The hardest thread is one missed in a single
 * phase of eight: that miss needs the box to reach 7/8 of its contrast, and the running spread,
 * worn down by seven catches that each land an eighth of the contrast from the period's mean, has
 * fallen to a = 1/8 + (7/8 a + 7/64 − 1/8)·(7/8)⁷ of the contrast by then — 0.181, a steady state
 * solved by hand — against the 7/32 it averages. Seven eighths over that is 4.8; six leaves room.
 * Threads caught in a share nearer a half spread more and need fewer.
 */
export const FLICKER_WIDTH = 6;

/**
 * The two numbers the proof takes from the jitter's period: how much of a period one frame is, and
 * how many spreads a proven pixel's box widens by. This resolve's are `FLICKER_MEMORY` and
 * `FLICKER_WIDTH`; a reconstruction jitters along a longer sequence and needs its own.
 */
export interface FlickerRule {
  readonly memory: number;
  readonly width: number;
}

/** The temporal resolve's own: eight phases. */
export const TEMPORAL_FLICKER: FlickerRule = { memory: FLICKER_MEMORY, width: FLICKER_WIDTH };

/**
 * The running spread of the hardest thread — one caught in a single phase of `phases` — just before
 * its catch, as a share of its contrast: the steady state `FLICKER_WIDTH`'s comment solves for eight
 * phases, solved for any. With m one over the period and r = (1 − m)^(p − 1), the seven, or p − 1,
 * misses that wear it down: a = (m + ((p − 1)m² − m)·r) / (1 − (1 − m)·r).
 */
function hardestSpread(phases: number): number {
  const m = 1 / phases;
  const r = (1 - m) ** (phases - 1);
  return (m + ((phases - 1) * m * m - m) * r) / (1 - (1 - m) * r);
}

/** How many of those spreads the hardest thread's catch lands from its period's mean. */
function widthNeeded(phases: number): number {
  return (1 - 1 / phases) / hardestSpread(phases);
}

/**
 * The rule for a jitter of `phases` positions. **The width keeps the room `FLICKER_WIDTH` leaves over
 * what eight phases need** — 4.8 — in proportion: a longer period wears the spread down further
 * between catches, so over eighteen phases the hardest thread needs eleven spreads, and a box that
 * reached six reset the count of exactly the pixels this is for.
 */
export function flickerRule(phases: number): FlickerRule {
  return {
    memory: 1 / phases,
    width: (FLICKER_WIDTH * widthNeeded(phases)) / widthNeeded(JITTER_PERIOD),
  };
}

/**
 * How far apart two periods' means may be, relative to the larger, and still repeat: fully below
 * this, not at all at twice it. Above an eight-bit record's rounding and a lamp's slow breathing; far
 * below what anything crossing the pixel does to it.
 */
export const FLICKER_REPEAT = 0.05;

/**
 * How much of the history a pixel proven to repeat keeps, where an unproven one keeps
 * `TEMPORAL_HISTORY_BLEND`. A settled thread still breathes with the jitter by the share of each
 * frame's sample that goes into what is shown — a tenth of its contrast at the base blend — and a
 * pixel that has repeated for two periods has nothing to respond to, so it keeps more: three
 * hundredths of each frame instead of a tenth. What it costs is a surface arriving inside the
 * pixel's own swing, which fades in at that rate until the period's check lets it through.
 */
export const FLICKER_BLEND = 0.97;

/**
 * How far last frame's depth may be from the depth a surface should have had there, relative, and
 * still be that surface: two percent beyond the pixel's own depth swing, taken as the nearest of the
 * texel where it stood and the four beside it. **The nearest of five and not the one**, because this
 * frame's sample and last frame's can straddle an edge with nothing moved — the lesson
 * `recon/resolve.ts` learned the expensive way.
 *
 * **And beyond its own swing, because depth aliases the way colour does.** A crack of light round a
 * door is a pixel whose sample lands on the door in some phases and on what is behind it in others,
 * so its depth jumps metres with nothing moved, and a test held to two percent reset the record of
 * exactly the pixels the anti-flicker is for: a held frame went from 5 flickering pixels back to 774.
 * So each pixel keeps the running mean of how far last frame's depth missed — kept whatever the test
 * says, since resetting it would stop it ever learning the swing — and the test allows
 * `FLICKER_WIDTH` of those, as the box does of the colour's. A flat surface's swing is none and its
 * test stays tight; a surface revealed by the camera is a jump nothing in the pixel's past explains.
 */
export const FLICKER_SURFACE = 0.02;

/** Whether a record follows the surface it was kept for: see `FLICKER_SURFACE`. */
export function sameSurface(expected: number, stood: ArrayLike<number>, swing: number): boolean {
  return missedBy(expected, stood) <= FLICKER_WIDTH * swing + FLICKER_SURFACE * expected;
}

/**
 * How far the nearest of last frame's depths missed the one expected. A depth of nought is a texel
 * with nothing recorded — the frame after a cut — and is no texel; with none, nothing is missed by
 * any amount.
 */
export function missedBy(expected: number, stood: ArrayLike<number>): number {
  let nearest = Number.POSITIVE_INFINITY;
  for (let i = 0; i < stood.length; i++) {
    const depth = stood[i] as number;
    if (depth > 0) nearest = Math.min(nearest, Math.abs(depth - expected));
  }
  return nearest;
}

/**
 * The pixel's depth swing carried on: the running mean of `missedBy`, over a period, and none where
 * there was nothing to miss — a swing learned from a cut would loosen the test for a whole period.
 */
export function nextDepthSwing(swing: number, missed: number): number {
  return Number.isFinite(missed) ? swing + (missed - swing) * FLICKER_MEMORY : 0;
}

/**
 * Reprojected motion in pixels a frame: still below the first, moving from the second. **Small,
 * because repetition breaks long before motion is visible**: a camera drifting a fifth of a pixel a
 * frame shifts the grid more than a pixel a period, so nothing repeats, and a ramp to half a pixel
 * counted that as mostly still and kept vouching for samples that had stopped repeating.
 */
export const STILL_FROM = 0.01;
export const STILL_TO = 0.05;

/**
 * A pixel's flicker record, in luma: the running spread of its samples about their period's mean,
 * the sum this period has gathered so far, the last period's mean, and how many periods running have
 * repeated — none, one or two, as 0, 0.5 and 1.
 */
export interface Flicker {
  spread: number;
  sum: number;
  mean: number;
  repeated: number;
}

/**
 * A fresh record for a surface first seen this frame: no spread and nothing repeated. **A
 * record of another surface is no record**, so the resolve starts one over wherever last frame's
 * depth says the surface is not the one it followed, before this frame widens by anything.
 */
export function freshFlicker(
  out: Flicker,
  sample: number,
  rule: FlickerRule = TEMPORAL_FLICKER,
): Flicker {
  out.spread = 0;
  out.sum = sample * rule.memory;
  out.mean = sample;
  out.repeated = 0;
  return out;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Rec. 709 luma, which is what the record measures in. */
export function luma(c: readonly [number, number, number]): number {
  return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
}

/** One for a pixel whose reprojection did not move, falling to none at a twentieth of a pixel. */
export function stillness(motionPixels: number): number {
  return 1 - smoothstep(STILL_FROM, STILL_TO, motionPixels);
}

/**
 * Whether a pixel is proven to repeat this frame: two periods running have, and this frame's sample
 * lands within the reach of the box it would widen to. A sample beyond that reach is something
 * arriving, and it disqualifies the frame it lands in as well as the count it carries out.
 */
export function proven(
  record: Flicker,
  sample: number,
  rule: FlickerRule = TEMPORAL_FLICKER,
): boolean {
  return record.repeated > 0.75 && within(record, sample, rule);
}

/** Whether this frame's sample lands inside the reach of the box the record would widen to. */
function within(record: Flicker, sample: number, rule: FlickerRule): boolean {
  return Math.abs(sample - record.mean) <= rule.width * record.spread + 1 / 255;
}

/** How far a pixel's box widens this frame: by its spread, once proven, and only while still. */
export function flickerWidening(
  record: Flicker,
  sample: number,
  still: number,
  rule: FlickerRule = TEMPORAL_FLICKER,
): number {
  return proven(record, sample, rule) ? rule.width * record.spread * still : 0;
}

/** How much of the history this frame keeps: the base blend, or more once proven. */
export function flickerBlend(
  base: number,
  record: Flicker,
  sample: number,
  still: number,
  rule: FlickerRule = TEMPORAL_FLICKER,
): number {
  return proven(record, sample, rule) ? base + (FLICKER_BLEND - base) * still : base;
}

/** Whether two periods' means are the same, one to zero. */
export function repeats(mean: number, previous: number): number {
  const apart = Math.abs(mean - previous) / Math.max(mean, previous, 1 / 255);
  return 1 - smoothstep(FLICKER_REPEAT, 2 * FLICKER_REPEAT, apart);
}

/**
 * The record carried out, from the one carried in and this frame's sample in luma. `periodStart`
 * is the first frame of the jitter's period, where the period just gathered is compared with the
 * one before. Forgotten in proportion to motion — a moving pixel's record would be a record of
 * somewhere else. `rule` is this resolve's eight phases unless a caller jitters along another
 * sequence, as a reconstruction does.
 */
export function nextFlicker(
  out: Flicker,
  previous: Flicker,
  sample: number,
  still: number,
  periodStart: boolean,
  rule: FlickerRule = TEMPORAL_FLICKER,
): Flicker {
  const apart = Math.abs(sample - previous.mean);
  let { sum, mean, repeated } = previous;
  if (apart > rule.width * previous.spread + 1 / 255) repeated = 0;
  if (periodStart) {
    repeated = repeats(sum, mean) > 0.5 ? Math.min(1, repeated + 0.5) : 0;
    mean = sum;
    sum = 0;
  }
  out.spread = previous.spread + (apart - previous.spread) * rule.memory;
  out.sum = sum + sample * rule.memory;
  out.mean = mean;
  out.repeated = repeated * still;
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
  /** Whether this frame of the renderer's has opened one of the sequence, and what it answered. */
  private opened = false;
  private answer = false;

  /**
   * A frame of the renderer's began: the next `openFrame` opens a frame of the sequence. Called at
   * `beginFrame`, by both backends.
   */
  nextFrame(): void {
    this.opened = false;
  }

  /**
   * Open a frame at this target size, and answer whether the history may be sampled.
   *
   * **The jitter advances whether or not it may be.** Holding the sequence still on the frames a
   * resize or a cut discarded would sample the same position twice running, which is one sample
   * and not two.
   *
   * **Once a frame, however many times it is asked.** A renderer asks where the scene's camera
   * arrives, and a frame binds that camera again after a scene capture or anything else that bound
   * another; each asking opened a frame of its own, so the sequence stepped twice in such a frame
   * and the edges of the picture swam. Asked again, it gives the answer it gave. What it gives up:
   * a size changed between two asks in one frame is seen at the next frame, not at once.
   */
  openFrame(width: number, height: number): boolean {
    if (this.opened) return this.answer;
    this.opened = true;
    this.frameIndex++;
    const usable = this.picture && width === this.width && height === this.height;
    if (!usable) this.picture = false;
    this.width = width;
    this.height = height;
    this.answer = usable;
    return usable;
  }

  /**
   * Whether this frame samples the first phase of the jitter's period, where the anti-flicker
   * compares the period just gathered with the one before. One answer for both backends.
   */
  get periodStart(): boolean {
    return this.frameIndex % JITTER_PERIOD === 0;
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
