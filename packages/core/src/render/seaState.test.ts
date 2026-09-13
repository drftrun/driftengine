import { expect, test } from 'vitest';
import { seaStateForAgitation, seaStateForWind } from './seaState.ts';

test('a calm sea is flat, a gale is steep, and it never inverts', () => {
  expect(seaStateForWind(0).steepness).toBeLessThan(seaStateForWind(6).steepness);

  let previous = -1;
  for (let speed = 0; speed <= 25; speed += 0.5) {
    const s = seaStateForWind(speed).steepness;
    expect(s, `speed ${speed}`).toBeGreaterThanOrEqual(previous);
    previous = s;
  }
});

test('the swell saturates rather than growing without limit', () => {
  /*
   * Load-bearing rather than theoretical. The islands sit about 1.8 m above the
   * waterline, so a swell that keeps growing with the wind eventually washes
   * over the route — at which point a weather effect has become a movement bug,
   * and one that only appears on the windiest days.
   */
  expect(seaStateForWind(1e6).steepness).toBeLessThanOrEqual(1.35);
  expect(seaStateForWind(50).steepness).toBeCloseTo(seaStateForWind(7).steepness, 6);
});

test('a dead calm is still water, not glass', () => {
  // Zero steepness would freeze the surface into a mirror, which reads as a
  // rendering failure rather than as a still day.
  expect(seaStateForWind(0).steepness).toBeGreaterThan(0.2);
});

test('whitecaps need real wind', () => {
  expect(seaStateForWind(0).foam).toBe(0);
  expect(seaStateForWind(1.5).foam, 'ripples do not break').toBe(0);
  expect(seaStateForWind(7).foam).toBeGreaterThan(0.9);
});

test('a body with its own agitation matches the wind that would have caused it', () => {
  /*
   * The two entry points must agree at the ends, or an indoor pool and an outdoor one at
   * the same roughness would look different for no reason a player could name — and the
   * whole point of the override is *where the number comes from*, not a second feel.
   *
   * Hand-derived from the module's own floor and ceiling: still water sits at
   * MINIMUM_STEEPNESS and fully agitated at MAXIMUM_STEEPNESS, which is exactly where a
   * dead calm and a fully developed sea sit.
   */
  expect(seaStateForAgitation(0).steepness).toBeCloseTo(seaStateForWind(0).steepness, 10);
  expect(seaStateForAgitation(1).steepness).toBeCloseTo(seaStateForWind(100).steepness, 10);
});

test('still water is calm, not glass, and does not break', () => {
  // Dead-flat water reads as a mirror rather than as calm, so the floor is above zero.
  const still = seaStateForAgitation(0);
  expect(still.steepness).toBeGreaterThan(0);
  expect(still.foam).toBe(0);
  // Clamped, so a caller passing nonsense cannot drive the surface past its ceiling.
  expect(seaStateForAgitation(4).steepness).toBe(seaStateForAgitation(1).steepness);
  expect(seaStateForAgitation(-1).steepness).toBe(seaStateForAgitation(0).steepness);
});
