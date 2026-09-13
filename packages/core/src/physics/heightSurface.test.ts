import { describe, expect, it, test } from 'vitest';

import { heightSurface } from './heightSurface.ts';
import { createSurfaceHit } from './ribbonSurface.ts';
import { CharacterController, GROUNDED } from '@driftengine/physics';
import { PhysicsWorld } from '@driftengine/physics';

/**
 * A plane of known slope, whose normal is arithmetic rather than a second implementation.
 *
 * The ground climbs half a metre per metre east, so the gradient is `(0.5, 0)` and the normal is
 * `(-0.5, 1, 0)` normalised. That length is `√1.25` = 1.1180339887, giving `-0.4472135955` and
 * `0.8944271910`. A central difference over a linear field is exact, so these are equalities and
 * not approximations — which is the point of choosing a plane to test with.
 */
test('a slope gives the normal its gradient implies', () => {
  const surface = heightSurface((x) => x * 0.5);
  const hit = createSurfaceHit();

  expect(surface.sample(4, 7, hit)).toBe(true);
  expect(hit.y, 'height is the function, untouched').toBe(2);
  expect(hit.normalX).toBeCloseTo(-0.4472135955, 9);
  expect(hit.normalY).toBeCloseTo(0.894427191, 9);
  expect(hit.normalZ).toBe(-0);
  expect(Math.hypot(hit.normalX, hit.normalY, hit.normalZ), 'unit').toBeCloseTo(1, 12);
  expect(hit.tiltY, 'it looks as it collides, so tilt is the normal').toBe(hit.normalY);
});

/**
 * The documented cost of `stepM`, asserted rather than described.
 *
 * A vertical step of one metre at the origin is not differentiable, so what comes back is the slope
 * *at the scale asked for*: sampled 5 cm either side the rise is 1 m over 0.1 m, a gradient of 10
 * and a normal 5.7° off horizontal; sampled half a metre either side the same cliff is 1 m over 1 m,
 * a gradient of 1 and a 45° face. Same ground, same query, two answers, and neither is wrong.
 */
test('a feature narrower than the step is measured at the step, not at its own scale', () => {
  const cliff = (x: number): number => (x < 0 ? 0 : 1);
  const hit = createSurfaceHit();

  heightSurface(cliff, { stepM: 0.05 }).sample(0, 0, hit);
  expect(hit.normalY, 'five centimetres: very nearly a wall').toBeCloseTo(0.099503719, 9);

  heightSurface(cliff, { stepM: 0.5 }).sample(0, 0, hit);
  expect(hit.normalY, 'half a metre: a ramp').toBeCloseTo(Math.SQRT1_2, 9);
});

test('an exact normal is used and costs one height sample', () => {
  let calls = 0;
  const surface = heightSurface(
    (x) => {
      calls++;
      return x * 0.5;
    },
    {
      normalAt(_x, _z, out) {
        out.x = -0.4472135955;
        out.y = 0.894427191;
        out.z = 0;
      },
    },
  );
  const hit = createSurfaceHit();
  expect(surface.sample(4, 7, hit)).toBe(true);
  expect(calls, 'four difference samples were not taken').toBe(1);
  expect(hit.normalX).toBe(-0.4472135955);
});

test('outside the bounds there is no ground, and inside them the edge has a distance', () => {
  const surface = heightSurface(() => 3, {
    bounds: { minX: -10, maxX: 10, minZ: -20, maxZ: 20 },
  });
  const hit = createSurfaceHit();

  expect(surface.sample(11, 0, hit), 'off the end of a heightmap is not ground at zero').toBe(
    false,
  );
  expect(surface.sample(-10.0001, 0, hit)).toBe(false);

  expect(surface.sample(6, 0, hit)).toBe(true);
  expect(hit.halfWidthM, 'four metres to the east edge, and everything else is further').toBe(4);
  expect(heightSurface(() => 3).sample(6, 0, hit) && hit.halfWidthM, 'unbounded has no edge').toBe(
    Infinity,
  );
});

test('a height that is not a number is an absence rather than a NaN passed on', () => {
  /* The edge of an analytic domain: a square root going negative. A NaN written here becomes a NaN
     position two frames later, where nothing points back at this function. */
  const surface = heightSurface((x) => Math.sqrt(4 - x * x));
  const hit = createSurfaceHit();
  expect(surface.sample(3, 0, hit)).toBe(false);

  /* And at the very edge of the domain, where two of the four difference samples fall outside it,
     the one-sided fallback still produces a usable normal. */
  expect(surface.sample(1.99, 0, hit)).toBe(true);
  expect(Number.isFinite(hit.normalY)).toBe(true);
  expect(hit.normalY).toBeGreaterThan(0);
});

test('a band query is half-open on both ends', () => {
  const surface = heightSurface(() => 5);
  const hit = createSurfaceHit();
  expect(surface.sampleBand(0, 0, hit, 5, 6), 'the low end is included').toBe(true);
  expect(surface.sampleBand(0, 0, hit, 4, 5), 'the high end is not').toBe(false);
  expect(surface.sampleBand(0, 0, hit, 0, 4)).toBe(false);
});

/**
 * The whole reason the adapter exists: a consumer's own `heightAt` becomes the floor a character
 * controller stands on, with no wiring in between.
 *
 * A gentle rise of one in ten, and a character dropped a metre above it. It should land on the
 * ground rather than at zero, and take the hill's normal rather than a flat one — `1/√1.01` is
 * 0.99503719, which is the number a controller compares against its slope cosine.
 */
