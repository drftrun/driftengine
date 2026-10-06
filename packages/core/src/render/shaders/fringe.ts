/**
 * Chromatic aberration: a lens bending each colour by its own amount, so red and green land a
 * little nearer the centre than blue toward the frame's edges.
 *
 * **Linear in wavelength, from an offset outward.** A simple lens's dispersion is close to linear
 * in wavelength over the visible range, so red (611 nm) and green (549 nm) are pulled toward the
 * centre by their distance from blue (464 nm), which is drawn where it is. Nothing moves inside
 * `start` — a share of the half-frame, 0 at the centre — and the pull grows linearly past it,
 * scaled so that the frame's edge takes the whole of `intensity`, which is a percentage.
 *
 * **What it gives up**: it re-reads the scene at the composite's first sample, so the camera's
 * motion blur and the depth of field, which re-read the scene themselves, carry less of the fringe
 * where they are strong. A pass of its own after both would carry it whole, at a full-frame read
 * and write a frame. **What would make that wrong** is a game that blurs heavily and fringes
 * heavily at once, where the colour edges would be seen to soften with the blur.
 */

/** How many floats `resolveFringe` fills: the red pull, the green pull, and where they begin. */
export const FRINGE_FLOATS = 3;

/** The primaries' wavelengths, nanometres. */
const RED_NM = 611.3;
const GREEN_NM = 549.1;
const BLUE_NM = 464.3;
/** The lens's dispersion per nanometre, the constant that makes `intensity` a percentage. */
const PER_NM = 0.007;

/**
 * The fringe's three numbers, into `out`: how far red and green are pulled toward the centre at
 * the frame's edge, as a share of the half-frame, and the start offset. `intensity` 0 or below is
 * none; a start of 1 or more is none too, since nothing then lies past it. Not finite is none.
 */
export function resolveFringe(intensity: number, start: number, out: Float32Array): void {
  const at = Number.isFinite(start) ? Math.min(Math.max(start, 0), 1) : 0;
  const amount = Number.isFinite(intensity) && intensity > 0 && at < 1 ? intensity * 0.01 : 0;
  /* Divided only where there is something to divide: at a start of 1 this is 0 over 0. */
  const reach = amount > 0 ? amount / (1 - at) : 0;
  out[0] = reach * PER_NM * (RED_NM - BLUE_NM);
  out[1] = reach * PER_NM * (GREEN_NM - BLUE_NM);
  out[2] = at;
}

/**
 * `withFringe(scene)`: the scene's colour with red and green read again where the lens put them.
 * Reads `uScene` and `vUv`, which the including stage declares, and `uFringe`, which this declares.
 */
export const FRINGE_GLSL = `
/** Red's and green's pull at the frame's edge, and where it begins: see shaders/fringe.ts. */
uniform vec3 uFringe;

vec3 withFringe(vec3 scene) {
  if (uFringe.x <= 0.0) return scene;
  vec2 lens = vUv * 2.0 - 1.0;
  vec2 past = sign(lens) * clamp(abs(lens) - uFringe.z, 0.0, 1.0);
  vec2 red = (lens - past * uFringe.x) * 0.5 + 0.5;
  vec2 green = (lens - past * uFringe.y) * 0.5 + 0.5;
  return vec3(textureLod(uScene, red, 0.0).r, textureLod(uScene, green, 0.0).g, scene.b);
}
`;
