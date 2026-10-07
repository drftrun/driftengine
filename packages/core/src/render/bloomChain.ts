/**
 * How wide the bloom pyramid is, how far it reaches, and where it stops.
 *
 * **Backend-neutral because both backends build the same pyramid**, and a difference in any of
 * these three numbers is a difference in the picture that nothing else would explain. The WebGL2
 * pass held the only copy and the WebGPU composite was written without it, which is how one
 * backend ended up running the first stage of eleven and calling it bloom: it drew, it validated,
 * and the frame it produced was a thresholded image with no blur in it at all. Measured on
 * night-court, that was 7,512 pixels moved against WebGL2's 47,574.
 *
 * `bloomPass.ts` binds these on one side and `webgpu/renderer.ts` on the other.
 */

/**
 * How many halvings the chain may take.
 *
 * Six covers a 4K frame down to about 30 pixels across, which is where a level stops describing
 * a halo and starts describing the whole screen. Fewer would put an end on the falloff; more
 * would spend draws on levels that add a flat tint.
 */
export const BLOOM_LEVELS = 6;

/** Below this a level is too small to describe anything but an average of the frame. */
export const BLOOM_MIN_SIDE = 8;

/**
 * How far the tent reaches on the way back up, in UV.
 *
 * In UV rather than in texels, so the spread is the same fraction of the picture on every
 * display and at every level of the chain. This is the "one radius" of the three numbers this
 * effect is allowed: it is fixed rather than exposed because nobody has asked to move it, and a
 * caller who does gets it as a construction-time option rather than as a magic literal here.
 */
export const BLOOM_FILTER_RADIUS_UV = 0.005;

/**
 * What is wrong with a profile that asked for bloom, in words, or null when nothing is.
 *
 * **Shared because it is a fact about the profile rather than about a backend**, and because a
 * warning that only one backend says is a warning half the consumers never see. WebGL2 said both
 * of these at init and this backend said something else entirely from its setters — that the
 * composite did not exist yet, which stopped being true the day it landed and went on being
 * printed. A stale warning is worse than none: it tells somebody a working feature is broken.
 *
 * Not a clamp and not a refusal. The effect still runs and still spreads whatever passes its
 * threshold. What it cannot do is separate a light from a white wall, because on a target that
 * does not keep the range they arrive as the same colour. That is the class of fault this engine
 * has shipped twice under other names — a shadow strength of zero behind an enabled shadow pass,
 * an exposure with no curve to be exposed into — where everything is switched on, nothing is
 * wrong, and nothing happens.
 */
/**
 * A threshold a frame asked for through `setBloom`, made safe: at least a thousandth of a scene
 * unit, because zero blooms the whole frame including what is meant to be dark, and a
 * non-number would reach the shader as one. Decided here so both backends answer the same.
 */
export function bloomThresholdOf(threshold: number): number {
  return Number.isFinite(threshold) ? Math.max(threshold, 1e-3) : 1e-3;
}

export function bloomProfileWarning(quality: {
  readonly bloom: number;
  readonly screenEffects: boolean;
  readonly hdrScene: boolean;
  readonly bloomThreshold: number;
}): string | null {
  if (quality.bloom <= 0) return null;
  if (!quality.screenEffects) {
    return (
      'bloom needs screenEffects, since without the off-screen target there is no finished ' +
      'frame to threshold. It is off.'
    );
  }
  if (!quality.hdrScene) {
    return (
      `bloom is on with hdrScene off, so the scene is clipped to 0..1 before the composite ` +
      `sees it and a threshold of ${quality.bloomThreshold} in scene units can only mean ` +
      `whiteness. Turn hdrScene on, or set a threshold below 1.`
    );
  }
  return null;
}

/**
 * How a frame's bloom answers the light it is given, beside the strength and threshold `setBloom`
 * already takes. Absent, or a field absent, is the response every frame had before 4.8.6.
 *
 * **Why it exists: one band over the colour less the threshold washes a stage built for another
 * engine.** A ramped bloom keeps `saturate((L − threshold) / 2)` of a colour rather than
 * the colour less the threshold, and spreads it over six bands, each in a tint of its own. A
 * stage authored against that — a threshold of 0.1 and tints summing below one — came out white
 * here, because subtracting so low a threshold keeps nearly every light in the frame at full
 * strength. These are the two things that differ, as numbers.
 */
