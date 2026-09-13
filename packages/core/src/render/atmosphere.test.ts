import { describe, expect, test } from 'vitest';
import { fogDensityAtEye, resolveAtmosphere } from './atmosphere.ts';
import type { Atmosphere, ResolvedAtmosphere } from './atmosphere.ts';

/*
 * **The medium is selected once, in numbers, and bound by whoever is drawing.**
 * `bindAtmosphere` exists so "mesh, sky, water and plume programs cannot drift into separate
 * medium-selection rules" — its own words — and a second backend that cannot call it, having
 * no `WebGL2RenderingContext`, is precisely the drift that was written against. So the
 * selection lives in `resolveAtmosphere` and the GL binder is one caller of it.
 *
 * Still arithmetic rather than appearance, which is what AGENTS.md allows to be tested: a
 * mode flag inverted, or an underwater slot left holding a stale colour, reaches the frame
 * without anything raising.
 */
describe('resolving the camera medium', () => {
  const air: Atmosphere = {
    fogColor: [0.5, 0.6, 0.7],
    fogDensity: 0.02,
    fogHeightFalloff: 0.1,
    fogBaseY: 0,
    underwater: null,
  };
  const out = (): ResolvedAtmosphere => ({
    fogColor: new Float32Array(3),
    underwaterColor: new Float32Array(3),
    fogDensity: 0,
    fogHeightFalloff: 0,
    fogEyeY: 0,
    fogMode: 0,
    fogNear: 0,
    fogFar: 0,
    underwaterFogDensity: 0,
    underwaterFactor: 0,
  });

  test('thins the haze with eye height, exactly as fogDensityAtEye does', () => {
    const r = resolveAtmosphere(air, 10, false, out());
    expect(r.fogDensity).toBeCloseTo(fogDensityAtEye(air, 10));
    expect(r.fogEyeY).toBe(10);
    /* Component-wise: the target is a Float32Array and 0.6 is not exact in it. */
    [0.5, 0.6, 0.7].forEach((v, i) => expect(r.fogColor[i]).toBeCloseTo(v));
  });

  /* Absent means exponential, which is what every existing world is authored against. */
  test('reports linear mode as 1 and anything else as 0', () => {
    expect(resolveAtmosphere(air, 0, false, out()).fogMode).toBe(0);
    const linear: Atmosphere = { ...air, fogMode: 'linear', fogNear: 5, fogFar: 90 };
    const r = resolveAtmosphere(linear, 0, false, out());
    expect(r.fogMode).toBe(1);
    expect(r.fogNear).toBe(5);
    expect(r.fogFar).toBe(90);
  });

  /*
   * With no water authored the underwater slots still have to hold something: the shader
   * multiplies by the factor rather than branching on it, so a stale colour or a NaN there
   * reaches the frame even when the factor is zero.
   */
  test('falls back to the air medium when nothing is submerged', () => {
    const r = resolveAtmosphere(air, 0, true, out());
    expect(r.underwaterFactor).toBe(0);
    [0.5, 0.6, 0.7].forEach((v, i) => expect(r.underwaterColor[i]).toBeCloseTo(v));
    expect(r.underwaterFogDensity).toBe(0.02);
  });

  test('ramps across the transition band, and only when the profile allows it', () => {
    const sea: Atmosphere = {
      ...air,
      underwater: { surfaceY: 0, color: [0, 0.3, 0.4], fogDensity: 0.4, transitionDepth: 2 },
    };
    expect(resolveAtmosphere(sea, 4, true, out()).underwaterFactor).toBe(0);
    expect(resolveAtmosphere(sea, 0, true, out()).underwaterFactor).toBeCloseTo(0.5);
    expect(resolveAtmosphere(sea, -4, true, out()).underwaterFactor).toBe(1);
    /* The profile's own switch wins over the world having water in it. */
    expect(resolveAtmosphere(sea, -4, false, out()).underwaterFactor).toBe(0);
  });
});

/**
 * The one part of the medium that is arithmetic rather than appearance.
 *
 * AGENTS.md forbids testing how something looks, and nothing here does: the curve, the
 * colour and the crossfade all live in GLSL and are verified by eye. What is asserted is
 * the *direction and size* of the height falloff — a sign that can be inverted silently,
 * producing a world that gets foggier the higher you climb, which reads as "the fog is
 * wrong somehow" and takes a browser session to pin down. Expectations are hand-derived
 * from `exp(±1)`, never from the function under test.
 */
function atmosphere(overrides: Partial<Atmosphere> = {}): Atmosphere {
  return {
    fogColor: [0, 0, 0],
    fogDensity: 0.01,
    fogHeightFalloff: 0,
    fogBaseY: 0,
    underwater: null,
    ...overrides,
  };
}

describe('fogDensityAtEye', () => {
  test('a uniform medium is the density it was given, at any height', () => {
    const air = atmosphere({ fogDensity: 0.0133 });
    expect(fogDensityAtEye(air, 0)).toBe(0.0133);
    expect(fogDensityAtEye(air, 231)).toBe(0.0133);
    expect(fogDensityAtEye(air, -40)).toBe(0.0133);
  });

  test('one scale height above the base is one e-fold thinner', () => {
    // Base at the sea, 80 m of scale height: an eye at 78.2 stands exactly 80 m up,
    // so the air around it is 1/e of the density quoted at the sea.
    const air = atmosphere({ fogHeightFalloff: 1 / 80, fogBaseY: -1.8 });
    expect(fogDensityAtEye(air, 78.2)).toBeCloseTo(0.01 * 0.36787944117, 12);
    // And two scale heights is 1/e², which is the whole point: it compounds.
    expect(fogDensityAtEye(air, 158.2)).toBeCloseTo(0.01 * 0.13533528324, 12);
  });

  test('below the base the haze thickens, by the same law', () => {
    const air = atmosphere({ fogHeightFalloff: 1 / 80, fogBaseY: -1.8 });
    expect(fogDensityAtEye(air, -81.8)).toBeCloseTo(0.01 * 2.71828182846, 11);
  });

  test('the base is where the density is quoted, not the origin', () => {
    // Same eye, two bases: standing *at* the base is always the quoted density,
    // which is what makes the base a meaningful place rather than an offset.
    const sea = atmosphere({ fogHeightFalloff: 1 / 80, fogBaseY: -1.8 });
    const deck = atmosphere({ fogHeightFalloff: 1 / 80, fogBaseY: 45.5 });
    expect(fogDensityAtEye(sea, -1.8)).toBeCloseTo(0.01, 12);
    expect(fogDensityAtEye(deck, 45.5)).toBeCloseTo(0.01, 12);
    expect(fogDensityAtEye(sea, 45.5)).toBeLessThan(fogDensityAtEye(deck, 45.5));
  });
});
