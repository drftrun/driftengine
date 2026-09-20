/** The split sum's second half, in TypeScript, so the second pipeline's copy has a reference. */

/**
 * **`flat/lobes.ts` in TypeScript: how much of an environment a surface returns.**
 *
 * The convolution decides *what* a surface reflects — a rougher one reads a blurrier level of the
 * prefiltered chain — and this decides *how much*. Both halves are a fit and an algebraic
 * compensation, which is to say both are arithmetic nobody can check by looking at a frame: the
 * failure they exist to prevent was reported twice from consumers as *metals reading opaque*, and
 * traced to a term that asserts a perfect mirror absorbs 55% of the light once it is roughened.
 *
 * **Metalness is a per-material scalar here, not an ORM map.** `flat/main.ts` reads it per texel
 * from the blue channel of an occlusion-roughness-metallic image, which is a thing this pipeline
 * has no textures to read; a GPU-driven material carries one number instead. That is a *subset* and
 * not a second opinion: everywhere a texel could vary, a material is constant, and every expression
 * below is the forward path's with a uniform standing in for a fetch.
 *
 * **What stays collapsed is the environment gain.** `flat/main.ts` scales what a metal reflects by
 * `uEnvironmentGain`, which exists because a metal has no diffuse behind its reflection and a probe
 * that under-reports the room leaves it with no other way to be lit. `PassEnvironment` carries no
 * such control, so the gain is 1 and `mix(1, gain, metal)` is exactly 1 at every metalness — a
 * collapse that is exact rather than approximate, which is the standard every term here is held to.
 */

/** A dielectric's normal-incidence reflectance, which is what a material with no metalness is. */
export const DIELECTRIC_F0 = 0.04;

/**
 * A surface's normal-incidence reflectance, from its metalness.
 *
 * **A metal's Fresnel base is close to its albedo and a dielectric's is four per cent**, and
 * `flat/main.ts` records what leaving it at 0.04 costs: a smooth metal seen head-on takes a four
 * per cent reflection and reads as dark paint. The chromatic half of that — a metal's `f0` being
 * its own colour rather than white — is in `lit.ts`, where the albedo is; this is the scalar the
 * split sum takes.
 */
export function surfaceF0(metalness: number): number {
  return DIELECTRIC_F0 + (1 - DIELECTRIC_F0) * metalness;
}

/**
 * The split sum's second half, as a two-term fit: `dfg.x` scales `f0` and `dfg.y` is added on top.
 *
 * **Karis's analytic fit rather than the tabulated integral**, which is a texture this pipeline
 * would otherwise have to carry and bind. Its published error is around one per cent of the
 * tabulated term, far below what an eight-bit frame can show. **What would make it wrong** is a
 * material model with a second lobe — a clearcoat or a sheen carries its own BRDF and its own
 * integral, and this is Trowbridge-Reitz with Smith masking and nothing else.
 */
export function envBrdfApprox(ndv: number, roughness: number, out: Float32Array): Float32Array {
  const c0 = [-1, -0.0275, -0.572, 0.022];
  const c1 = [1, 0.0425, 1.04, -0.04];
  const rx = roughness * (c0[0] as number) + (c1[0] as number);
  const ry = roughness * (c0[1] as number) + (c1[1] as number);
  const rz = roughness * (c0[2] as number) + (c1[2] as number);
  const rw = roughness * (c0[3] as number) + (c1[3] as number);
  const a004 = Math.min(rx * rx, Math.pow(2, -9.28 * ndv)) * rx + ry;
  out[0] = -1.04 * a004 + rz;
  out[1] = 1.04 * a004 + rw;
  return out;
}

