import { expect, test } from 'vitest';
import { createWindState, sampleWind } from './wind.ts';
import type { WindProfile } from './wind.ts';

const PROFILE: WindProfile = {
  directionX: 0.8,
  directionZ: -0.6,
  baseSpeed: 4,
  gustSpeed: 2.5,
  directionWander: 0.4,
  cycleSeconds: 42,
  phase: 3.1,
};

test('wind repeats continuously at the declared cycle boundary', () => {
  /*
   * A run is recorded and replayed. A replay watched an hour later must meet the
   * same gust its character did, and a signal built from non-integer harmonics
   * looks organic while never actually closing — so the replay would drift from
   * the run with nothing to point at.
   */
  const a = createWindState();
  const b = createWindState();
  sampleWind(PROFILE, 17.25, a);
  sampleWind(PROFILE, 17.25 + PROFILE.cycleSeconds, b);

  expect(b.velocityX).toBeCloseTo(a.velocityX, 6);
  expect(b.velocityZ).toBeCloseTo(a.velocityZ, 6);
  expect(b.gust).toBeCloseTo(a.gust, 6);
});

test('sampled wind stays finite, consistent and inside its speed bounds', () => {
  const out = createWindState();
  for (let t = 0; t <= PROFILE.cycleSeconds; t += 0.25) {
    sampleWind(PROFILE, t, out);
    expect(Number.isFinite(out.speed)).toBe(true);
    expect(out.speed).toBeGreaterThanOrEqual(Math.max(0, PROFILE.baseSpeed - PROFILE.gustSpeed));
    expect(out.speed).toBeLessThanOrEqual(PROFILE.baseSpeed + PROFILE.gustSpeed);
    // The velocity must agree with the speed it reports, or consumers that use
    // one and consumers that use the other disagree about the same weather.
    expect(Math.hypot(out.velocityX, out.velocityZ)).toBeCloseTo(out.speed, 6);
  }
});

test('a still profile never produces negative wind', () => {
  // A gust larger than the base is legitimate — a calm day with real gusts —
  // and must lull to zero rather than reverse.
  const out = createWindState();
  const gusty: WindProfile = { ...PROFILE, baseSpeed: 1, gustSpeed: 3 };
  for (let t = 0; t <= gusty.cycleSeconds; t += 0.1) {
    sampleWind(gusty, t, out);
    expect(out.speed).toBeGreaterThanOrEqual(0);
  }
});

test('a zero cycle is rejected rather than producing a division by zero', () => {
  // Fails at init, loudly, instead of writing NaN into every foliage vertex.
  const out = createWindState();
  expect(() => sampleWind({ ...PROFILE, cycleSeconds: 0 }, 1, out)).toThrow();
});
