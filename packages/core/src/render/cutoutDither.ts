/**
 * A cutout whose edge is a share of the pixel rather than a line through it.
 *
 * **Why.** A hard alpha test draws a strand of hair, an eyelash or a fringe of leaves as a stair of
 * whole pixels: a card's alpha falls off over a few texels and the test turns that into on and off.
 * A dithered cutout keeps each pixel with a probability, the share of it the texture covers, and
 * something downstream then averages the pattern back into coverage. What can average it depends on
 * the frame, so the material asks for the smooth edge and the renderer decides, per frame, how:
 *
 * - **A temporal resolve (TAA or DriftTR)**: the pixel is kept against a threshold that moves every
 *   frame, and the resolve integrates the pattern over its history into coverage.
 * - **A multisampled frame**: the share goes to the GPU as alpha-to-coverage, which turns it into
 *   that many of the pixel's samples.
 * - **Neither**: the hard test, because a dither nothing resolves is grain on the screen.
 *
 * **What it gives up**: a dithered edge under a temporal resolve is soft by one history's worth of
 * blur and ghosts slightly behind a fast card, which is the resolve's own trade; and under
 * multisampling the share is quantised to the sample count, five levels at four samples. **What
 * would make it wrong** is a pass that tests depth for equality against the main pass and discards
 * differently from it; the caster and the lit pass take their keep from the same two functions here.
 */

/** What a material asks for. `'hard'` is every cutout that shipped before this. */
export type CutoutMode = 'hard' | 'dithered';

/** What the frame does with it: 0, 1 and 2 in the shader's `uCutout.y`. */
export type CutoutResolve = 'hard' | 'dither' | 'coverage';

/** The shader's number for a resolve. */
export const CUTOUT_RESOLVE_CODE: Readonly<Record<CutoutResolve, number>> = Object.freeze({
  hard: 0,
  dither: 1,
  coverage: 2,
});

/**
 * How a cutout is drawn this frame. A temporal resolve is preferred over multisampling when a frame
 * has both, because it resolves every share and multisampling only the sample count's.
 */
export function resolveCutout(mode: CutoutMode, temporal: boolean, samples: number): CutoutResolve {
  if (mode !== 'dithered') return 'hard';
  if (temporal) return 'dither';
  if (samples > 1) return 'coverage';
  return 'hard';
}

/**
 * The share of a pixel a cutout keeps, from its alpha: half at the cutoff, ramping over a band
 * twice the distance to the nearer end. At a cutoff of a half that is alpha itself.
 */
export function cutoutShare(alpha: number, cutoff: number): number {
  const band = Math.max(2 * Math.min(cutoff, 1 - cutoff), 1e-4);
  return Math.min(Math.max((alpha - cutoff) / band + 0.5, 0), 1);
}

/**
 * The temporal step of the noise below, per frame: Jimenez's constant (2014), which moves the
 * pattern across the tile rather than stepping each pixel's threshold.
 *
 * **A golden-ratio step per pixel was tried and measured, and it is not better.** It spreads a still
 * pixel's thresholds evenly over time, which reads like the cure for grain; on a card of strands
 * under TAA it left 12.9 levels of grain against this one's 11.7. The floor is the resolve's own: it
 * keeps nine tenths of its history, so the newest frame's kept-or-not pattern is a tenth of the
 * picture, about ten levels of grain at a half share whatever sequence chose it.
 */
const NOISE_FRAME_STEP = 5.588238;

/**
 * The threshold a pixel's share is compared against: interleaved gradient noise (Jimenez,
 * "Next Generation Post Processing in Call of Duty: Advanced Warfare", 2014), offset by the frame so
 * the pattern moves. `x` and `y` are pixel centres, as `gl_FragCoord.xy` is.
 */
export function ditherThreshold(x: number, y: number, frame: number): number {
  const px = x + NOISE_FRAME_STEP * frame;
  const py = y + NOISE_FRAME_STEP * frame;
  const inner = 0.06711056 * px + 0.00583715 * py;
  const f = 52.9829189 * (inner - Math.floor(inner));
  return f - Math.floor(f);
}

/**
 * The two functions in GLSL, for the lit pass and every caster that keeps the same pixels.
 *
 * `cutoutKeeps(share, pixel, frame)` is the dithered test; `cutoutShare(alpha, cutoff)` is also what
 * a coverage frame writes as alpha. Frame is a float the renderer counts and wraps, so the noise's
 * argument stays small enough for a half-precision device.
 */
export const CUTOUT_DITHER_GLSL = `
float cutoutShare(float alpha, float cutoff) {
  float band = max(2.0 * min(cutoff, 1.0 - cutoff), 1e-4);
  return clamp((alpha - cutoff) / band + 0.5, 0.0, 1.0);
}

bool cutoutKeeps(float share, vec2 pixel, float frame) {
  vec2 p = pixel + vec2(${NOISE_FRAME_STEP.toFixed(6)} * frame);
  float noise = fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
  return share > noise;
}
`;
