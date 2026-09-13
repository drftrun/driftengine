import { describe, expect, it } from 'vitest';

import { damp, dampTracking } from './scalar.ts';

/**
 * The contract `damp` cannot hold, stated as arithmetic rather than as a camera.
 *
 * `damp` solves `a' = lambda (b - a)` for a target that holds still across the interval. For one
 * that is moving the solution is different, and the difference is a function of `dt` — which is
 * what makes it a frame-rate dependence rather than a constant offset somebody could tune out.
 *
 * Expectations here are hand-derived from the closed form and never from the code under test:
 * the settled gap of the exact solution is `v/lambda`, and the hold's is `v dt (1-k)/k` for
 * `k = 1 - exp(-lambda dt)`.
 */
describe('damping toward a target that is moving', () => {
  const V = 25;
  const LAMBDA = 8;

  /** Run a ramp long enough to settle, and answer the gap the follower holds. */
  function settledGap(
    step: (a: number, b: number, dt: number) => number,
    dtOf: (i: number) => number,
    steps = 4000,
  ): { gap: number; swing: number } {
    let a = 0;
    let b = 0;
    let low = Infinity;
    let high = -Infinity;
    for (let i = 0; i < steps; i++) {
      const dt = dtOf(i);
      b += V * dt;
      a = step(a, b, dt);
      if (i > steps / 2) {
        const gap = b - a;
        if (gap < low) low = gap;
        if (gap > high) high = gap;
      }
    }
    return { gap: b - a, swing: high - low };
  }

  const tracking = (a: number, b: number, dt: number) => dampTracking(a, b, V, LAMBDA, dt);
  const holding = (a: number, b: number, dt: number) => damp(a, b, LAMBDA, dt);

  it('settles at v/lambda whatever the frame time is', () => {
    const exact = V / LAMBDA;
    expect(settledGap(tracking, () => 1 / 60).gap).toBeCloseTo(exact, 6);
    expect(settledGap(tracking, () => 1 / 28).gap).toBeCloseTo(exact, 6);
    expect(settledGap(tracking, () => 1 / 144).gap).toBeCloseTo(exact, 6);
  });

  /**
   * The hold's own numbers, asserted so the difference is on the record rather than implied.
   *
   * `v dt (1-k)/k` at 60 Hz is 2.921 m and at 28 Hz is 2.700 m, against an exact 3.125 m at both.
   * That 22 cm is a camera re-framing itself because a machine got slower.
   */
  it('is what a zero-order hold cannot do, and the gap it settles at moves with the rate', () => {
    const at = (dt: number) => {
      const k = 1 - Math.exp(-LAMBDA * dt);
      return (V * dt * (1 - k)) / k;
    };
    expect(settledGap(holding, () => 1 / 60).gap).toBeCloseTo(at(1 / 60), 6);
    expect(settledGap(holding, () => 1 / 28).gap).toBeCloseTo(at(1 / 28), 6);
    expect(Math.abs(at(1 / 60) - at(1 / 28))).toBeGreaterThan(0.2);
  });

  it('holds the gap still through uneven frames, where the hold breathes', () => {
    const jitter = (i: number) => (i % 2 === 0 ? 1 / 35 + 0.02 : 1 / 35 - 0.02);
    expect(settledGap(tracking, jitter).swing, 'nothing left for jitter to move').toBeLessThan(
      1e-9,
    );
    expect(settledGap(holding, jitter).swing, 'and the hold does move').toBeGreaterThan(0.01);
  });

  it('is damp exactly when the target is not moving, and refuses a lambda it cannot divide by', () => {
    expect(dampTracking(1, 5, 0, 3, 0.02)).toBeCloseTo(damp(1, 5, 3, 0.02), 12);
    expect(dampTracking(1, 5, 2, 0, 0.02), 'no pull, no movement').toBe(1);
    expect(dampTracking(1, 5, 2, -1, 0.02)).toBe(1);
  });
});
