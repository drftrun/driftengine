import { expect, test } from 'vitest';
import {
  createDaylightPalette,
  createDaylightState,
  easeExposure,
  resolveDaylight,
} from './daylight.ts';
import type { DaylightKey } from './daylight.ts';

/**
 * A palette of lighting keyed by one number, and an exposure that follows it in time.
 *
 * The expectations are written by hand from the keys: a key is a set of literals, the answer
 * between two of them is the linear blend a reader can do on paper, and exposure blends in stops.
 */

function key(at: number, level: number, exposure: number): DaylightKey {
  return {
    at,
    sunColor: [level, level, level],
    moonColor: [0, 0, 0],
    skyTop: [level, 0, 0],
    skyHorizon: [0, level, 0],
    skyDeep: [0, 0, level],
    ambient: [level, level, level],
    ambientGround: [level / 2, level / 2, level / 2],
    fogColor: [level, level, level],
    fogDensity: level / 100,
    shadowStrength: level,
    emissiveGain: 1 - level,
    exposure,
  };
}

test('BETWEEN TWO KEYS EVERY FIELD IS THEIR BLEND, and exposure blends in stops', () => {
  const palette = createDaylightPalette([key(-10, 0, 4), key(30, 1, 1)]);
  const out = createDaylightState();
  /* A quarter of the way from -10 to 30. */
  resolveDaylight(0, palette, out);
  expect(out.sunColor).toEqual([0.25, 0.25, 0.25]);
  expect(out.skyTop).toEqual([0.25, 0, 0]);
  expect(out.skyHorizon).toEqual([0, 0.25, 0]);
  expect(out.skyDeep).toEqual([0, 0, 0.25]);
  expect(out.ambientGround).toEqual([0.125, 0.125, 0.125]);
  expect(out.fogDensity).toBeCloseTo(0.0025, 12);
  expect(out.shadowStrength).toBeCloseTo(0.25, 12);
  expect(out.emissiveGain).toBeCloseTo(0.75, 12);
  /* 4 is two stops over 1; a quarter of the way is a half-stop down from 4: 4 / 2^0.5. */
  expect(out.exposure).toBeCloseTo(4 / Math.SQRT2, 12);
});

test('outside the keys the nearest one holds, rather than the blend running on', () => {
  const palette = createDaylightPalette([key(-10, 0, 4), key(30, 1, 1)]);
  const out = createDaylightState();
  resolveDaylight(-90, palette, out);
  expect(out.sunColor).toEqual([0, 0, 0]);
  expect(out.exposure).toBe(4);
  resolveDaylight(90, palette, out);
  expect(out.sunColor).toEqual([1, 1, 1]);
  expect(out.exposure).toBe(1);
});

test('the keys may arrive in any order, and a repeated or empty key list is refused', () => {
  const palette = createDaylightPalette([key(30, 1, 1), key(-10, 0, 4), key(10, 0.5, 2)]);
  const out = createDaylightState();
  resolveDaylight(20, palette, out);
  expect(out.sunColor).toEqual([0.75, 0.75, 0.75]);
  expect(() => createDaylightPalette([])).toThrow(/at least one key/);
  expect(() => createDaylightPalette([key(5, 0, 1), key(5, 1, 1)])).toThrow(/two keys at 5/);
  expect(() => createDaylightPalette([key(0, 0, 0)])).toThrow(/exposure/);
});

test('A SINGLE KEY IS THE WHOLE PALETTE', () => {
  const palette = createDaylightPalette([key(0, 0.6, 2)]);
  const out = createDaylightState();
  resolveDaylight(-40, palette, out);
  expect(out.sunColor).toEqual([0.6, 0.6, 0.6]);
  expect(out.exposure).toBe(2);
});

test('EXPOSURE EASES BY TIME, SO THE FRAME RATE DOES NOT CHANGE HOW FAST THE EYE ADAPTS', () => {
  /* One half-life closes half the distance in stops: from 1 toward 4 is two stops, so one stop. */
  expect(easeExposure(1, 4, 1, 1)).toBeCloseTo(2, 12);
  let at60 = 1;
  for (let i = 0; i < 60; i++) at60 = easeExposure(at60, 4, 1 / 60, 1);
  let at144 = 1;
  for (let i = 0; i < 144; i++) at144 = easeExposure(at144, 4, 1 / 144, 1);
  expect(at60).toBeCloseTo(2, 10);
  expect(at144).toBeCloseTo(2, 10);
  /* No time, no change; a half-life of zero is a cut. */
  expect(easeExposure(1, 4, 0, 1)).toBe(1);
  expect(easeExposure(1, 4, 1 / 60, 0)).toBe(4);
});
