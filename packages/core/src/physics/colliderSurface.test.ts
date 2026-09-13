import {
  CharacterController,
  ColliderSet,
  GROUNDED,
  PhysicsWorld,
  boxCollider,
  colliderFromShape,
  hullShape,
} from '@driftengine/physics';
import { describe, expect, it, test } from 'vitest';

import { colliderSurface } from './colliderSurface.ts';
import { CompositeSurface } from './compositeSurface.ts';
import { heightSurface } from './heightSurface.ts';
import { createSurfaceHit } from './ribbonSurface.ts';

const EXTENT = { minY: -20, maxY: 60 };
const hit = createSurfaceHit();

describe('a collider as ground', () => {
  /* A slab 20 x 1 x 20 centred at y = 5, so its lid is at 5.5 — a flyover deck. */
  const deck = new ColliderSet([boxCollider(0, 5, 0, 10, 0.5, 10)]);
  const surface = colliderSurface(deck, EXTENT);

  it('puts the ground on the lid, not on the box the broad phase uses', () => {
    expect(surface.sample(0, 0, hit, 6)).toBe(true);
    expect(hit.y).toBeCloseTo(5.5, 6);
    expect(hit.normalY).toBeCloseTo(1, 6);
  });

  it('answers nothing beside the slab', () => {
    expect(surface.sample(50, 0, hit, 6)).toBe(false);
  });

  /* The lid is a face and the underside is another: a body beneath gets no ground from it. */
  it('gives a body under the slab the floor below, not the deck above', () => {
    const ground = new CompositeSurface([heightSurface(() => 0), surface]);
    expect(ground.sample(0, 0, hit, 0.5)).toBe(true);
    expect(hit.y).toBe(0);
    expect(ground.sample(0, 0, hit, 6)).toBe(true);
    expect(hit.y).toBeCloseTo(5.5, 6);
  });

  it('is visible overhead to a band query, which is how a roof is one', () => {
    expect(surface.sampleBand(0, 0, hit, 1, 10)).toBe(true);
    expect(hit.y).toBeCloseTo(5.5, 6);
    expect(surface.sampleBand(0, 0, hit, 1, 4)).toBe(false);
  });

  it('refuses an extent with no height in it', () => {
    expect(() => colliderSurface(deck, { minY: 10, maxY: 10 })).toThrow(/above minY/);
  });
});

describe('a sloped hull', () => {
  /*
   * **The case the box answer gets wrong.** A ramp is a hull, and its bounding box's lid is flat at
   * the ramp's high end — so a surface that answered the box would stand a body on thin air over
   * the whole low half of it. Solved against the hull's own face planes, the height follows the
   * slope and the normal tilts with it.
   */
  const ramp = new ColliderSet([
    colliderFromShape(
      hullShape([
        /* A wedge climbing 5 m over 10 m of x, one metre thick under its face. */
        0, 0, -5, 0, 0, 5, 10, 5, -5, 10, 5, 5, 0, -1, -5, 0, -1, 5, 10, -1, -5, 10, -1, 5,
      ]),
    ),
  ]);
  const surface = colliderSurface(ramp, EXTENT);

  it('follows the slope rather than the box lid', () => {
    for (const [x, y] of [
      [1, 0.5],
      [5, 2.5],
      [9, 4.5],
    ] as const) {
      expect(surface.sample(x, 0, hit, y + 1)).toBe(true);
      expect(hit.y).toBeCloseTo(y, 4);
    }
  });

  it('tilts its normal with the slope', () => {
    expect(surface.sample(5, 0, hit, 4)).toBe(true);
    expect(hit.normalY).toBeGreaterThan(0.7);
    expect(hit.normalY).toBeLessThan(0.95);
    expect(hit.normalX).toBeLessThan(0);
  });
});

/**
 * **The end-to-end claim, and the one ask #2 was written about.** Measured before this existed: a
 * character dropped over this exact slab falls to −84 m, which is what it does with no slab at all.
 */
test('a character stands on a collider slab, held up by it', () => {
  const deck = new ColliderSet([boxCollider(0, 5, 0, 10, 0.5, 10)]);
  const controller = new CharacterController({
    ground: colliderSurface(deck, EXTENT),
    gravity: -20,
  });
  controller.teleport(0, 5.5 + controller.halfHeight + controller.radius + 1, 0);

  const world = new PhysicsWorld();
  for (let tick = 0; tick < 180; tick++) {
    controller.move(world, 1 / 60, { moveX: 0, moveZ: 0, jump: false });
  }

  expect(controller.state).toBe(GROUNDED);
  expect(controller.y - controller.halfHeight - controller.radius).toBeCloseTo(5.5, 2);
});

/** And the whole point of it being a `GroundSurface`: it layers with terrain and with itself. */
test('a deck of colliders over terrain lets a body drive under it', () => {
  const decks = new ColliderSet([boxCollider(0, 5, 0, 40, 0.5, 6)]);
  const ground = heightSurface([() => 0]);
  const world = new CompositeSurface([ground, colliderSurface(decks, EXTENT)]);

  expect(world.sample(0, 0, hit, 0.5)).toBe(true);
  expect(hit.y).toBe(0);
  expect(world.sample(0, 0, hit, 6)).toBe(true);
  expect(hit.y).toBeCloseTo(5.5, 6);
});
