import { expect, test } from 'vitest';

import { createResolvedWater, resolveWater, waterAppearance } from './waterDraw.ts';
import type { WaterBody } from './waterRenderer.ts';

/** The grid numbers a renderer built with the defaults, so a test reads like a draw. */
const CELL = 3.90625;
const NEAR_HALF = 250;
const FAR_HALF = 4000;

const body = (extra: Partial<WaterBody> = {}): WaterBody => ({
  level: 0,
  deepColor: [0.02, 0.05, 0.08],
  shallowColor: [0.1, 0.2, 0.25],
  ...extra,
});

const resolve = (settings: WaterBody, cameraX = 0, cameraZ = 0, windX = 0, windZ = 0) =>
  resolveWater(
    settings,
    cameraX,
    cameraZ,
    CELL,
    NEAR_HALF,
    FAR_HALF,
    windX,
    windZ,
    createResolvedWater(),
  );

/**
 * The ocean is the case every other one is measured against, so it is asserted first: nothing
 * about it may change when a bounded body grows an axis or a direction.
 */
test('an unbounded body is the camera-following ocean', () => {
  const w = resolve(body(), 1000, -1000);
  expect(w.bounded).toBe(false);
  /* Snapped to whole cells: 1000 / 3.90625 is 256 exactly, and −1000 is −256. */
  expect(Array.from(w.origin)).toEqual([1000, -1000]);
  expect(Array.from(w.span), 'the ocean grid is authored in metres').toEqual([1, 1]);
  expect(Array.from(w.half)).toEqual([FAR_HALF, FAR_HALF]);
  expect(Array.from(w.nearHalf)).toEqual([NEAR_HALF, NEAR_HALF]);
  expect(Array.from(w.forward), 'and it is not turned').toEqual([0, 1]);
});

test('a camera between cells snaps down to the one it is in', () => {
  const w = resolve(body(), 5, -5);
  /* floor(5 / 3.90625) = 1 and floor(−5 / 3.90625) = −2, times the cell. */
  expect(Array.from(w.origin)).toEqual([3.90625, -7.8125]);
});

test('a square body is bounded by one number, sitting where it was put', () => {
  const w = resolve(body({ bounds: { centreX: 4, centreZ: -6, halfM: 12 } }), 500, 500);
  expect(w.bounded).toBe(true);
  expect(Array.from(w.origin), 'the camera does not move it').toEqual([4, -6]);
  expect(Array.from(w.span)).toEqual([12, 12]);
  expect(Array.from(w.half)).toEqual([12, 12]);
  expect(Array.from(w.nearHalf), 'so a bounded body is flat at its own rim').toEqual([12, 12]);
});

/**
 * **The entry this exists for.** A channel is long and thin, and until 2026-08-28 `bounds` was a
 * centre and one half-extent — so the square that contained a 3 by 21 metre ditch flooded 18 metres
 * of field either side of it. Reported from outside, where the workaround was one unbounded body at
 * the ditches' level with the whole world's ground raised above it: a technically flooded world,
 * held up by the rule that nothing anywhere may be drawn below the water.
 */
test('a channel is bounded along each of its own axes', () => {
  const w = resolve(body({ bounds: { centreX: 0, centreZ: 4, halfX: 3, halfZ: 21 } }));
  expect(Array.from(w.span)).toEqual([3, 21]);
  expect(Array.from(w.half)).toEqual([3, 21]);
  expect(Array.from(w.nearHalf)).toEqual([3, 21]);
  expect(Array.from(w.origin)).toEqual([0, 4]);
});

test('a per-axis extent wins over the square shorthand, on that axis alone', () => {
  const w = resolve(body({ bounds: { centreX: 0, centreZ: 0, halfM: 9, halfX: 2 } }));
  expect(Array.from(w.span)).toEqual([2, 9]);
});

/**
 * A turn is a direction and not an angle, which is `addOrientedBox`'s convention: `forward` is
 * where the body's own +z points, the across axis is world up crossed with it, and a consumer with
 * a road or a ditch graph already holds the direction the run takes.
 */
test('a turned body carries the direction its own z points in', () => {
  const w = resolve(
    body({
      bounds: { centreX: 0, centreZ: 0, halfX: 3, halfZ: 21, forwardX: 1, forwardZ: 0 },
    }),
  );
  expect(Array.from(w.forward)).toEqual([1, 0]);
});

test('and it is normalised, so a length is not a scale', () => {
  const w = resolve(
    body({
      bounds: { centreX: 0, centreZ: 0, halfM: 5, forwardX: 3, forwardZ: 4 },
    }),
  );
  /* 3-4-5, so the unit direction is 0.6 and 0.8 exactly before it is stored. Six places, not
     twelve: the target is a `Float32Array`, so 0.6 comes back 2.4e-8 away and a tighter tolerance
     would be asserting single precision is double. */
  expect(w.forward[0]).toBeCloseTo(0.6, 6);
  expect(w.forward[1]).toBeCloseTo(0.8, 6);
  expect(Array.from(w.span), 'and the extents are untouched by it').toEqual([5, 5]);
});

/**
 * A direction of no length is the one input that could produce a NaN basis, which would take the
 * whole sheet off screen rather than degrade.
 */
test('a direction of zero length falls back to the unturned body', () => {
  const w = resolve(
    body({
      bounds: { centreX: 0, centreZ: 0, halfM: 5, forwardX: 0, forwardZ: 0 },
    }),
  );
  expect(Array.from(w.forward)).toEqual([0, 1]);
});

test('a bounded body with no extent at all draws nothing rather than everything', () => {
  const w = resolve(body({ bounds: { centreX: 0, centreZ: 0 } }));
  expect(Array.from(w.span)).toEqual([0, 0]);
  expect(Array.from(w.half)).toEqual([0, 0]);
});

/**
 * The sea state is the other half of `resolveWater` and neither change here may touch it: an
 * authored agitation overrides the wind, and a dead calm keeps an authored bearing instead of
 * collapsing every wave direction onto zero.
 */
test('the wind still decides the sea, and agitation still overrides it', () => {
  const blown = resolve(body(), 0, 0, 12, 0);
  expect(blown.waveGain).toBeGreaterThan(0);
  expect(Array.from(blown.windDir)).toEqual([1, 0]);

  const calm = resolve(body(), 0, 0, 0, 0);
  expect(Array.from(calm.windDir), 'the authored fallback bearing').toEqual([1, 0]);

  const cistern = resolve(body({ agitation: 0 }), 0, 0, 20, 0);
  expect(cistern.waveGain).toBeLessThan(blown.waveGain);
});

test('appearance carries the defaults, so neither backend invents one', () => {
  const look = waterAppearance(body({ level: 1.5 }));
  expect(look.level).toBe(1.5);
  expect(look.nadirOpacity).toBe(0.22);
  expect(look.visibility).toBe(1);
  expect(look.mirror).toBe(0);
});
