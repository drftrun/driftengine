import { expect, test } from 'vitest';

import { lookAt } from '../testScene.ts';
import { cameraCentre, sh1Basis, splatColour, SH_C1, viewDirection } from './harmonics.ts';

/**
 * **The colour a Gaussian shows is the one the engine's shader would show it.** A capture is fitted
 * here and drawn there, so a band evaluated with a different sign or a different basis order is a
 * capture that looks right in the fitter and wrong in the game — and looks like a shader fault when
 * it gets there. Every expectation below is derived by hand from the shader's own line.
 */

test('THE DEGREE-1 BAND IS THE SHADER’S, basis for basis and sign for sign', () => {
  /* `SH_C1 * (-direction.y * c0 + direction.z * c1 - direction.x * c2)`, from splat.ts. */
  expect(SH_C1).toBe(0.4886025119029199);
  const basis = new Float64Array(3);
  sh1Basis([0, 0, 1], basis);
  expect(Array.from(basis)).toEqual([-0, SH_C1, -0]);
  sh1Basis([1, 0, 0], basis);
  expect(Array.from(basis)).toEqual([-0, 0, -SH_C1]);
  sh1Basis([0, 1, 0], basis);
  expect(Array.from(basis)).toEqual([-SH_C1, 0, -0]);
});

test('a colour is its constant term plus that band, and never below zero', () => {
  const colors = Float64Array.from([0.4, 0.5, 0.6]);
  /* Nine coefficients, interleaved by basis and then by channel, as `SplatSource.sh1` is. */
  const sh1 = Float64Array.from([0, 0, 0, 0.2, -0.4, 0, 0, 0, 0]);
  const basis = new Float64Array(3);
  const out = new Float64Array(3);
  sh1Basis([0, 0, 1], basis);
  splatColour(colors, sh1, 0, basis, out);
  /* Only the middle basis is lit, so red gains 0.4886 · 0.2 and green loses 0.4886 · 0.4. */
  expect(out[0]).toBeCloseTo(0.4 + SH_C1 * 0.2, 12);
  expect(out[1]).toBeCloseTo(0.5 - SH_C1 * 0.4, 12);
  expect(out[2]).toBe(0.6);

  /* Turn around and the same coefficients pull the other way: red loses what it gained, and
     green gains back what it lost. */
  sh1Basis([0, 0, -1], basis);
  splatColour(colors, sh1, 0, basis, out);
  expect(out[0]).toBeCloseTo(0.4 - SH_C1 * 0.2, 12);
  expect(out[1]).toBeCloseTo(0.5 + SH_C1 * 0.4, 12);

  /* A constant term the band would carry below zero stops at zero instead, which is the one thing
     the shader does that a plain sum does not — and is why the gradient has to know it happened. */
  sh1Basis([0, 0, 1], basis);
  const dark = Float64Array.from([0.4, 0.1, 0.6]);
  splatColour(dark, sh1, 0, basis, out);
  expect(0.1 - SH_C1 * 0.4).toBeLessThan(0);
  expect(out[1]).toBe(0);

  /* A Gaussian with no band of its own is its constant term, whatever the direction. */
  splatColour(colors, undefined, 0, basis, out);
  expect(Array.from(out)).toEqual([0.4, 0.5, 0.6]);
});

test('the direction is from the camera to the Gaussian, in the capture’s own world', () => {
  /* A camera four metres back along z, looking at the origin: its centre is where it was put. */
  const pose = lookAt([0, 0, -4], [0, 0, 0]);
  const centre = new Float64Array(3);
  cameraCentre(pose, centre);
  expect(centre[0]).toBeCloseTo(0, 12);
  expect(centre[1]).toBeCloseTo(0, 12);
  expect(centre[2]).toBeCloseTo(-4, 12);

  const positions = Float64Array.from([0, 0, 2]);
  const direction = new Float64Array(3);
  /* Six metres away along z, so the unit direction is z alone — and the distance is that six,
     which the band's gradient divides by. */
  expect(viewDirection(positions, 0, centre, direction)).toBe(6);
  expect(Array.from(direction)).toEqual([0, 0, 1]);

  /* A Gaussian at the camera itself has no direction to give, and answers with a fixed one
     rather than a division by zero. */
  const here = Float64Array.from([0, 0, -4]);
  expect(viewDirection(here, 0, centre, direction)).toBe(0);
  expect(Array.from(direction)).toEqual([0, 0, 1]);
});
