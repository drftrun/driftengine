import { expect, test } from 'vitest';
import { MAX_LIGHTS_PER_CLUSTER } from './clusteredLights.ts';
import {
  CLUSTER_TABLE_TEXTURE_UNIT,
  COOKIE_ATLAS_TEXTURE_UNIT,
  IES_ATLAS_TEXTURE_UNIT,
  REFRACT_SCENE_TEXTURE_UNIT,
  DIRECTIONAL_SHADOW_UNITS,
  EMISSIVE_TEXTURE_UNIT,
  ENVIRONMENT_TEXTURE_UNIT,
  MAX_POINT_LIGHTS,
  NORMAL_TEXTURE_UNIT,
  ORM_TEXTURE_UNIT,
  MORPH_DELTA_TEXTURE_UNIT,
  SKIN_PALETTE_TEXTURE_UNIT,
  POINT_SHADOW_UNITS,
  SURFACE_TEXTURE_UNIT,
} from './lightBudget.ts';

/**
 * The shading pass's texture-unit budget, checked as arithmetic rather than trusted.
 *
 * **The bug this started as.** The lit pass bound three directional maps at units 0-2, ten
 * static point-shadow cubemaps at 3-12, two live cubemaps at 13-14, and the surface texture
 * at a hard-coded 15. That is sixteen units, and sixteen is exactly what WebGL2 *guarantees*
 * — not what it promises beyond. A desktop reports 32 and nobody notices; every Apple GPU
 * reports 16, and there the engine consumed the entire limit with nothing spare.
 *
 * It was found from a phone, through a diagnostic panel, on a scene lit almost entirely by
 * point lights: 0.7% of the frame above black, with a brightest pixel of 208 where the fire
 * was. Emissive and additive geometry survived and everything lit did not, which is what a
 * shading pass looks like when it cannot read its lights.
 *
 * **And the fix is not "one more unit".** Every point light's shadow is one layer of one
 * `TEXTURE_2D_ARRAY` now, so the twelve cubemaps are one binding and the pass uses five units
 * of sixteen. What these assertions pin is that the relationship holds — a future change that
 * adds a sampler, or that makes the light count cost units again, has to come through here.
 */

/** What WebGL2 guarantees, and therefore what has to be survivable. */
const GUARANTEED_UNITS = 16;

/**
 * Everything the flat pass binds with both shadow kinds on.
 *
 * **Derived from the highest unit rather than counted, since 2026-08-24, because counting it got
 * it wrong.** It was `DIRECTIONAL_SHADOW_UNITS + POINT_SHADOW_UNITS + 3` — the three being the
 * surface, normal and ORM maps — which quietly omitted the reflection probe for as long as the
 * probe has existed, and then omitted the froxel table too. The document quoting this said seven
 * used and nine free while the widest permutation was actually binding nine.
 *
 * A literal cannot notice a unit being added. The last unit plus one cannot fail to.
 *
 * **And it did fail to, on 2026-08-25, which is the same lesson one level up.** This read
 * `CLUSTER_TABLE_TEXTURE_UNIT + 1`, and the froxel table stopped being the highest unit the moment
 * the IES atlas landed above it — so "the last unit plus one" quietly became "some unit plus one"
 * and the count was short by one again. Naming *a* unit is the mistake; the fix is to derive from
 * the maximum of every unit this pass binds, which cannot be outgrown by adding another.
 */
const UNITS_WITH_EVERYTHING =
  Math.max(
    DIRECTIONAL_SHADOW_UNITS + POINT_SHADOW_UNITS - 1,
    SURFACE_TEXTURE_UNIT,
    /*
     * The joint palette, which the **vertex** stage reads and which still comes out of this
     * sixteen. `MAX_VERTEX_TEXTURE_IMAGE_UNITS` and `MAX_TEXTURE_IMAGE_UNITS` bound the two stages
     * separately, but they bound how many units each may reference rather than numbering them
     * apart — `activeTexture` selects from one pool. Given unit 0 on the other reading, the palette
     * landed on the directional shadow map and the driver answered
     * `two textures of different types use the same sampler location`.
     */
    SKIN_PALETTE_TEXTURE_UNIT,
    /* The vertex stage's second sampler, on the same shared pool. */
    MORPH_DELTA_TEXTURE_UNIT,
    NORMAL_TEXTURE_UNIT,
    ORM_TEXTURE_UNIT,
    EMISSIVE_TEXTURE_UNIT,
    ENVIRONMENT_TEXTURE_UNIT,
    CLUSTER_TABLE_TEXTURE_UNIT,
    COOKIE_ATLAS_TEXTURE_UNIT,
    IES_ATLAS_TEXTURE_UNIT,
    REFRACT_SCENE_TEXTURE_UNIT,
  ) + 1;

