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
