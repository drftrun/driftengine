import { expect, test } from 'vitest';

import { resolveAtmosphere, type Atmosphere } from './atmosphere.ts';
import {
  LINEAR_FOG,
  MEDIUM_FOG,
  atmosphereFog,
  createFogTarget,
  mediumColour,
  mediumFog,
  type FogOptions,
} from './fog.ts';

const CLEAR: FogOptions = {
  colour: [0.7, 0.82, 0.92],
  density: 0,
  heightFalloff: 0,
  eyeY: 0,
  underwaterColour: [0, 0.2, 0.3],
  underwaterDensity: 0,
  underwaterFactor: 0,
  mode: MEDIUM_FOG,
  near: 0,
  far: 1,
};

test('A LINEAR RAMP IS EXACTLY ZERO BEFORE NEAR AND EXACTLY ONE PAST FAR', () => {
  /* The property that makes a ramp a ramp rather than a medium: before `near` the air is
     perfectly clear, which Beer-Lambert can never be. `shaders/fog.ts` argues it at length. */
  const ramp: FogOptions = { ...CLEAR, mode: LINEAR_FOG, near: 50, far: 100 };
  expect(mediumFog(ramp, 49.9, 0)).toBe(0);
  expect(mediumFog(ramp, 50, 0)).toBe(0);
  expect(mediumFog(ramp, 75, 0)).toBeCloseTo(0.5, 6);
  expect(mediumFog(ramp, 100, 0)).toBe(1);
  expect(mediumFog(ramp, 1e6, 0)).toBe(1);
});

test('A ZERO SPAN IS A HARD CUT, and the one distance it is NaN at is the guard', () => {
  /*
   * `far === near` is a consumer asking for a cut rather than a ramp, and either side of it the
   * clamp already gives the right answer without any guard at all: minus infinity clamps to 0 and
   * plus infinity clamps to 1. **At exactly the cut distance the quotient is 0/0**, and `NaN`
   * survives both `Math.max` and `Math.min` — so the guard is observable at one distance and
   * nowhere else, which is how it came to be tested. A `NaN` fog factor is a `mix` that paints the
   * fog colour over that fragment, so it is a line along the cut rather than a subtle shift.
   */
  const cut: FogOptions = { ...CLEAR, mode: LINEAR_FOG, near: 60, far: 60 };
  expect(mediumFog(cut, 59, 0)).toBe(0);
  expect(mediumFog(cut, 61, 0)).toBe(1);
  /* Clear exactly at the cut, as a ramp is exactly at its near distance, and total a tenth of a
     millimetre past it — which is what the guarded span makes of a cut. */
  expect(mediumFog(cut, 60, 0)).toBe(0);
  expect(mediumFog(cut, 60.0001, 0)).toBe(1);
});

test('a medium never reaches one and is zero at the eye', () => {
  const air: FogOptions = { ...CLEAR, density: 0.01 };
  expect(mediumFog(air, 0, 0)).toBe(0);
  expect(mediumFog(air, 100, 0)).toBeGreaterThan(0);
  expect(mediumFog(air, 100, 0)).toBeLessThan(1);
  /* Monotone in distance, which is the one property a haze cannot violate. */
  expect(mediumFog(air, 200, 0)).toBeGreaterThan(mediumFog(air, 100, 0));
});

test('HEIGHT FALLOFF IS GUARDED AT THE LEVEL RAY, where the quotient is zero over zero', () => {
  /*
   * `(1 - e^-t)/t` tends to 1 as `t` tends to 0, and `t` is zero for every fragment at the eye's
   * own height — which in a flat world is most of them. Unguarded this is NaN across the horizon,
   * and a NaN fog factor is a `mix` that paints the fog colour over the whole frame.
   */
  const hazy: FogOptions = { ...CLEAR, density: 0.02, heightFalloff: 0.1, eyeY: 10 };
  const level = mediumFog(hazy, 100, 10);
  expect(Number.isFinite(level)).toBe(true);
  expect(level).toBeGreaterThan(0);
  /* And it is the limit rather than an arbitrary substitute: just off the level ray agrees. */
  expect(mediumFog(hazy, 100, 10.0001)).toBeCloseTo(level, 4);
  /* Above the eye there is less air to look through, which is the whole point of the term. */
  expect(mediumFog(hazy, 100, 40)).toBeLessThan(level);
});

test('UNDERWATER IS ITS OWN CURVE, crossfaded rather than added', () => {
  /*
   * Water is a camera medium: crossing the surface changes which law is read, not how the water
   * column itself reads. At a factor of one the air term is gone entirely.
   */
  const wet: FogOptions = { ...CLEAR, density: 0.01, underwaterDensity: 0.05, underwaterFactor: 1 };
  const dry: FogOptions = { ...wet, underwaterFactor: 0 };
  expect(mediumFog(wet, 40, 0)).not.toBeCloseTo(mediumFog(dry, 40, 0), 3);
  /* Half way across the surface is half way between the two, which is what "crossfade" means. */
  const half = mediumFog({ ...wet, underwaterFactor: 0.5 }, 40, 0);
  expect(half).toBeCloseTo((mediumFog(wet, 40, 0) + mediumFog(dry, 40, 0)) / 2, 6);
});

