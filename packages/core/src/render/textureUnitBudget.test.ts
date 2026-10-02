import { expect, test } from 'vitest';
import { MAX_LIGHTS_PER_CLUSTER } from './clusteredLights.ts';
import { flatFrag } from './shaders/flat/index.ts';
import * as budget from './lightBudget.ts';
import {
  CLUSTER_TABLE_TEXTURE_UNIT,
  FIXTURE_ATLAS_TEXTURE_UNIT,
  REFRACT_SCENE_TEXTURE_UNIT,
  DIRECTIONAL_SHADOW_UNITS,
  EMISSIVE_TEXTURE_UNIT,
  ENVIRONMENT_TEXTURE_UNIT,
  MAX_POINT_LIGHTS,
  NORMAL_TEXTURE_UNIT,
  ORM_TEXTURE_UNIT,
  MORPH_DELTA_TEXTURE_UNIT,
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

/** What WebGL2 guarantees a stage, and therefore what has to be survivable. */
const GUARANTEED_UNITS = 16;
/** What WebGL2 guarantees the vertex and fragment stages together, whose units share one numbering. */
const GUARANTEED_COMBINED_UNITS = 32;

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

test("THE SUN'S THREE MAPS ARE ONE BINDING, as the lamps' twelve became one", () => {
  /*
   * Static, peeled and moving: three sampler2Ds until 4.5.0, one sampler2DArray since, which is
   * what paid for glass's two tints. The same move `POINT_SHADOW_UNITS` records, one family over.
   */
  expect(DIRECTIONAL_SHADOW_UNITS).toBe(1);
});

test('EVERY UNIT THE LIT PASS NAMES IS ITS OWN, and all of them fit the combined pool', () => {
  /*
   * **Derived from every exported unit since 2026-09-30, because a list of them went stale.** This
   * test counted the highest of a hand-kept list of units and asserted thirteen used and three of
   * sixteen free — while DriftLight's index and atlas and both glass tints sat at units 13 to 16,
   * named nowhere in the list, and the test stayed green describing a pass four units smaller than
   * the one that shipped. The fragment stage's own count is the test below, from the shader source;
   * what this pins is the pool the units are numbered in.
   *
   * A unit is a place in the combined pool, which WebGL2 guarantees is at least thirty-two, shared by
   * the vertex stage's palette and morph deltas and the fragment stage's samplers. Two units on one
   * number bind two textures to one place, which is undefined and reads as a scene losing one of
   * them depending on the driver — except the SDF text atlas, which is drawn by its own program on
   * the surface unit by design.
   */
  const units = Object.entries(budget)
    .filter(([name, value]) => name.endsWith('_TEXTURE_UNIT') && typeof value === 'number')
    .filter(([name]) => name !== 'SDF_TEXT_TEXTURE_UNIT') as [string, number][];
  expect(units.length, 'the units found, so an empty scan cannot pass').toBeGreaterThanOrEqual(10);
  const taken = new Map<number, string>();
  for (const [name, unit] of units) {
    expect(taken.get(unit), `${name} shares unit ${unit}`).toBeUndefined();
    taken.set(unit, name);
    expect(unit, `${name} is below the shadow units`).toBeGreaterThanOrEqual(
      DIRECTIONAL_SHADOW_UNITS + POINT_SHADOW_UNITS,
    );
  }
  const highest = Math.max(...units.map(([, unit]) => unit));
  /* Below the last unit of the pool, which is left for a pass that borrows one for a draw and
     releases it: `@driftengine/ui2d`'s sprites, whose unit fourteen was once a lit-pass unit. */
  expect(highest, 'every unit below the one kept for borrowers').toBeLessThan(
    GUARANTEED_COMBINED_UNITS - 1,
  );
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

test('a froxel holds at least the fixed budget, so the one loop bound covers both arms', () => {
  /*
   * **This was an equality until a candlelit interior needed more.** The loop's bound is the
   * froxel cap now, and the fixed arm leaves it at `MAX_LIGHTS` of its own accord, which
   * `flat.test.ts` pins in the source. What must still hold is that the bound is never below the
   * fixed budget, or the fixed arm would stop short of its own lights.
   */
  expect(MAX_LIGHTS_PER_CLUSTER).toBeGreaterThanOrEqual(MAX_POINT_LIGHTS);
});

test('the fixture atlas sits directly above the froxel table, with no gap', () => {
  /*
   * Derived rather than a literal, for the reason every unit above is: a gap wastes a unit on a
   * device with none to waste, and an overlap binds two textures of different types to one unit,
   * which is undefined behaviour read as a scene losing one of them depending on the driver.
   */
  expect(FIXTURE_ATLAS_TEXTURE_UNIT).toBe(CLUSTER_TABLE_TEXTURE_UNIT + 1);
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
  expect(REFRACT_SCENE_TEXTURE_UNIT).toBe(MORPH_DELTA_TEXTURE_UNIT + 1);
  expect(REFRACT_SCENE_TEXTURE_UNIT).toBeLessThan(GUARANTEED_UNITS);
});

test('THE LIT STAGE KEEPS ONE OF THE SIXTEEN GUARANTEED FRAGMENT SAMPLERS SPARE, glass tints and all', () => {
  /*
   * Counted from the widest lit shader itself rather than from unit numbers: a unit number is a
   * place in the combined pool, where the vertex stage's palette and morph deltas also live, and
   * `MAX_TEXTURE_IMAGE_UNITS` bounds how many samplers a *stage* declares. This is that count.
   * The sun's three maps became one array to afford the glass tints, the sun's and the lamps'; the
   * sixteenth stays free, and the next sampler has to fold into a binding rather than take it.
   */
  const source = flatFrag({
    pointShadows: true,
    directionalShadows: true,
    environmentProbe: true,
    nightEmissive: true,
  });
  const samplers = [
    ...source.matchAll(/^\s*uniform\s+(?:highp\s+|mediump\s+|lowp\s+)?[iu]?sampler\w+\s+(\w+)/gm),
  ].map((match) => match[1]);
  expect(samplers).toContain('uSunGlassTints');
  expect(samplers).toContain('uPointGlassTints');
  /* The cookie and photometric atlases became one fixture atlas, the fold this test asks the next
     sampler for, and the surface effects table took the sampler it freed: fifteen, one spare. */
  expect(samplers).toContain('uFixtureAtlas');
  expect(samplers).toContain('uSurfaceEffects');
  expect(samplers).toHaveLength(15);
  expect(GUARANTEED_UNITS - samplers.length).toBeGreaterThanOrEqual(1);
});
