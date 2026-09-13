import { expect, test } from 'vitest';

import { RainField } from './rainField.ts';
import { BoxSurface } from '../physics/boxSurface.ts';
import { CompositeSurface } from '../physics/compositeSurface.ts';
import type { SurfaceBox } from '../physics/boxSurface.ts';

const DT = 1 / 60;

/** A pad, as the surface wants one. */
const pad = (minX: number, maxX: number, topY: number): SurfaceBox => ({
  minX,
  maxX,
  minZ: -50,
  maxZ: 50,
  topY,
  distanceM: 0,
  tangentX: 1,
  tangentZ: 0,
});

/** Every drawn streak's midpoint x, so a test can ask where the rain is falling. */
function columns(field: RainField): number[] {
  const out: number[] = [];
  for (let i = 0; i < field.segments.count; i++) out.push(field.segments.from[i * 3] ?? 0);
  return out;
}

/**
 * The first update spreads the drops through the slab rather than hanging them from the ceiling.
 *
 * Without it a field built and drawn is a single sheet descending: every drop respawns near the
 * top, which is where a drop that has just landed belongs and where all of them at once is a
 * curtain that arrives once and never again.
 */
test('rain is already falling the first time it is drawn', () => {
  const field = new RainField({ count: 400, radiusM: 20, heightM: 30 });
  field.update(DT, 0, 0, 0);

  let low = 0;
  let high = 0;
  for (let i = 0; i < field.segments.count; i++) {
    const y = field.segments.from[i * 3 + 1] ?? 0;
    if (y < -10) low++;
    if (y > 10) high++;
  }
  expect(field.segments.count).toBe(400);
  expect(low, 'drops near the ground already').toBeGreaterThan(30);
  expect(high, 'and drops still high up').toBeGreaterThan(30);
});

/**
 * The streak is the drop's own motion over a shutter time, which is what makes wind visible.
 *
 * At 9 m/s down and 6 m/s sideways over 0.05 s the drop moves 0.45 m down and 0.30 m across, so
 * the streak is 0.5408326913 m long and leans `atan(6/9)` = 33.69° off vertical. Both are read off
 * the geometry rather than asserted about a parameter.
 */
test('a streak runs along the fall, leaned by the wind', () => {
  const field = new RainField({ count: 1, radiusM: 20, heightM: 30, speedMps: 9, streakSec: 0.05 });
  field.update(DT, 0, 0, 0, 6, 0);
  expect(field.segments.count).toBe(1);

  const dx = (field.segments.to[0] ?? 0) - (field.segments.from[0] ?? 0);
  const dy = (field.segments.to[1] ?? 0) - (field.segments.from[1] ?? 0);
  const dz = (field.segments.to[2] ?? 0) - (field.segments.from[2] ?? 0);
  /* Six places, not nine: the segments are `Float32Array`, so 0.45 comes back 1.9e-7 away from
     0.45 and a tighter tolerance would be asserting single precision is double. */
  expect(dy, 'the streak trails upward, where the drop was').toBeCloseTo(0.45, 6);
  expect(dx, 'and upwind').toBeCloseTo(-0.3, 6);
  expect(Math.hypot(dx, dy, dz)).toBeCloseTo(0.5408326913, 6);
  expect(Math.atan2(0.3, 0.45) * (180 / Math.PI)).toBeCloseTo(33.690067526, 6);
});

test('with no wind a streak is straight down', () => {
  const field = new RainField({ count: 1, radiusM: 20, heightM: 30, speedMps: 9, streakSec: 0.05 });
  field.update(DT, 0, 0, 0);
  expect((field.segments.to[0] ?? 0) - (field.segments.from[0] ?? 0)).toBe(0);
  expect((field.segments.to[1] ?? 0) - (field.segments.from[1] ?? 0)).toBeCloseTo(0.45, 6);
});

