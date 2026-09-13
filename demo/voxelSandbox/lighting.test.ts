import { describe, expect, it } from 'vitest';

import { Lighting } from './lighting';

/* The phase convention, from the reference: 0 is midnight, 0.25 sunrise, 0.5 noon. */
const MIDNIGHT = 0;
const NOON = 0.5;

describe('the day-night clock', () => {
  it('returns to where it started after one full day', () => {
    const lighting = new Lighting({ dayLengthSec: 150, startTimeOfDay: 0.25 });
    const before = lighting.snapshot().sunDir[1];
    for (let i = 0; i < 150 * 60; i++) lighting.tick(1 / 60);
    expect(lighting.snapshot().sunDir[1]).toBeCloseTo(before, 3);
  });

  it('puts the sun above the horizon at noon and below it at midnight', () => {
    expect(
      new Lighting({ dayLengthSec: 150, startTimeOfDay: NOON }).snapshot().sunDir[1],
    ).toBeGreaterThan(0);
    expect(
      new Lighting({ dayLengthSec: 150, startTimeOfDay: MIDNIGHT }).snapshot().sunDir[1],
    ).toBeLessThan(0);
  });

  it('reaches full night factor when the sun is down', () => {
    /* Emissive is gated on this, so a nightFactor stuck at zero means block light never shows
       and the mesher looks wrong instead of the clock. */
    expect(
      new Lighting({ dayLengthSec: 150, startTimeOfDay: MIDNIGHT }).snapshot().nightFactor,
    ).toBeGreaterThan(0.9);
    expect(
      new Lighting({ dayLengthSec: 150, startTimeOfDay: NOON }).snapshot().nightFactor,
    ).toBeLessThan(0.1);
  });

  it('turns the sun off below the horizon', () => {
    const night = new Lighting({ dayLengthSec: 150, startTimeOfDay: MIDNIGHT }).snapshot();
    expect(Math.max(...night.sunColor)).toBeLessThan(0.02);
  });

  it('never lets fog or zenith reach pure black', () => {
    /* A world at midnight still has to be readable, and a fog colour of zero is a hole rather
       than a night sky. */
    const night = new Lighting({ dayLengthSec: 150, startTimeOfDay: MIDNIGHT }).snapshot();
    expect(Math.max(...night.fogColor)).toBeGreaterThan(0);
    expect(Math.max(...night.zenithColor)).toBeGreaterThan(0);
  });

  it('allocates nothing per tick', () => {
    /* The snapshot is a view of fields the clock owns, not a fresh object each frame. */
    const lighting = new Lighting({ dayLengthSec: 150 });
    const first = lighting.snapshot();
    lighting.tick(1 / 60);
    expect(lighting.snapshot()).toBe(first);
    expect(lighting.snapshot().sunDir).toBe(first.sunDir);
  });

  it('reads a clock a person can compare against the reference', () => {
    expect(new Lighting({ dayLengthSec: 150, startTimeOfDay: NOON }).clockText()).toBe('12:00');
    expect(new Lighting({ dayLengthSec: 150, startTimeOfDay: MIDNIGHT }).clockText()).toBe('00:00');
  });
});