test('AND A LINEAR RAMP UNDERWATER IS STILL THE WATER CURVE, not a ramp', () => {
  /* The ramp is a look for the air; the water column keeps its own law under both modes, so a
     consumer who chose a ramp and swam under does not get a hard clear band below the surface. */
  const ramp: FogOptions = {
    ...CLEAR,
    mode: LINEAR_FOG,
    near: 50,
    far: 100,
    underwaterDensity: 0.05,
    underwaterFactor: 1,
  };
  expect(mediumFog(ramp, 20, 0)).toBeGreaterThan(0);
});

test('the colour is the haze until the camera is underwater', () => {
  expect(mediumColour(CLEAR)).toEqual([0.7, 0.82, 0.92]);
  expect(mediumColour({ ...CLEAR, underwaterFactor: 1 })).toEqual([0, 0.2, 0.3]);
  expect(mediumColour({ ...CLEAR, underwaterFactor: 0.5 })).toEqual([0.35, 0.51, 0.61]);
});

/*
 * **The second pipeline's haze is the medium the first one binds, field for field.** A consumer
 * drawing both pipelines in one frame — the voxel sandbox's port, its terrain on one and its mobs
 * on the other — has one `Environment` and needs one haze from it. `resolveAtmosphere` is the
 * forward path's decision about which medium the camera is in and what it looks like; this is that
 * decision handed over in the shape `GpuDrivenView.fog` takes, so the two cannot disagree about
 * where the fog starts or whether the camera is under water.
 */
test('THE SECOND PIPELINE’S HAZE IS THE MEDIUM THE FIRST ONE BINDS, field for field', () => {
  const cases: [Atmosphere, number, boolean][] = [
    [
      {
        fogColor: [0.7, 0.82, 0.92],
        fogDensity: 0,
        fogHeightFalloff: 0,
        fogBaseY: 0,
        fogMode: 'linear',
        fogNear: 48,
        fogFar: 91.2,
        underwater: null,
      },
      70,
      true,
    ],
    [
      {
        fogColor: [0.3, 0.36, 0.44],
        fogDensity: 0.02,
        fogHeightFalloff: 0.05,
        fogBaseY: 4,
        underwater: { surfaceY: 30, transitionDepth: 0.5, color: [0, 0.2, 0.3], fogDensity: 0.4 },
      },
      29.8,
      true,
    ],
    [
      {
        fogColor: [0.3, 0.36, 0.44],
        fogDensity: 0.02,
        fogHeightFalloff: 0.05,
        fogBaseY: 4,
        underwater: { surfaceY: 30, transitionDepth: 0.5, color: [0, 0.2, 0.3], fogDensity: 0.4 },
      },
      29.8,
      false,
    ],
  ];
  const into = createFogTarget();
  for (const [atmosphere, eyeY, underwater] of cases) {
    const bound = resolveAtmosphere(atmosphere, eyeY, underwater, {
      fogColor: new Float32Array(3),
      underwaterColor: new Float32Array(3),
      fogDensity: 0,
      fogHeightFalloff: 0,
      fogEyeY: 0,
      fogMode: 0,
      fogNear: 0,
      fogFar: 1,
      underwaterFogDensity: 0,
      underwaterFactor: 0,
    });
    const fog = atmosphereFog(atmosphere, eyeY, underwater, into);
    /* Filled in place: the frame loop that calls this may not allocate. */
    expect(fog).toBe(into);
    expect([...fog.colour]).toEqual([...bound.fogColor]);
    expect(fog.density).toBe(bound.fogDensity);
    expect(fog.heightFalloff).toBe(bound.fogHeightFalloff);
    expect(fog.eyeY).toBe(bound.fogEyeY);
    expect([...fog.underwaterColour]).toEqual([...bound.underwaterColor]);
    expect(fog.underwaterDensity).toBe(bound.underwaterFogDensity);
    expect(fog.underwaterFactor).toBe(bound.underwaterFactor);
    expect(fog.mode).toBe(bound.fogMode);
    expect(fog.near).toBe(bound.fogNear);
    expect(fog.far).toBe(bound.fogFar);
  }
  /* And the two modes are the same numbers on both sides, which the mapping above relies on. */
  expect(atmosphereFog(cases[0]![0], 70, true, into).mode).toBe(LINEAR_FOG);
  expect(atmosphereFog(cases[1]![0], 29.8, true, into).mode).toBe(MEDIUM_FOG);
  expect(atmosphereFog(cases[1]![0], 29.8, true, into).underwaterFactor).toBeGreaterThan(0);
});