/**
 * The same, with the light that bounces more than once inside the microsurface put back.
 *
 * **The split sum integrates a *single* scattering event**, so it silently discards every ray that
 * strikes one microfacet, bounces, and leaves. Roughness scatters light; it does not absorb it, so
 * a surface with `f0` 1 has to return everything at every roughness — and the bare sum returns
 * about `1 - 0.55 * roughness`, which is a 44% loss at roughness 0.8.
 *
 * Fdez-Agüera's compensation: the missing energy, returned at the surface's average Fresnel over
 * the hemisphere, summed as a geometric series over repeated bounces. **At `f0` 1 it comes back to
 * exactly 1.0 at every roughness** — `average` is 1, `multi` is `energy / energy`, and the sum
 * telescopes — which is the invariant the test beside this file asserts across the whole range.
 *
 * **No divide guard, because the denominator cannot reach zero.** `missing` is at most 0.55 and
 * `average` at most 1, so `1 - missing * average` bottoms out at 0.45 — the worst case in both
 * variables at once.
 */
export function envSpecularEnergy(f0: number, dfgX: number, dfgY: number): number {
  const single = f0 * dfgX + dfgY;
  const energy = dfgX + dfgY;
  const missing = 1 - energy;
  const average = f0 + (1 - f0) / 21;
  const multi = (single * average) / (1 - missing * average);
  return single + multi * missing;
}

/**
 * How much of what the surface sees in the mirror direction reaches the frame.
 *
 * **Two expressions and a selector, because they answer different questions.** `prefiltered` is 1
 * where the radiance came from a GGX-convolved chain, and there the split sum is the correct share
 * of that integral — it carries the angular dependence itself, so it replaces the Fresnel sweep
 * rather than multiplying it. Where the radiance is anything else, applying it would assert an
 * integral that was never performed: `flat/main.ts` measured that mistake as the grazing-to-head-on
 * ratio falling from about 15 to 1 down to 5 to 1, reported twice as a metal going opaque.
 *
 * So without a chain this is the engine's own long-standing weight — Schlick's Fresnel times
 * `reflectivity * (1 - roughness)` — and with one it is the integral. The two are deliberately not
 * blended into a single formula; a selector that is exactly 0 or exactly 1 is what makes a scene
 * with no environment arithmetically identical to the frame it already rendered.
 *
 * `ndv` is `dot(n, toEye)` clamped at zero, as the caller's own facing term already computes.
 */
export function environmentWeight(
  ndv: number,
  roughness: number,
  reflectivity: number,
  prefiltered: number,
  /**
   * 0 is a dielectric and 1 is a metal. **Defaults to 0**, so every caller written before this
   * argument existed gets the arithmetic it had.
   */
  metalness = 0,
): number {
  const f0 = surfaceF0(metalness);
  const facing = 1 - ndv;
  const fresnel = f0 + (1 - f0) * (facing * facing * facing * facing * facing);
  /*
   * **`max(reflectivity * (1 - roughness), metal)`, and both halves of that are repairs.**
   *
   * `reflectivity` is a per-material control, and it is zero for exactly the surfaces that carry
   * their metalness some other way — `flat/main.ts` measured reading it alone as a chromed subject
   * coming out near black with a baked probe sitting unread, because the whole block was skipped.
   * So a metal reflects whether or not the material asked for reflections.
   *
   * And the `1 - roughness` thinning does not reach the metal. It stands for a polish that
   * scatters a dielectric's reflection into no image at all; a metal has no diffuse to fall back
   * on, so scaling it throws away 40% of everything a surface at roughness 0.4 shows and replaces
   * it with a dark constant. It is also double counting — the level the sample comes from already
   * *is* the roughness.
   */
  const amount = Math.max(reflectivity * (1 - roughness), metalness);
  const sweep = Math.min(Math.max(fresnel * amount, 0), 1);

  const dfg = new Float32Array(2);
  envBrdfApprox(ndv, roughness, dfg);
  const integrated = Math.min(
    Math.max(
      envSpecularEnergy(f0, dfg[0] as number, dfg[1] as number) * Math.max(reflectivity, metalness),
      0,
    ),
    1,
  );
  return sweep + (integrated - sweep) * prefiltered;
}
