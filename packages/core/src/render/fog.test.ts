import { expect, test } from 'vitest';

import { createResolvedAtmosphere, resolveAtmosphere, type Atmosphere } from './atmosphere.ts';
import {
  LINEAR_FOG,
  MEDIUM_FOG,
  atmosphereFog,
  createFogTarget,
  mediumColour,
  mediumFog,
  mediumGlow,
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
    const bound = resolveAtmosphere(atmosphere, eyeY, underwater, createResolvedAtmosphere());
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

/*
 * **A medium that starts some way along the ray**: integrated from `fogStart` metres out, so
 * nothing nearer is fogged and what is further is fogged by the air past that point alone — a
 * faint, bright fog that hazes a crowd and leaves the figures in front of it clear. Carried in the
 * linear mode's `near`, which the medium never read, so a world that sets no start draws the
 * expression it always did. Expectations are worked by hand.
 */
test('A MEDIUM THAT STARTS AT A DISTANCE FOGS NOTHING BEFORE IT AND ONLY THE AIR PAST IT', () => {
  const air: FogOptions = { ...CLEAR, density: 0.1, near: 10 };
  expect(mediumFog(air, 5, 0)).toBe(0);
  expect(mediumFog(air, 10, 0)).toBe(0);
  /* Twenty metres of 0.1 per metre: 1 - e^-2, times the level ray's guard — (1 - e^-1e-4)/1e-4,
     the 8 mm of a scale height every flat ray has always been integrated with. */
  const level = (1 - Math.exp(-1e-4)) / 1e-4;
  expect(mediumFog(air, 30, 0)).toBeCloseTo(1 - Math.exp(-2 * level), 9);
  /* A ray climbing 10 m over 20, haze thinning 0.1 a metre, starting 10 m out: the density at the
     start point (height 5) carried over the last ten metres, ∫₁₀²⁰ 0.1·e^(−0.05t) dt = 0.477302. */
  const thinning: FogOptions = { ...air, heightFalloff: 0.1 };
  expect(mediumFog(thinning, 20, 10)).toBeCloseTo(1 - Math.exp(-0.477302), 6);
});

test('A MEDIUM WITH NO START IS THE EXPRESSION IT ALWAYS WAS, TO THE BIT', () => {
  const air: FogOptions = { ...CLEAR, density: 0.03, heightFalloff: 0.07, eyeY: 2 };
  for (const [dist, y] of [
    [5, 1],
    [40, 12],
    [300, -3],
  ] as const) {
    const t = (y - 2) * 0.07;
    const denom = Math.abs(t) < 1e-4 ? 1e-4 : t;
    expect(mediumFog(air, dist, y)).toBe(
      1 - Math.exp((-0.03 * dist * (1 - Math.exp(-denom))) / denom),
    );
  }
});

test('TWO LAYERS SUM ALONG THE RAY, EACH THINNING BY ITS OWN HEIGHT', () => {
  /*
   * On a level ray each layer is its density times the distance, times the level ray's guard,
   * (1 − e^-1e-4) / 1e-4 = 0.99995: 0.01 and 0.02 over 50 m is an optical depth of 1.4999250, and
   * the fog 1 − e^-1.4999250 = 0.776853. On a ray climbing 20 m over 100 m
   * through the second layer alone, falloff 0.05, the climb is one scale height, so the layer gives
   * 0.01 · 100 · (1 − e^-1) / 1 = 0.632121 and the fog 1 − e^-0.632121 = 0.468536. Without the
   * second layer the first is what it always was.
   */
  const both: FogOptions = { ...CLEAR, density: 0.01, density2: 0.02, heightFalloff2: 0.05 };
  expect(mediumFog(both, 50, 0)).toBeCloseTo(0.776853, 6);
  const second: FogOptions = { ...CLEAR, density2: 0.01, heightFalloff2: 0.05 };
  expect(mediumFog(second, 100, 20)).toBeCloseTo(0.468536, 5);
  expect(mediumFog({ ...CLEAR, density: 0.01 }, 50, 0)).toBeCloseTo(0.393454, 6);
});

test('THE HAZE LEAVES ITS FLOOR OF A SURFACE, AND HIDES NOTHING PAST ITS CUTOFF', () => {
  /*
   * A floor of 0.2 is a haze that may hide at most 0.8: a wall behind a hundred metres of air at
   * density 1 keeps a fifth of itself, where without the floor it keeps e^-100. In the linear ramp
   * too. Past a cutoff of 100 m nothing is hidden at all, in either mode, and short of it the haze
   * is what it was.
   */
  const thick: FogOptions = { ...CLEAR, density: 1 };
  expect(mediumFog({ ...thick, floor: 0.2 }, 100, 0)).toBeCloseTo(0.8, 12);
  expect(mediumFog(thick, 100, 0)).toBe(1);
  const ramp: FogOptions = { ...CLEAR, mode: LINEAR_FOG, near: 0, far: 10 };
  expect(mediumFog({ ...ramp, floor: 0.2 }, 50, 0)).toBeCloseTo(0.8, 12);
  const air: FogOptions = { ...CLEAR, density: 0.01, cutoff: 100 };
  expect(mediumFog(air, 101, 0)).toBe(0);
  expect(mediumFog(air, 99, 0)).toBeCloseTo(0.628405, 6);
  expect(mediumFog({ ...ramp, cutoff: 100 }, 101, 0)).toBe(0);
});

test('THE SUN GLOWS IN THE HAZE PAST ITS START, ABOUT ITS DIRECTION AND NOWHERE ELSE', () => {
  /*
   * A level ray of 100 m through haze of 0.01 a metre, the glow beginning 20 m out: the haze over
   * the last 80 m, at 0.01 times the level ray's guard of 0.99995 a metre, hides 1 − e^-0.799960 =
   * 0.550653 of the light. Looking at 0.8 of the way toward the sun at exponent 2 the lobe is 0.64,
   * so a glow of (1, 0.5, 0.25) adds (0.352418, 0.176209, 0.088104). Away from the sun, in a linear ramp, past the cutoff and inside the start it adds
   * none; half under water, half.
   */
  const glowing: FogOptions = {
    ...CLEAR,
    density: 0.01,
    glowColour: [1, 0.5, 0.25],
    glowExponent: 2,
    glowDirection: [0, 0, 1],
    glowStart: 20,
  };
  const out: [number, number, number] = [0, 0, 0];
  const toward = [0.6, 0, 0.8];
  const glow = (fog: FogOptions, dist: number, at: ArrayLike<number>): number[] => [
    ...mediumGlow(fog, dist, 0, at, out),
  ];
  const near = (actual: number[], expected: number[]): void =>
    actual.forEach((v, i) => expect(v).toBeCloseTo(expected[i] as number, 5));
  near(glow(glowing, 100, toward), [0.352418, 0.176209, 0.088104]);
  near(glow(glowing, 100, [0, 0, -1]), [0, 0, 0]);
  near(glow({ ...glowing, mode: LINEAR_FOG }, 100, toward), [0, 0, 0]);
  near(glow({ ...glowing, cutoff: 90 }, 100, toward), [0, 0, 0]);
  near(glow(glowing, 15, toward), [0, 0, 0]);
  near(glow({ ...glowing, underwaterFactor: 0.5 }, 100, toward), [0.176209, 0.088104, 0.044052]);
});

test('AN ATMOSPHERE RESOLVES ITS SECOND LAYER AT THE EYE, ITS FLOOR AND ITS GLOW TOWARD THE SUN', () => {
  /*
   * A second layer of 0.02 at y 10, falloff 0.1, seen from y 0 is 0.02 · e^1 = 0.0543656 at the
   * eye. A most of 0.8 is a floor of 0.2, and none is no floor. The glow takes the environment's
   * sun where it names no direction, as a unit vector, and in a linear ramp there is none.
   */
  const air = {
    fogColor: [0.7, 0.8, 0.9] as [number, number, number],
    fogDensity: 0.01,
    fogHeightFalloff: 0,
    fogBaseY: 0,
    fogLayer2: { density: 0.02, heightFalloff: 0.1, baseY: 10 },
    fogMaxOpacity: 0.8,
    fogCutoff: 300,
    fogSunGlow: { color: [1, 0.9, 0.7] as [number, number, number], exponent: 8, start: 5 },
    directionalDir: [0, 3, 4] as [number, number, number],
    underwater: null,
  };
  const fog = atmosphereFog(air, 0, false, createFogTarget());
  expect(fog.density2).toBeCloseTo(0.0543656, 6);
  expect(fog.heightFalloff2).toBeCloseTo(0.1, 6);
  expect(fog.floor).toBeCloseTo(0.2, 6);
  expect(fog.cutoff).toBe(300);
  expect(fog.glowColour.map((c) => Math.round(c * 1000) / 1000)).toEqual([1, 0.9, 0.7]);
  expect(fog.glowDirection.map((c) => Math.round(c * 1000) / 1000)).toEqual([0, 0.6, 0.8]);
  expect(fog.glowExponent).toBe(8);
  expect(fog.glowStart).toBe(5);
  const plain = atmosphereFog(
    { ...air, fogMaxOpacity: undefined, fogMode: 'linear' as const },
    0,
    false,
    createFogTarget(),
  );
  expect(plain.floor).toBe(0);
  expect(plain.density2).toBe(0);
  expect(plain.glowColour).toEqual([0, 0, 0]);
});
