import { expect, test } from 'vitest';

import { envBrdfApprox, envSpecularEnergy, environmentWeight } from './ibl.ts';

/**
 * **What this file is for: the split sum's second half is a fit, and a fit has invariants.**
 *
 * `flat/lobes.ts` carries both halves in GLSL and its comments carry what they cost when they are
 * wrong — a metal that reads as opaque paint, reported twice from consumers, and traced to a term
 * that asserts a perfect mirror absorbs 55% of the light once it is roughened. The second pipeline
 * is about to compute the same numbers, so they are written here first and
 * `scripts/gpu-parity.mjs` runs both.
 *
 * Every assertion below is a property rather than a transcription: a fit compared against its own
 * constants passes when the constants are copied wrongly, and these do not.
 */

const ROUGHNESSES = [0, 0.05, 0.2, 0.4, 0.6, 0.8, 1];
const ANGLES = [0.05, 0.2, 0.5, 0.8, 1];

test('a mirror seen head-on returns its own reflectance and nothing more', () => {
  const out = new Float32Array(2);
  envBrdfApprox(1, 0, out);
  /*
   * `dfg.x` is the share of `f0` and `dfg.y` the share added on top; at roughness 0 there is no
   * bias. Held to one decimal rather than three, because this is a **fit**: its published error is
   * around one per cent of the tabulated integral, and it reads 0.994 here. A tolerance tight
   * enough to exclude that would be asserting a transcription rather than a property.
   */
  expect(out[0]).toBeCloseTo(1, 1);
  expect(out[1]).toBeCloseTo(0, 1);
});

test('THE SINGLE-SCATTER INTEGRAL LOSES ENERGY WITH ROUGHNESS, which is why the next term exists', () => {
  const out = new Float32Array(2);
  /*
   * `dfg.x + dfg.y` is what a surface at `f0` 1 returns before compensation, and the comment in
   * `lobes.ts` states the measurement: about `1 - 0.55 * roughness`. That is the defect, not the
   * answer — asserting it here is what makes the compensation below testable as a repair.
   */
  envBrdfApprox(1, 0, out);
  const smooth = (out[0] as number) + (out[1] as number);
  envBrdfApprox(1, 1, out);
  const rough = (out[0] as number) + (out[1] as number);
  expect(smooth).toBeGreaterThan(0.95);
  expect(rough).toBeLessThan(0.6);
});

test('A PERFECT REFLECTOR RETURNS EXACTLY ONE AT EVERY ROUGHNESS, which is the repair', () => {
  /*
   * The invariant the compensation exists for, and the one a consumer's report came down to:
   * roughness scatters light, it does not absorb it. At `f0` 1 the geometric series telescopes and
   * this must come back to 1 — not nearly, and not only for smooth surfaces.
   */
  const out = new Float32Array(2);
  for (const roughness of ROUGHNESSES) {
    for (const ndv of ANGLES) {
      envBrdfApprox(ndv, roughness, out);
      const energy = envSpecularEnergy(1, out[0] as number, out[1] as number);
      expect(energy, `f0 1 at roughness ${roughness}, ndv ${ndv}`).toBeCloseTo(1, 5);
    }
  }
});

test('a dielectric gains the small amount the single-scatter integral owed it', () => {
  const out = new Float32Array(2);
  envBrdfApprox(0.5, 0.6, out);
  const single = 0.04 * (out[0] as number) + (out[1] as number);
  const compensated = envSpecularEnergy(0.04, out[0] as number, out[1] as number);
  expect(compensated).toBeGreaterThan(single);
  /* And it is a small amount: a four-percent reflector has little to scatter twice. */
  expect(compensated - single).toBeLessThan(0.02);
});

test('the environment weight collapses to nothing where a material asks for nothing', () => {
  /*
   * **Zero reflectivity is exactly zero**, which is what keeps this from moving a frame that
   * shipped before it — the same promise `specular` and `shade` make.
   */
  expect(environmentWeight(0.5, 0.4, 0, 1)).toBe(0);
  expect(environmentWeight(0.5, 0.4, 0, 0)).toBe(0);
});

test('without a prefiltered chain the weight is the Fresnel sweep the engine always had', () => {
  /*
   * The split sum is the correct share of a *prefiltered* environment; over anything else it
   * asserts an integral that was never performed. `flat/main.ts` selects between them on exactly
   * this flag and measures what ignoring it costs: the grazing-to-head-on ratio falling from about
   * 15 to 1 down to 5 to 1, reported twice as a metal going opaque.
   */
  const sweep = environmentWeight(0.05, 0.5, 1, 0) / environmentWeight(1, 0.5, 1, 0);
  const integrated = environmentWeight(0.05, 0.5, 1, 1) / environmentWeight(1, 0.5, 1, 1);
  expect(sweep).toBeGreaterThan(10);
  /*
   * Flatter than the sweep, compared against *it* rather than against a number picked here: the
   * claim is that the two differ in angular shape, and a constant on the right-hand side would
   * pin whichever roughness this line happens to use.
   */
  expect(integrated).toBeLessThan(sweep);
});