/**
 * A solid roof stops the rain, and a hole in it does not — which is the whole of the concept, and
 * none of it is arranged in the rain.
 *
 * A building: a floor across the whole scene at ground level, and a roof five metres up made of
 * two pads with three metres of air between them, at x in [-10,-1.5] and [1.5,10]. Inside it, the
 * floor a drop falls toward is the ground rather than the ceiling — which is what `sample` means by
 * the deck *under* the asker — so nothing stops a drop reaching the carpet except the question of
 * whether it should have been in the room at all.
 *
 * `coveredAbove` is that question, and its answer comes from whether the surface has a face in the
 * column. The gap is real geometry, cut once, so those columns rain to the floor and the covered
 * ones are dry. Nothing here describes the opening a second time, which is the property worth
 * having: an opening described twice is one that can disagree with the roof it was cut from. The
 * same is true of a `RibbonSurface` with a stretch of `holes` and of a bounded field past its edge.
 */
test('a roof stops rain and a hole in it lets rain through', () => {
  const ROOF_Y = 5;
  const inside = new CompositeSurface([
    new BoxSurface([pad(-40, 40, 0)]),
    new BoxSurface([pad(-10, -1.5, ROOF_Y), pad(1.5, 10, ROOF_Y)]),
  ]);
  const field = new RainField({ count: 800, radiusM: 10, heightM: 20, ground: inside });
  /*
   * One update, with the viewer standing inside. The first pass spreads drops through the whole
   * slab — which is what puts them *in the room*, and is the case the query is for. A solid roof is
   * also a floor, so rain arriving from above lands on it and never reaches here at all; what this
   * catches is a drop that starts, or wanders, underneath.
   */
  field.update(DT, 0, 1, 0);

  let indoors = 0;
  for (let i = 0; i < field.segments.count; i++) {
    const x = field.segments.from[i * 3] ?? 0;
    const y = field.segments.from[i * 3 + 1] ?? 0;
    if (y >= ROOF_Y) continue;
    indoors++;
    expect(
      Math.abs(x),
      `a drop at x=${x}, y=${y} is indoors under a solid pad`,
    ).toBeLessThanOrEqual(1.5);
  }
  expect(indoors, 'and the gap itself rains all the way to the floor').toBeGreaterThan(5);
  expect(field.shelteredCount, 'the covered columns are dry').toBeGreaterThan(50);
  expect(field.segments.count).toBe(800 - field.shelteredCount);
});

test('and over many ticks nothing ever ends up under the solid part', () => {
  /* The steady state, which gets there another way: rain from above lands *on* a roof, because a
     roof is the nearest floor under anything higher than it. Two mechanisms, one invariant. */
  const ROOF_Y = 5;
  const inside = new CompositeSurface([
    new BoxSurface([pad(-40, 40, 0)]),
    new BoxSurface([pad(-10, -1.5, ROOF_Y), pad(1.5, 10, ROOF_Y)]),
  ]);
  const field = new RainField({ count: 400, radiusM: 10, heightM: 20, ground: inside });
  for (let tick = 0; tick < 240; tick++) field.update(DT, 0, 1, 0);

  for (let i = 0; i < field.segments.count; i++) {
    const x = field.segments.from[i * 3] ?? 0;
    const y = field.segments.from[i * 3 + 1] ?? 0;
    if (y >= ROOF_Y) continue;
    expect(Math.abs(x), `a drop at x=${x}, y=${y} got through`).toBeLessThanOrEqual(1.5);
  }
});

test('rain lands on the ground rather than falling past it', () => {
  /* One pad, low and wide: it is the floor here rather than a roof, because every drop starts
     above it. Nothing may end up underneath. */
  const floor = new BoxSurface([pad(-40, 40, 0)]);
  const field = new RainField({ count: 200, radiusM: 20, heightM: 15, ground: floor });
  for (let tick = 0; tick < 240; tick++) field.update(DT, 0, 12, 0);

  for (let i = 0; i < field.segments.count; i++) {
    expect(field.segments.from[i * 3 + 1] ?? 0, 'no drop below the floor').toBeGreaterThanOrEqual(
      0,
    );
  }
});

