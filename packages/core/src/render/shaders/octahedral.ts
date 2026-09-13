import type { vec2, vec3 } from 'gl-matrix';

/**
 * Octahedral mapping: a direction to a point on the unit square, and back.
 *
 * **One projection over the whole sphere, which is the entire reason this exists.** A cube map
 * stores six images rasterised under six separate 90 degree projections, and along a shared edge
 * the two disagree by up to a texel of depth — so a filter tap that crosses the edge reads the
 * other projection's answer, the comparison flips along that line, and the line draws as a
 * straight ray from beneath the light. Seven separate reports pointed at those rays, and four
 * attempts at widening the point-shadow filter failed against them. There is no second projection
 * here for a tap to cross.
 *
 * **The algorithm is written twice, in two languages, and they must move together.** The GLSL is
 * what runs, on both backends, since the WGSL is generated from it. The TypeScript exists so that
 * a change to it has a test that needs no device, and `octahedral.test.ts` is that test. Nothing
 * catches a divergence between the two, which is why they are in one file rather than one each.
 */

/**
 * The chunk both the resolve pass and the lit pass include.
 *
 * **Not `sign()`, anywhere in here.** GLSL's `sign` returns 0 at 0, and a direction with an exact
 * zero component is not a rarity in this engine — it is every axis-aligned wall in every scene it
 * draws. `sign(0.0)` folds such a direction to the origin of the map, which reads as one light's
 * shadow appearing on a surface it does not face. The ternaries below are that fix and are not
 * style; a test asserts this text contains no `sign(` at all.
 *
 * **`octWrapUv` and the two inset helpers exist because a *filtered* octahedral map needs a
 * gutter, and the point-shadow array never did.** That array is one storage level with `NEAREST`
 * on both filters, so no tap ever crosses the map's outer border. A prefiltered environment is
 * `LINEAR` with a mip chain, and there a tap does cross it — into whatever `CLAMP_TO_EDGE` last
 * repeated, which is not the direction on the other side of the fold.
 *
 * The square's border is a fold rather than an edge: the point just past the right border at
 * height `v` is the point just inside it at `1 - v`, and passing through a corner comes back in at
 * the opposite corner, because all four corners are the same pole. Measured before it was written:
 * a gutter texel filled by this rule matches the texel it is folded against to **3.3e-16**, and a
 * border without one is wrong by **4.6e-2** in direction. The corner case is exact to 1.1e-16, and
 * the direction gap across a corner falls linearly with the step, which is what a pole requires.
 *
 * `octInsetUv` and `octInsetDir` are the two ends of that: a sampler maps a direction into the
 * inner `edge - 2` texels, and a generator asks which direction its own texel must hold — which in
 * the gutter is a folded one. They are exact inverses on the interior.
 */
export const OCTAHEDRAL_GLSL = `vec2 octEncode(vec3 d) {
  vec3 n = d / (abs(d.x) + abs(d.y) + abs(d.z));
  vec2 p = n.z >= 0.0
    ? n.xy
    : (1.0 - abs(vec2(n.y, n.x))) * vec2(n.x >= 0.0 ? 1.0 : -1.0, n.y >= 0.0 ? 1.0 : -1.0);
  return p * 0.5 + 0.5;
}

vec3 octDecode(vec2 uv) {
  vec2 f = uv * 2.0 - 1.0;
  vec3 n = vec3(f.x, f.y, 1.0 - abs(f.x) - abs(f.y));
  float t = max(-n.z, 0.0);
  n.x += n.x >= 0.0 ? -t : t;
  n.y += n.y >= 0.0 ? -t : t;
  return normalize(n);
}

vec2 octWrapUv(vec2 uv) {
  vec2 f = uv * 2.0 - 1.0;
  if (f.x < -1.0 || f.x > 1.0) {
    f.x = (f.x > 0.0 ? 2.0 : -2.0) - f.x;
    f.y = -f.y;
  }
  if (f.y < -1.0 || f.y > 1.0) {
    f.y = (f.y > 0.0 ? 2.0 : -2.0) - f.y;
    f.x = -f.x;
  }
  return f * 0.5 + 0.5;
}

vec2 octInsetUv(vec3 d, float edge) {
  return (octEncode(d) * (edge - 2.0) + 1.0) / edge;
}

vec3 octInsetDir(vec2 uv, float edge) {
  return octDecode(octWrapUv((uv * edge - 1.0) / (edge - 2.0)));
}`;

