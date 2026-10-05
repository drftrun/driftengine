/**
 * The skin model's arithmetic, as `shaders/flat/skin.ts` computes it: the reference its tests hold
 * the fit to, and nothing at run time calls it.
 *
 * **Pre-integrated, after Penner 2011, with the profile integrated rather than looked up.** Light
 * entering skin leaves it a little way off, so on a curved surface a point is lit by its
 * neighbours' `N·L` as well as its own: the clamped cosine averaged around a ring of the surface's
 * curvature, weighted by the diffusion profile at each neighbour's distance. The profile is Burley's
 * normalised diffusion, one per channel, at a scatter distance `d` — the model's `radius` times its
 * scatter colour, over `SKIN_MEAN_EXIT`, since `radius` is how far light travels and the profile
 * carries it two and a half `d` — projected onto the ring's plane, as a cylinder's cross-section
 * sees it. The
 * result depends on `N·L` and on one number per channel, `k = d × curvature`, and at `k = 0` it is
 * Lambert's.
 *
 * **Fitted rather than tabulated**, so no seventeenth sampler and no image: the ring average is the
 * clamped cosine convolved with an angular kernel, so it splits into the cosine's first harmonic —
 * scaled by one number, `κ₁(k)` — and a smoothed `|cos θ|` carrying every even harmonic:
 *
 *     D(c, k) = ½ (κ₁ c + A √(c² + ε²) + B)
 *
 * with `κ₁`, `A`, `ε` and `B` closed forms in `k` that are exactly `1, 1, 0, 0` at `k = 0`. The
 * test measures it against the integral done numerically: **worst 0.0105 over `k` to 10**, beyond
 * which the shader holds `k` — a scatter ten times the surface's own radius, where the answer is
 * nearly flat already.
 */

/** Schlick's base for skin, at index 1.4: `((1 − n) / (1 + n))²`. */
export const SKIN_F0 = ((1 - 1.4) / (1 + 1.4)) ** 2;

/** The largest `k` the fit is held to, and where the shader clamps it. */
export const SKIN_MAX_K = 10;

/**
 * The fit's eight numbers, found by minimising its worst error against the numeric integral over
 * `c` in [−1, 1] and `k` in (0, 10]:
 *
 * - `kappa`: `κ₁ = (1 + a k² + b k³)^(−1/6)` — the first harmonic's share, quadratic at zero and
 *   falling as `1/√k`, as the integral's does;
 * - `spread`: `A = (1 + a k³)^(−1/6)`;
 * - `soften`: `ε = a k / (1 + b k)`, how far `|c|` is rounded at the terminator;
 * - `floor`: `B = (1 − A)(a + b (1 − A))`, the even part's floor as `A` gives up `|c|`.
 */
export const SKIN_FIT = {
  kappa: [22.6772, 101.349],
  spread: 838.87,
  soften: [1.3081, 3.65743],
  floor: [0.508537, 0.129496],
} as const;

/** The ring-averaged `N·L` for one channel: `c` is `N·L`, `k` that channel's scatter × curvature. */
export function skinRing(c: number, k: number): number {
  const q = Math.min(Math.max(k, 0), SKIN_MAX_K);
  const k2 = q * q;
  const kappa = (1 + SKIN_FIT.kappa[0] * k2 + SKIN_FIT.kappa[1] * k2 * q) ** (-1 / 6);
  const spread = (1 + SKIN_FIT.spread * k2 * q) ** (-1 / 6);
  const soften = (SKIN_FIT.soften[0] * q) / (1 + SKIN_FIT.soften[1] * q);
  const given = 1 - spread;
  const floor = given * (SKIN_FIT.floor[0] + SKIN_FIT.floor[1] * given);
  return 0.5 * (kappa * c + spread * Math.sqrt(c * c + soften * soften) + floor);
}

/**
 * How far into a penumbra skin's light reaches, as a width the shadow is assumed to have: the
 * lamp loop reads a shadow where its derivative cannot be taken, so its width in the world is not
 * known there. Two centimetres is a soft edge across a face.
 */
export const SKIN_PENUMBRA_WIDTH = 0.02;

/**
 * A shadow on skin, one channel at scatter distance `d`: the shadow's own value raised to
 * `1 / (1 + d / width)`, so light reaches further into the penumbra the further that channel
 * travels beneath the surface — red furthest, which is the red edge a shadow on skin has — and a
 * shadow stays whole at 0 and absent at 1. **What it gives up** is the profile itself: Penner
 * convolves a sharpened shadow with it, which needs the penumbra's width in the world and hardens
 * the narrow channels' edge where nothing widened the map to make room.
 */
export function skinPenumbra(shadow: number, d: number): number {
  return Math.max(shadow, 0) ** (1 / (1 + d / SKIN_PENUMBRA_WIDTH));
}

/**
 * Light through a thin part, one channel: `transmission × exp(−thickness / d)` of the light behind,
 * by how squarely it is behind. A part as thick as its curvature's diameter — an ear's rim at a few
 * millimetres, a cheek at ten centimetres — passes red through the one and nothing through the other.
 */
export function skinTransmission(
  backNdl: number,
  thickness: number,
  d: number,
  transmission: number,
): number {
  return transmission * Math.exp(-thickness / Math.max(d, 1e-6)) * Math.max(backNdl, 0);
}
