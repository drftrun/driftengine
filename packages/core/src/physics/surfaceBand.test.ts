import { expect, test } from 'vitest';
import { BoxSurface } from './boxSurface.ts';
import { CompositeSurface } from './compositeSurface.ts';
import { createSurfaceHit } from './ribbonSurface.ts';
import type { SurfaceBox } from './boxSurface.ts';

/*
 * `sampleBand` answers a different question from `sample`, and the difference is the
 * whole reason it exists. `sample` asks "what am I standing on" and scores candidates
 * by nearness to the asker, with a tie-break *against* anything above them. That rule
 * cannot answer "is there a floor in the way", because the floor in the way is above
 * the asker by definition — the tie-break is pointed at exactly the answer wanted.
 */

function pad(topY: number, over: Partial<SurfaceBox> = {}): SurfaceBox {
  return {
    minX: -5,
    maxX: 5,
    minZ: -5,
    maxZ: 5,
    topY,
    distanceM: 0,
    tangentX: 1,
    tangentZ: 0,
    ...over,
  };
}

test('a floor inside the band is found however far above the asker it is', () => {
  /*
   * The measured defect, as a unit. A character's feet at 0 with a deck at 1.0 is a wall
   * they must not walk into — and `sample` asked from just above the step ceiling
   * hands back the deck at 0 instead, because 1.0 is penalised for being overhead.
   */
  const surface = new CompositeSurface([new BoxSurface([pad(0)]), new BoxSurface([pad(1)])]);
  const hit = createSurfaceHit();

  expect(surface.sampleBand(0, 0, hit, 0.6, 1.7)).toBe(true);
  expect(hit.y).toBeCloseTo(1);
});

test('the highest floor in the band wins, so a stack resolves to its top', () => {
  const surface = new CompositeSurface([
    new BoxSurface([pad(0)]),
    new BoxSurface([pad(0.3)]),
    new BoxSurface([pad(0.5)]),
  ]);
  const hit = createSurfaceHit();

  expect(surface.sampleBand(0, 0, hit, 0.01, 0.6)).toBe(true);
  expect(hit.y).toBeCloseTo(0.5);
});

test('a floor outside the band is not a floor in the band', () => {
  const surface = new CompositeSurface([new BoxSurface([pad(0)]), new BoxSurface([pad(2.5)])]);
  const hit = createSurfaceHit();

  // Underfoot is below the band; the flyover is above it. Neither is in the way.
  expect(surface.sampleBand(0, 0, hit, 0.6, 1.7)).toBe(false);
});

test('a flyover cannot hide the floor in the way beneath it', () => {
  /*
   * Why this is exact rather than scored. Under `sample`'s nearest-wins rule a deck at
   * 2.2 outscores the wall at 0.7 when asked from head height, and the wall vanishes.
   */
  const surface = new CompositeSurface([
    new BoxSurface([pad(0)]),
    new BoxSurface([pad(0.7)]),
    new BoxSurface([pad(2.2)]),
  ]);
  const hit = createSurfaceHit();

  expect(surface.sampleBand(0, 0, hit, 0.6, 1.7)).toBe(true);
  expect(hit.y).toBeCloseTo(0.7);
});

test('the band is half-open, so a floor exactly at the ceiling is above it', () => {
  const surface = new BoxSurface([pad(1.7)]);
  const hit = createSurfaceHit();

  expect(surface.sampleBand(0, 0, hit, 0.6, 1.7)).toBe(false);
  expect(surface.sampleBand(0, 0, hit, 0.6, 1.71)).toBe(true);
});

test('a column with no floor at all answers no', () => {
  const surface = new CompositeSurface([new BoxSurface([pad(1)])]);
  const hit = createSurfaceHit();

  expect(surface.sampleBand(50, 50, hit, 0, 10)).toBe(false);
});

test('the hit a band query fills describes the floor it found', () => {
  const surface = new BoxSurface([pad(1.2, { distanceM: 42, tangentX: 0, tangentZ: 1 })]);
  const hit = createSurfaceHit();

  expect(surface.sampleBand(0, 0, hit, 0.6, 1.7)).toBe(true);
  expect(hit.y).toBeCloseTo(1.2);
  expect(hit.normalY).toBe(1);
  expect(hit.distanceM).toBe(42);
  expect(hit.tangentZ).toBe(1);
});