/**
 * Two fields, same instants, same rain. Nothing here reads a clock or a random number, which is
 * the rule the dust field in `lightVolume.ts` is under: a consumer evaluating arbitrary instants
 * out of order has to get the same frame every time.
 */
test('the same viewer at the same instant sees the same rain', () => {
  const build = (): RainField => new RainField({ count: 120, radiusM: 15, heightM: 25 });
  const a = build();
  const b = build();
  for (let tick = 0; tick < 30; tick++) {
    a.update(DT, tick * 0.1, 2, 0, 3, 1);
    b.update(DT, tick * 0.1, 2, 0, 3, 1);
  }
  expect(a.segments.count).toBe(b.segments.count);
  expect(Array.from(a.segments.from.subarray(0, a.segments.count * 3))).toEqual(
    Array.from(b.segments.from.subarray(0, b.segments.count * 3)),
  );
});

test('the slab follows the viewer, so rain is always where they are', () => {
  const field = new RainField({ count: 300, radiusM: 8, heightM: 20 });
  field.update(DT, 0, 0, 0);
  for (let tick = 0; tick < 600; tick++) field.update(DT, 500, 0, -300);

  for (const x of columns(field)) {
    expect(Math.abs(x - 500), 'still around the viewer half a kilometre later').toBeLessThanOrEqual(
      8.001,
    );
  }
  expect(field.segments.count).toBe(300);
});

/**
 * Weather changes while a game runs, and hail is the case that proves the speed has to move
 * with it.
 *
 * **Reported from outside 2026-08-28**: `speedMps` was read once into a private field, so a
 * consumer whose eight weather states included a hailstorm had to change the streak width and the
 * opacity instead, and hail — which comes down at about 14 m/s against rain's 9 — read as heavy
 * rain. Both halves are read off the geometry here: how far a drop moves in a tick, and how long
 * the streak it leaves behind is.
 */
test('the fall speed changes while the field is running', () => {
  const field = new RainField({ count: 1, radiusM: 40, heightM: 60, speedMps: 9, streakSec: 0.05 });
  field.update(DT, 0, 0, 0);
  const before = field.segments.from[1] ?? 0;
  /* Rain, at 9 m/s over a 60th of a second: 0.15 m. */
  field.update(DT, 0, 0, 0);
  expect((field.segments.from[1] ?? 0) - before).toBeCloseTo(-0.15, 6);

  field.speedMps = 14;
  expect(field.speedMps).toBe(14);
  const hailFrom = field.segments.from[1] ?? 0;
  /* Hail, at 14 m/s over the same tick: 0.2333333 m, and the streak grows with it — 0.7 m over a
     0.05 s shutter against rain's 0.45. */
  field.update(DT, 0, 0, 0);
  expect((field.segments.from[1] ?? 0) - hailFrom).toBeCloseTo(-0.2333333, 6);
  /* Five places for the streak, not six: a 0.7 m offset carried in `Float32Array` comes back
     7.6e-7 away from 0.7, which is single precision rather than a wrong streak. */
  expect((field.segments.to[1] ?? 0) - (field.segments.from[1] ?? 0)).toBeCloseTo(0.7, 5);
});

test('and the shutter time does too, so a downpour can smear without falling faster', () => {
  const field = new RainField({ count: 1, radiusM: 40, heightM: 60, speedMps: 9, streakSec: 0.04 });
  field.update(DT, 0, 0, 0);
  expect((field.segments.to[1] ?? 0) - (field.segments.from[1] ?? 0)).toBeCloseTo(0.36, 5);
  field.streakSec = 0.1;
  expect(field.streakSec).toBe(0.1);
  field.update(DT, 0, 0, 0);
  expect((field.segments.to[1] ?? 0) - (field.segments.from[1] ?? 0)).toBeCloseTo(0.9, 5);
});