test('a consumer height function is a floor a character stands on', () => {
  const ground = heightSurface((x) => x * 0.1);
  const controller = new CharacterController({ ground, gravity: -20 });
  controller.teleport(20, 2 + 1 + controller.halfHeight + controller.radius, 0);

  const world = new PhysicsWorld();
  for (let tick = 0; tick < 90; tick++) {
    controller.move(world, 1 / 60, { moveX: 0, moveZ: 0, jump: false });
  }

  const feet = controller.y - controller.halfHeight - controller.radius;
  expect(feet, 'standing on the hill at x = 20, which is two metres up').toBeCloseTo(2, 6);
  expect(controller.state).toBe(GROUNDED);
  expect(controller.groundY, 'and on the hill s own normal').toBeCloseTo(0.99503719, 6);
});

describe('a road that passes under a road', () => {
  /*
   * **The cavalcavia a consumer could not represent**, reduced to its two fields. The span sits at
   * 5.5 m of clearance over a 12 m carriageway, ramps fall away at 6%, and the deck answers `NaN`
   * off the structure — which is the whole contract that makes a layer a floor exactly where it is
   * drawn and nothing beside it.
   *
   * Built as one field the deck wins everywhere it exists, and the only way through a crossing is
   * over it: a car on the lower road is lifted five and a half metres onto a deck it should be
   * driving beneath.
   */
  const CLEARANCE = 5.5;
  const HALF_SPAN = 6;
  const GRADE = 0.06;
  const RAMP = CLEARANCE / GRADE;

  const plain = (): number => 0;
  const deck = (x: number, z: number): number => {
    if (Math.abs(x) > 40) return NaN;
    const d = Math.abs(z);
    if (d <= HALF_SPAN) return CLEARANCE;
    if (d <= HALF_SPAN + RAMP) return CLEARANCE - (d - HALF_SPAN) * GRADE;
    return NaN;
  };

  const surface = heightSurface([plain, deck]);
  const hit = createSurfaceHit();

  it('puts a car under the span on the carriageway, not on the deck', () => {
    expect(surface.sample(0, 0, hit, 0.5)).toBe(true);
    expect(hit.y).toBe(0);
  });

  it('puts a car on the span on the deck', () => {
    expect(surface.sample(0, 0, hit, 6)).toBe(true);
    expect(hit.y).toBeCloseTo(CLEARANCE, 6);
  });

  it('follows the ramp up, at the grade it was drawn at', () => {
    expect(surface.sample(0, -30, hit, 4)).toBe(true);
    expect(hit.y).toBeCloseTo(CLEARANCE - (30 - HALF_SPAN) * GRADE, 6);
  });

  /* Beside the structure there is one floor and it is the plain, whatever height is asked from. */
  it('answers the plain where the deck is not', () => {
    for (const y of [0.5, 4, 20]) {
      expect(surface.sample(200, 200, hit, y)).toBe(true);
      expect(hit.y).toBe(0);
    }
  });

  /*
   * **A caller with no position still gets the highest**, which is right for a generator placing a
   * lamp and is exactly the behaviour that makes a single field wrong for this world.
   */
  it('gives the highest floor to a caller that has no height', () => {
    expect(surface.sample(0, 0, hit)).toBe(true);
    expect(hit.y).toBeCloseTo(CLEARANCE, 6);
  });

  /* The band query is a filter, so both floors are visible to "is anything over me". */
  it('sees the deck overhead from the carriageway', () => {
    expect(surface.sampleBand(0, 0, hit, 1, 10)).toBe(true);
    expect(hit.y).toBeCloseTo(CLEARANCE, 6);
    expect(surface.sampleBand(200, 200, hit, 1, 10)).toBe(false);
  });

  it('refuses an empty list, which is a world with no ground at all', () => {
    expect(() => heightSurface([])).toThrow(/at least one/);
  });

  it('treats a list of one exactly as the single field it is', () => {
    const one = heightSurface([plain]);
    expect(one.sample(3, 4, hit, 0.5)).toBe(true);
    expect(hit.y).toBe(0);
  });
});

/**
 * **The end-to-end claim, and the one the consumer's own check would make.** A body standing on the
 * carriageway under a span stays on the carriageway: the controller passes its own height into
 * `sample` every tick, which is the information that was said to be missing and has always been
 * there. Built as one field this body ends up on the deck, five and a half metres up.
 */
test('a body under a flyover stands on the road, not on the deck above it', () => {
  const CLEARANCE = 5.5;
  const deck = (x: number, z: number): number => {
    if (Math.abs(x) > 40) return NaN;
    const d = Math.abs(z);
    if (d <= 6) return CLEARANCE;
    if (d <= 6 + CLEARANCE / 0.06) return CLEARANCE - (d - 6) * 0.06;
    return NaN;
  };
  const ground = heightSurface([(): number => 0, deck]);

  const controller = new CharacterController({ ground, gravity: -20 });
  controller.teleport(0, controller.halfHeight + controller.radius, 0);

  const world = new PhysicsWorld();
  for (let tick = 0; tick < 120; tick++) {
    controller.move(world, 1 / 60, { moveX: 0, moveZ: 0, jump: false });
  }

  expect(controller.state).toBe(GROUNDED);
  /* Feet on the carriageway, with the deck a clear five and a half metres overhead. */
  expect(controller.y - controller.halfHeight - controller.radius).toBeCloseTo(0, 2);
});
