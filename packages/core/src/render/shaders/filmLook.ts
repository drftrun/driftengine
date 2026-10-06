/**
 * The lens and the print: a vignette in scene light, and grain in display values.
 *
 * **The vignette is the lens's, so it acts on light rather than on the picture.** A lens loses light
 * toward its corners by roughly the fourth power of the cosine of the angle off axis, which for a
 * point `r` from the centre is `1 / (1 + k r^2)^2`. Applied to scene light before the tone curve,
 * a bright corner rolls off through the curve's shoulder the way a photographed one does, where a
 * vignette painted over the finished picture greys it. `r` is measured to the frame's corner on a
 * circle, not an ellipse, so a wide window is not darker at its sides than at its top.
 *
 * **The grain is the print's, so it acts on display values after the grade and the veil.** It is
 * one value a pixel, the same on all three channels, weighted toward the midtones where film shows
 * it and kept faint in deep shadow and highlight, where adding it would lift black and grey white.
 * It also dithers: a dark gradient quantised to eight bits bands, and a noise of a few levels breaks
 * the bands up. **The seed is the caller's**, because the engine takes time from its caller: a held
 * capture passes the same seed and is identical run to run, and a playing scene passes a new one
 * each frame and the grain moves as film does.
 *
 * Zero strength for each is the whole of its off path: a branch on a uniform, and the frame is what
 * it was byte for byte.
 */

/**
 * `uVignette`, `uGrain`, `withVignette` and `withGrain`. The rush composite includes it once.
 *
 * `withVignette` takes the pixel's coordinate and the scene's size, since a distance to the corner
 * has to know the aspect. `withGrain` takes the fragment's integer position, so the grain is one
 * value a pixel whatever the resolution.
 */
export const FILM_LOOK_GLSL = `
/** How strongly the lens darkens its corners: 0 is none, 0.5 about 1.2 stops at the corner. */
uniform float uVignette;
/** x: the grain's amplitude in display values, 0 for none. y: this frame's seed, the caller's. */
uniform vec2 uGrain;

vec3 withVignette(vec3 c, vec2 uv, vec2 size) {
  if (uVignette <= 0.0) return c;
  vec2 d = (uv - 0.5) * size;
  vec2 corner = 0.5 * size;
  float r2 = dot(d, d) / dot(corner, corner);
  float falloff = 1.0 + uVignette * r2;
  return c / (falloff * falloff);
}

float grainNoise(uvec2 p, uint seed) {
  uint h = p.x * 1664525u + p.y * 1013904223u + seed * 2654435769u;
  h ^= h >> 16u;
  h *= 2246822519u;
  h ^= h >> 13u;
  h *= 3266489917u;
  h ^= h >> 16u;
  return float(h) * (1.0 / 4294967295.0);
}

vec3 withGrain(vec3 c, vec2 fragCoord) {
  if (uGrain.x <= 0.0) return c;
  float luma = dot(clamp(c, 0.0, 1.0), vec3(0.2126, 0.7152, 0.0722));
  float weight = 0.25 + 3.0 * luma * (1.0 - luma);
  float n = grainNoise(uvec2(fragCoord), uint(uGrain.y)) - 0.5;
  return c + vec3(2.0 * n * uGrain.x * weight);
}
`;

/**
 * The vignette's factor at `uv` on a `width` by `height` frame, as the shader computes it.
 * The shader's arithmetic written out once more, so a test can pin it to hand-derived values.
 */
export function vignetteFactor(
  u: number,
  v: number,
  width: number,
  height: number,
  strength: number,
): number {
  if (strength <= 0) return 1;
  const dx = (u - 0.5) * width;
  const dy = (v - 0.5) * height;
  const r2 = (dx * dx + dy * dy) / (0.25 * (width * width + height * height));
  const falloff = 1 + strength * r2;
  return 1 / (falloff * falloff);
}

/** How much of the grain a display luminance takes: full in the midtones, a quarter at the ends. */
export function grainWeight(luma: number): number {
  const l = Math.min(Math.max(luma, 0), 1);
  return 0.25 + 3 * l * (1 - l);
}

/** Both backends' words when there is no composite to apply the look in. */
export const FILM_LOOK_WITHOUT_COMPOSITE =
  '[driftengine] setVignette, setFilmGrain and setChromaticAberration need `screenEffects`: ' +
  'without a composite every ' +
  'pass is the last thing to touch the frame, so there is no one place to apply a lens or a ' +
  'print. The look was not applied.';

/** A vignette strength as the shader takes it: 0 to 4, anything else off. */
export function clampVignette(strength: number): number {
  return Number.isFinite(strength) ? Math.min(Math.max(strength, 0), 4) : 0;
}

/** A grain amplitude in display values: 0 to 0.5, anything else off. */
export function clampGrain(strength: number): number {
  return Number.isFinite(strength) ? Math.min(Math.max(strength, 0), 0.5) : 0;
}

/**
 * A seed as the shader reads it: a whole number below 2^24, which a 32-bit float carries exactly,
 * so the same seed is the same grain on both backends. Any number a caller has is accepted.
 */
export function grainSeed(seed: number): number {
  return Number.isFinite(seed) ? Math.floor(Math.abs(seed)) % 16777216 : 0;
}