test('the surface unit sits directly above the shadow units, with no gap and no overlap', () => {
  /*
   * `SURFACE_TEXTURE_UNIT` is derived from the two shadow counts now rather than being a
   * literal that happened to agree with them, which is what this used to catch. It is still
   * asserted, because a derivation can be changed as easily as a literal: a gap wastes a unit
   * on a device that has none to waste, and an overlap binds two textures of different types
   * to one unit — undefined behaviour, read as a scene losing either its shadows or its
   * surfaces depending on the driver.
   */
  expect(SURFACE_TEXTURE_UNIT).toBe(DIRECTIONAL_SHADOW_UNITS + POINT_SHADOW_UNITS);
});

test('the normal map sits directly above the surface texture', () => {
  /*
   * Derived rather than a literal, for the reason the surface unit is: a gap wastes a unit on a
   * device that has none to waste, and an overlap binds two textures to one unit, which reads as a
   * scene losing either its surfaces or its normals depending on the driver.
   */
  expect(NORMAL_TEXTURE_UNIT).toBe(SURFACE_TEXTURE_UNIT + 1);
  expect(ORM_TEXTURE_UNIT).toBe(NORMAL_TEXTURE_UNIT + 1);
  /* The four material maps are contiguous, which is what makes the budget above readable. */
  expect(EMISSIVE_TEXTURE_UNIT).toBe(ORM_TEXTURE_UNIT + 1);
  expect(ENVIRONMENT_TEXTURE_UNIT).toBe(EMISSIVE_TEXTURE_UNIT + 1);
});

test('the full configuration leaves one of the guaranteed sixteen units free', () => {
  /*
   * **This test used to assert the opposite** — `toBe(GUARANTEED_UNITS)`, an exact fill with
   * nothing to spare — and the comment under it said that one more sampler genuinely would not
   * fit. Both were true and both stopped being true when the point-shadow cubes became one
   * array binding.
   *
   * The eleven were what Phase 1.3's material maps came out of. The normal map spent one, the ORM
   * map the second and the emissive map the third; the froxel table took a fourth, **the IES
   * atlas a fifth on 2026-08-25**, **the joint palette a sixth and the morph deltas a seventh the
   * same day**, and **the spot-light cookie atlas an eighth on 2026-08-27**. They are named here
   * rather than left as a number so that the change which spends one has to read what it is
   * spending, **and the refraction snapshot a ninth on 2026-09-03**.
   *
   * **One remains, and the name of this test said two for a release.** The assertion moved and the
   * sentence describing it did not, which is the failure this whole file is written against one
   * level up: a number a person maintains beside a number the code derives will disagree, and the
   * prose is the half nothing checks. The next sampler is the one that has to find room — by
   * folding into an existing binding the way the twelve point-shadow cubemaps became one array —
   * rather than taking the last unit.
   *
   * The palette is the first of them the *vertex* stage reads, and it still comes out of this
   * sixteen — see `SKIN_PALETTE_TEXTURE_UNIT` for the reading that said otherwise and what the
   * driver answered.
   */
  expect(UNITS_WITH_EVERYTHING).toBe(15);
  expect(
    GUARANTEED_UNITS - UNITS_WITH_EVERYTHING,
    'free units, with every material map, the probe, the froxel table, the IES atlas, the joint ' +
      'palette, the morph deltas, the cookie atlas and the refraction snapshot bound',
  ).toBe(1);
});

