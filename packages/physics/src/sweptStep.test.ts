import { describe, expect, it } from 'vitest';

import { AXIS_X, AXIS_Z } from './collide/index.ts';
import type { Axis, Body } from './collide/index.ts';
import { ColliderSet, boxCollider } from './colliderSet.ts';
import { SweptStep } from './sweptStep.ts';
import type { WorldOpinion } from './sweptStep.ts';

/**
 * Moving horizontally through a world with opinions.
 *
 * Every rule here was paid for in a shipping game, and each names the failure it prevents: a body
 * walking bodily into the side of a raised deck; a corner that trapped a player because both axes
 * refused in the same tick; a one-centimetre facet seam killing a jump in mid-air; a lamp post the
 * surface said nothing about.
 */

function body(x = 0, y = 0, z = 0): Body {
  return { x, y, z, hx: 0.35, hy: 0.85, hz: 0.35 };
}

function state(velX = 0, velZ = 0): { velX: number; velZ: number } {
  return { velX, velZ };
}

/** A world with no opinions at all: the colliders are the whole story. */
const SILENT: WorldOpinion = {
  blocked: () => false,
  riseTo: () => null,
  vouches: () => false,
};

const NOTHING = new ColliderSet([]);

describe('an unobstructed move', () => {
  it('arrives, and refuses nothing', () => {
    const step = new SweptStep();
    const b = body();
    const s = state(10, 0);
    step.moveHorizontal(b, s, AXIS_X, 0.2, NOTHING, true, SILENT);
    expect(b.x).toBeCloseTo(0.2, 9);
    expect(step.moveRefused).toBe(false);
    expect(s.velX, 'and nothing touched the velocity').toBe(10);
  });
});

describe('a wall', () => {
  it('redirects the velocity along the face rather than deleting it', () => {
    /*
     * **Zeroing the axis is what turned every corner into a trap.** X and Z resolve separately, so
     * at a corner both axes refuse in the same tick and both get zeroed: the body ends pressed
     * against the geometry with no speed, and next tick asks for the same refused move again.
     * Sliding removes only the component going *into* the surface, so met square on a wall costs
     * exactly what it always did, and met at an angle the body skims along it.
     */
    const step = new SweptStep();
    const b = body();
    const wall = new ColliderSet([boxCollider(2, 0, 0, 0.4, 4, 8)]);
    const s = state(10, 6);
    step.moveHorizontal(b, s, AXIS_X, 4, wall, true, SILENT);
    expect(step.moveRefused).toBe(true);
    expect(s.velZ, 'travel along the face survives').toBeCloseTo(6, 6);
    expect(Math.abs(s.velX), 'travel into it does not').toBeLessThan(1);
  });
});

describe('a face the colliders do not carry', () => {
  it('is refused when the world says so, and the body is put back', () => {
    /*
     * A deck drawn as a smooth ribbon carries no boxes at all, so its edge is scenery: a body
     * walks into the side of a raised slab and keeps going, which looks exactly like clipping
     * through the world because it is.
     */
    const step = new SweptStep();
    const b = body();
    const s = state(10, 0);
    const solid: WorldOpinion = { ...SILENT, blocked: () => true };
    step.moveHorizontal(b, s, AXIS_X, 0.2, NOTHING, true, solid);
    expect(b.x, 'put back exactly').toBe(0);
    expect(s.velX).toBe(0);
    expect(step.moveRefused).toBe(true);
  });

  it('is not asked at all of a body in the air', () => {
    /*
     * The check predates the deck being solid. For a body genuinely clear of the ground the hulls
     * are the honest answer, and the surface prediction was stopping jumps in open air a stride
     * short of the drawn face — measured as 13 m/s dying mid-flight over a gap.
     */
    const step = new SweptStep();
    const b = body();
    let asked = false;
    const watching: WorldOpinion = {
      ...SILENT,
      blocked: () => {
        asked = true;
        return true;
      },
    };
    step.moveHorizontal(b, state(10, 0), AXIS_X, 0.2, NOTHING, false, watching);
    expect(asked).toBe(false);
    expect(b.x).toBeCloseTo(0.2, 9);
  });
});

describe('stepping over a lip', () => {
  it('carries a grounded body up a kerb', () => {
    const step = new SweptStep();
    const b = body(0, 0.85, 0);
    /* A floor to stand on, and a kerb 0.2 m proud of it. */
    const world = new ColliderSet([
      boxCollider(0, -4, 0, 20, 4, 20),
      boxCollider(2, -3.9, 0, 0.5, 4, 8),
    ]);
    step.moveHorizontal(b, state(6, 0), AXIS_X, 2, world, true, SILENT);
    expect(b.x, 'it got past the kerb').toBeGreaterThan(1.4);
    expect(b.y, 'and is standing on top of it').toBeGreaterThan(0.9);
  });

  it('does not carry a body in the air up anything', () => {
    /* Stepping is a grounded body's tool: one clear of the deck has no floor to step onto. */
    const step = new SweptStep();
    const b = body(0, 0.85, 0);
    const world = new ColliderSet([
      boxCollider(0, -4, 0, 20, 4, 20),
      boxCollider(2, -3.9, 0, 0.5, 4, 8),
    ]);
    const before = b.y;
    step.moveHorizontal(b, state(6, 0), AXIS_X, 2, world, false, SILENT);
    expect(b.y).toBeCloseTo(before, 9);
  });
});