test('a fully rough dielectric still reflects something, which one-minus-roughness denied', () => {
  /*
   * `reflectAmount` is `reflectivity * (1 - roughness)`, which is exactly zero at roughness 1 —
   * false of every real surface, and the reason the prefiltered branch exists at all.
   */
  expect(environmentWeight(0.6, 1, 1, 0)).toBe(0);
  expect(environmentWeight(0.6, 1, 1, 1)).toBeGreaterThan(0.01);
});

test('the weight never exceeds one, so a reflection cannot outshine what it reflects', () => {
  for (const roughness of ROUGHNESSES) {
    for (const ndv of ANGLES) {
      for (const reflectivity of [0.2, 1, 4]) {
        const weight = environmentWeight(ndv, roughness, reflectivity, 1);
        expect(weight, `r ${roughness} ndv ${ndv} refl ${reflectivity}`).toBeLessThanOrEqual(1);
        expect(weight).toBeGreaterThanOrEqual(0);
      }
    }
  }
});

/**
 * **Metalness, added 2026-09-17, and every assertion below is about a collapse or an invariant.**
 *
 * `flat/main.ts` carries the four places metalness enters the environment term and its own comments
 * carry what each cost when it was missing — a chromed subject near black with a baked probe
 * sitting unread, a rough metal reading as paint because `1 - roughness` threw away 40% of
 * everything it shows. The second pipeline is a subset, so the requirement is sharper than
 * "similar": at metalness zero every expression here has to be the one that shipped, exactly.
 */

test('METALNESS ZERO IS THE DIELECTRIC THE PIPELINE ALREADY HAD, argument for argument', () => {
  /*
   * The promise every term in this pipeline makes, and the only one that keeps a capture
   * comparable: a material that says nothing about metal renders the frame it rendered before
   * metal existed. Asserted over the whole corpus rather than at a point, because a collapse that
   * holds at one angle and not another is the shape a `mix` written the wrong way round takes.
   */
  for (const roughness of ROUGHNESSES) {
    for (const ndv of ANGLES) {
      for (const reflectivity of [0, 0.3, 1]) {
        for (const prefiltered of [0, 1]) {
          expect(
            environmentWeight(ndv, roughness, reflectivity, prefiltered, 0),
            `r ${roughness} ndv ${ndv} refl ${reflectivity} pre ${prefiltered}`,
          ).toBe(environmentWeight(ndv, roughness, reflectivity, prefiltered));
        }
      }
    }
  }
});

test('A METAL REFLECTS WHERE THE PASS ASKED FOR NO REFLECTIONS AT ALL', () => {
  /*
   * `reflectivity` is a per-material control and it is zero for exactly the surfaces that carry
   * their metalness some other way. `flat/main.ts` records what reading it alone cost: a chromed
   * subject came out near black with a baked probe sitting unread, because the whole block was
   * skipped. So the amount is `max(reflectivity, metal)` rather than the product.
   */
  expect(environmentWeight(0.7, 0.2, 0, 1, 0)).toBe(0);
  expect(environmentWeight(0.7, 0.2, 0, 1, 1)).toBeGreaterThan(0.8);
});

test('A ROUGH METAL IS STILL A METAL, which one-minus-roughness denied', () => {
  /*
   * The thinning belongs to the dielectric term, where it stands for a polish that scatters the
   * reflection into no image at all. A metal has no diffuse to fall back on — this is its entire
   * response to light — and `flat/main.ts` measured scaling it by `1 - roughness` as throwing away
   * 40% of what a surface at roughness 0.4 shows. It is also double counting: the level the sample
   * comes from already *is* the roughness.
   */
  for (const roughness of ROUGHNESSES) {
    expect(environmentWeight(0.8, roughness, 0, 0, 1), `roughness ${roughness}`).toBeCloseTo(1, 6);
  }
});

test('A FULLY METALLIC SURFACE RETURNS ALL OF A PREFILTERED ROOM, at every roughness', () => {
  /*
   * The white furnace again, one level up. `envSpecularEnergy` at `f0` 1 comes back to exactly 1
   * and the amount is `max(reflectivity, metal)` — so the whole weight is 1 and a mirror returns
   * the room it sees, whatever its roughness and whatever angle it is seen from. Roughness
   * scatters light; it does not absorb it, and a term that says otherwise is the "metals read
   * opaque" report arithmetically.
   */
  for (const roughness of ROUGHNESSES) {
    for (const ndv of ANGLES) {
      expect(
        environmentWeight(ndv, roughness, 0, 1, 1),
        `roughness ${roughness}, ndv ${ndv}`,
      ).toBeCloseTo(1, 5);
    }
  }
});

test('and half a metal is between the two, rather than at either end', () => {
  /* A `mix` written backwards passes both ends and fails here. */
  const dielectric = environmentWeight(0.9, 0.5, 0, 1, 0);
  const metal = environmentWeight(0.9, 0.5, 0, 1, 1);
  const half = environmentWeight(0.9, 0.5, 0, 1, 0.5);
  expect(half).toBeGreaterThan(dielectric);
  expect(half).toBeLessThan(metal);
});