/**
 * The GLSL above, in TypeScript, filling a target the caller owns.
 *
 * The direction need not be normalised: the L1 division below normalises it in the only sense this
 * mapping cares about. Fills rather than returns a new vector because the callers that will exist
 * are per-face rather than per-frame, and the rule is cheaper to keep than to reason about.
 */
export function octEncode(x: number, y: number, z: number, out: vec2): vec2 {
  const l = Math.abs(x) + Math.abs(y) + Math.abs(z);
  const nx = x / l;
  const ny = y / l;
  const nz = z / l;
  let px = nx;
  let py = ny;
  if (nz < 0) {
    px = (1 - Math.abs(ny)) * (nx >= 0 ? 1 : -1);
    py = (1 - Math.abs(nx)) * (ny >= 0 ? 1 : -1);
  }
  out[0] = px * 0.5 + 0.5;
  out[1] = py * 0.5 + 0.5;
  return out;
}

/**
 * A point outside the unit square, folded back to the point of the sphere it names.
 *
 * The GLSL above, in TypeScript, and the identity inside the square — a texel that is not in the
 * gutter must not move, or every map would be resampled by a function meant to touch its border.
 */
export function octWrapUv(u: number, v: number, out: vec2): vec2 {
  let fx = u * 2 - 1;
  let fy = v * 2 - 1;
  if (fx < -1 || fx > 1) {
    fx = (fx > 0 ? 2 : -2) - fx;
    fy = -fy;
  }
  if (fy < -1 || fy > 1) {
    fy = (fy > 0 ? 2 : -2) - fy;
    fx = -fx;
  }
  out[0] = fx * 0.5 + 0.5;
  out[1] = fy * 0.5 + 0.5;
  return out;
}

/**
 * Where to sample a direction in a map `edge` texels across whose outer ring is a gutter.
 *
 * The inner region is `edge - 2` texels, offset by one, so a direction at the very border of the
 * octahedral square lands on the last real texel and the tap that interpolates past it reads the
 * gutter — which `octInsetDir` filled with the folded direction.
 */
export function octInsetUv(x: number, y: number, z: number, edge: number, out: vec2): vec2 {
  octEncode(x, y, z, out);
  out[0] = (out[0] * (edge - 2) + 1) / edge;
  out[1] = (out[1] * (edge - 2) + 1) / edge;
  return out;
}

/**
 * The direction one texel of such a map must hold, gutter included.
 *
 * The exact inverse of `octInsetUv` on the interior. In the gutter the un-inset coordinate falls
 * outside the square and the fold answers it, which is the whole point.
 */
export function octInsetDir(u: number, v: number, edge: number, out: vec3): vec3 {
  const wrapped = octWrapUv((u * edge - 1) / (edge - 2), (v * edge - 1) / (edge - 2), insetScratch);
  return octDecode(wrapped[0], wrapped[1], out);
}

/** Reused by `octInsetDir`, which the convolution calls once per texel of every level. */
const insetScratch: vec2 = [0, 0] as unknown as vec2;

/** The exact inverse, filling a target the caller owns. Returns a unit vector. */
export function octDecode(u: number, v: number, out: vec3): vec3 {
  const fx = u * 2 - 1;
  const fy = v * 2 - 1;
  const nz = 1 - Math.abs(fx) - Math.abs(fy);
  const t = Math.max(-nz, 0);
  const nx = fx + (fx >= 0 ? -t : t);
  const ny = fy + (fy >= 0 ? -t : t);
  const l = Math.hypot(nx, ny, nz);
  out[0] = nx / l;
  out[1] = ny / l;
  out[2] = nz / l;
  return out;
}