describe('a graze in mid-air', () => {
  it('is not treated as a wall', () => {
    /*
     * Measured on a low hop through a hairpin: a 1 cm shortfall killed a body's whole speed on the
     * axis it grazed, well clear of the deck. A genuine wall does not pass this — hit one square
     * and the move is near zero regardless of how small it was.
     */
    const step = new SweptStep();
    const b = body(0, 0.85, 0);
    const seam = new ColliderSet([boxCollider(0.5, 0, 0, 0.01, 4, 8)]);
    const s = state(13, 0);
    step.moveHorizontal(b, s, AXIS_X, 0.2, seam, false, SILENT);
    expect(s.velX, 'the speed survives a seam').toBe(13);
  });
});

describe('a rise the world vouches for', () => {
  it('is retried, lifted, when the world says the ground comes up to meet it', () => {
    /*
     * A banked span builds a hull tall enough that a landing a few centimetres the wrong side of a
     * facet seam refuses both axes outright — not a graze, a flat zero — on ground the smooth
     * surface calls perfectly ordinary.
     */
    const step = new SweptStep();
    const b = body(0, 0.85, 0);
    const ridge = new ColliderSet([
      boxCollider(0, -4, 0, 20, 4, 20),
      boxCollider(1, -3.75, 0, 0.3, 4, 8),
    ]);
    const vouching: WorldOpinion = { blocked: () => false, riseTo: () => 0.3, vouches: () => true };
    step.moveHorizontal(b, state(10, 0), AXIS_X, 2, ridge, true, vouching);
    expect(b.x, 'it got over the ridge').toBeGreaterThan(1.3);
  });

  it('is not retried where the world does not vouch', () => {
    /* A terrace wall, a station lip and a courtyard edge are real walls and the hull is the only
       honest answer for them. */
    const step = new SweptStep();
    const b = body(0, 0.85, 0);
    const wall = new ColliderSet([
      boxCollider(0, -4, 0, 20, 4, 20),
      boxCollider(2, 2, 0, 0.4, 6, 8),
    ]);
    const notHere: WorldOpinion = { blocked: () => false, riseTo: () => 6, vouches: () => false };
    step.moveHorizontal(b, state(10, 0), AXIS_X, 4, wall, true, notHere);
    expect(b.x, 'stopped at the wall').toBeLessThan(1.7);
  });

  it('still refuses a wall the world merely has no opinion about', () => {
    /*
     * **The retry is a real sweep, not an assumption.** Trusting the surface outright walked a
     * body straight through a wall it carried no opinion about — a synthetic wall has no surface
     * opinion at all, and `riseTo` answering "ordinary ground" is not permission.
     */
    const step = new SweptStep();
    const b = body(0, 0.85, 0);
    const wall = new ColliderSet([
      boxCollider(0, -4, 0, 20, 4, 20),
      boxCollider(2, 6, 0, 0.4, 12, 8),
    ]);
    const vouching: WorldOpinion = { blocked: () => false, riseTo: () => 0, vouches: () => true };
    step.moveHorizontal(b, state(10, 0), AXIS_X, 4, wall, true, vouching);
    expect(b.x, 'a twelve-metre wall is still a wall').toBeLessThan(1.7);
  });

  it('does not overrule a post', () => {
    /*
     * A deck's own geometry spans metres; a lamp post is fourteen centimetres. Real obstacles have
     * to collide, or a world's items become scenery you walk through.
     */
    const step = new SweptStep();
    const b = body(0, 0.85, 0);
    const post = new ColliderSet([
      boxCollider(0, -4, 0, 20, 4, 20),
      boxCollider(1.2, 1, 0, 0.07, 2, 0.07),
    ]);
    const vouching: WorldOpinion = { blocked: () => false, riseTo: () => 0.3, vouches: () => true };
    step.moveHorizontal(b, state(10, 0), AXIS_X, 2, post, true, vouching);
    expect(b.x, 'the post stopped it').toBeLessThan(1.0);
  });
});

describe('the numbers are the consumers', () => {
  it('takes how high a lip may be', () => {
    const shallow = new SweptStep({ stepHeight: 0.05 });
    const b = body(0, 0.85, 0);
    const world = new ColliderSet([
      boxCollider(0, -4, 0, 20, 4, 20),
      boxCollider(2, -3.9, 0, 0.5, 4, 8),
    ]);
    shallow.moveHorizontal(b, state(6, 0), AXIS_X, 2, world, true, SILENT);
    expect(b.x, 'a kerb taller than the step height is a wall').toBeLessThan(1.7);
  });
});

describe('both axes', () => {
  it('moves along z the same way it moves along x', () => {
    const step = new SweptStep();
    const b = body();
    step.moveHorizontal(b, state(0, 10), AXIS_Z as Axis, 0.3, NOTHING, true, SILENT);
    expect(b.z).toBeCloseTo(0.3, 9);
  });
});