test('the light count costs layers rather than texture units', () => {
  /*
   * The property the whole octahedral change bought, and the one most likely to be undone by
   * accident: a future light-selection change that went back to a sampler per light would pass
   * every other test in this file and quietly reintroduce the phone bug above.
   *
   * `MAX_POINT_LIGHTS` is 16 for exactly this reason — it was 10 because ten was where the
   * units ran out, and the constant's own comment used to say eleven was "the end of the road".
   */
  expect(POINT_SHADOW_UNITS).toBe(1);
  expect(
    DIRECTIONAL_SHADOW_UNITS + POINT_SHADOW_UNITS,
    'raising the light cap must not move the surface unit',
  ).toBe(SURFACE_TEXTURE_UNIT);
  expect(MAX_POINT_LIGHTS).toBeGreaterThan(10);
});

test('the environment probe now fits inside the guarantee', () => {
  /*
   * It did not. The probe sat at the seventeenth unit while the lit pass filled 0 through 15,
   * so every Apple GPU — all of which report exactly sixteen — had nowhere to put it and
   * reflective surfaces kept a sky-and-ground gradient on hardware that could have mirrored
   * the room. `ENVIRONMENT_TEXTURE_UNIT` is derived from the surface unit, so this moves with
   * the accounting rather than needing to be remembered.
   */
  expect(ENVIRONMENT_TEXTURE_UNIT).toBeLessThan(GUARANTEED_UNITS);
});

test('dropping point-light shadows fits the guaranteed minimum with room to spare', () => {
  // What the guard falls back to. The lights still light; they stop casting.
  const withoutPointShadows = DIRECTIONAL_SHADOW_UNITS + 1;
  expect(withoutPointShadows).toBeLessThan(GUARANTEED_UNITS);
  expect(
    GUARANTEED_UNITS - withoutPointShadows,
    'and it leaves enough room that the next sampler added does not repeat this',
  ).toBeGreaterThanOrEqual(4);
});

test('the froxel table sits directly above the environment probe', () => {
  /*
   * Derived rather than a literal, for the reason every unit above it is: a gap wastes a unit on a
   * device that has none to spare, and an overlap binds two textures of different types to one
   * unit, which is undefined and reads as a scene losing one of them depending on the driver.
   */
  expect(CLUSTER_TABLE_TEXTURE_UNIT).toBe(ENVIRONMENT_TEXTURE_UNIT + 1);
  /* Eight of sixteen used with everything on, so eight are still free. */
  expect(CLUSTER_TABLE_TEXTURE_UNIT).toBeLessThan(GUARANTEED_UNITS);
});

test('a froxel holds exactly as many lights as the fixed budget, so the loop bound is unchanged', () => {
  /*
   * **The equality is load-bearing and is not a coincidence to be tidied away.** There is one
   * light loop and its bound must be a constant, so a larger froxel cap would raise the bound for
   * the fixed path too — a scene that never asks for clustering would carry a loop of 28 where it
   * carries 16 today, on the same driver that faulted under the full shader. Raising
   * `MAX_LIGHTS_PER_CLUSTER` means raising `MAX_POINT_LIGHTS` with it, or splitting the loop.
   */
  expect(MAX_LIGHTS_PER_CLUSTER).toBe(MAX_POINT_LIGHTS);
});

test('the photometric atlas sits directly above the froxel table, with no gap', () => {
  /*
   * Derived rather than a literal, for the reason every unit above is: a gap wastes a unit on a
   * device with none to waste, and an overlap binds two textures of different types to one unit,
   * which is undefined behaviour read as a scene losing one of them depending on the driver.
   */
  expect(IES_ATLAS_TEXTURE_UNIT).toBe(CLUSTER_TABLE_TEXTURE_UNIT + 1);
});

/*
 * **The last of the two that were free.** This file's header is about the pass filling all sixteen
 * on a device that reports exactly sixteen, and what that looked like: 0.7% of the frame above
 * black, because a shading pass that cannot read its lights still draws emissive geometry.
 *
 * One unit remains. The next sampler is the one that has to find room rather than take it, and the
 * pattern for that is above: twelve point-shadow cubemaps became one array binding, which is what
 * freed the units everything since has been spending.
 */
test('the refraction snapshot takes the second-to-last guaranteed unit', () => {
  expect(REFRACT_SCENE_TEXTURE_UNIT).toBe(COOKIE_ATLAS_TEXTURE_UNIT + 1);
  expect(REFRACT_SCENE_TEXTURE_UNIT).toBeLessThan(GUARANTEED_UNITS);
});