export interface BloomResponse {
  /**
   * Scene units over which a colour comes in, from none of it at the threshold to all of it this
   * far past. **0, the default, subtracts instead**: a colour keeps what it has past the threshold,
   * the response since bloom shipped. A ramped bloom's is 2 after exposure, so a frame exposed by
   * `e` that wants it passes `2 / e`, as it passes the threshold over the exposure.
   *
   * Brightness is still the largest channel rather than luminance, for the reason
   * `shaders/bloom.ts` gives; on a neutral colour the two are equal.
   */
  readonly ramp?: number;
  /**
   * Each level's colour, three numbers a level, finest first: the halo at a few pixels first and
   * at a twentieth of the frame last. **White, the default, is the identity**; a level not named
   * takes white. Not clamped above one, which is how a tint carries a strength past the 0..1 the
   * dial gives — a stage asking for twice the light names tints twice as bright.
   *
   * At most `BLOOM_LEVELS` levels. A frame too small for that many uses the first it has room for.
   */
  readonly tints?: ArrayLike<number>;
}

/** Floats `resolveBloomResponse` writes: the ramp, then a tint a level. */
export const BLOOM_RESPONSE_FLOATS = 1 + BLOOM_LEVELS * 3;

/**
 * A response as both backends bind it, into a caller-owned `out` of `BLOOM_RESPONSE_FLOATS`: the
 * ramp, then `BLOOM_LEVELS` tints, white where none was named. Refuses a tint list that is not
 * whole colours or names more levels than the pyramid has, naming the length — a caller error with
 * one correct outcome. A ramp that is not a positive number is the subtraction; a tint channel
 * that is not a number or is below zero is zero.
 */
export function resolveBloomResponse(
  response: BloomResponse | null | undefined,
  out: Float32Array,
): void {
  const ramp = response?.ramp ?? 0;
  out[0] = Number.isFinite(ramp) && ramp > 0 ? ramp : 0;
  const tints = response?.tints;
  if (tints !== undefined && (tints.length % 3 !== 0 || tints.length > BLOOM_LEVELS * 3)) {
    throw new Error(
      `setBloom: ${tints.length} tint values is not up to ${BLOOM_LEVELS} whole colours, three ` +
        'numbers a level, finest first',
    );
  }
  for (let i = 0; i < BLOOM_LEVELS * 3; i++) {
    const value = tints !== undefined && i < tints.length ? (tints[i] as number) : 1;
    out[1 + i] = Number.isFinite(value) && value > 0 ? value : 0;
  }
}

/** The response every frame had before 4.8.6: the subtraction, every level white. */
export function defaultBloomResponse(): Float32Array {
  const out = new Float32Array(BLOOM_RESPONSE_FLOATS);
  resolveBloomResponse(null, out);
  return out;
}

/** One level of the pyramid: level 0 is half the frame and each one after it half again. */
export interface BloomLevelSize {
  readonly width: number;
  readonly height: number;
}

/**
 * The pyramid for a frame of this size, largest first, or an empty list where none would fit.
 *
 * Empty is a real answer rather than a failure: a frame small enough that its half is under
 * `BLOOM_MIN_SIDE` has nowhere for a halo to live, and a caller reads that as "no bloom this
 * frame" exactly as it reads a target that would not allocate.
 */
export function bloomLevelSizes(width: number, height: number): BloomLevelSize[] {
  const sizes: BloomLevelSize[] = [];
  let levelWidth = width;
  let levelHeight = height;
  for (let level = 0; level < BLOOM_LEVELS; level++) {
    levelWidth = Math.floor(levelWidth / 2);
    levelHeight = Math.floor(levelHeight / 2);
    /* Below this a level is a handful of texels describing the whole frame, which adds a
       flat tint rather than a halo, and one more halving of a 3-pixel side is 1. */
    if (levelWidth < BLOOM_MIN_SIDE || levelHeight < BLOOM_MIN_SIDE) break;
    sizes.push({ width: levelWidth, height: levelHeight });
  }
  return sizes;
}
