import { describe, expect, it } from 'vitest';
import { STANDARD_TEMPERATURE } from './species.ts';
import {
  MAX_MODEL_TEMPERATURE,
  MIN_MODEL_TEMPERATURE,
  sensibleEnthalpy,
  temperatureFromCapacity,
} from './thermal.ts';

describe('sensibleEnthalpy', () => {
  it('is zero at the standard state, whatever the heat capacity', () => {
    expect(sensibleEnthalpy(4182, 0, STANDARD_TEMPERATURE)).toBe(0);
    expect(sensibleEnthalpy(1996, 0.4, STANDARD_TEMPERATURE)).toBe(0);
  });

  it('is the heat capacity times the rise, where the capacity is constant', () => {
    expect(sensibleEnthalpy(4182, 0, STANDARD_TEMPERATURE + 10)).toBeCloseTo(41820, 9);
    expect(sensibleEnthalpy(4182, 0, STANDARD_TEMPERATURE - 25)).toBeCloseTo(-104550, 9);
  });

  it('integrates a rising capacity exactly rather than sampling it', () => {
    /* `cp = a + b·ΔT` integrates to `a·ΔT + b·ΔT²/2`, and that is arithmetic rather than a table —
       which is the whole reason the curve this replaces could be retired. */
    const dT = 75;
    expect(sensibleEnthalpy(1996, 0.4, STANDARD_TEMPERATURE + dT)).toBeCloseTo(
      1996 * dT + (0.4 * dT * dT) / 2,
      9,
    );
  });
});

describe('temperatureFromCapacity', () => {
  it('inverts a constant capacity exactly', () => {
    /* Two kilograms of water: A = 2 × 4182 J/K. */
    const A = 2 * 4182;
    expect(temperatureFromCapacity(A, 0, A * 10)).toBeCloseTo(STANDARD_TEMPERATURE + 10, 9);
    expect(temperatureFromCapacity(A, 0, 0)).toBeCloseTo(STANDARD_TEMPERATURE, 12);
    expect(temperatureFromCapacity(A, 0, -A * 25)).toBeCloseTo(STANDARD_TEMPERATURE - 25, 9);
  });

  it('inverts a rising capacity in closed form, with one square root', () => {
    /*
     * **The whole reason this phase could reverse `§3`.** `h = A·ΔT + B·ΔT²/2` is a quadratic, so
     * inverting it is a formula rather than a search — and `Math.sqrt` is one of the two operations
     * ECMAScript specifies exactly, which is what lets it run on a tick at all.
     */
    const A = 1996;
    const B = 0.4;
    for (const dT of [-50, -1, 0, 1, 75, 400, 1500]) {
      const h = A * dT + (B * dT * dT) / 2;
      expect(temperatureFromCapacity(A, B, h), `ΔT ${dT}`).toBeCloseTo(
        STANDARD_TEMPERATURE + dT,
        6,
      );
    }
  });

  it('inverts a falling capacity too, taking the branch through the standard state', () => {
    const A = 2000;
    const B = -0.2;
    for (const dT of [-100, 0, 100, 500]) {
      const h = A * dT + (B * dT * dT) / 2;
      expect(temperatureFromCapacity(A, B, h), `ΔT ${dT}`).toBeCloseTo(
        STANDARD_TEMPERATURE + dT,
        6,
      );
    }
  });

  it('clamps to the range this model claims to know rather than extrapolating', () => {
    const A = 1000;
    expect(temperatureFromCapacity(A, 0, -1e12)).toBe(MIN_MODEL_TEMPERATURE);
    expect(temperatureFromCapacity(A, 0, 1e12)).toBe(MAX_MODEL_TEMPERATURE);
  });

  it('answers the standard state for something with no heat capacity at all', () => {
    /* An empty shell, or one holding nothing this model has a capacity for. A temperature is not a
       meaningful question there, and inventing one is worse than declining. */
    expect(temperatureFromCapacity(0, 0, 500)).toBe(STANDARD_TEMPERATURE);
    expect(temperatureFromCapacity(-1, 0, 500)).toBe(STANDARD_TEMPERATURE);
  });

  it('round-trips against sensibleEnthalpy for a mixture', () => {
    /* Half water and half steam by mass, which is what a boiling shell holds. */
    const A = 0.5 * 4182 + 0.5 * 1996;
    const B = 0.5 * 0 + 0.5 * 0.4;
    for (const dT of [-60, 0, 60, 300]) {
      const h = A * dT + (B * dT * dT) / 2;
      expect(temperatureFromCapacity(A, B, h)).toBeCloseTo(STANDARD_TEMPERATURE + dT, 6);
    }
  });
});
