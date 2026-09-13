import { describe, expect, it } from 'vitest';

import { AIRBORNE, CharacterController, GROUNDED, SLIDING } from './controller.ts';
import type { GroundProbe } from './controller.ts';
import { BODY_STATIC } from './bodies.ts';
import { boxShape } from './shape.ts';
import { PhysicsWorld } from './world.ts';

/**
 * A flat analytic floor at a height, tilted by a normal.
 *
 * Structural: it satisfies `GroundProbe` without importing anything, which is the property the
 * seam exists for. `@driftengine/core`'s `GroundSurface` satisfies it the same way — and **this
 * fake used to spell the normal `nx`, `ny`, `nz`, which is what let that sentence be false for as
 * long as it was.** A real surface writes `normalX`; the controller read `nx`; the fake wrote `nx`;
 * every test here passed while a banked ribbon handed a character the normal of the last body it
 * touched. A fake that agrees with the caller instead of with the interface tests the caller
 * against itself.
 */
function floorAt(y: number, normalX = 0, normalY = 1, normalZ = 0): GroundProbe {
  return {
    sample(_x, _z, out) {
      out.y = y;
      out.normalX = normalX;
      out.normalY = normalY;
      out.normalZ = normalZ;
      return true;
    },
  };
}

/** A controller standing with its feet exactly on a floor at `y`. */
function standingOn(y: number, probe: GroundProbe | undefined): CharacterController {
  const controller = new CharacterController({ ground: probe, gravity: -20 });
  controller.teleport(0, y + controller.halfHeight + controller.radius, 0);
  return controller;
}

describe('a character on an analytic surface', () => {
  it('is airborne over an empty world with no probe', () => {
    /* The baseline the seam has to leave alone: bodies alone, and there are none. */
    const world = new PhysicsWorld();
    const controller = standingOn(0, undefined);
    controller.move(world, 1 / 60, { moveX: 0, moveZ: 0, jump: false });
    expect(controller.state).toBe(AIRBORNE);
  });

  it('stands on a surface where no body exists', () => {
    /*
     * The whole point. A consumer whose deck is analytic — a banked ribbon, where a world-axis box
     * has a flat top at the strip's highest corner — could sweep bodies or stand on the deck, and
     * never both.
     */
    const world = new PhysicsWorld();
    const controller = standingOn(0, floorAt(0));
    controller.move(world, 1 / 60, { moveX: 0, moveZ: 0, jump: false });
    expect(controller.state).toBe(GROUNDED);
    expect(controller.groundY).toBeCloseTo(1, 6);
    /* No body holds it up, and −1 is what that has always meant. */
    expect(controller.groundBody).toBe(-1);
  });

  it('takes the surface normal, so a banked deck is a banked deck', () => {
    const world = new PhysicsWorld();
    const bank = 0.3;
    const controller = standingOn(0, floorAt(0, Math.sin(bank), Math.cos(bank), 0));
    controller.move(world, 1 / 60, { moveX: 0, moveZ: 0, jump: false });
    expect(controller.state).toBe(GROUNDED);
    expect(controller.groundX).toBeCloseTo(Math.sin(bank), 6);
    expect(controller.groundY).toBeCloseTo(Math.cos(bank), 6);
  });

  it('slides on a surface too steep to stand on', () => {
    /* The same discrimination a body gets: a surface is not automatically walkable. */
    const world = new PhysicsWorld();
    const steep = 1.2;
    const controller = standingOn(0, floorAt(0, Math.sin(steep), Math.cos(steep), 0));
    controller.move(world, 1 / 60, { moveX: 0, moveZ: 0, jump: false });
    expect(controller.state).toBe(SLIDING);
  });

  it('is airborne above a surface it has left', () => {
    /* A probe that reported ground at any height would make a character grounded in mid-air, and
       a jump would never leave. */
    const world = new PhysicsWorld();
    const controller = standingOn(0, floorAt(0));
    controller.teleport(0, 12, 0);
    controller.move(world, 1 / 60, { moveX: 0, moveZ: 0, jump: false });
    expect(controller.state).toBe(AIRBORNE);
  });

  it('a body wins over a surface under it', () => {
    /*
     * The ordering, and it is the decision rather than an accident: a body is a thing that is
     * *there* and a surface is a description of where the ground *is*. A crate resting on a deck
     * is what the character stands on.
     */
    const world = new PhysicsWorld();
    const controller = standingOn(0, floorAt(-4));
    /* A wide static box whose top is exactly at 0. */
    world.addBody({ type: BODY_STATIC, shape: boxShape(8, 1, 8), x: 0, y: -1, z: 0 });
    controller.move(world, 1 / 60, { moveX: 0, moveZ: 0, jump: false });
    expect(controller.state).toBe(GROUNDED);
  });

  /**
   * A second of standing still, which is the arrangement every test above could not reach.
   *
   * **Each of them ran one tick from feet already exactly on the floor**, and one tick is less than
   * the six centimetres `senseGround` calls standing on something, so a character that was sinking
   * still answered `GROUNDED`. Run it out and the truth appears: at −20 m/s² the feet were 0.006 m
   * under after one tick, 0.31 after ten, and 10.17 after sixty, still falling, because the sweep
   * resolves bodies and a surface is not a body. Nothing held it up and nothing said so.
   *
   * The literal is the surface's own height, not a tolerance around it: standing is standing.
   */
  it('stays on the surface for as long as it is stood on', () => {
    const world = new PhysicsWorld();
    const controller = standingOn(0, floorAt(0));
    for (let tick = 0; tick < 60; tick++) {
      controller.move(world, 1 / 60, { moveX: 0, moveZ: 0, jump: false });
    }
    const feet = controller.y - controller.halfHeight - controller.radius;
    expect(feet, 'a second later, still on the floor').toBeCloseTo(0, 9);
    expect(controller.state).toBe(GROUNDED);
  });

  it('leaves it when it jumps, and comes back', () => {
    /* The other half of the same mechanism: a floor that stopped a rise would be a ceiling. */
    const world = new PhysicsWorld();
    const controller = standingOn(0, floorAt(0));
    let peak = 0;
    for (let tick = 0; tick < 90; tick++) {
      controller.move(world, 1 / 60, { moveX: 0, moveZ: 0, jump: tick === 1 });
      peak = Math.max(peak, controller.y - controller.halfHeight - controller.radius);
    }
    expect(peak, 'it got off the ground').toBeGreaterThan(0.2);
    expect(
      controller.y - controller.halfHeight - controller.radius,
      'and landed back on it',
    ).toBeCloseTo(0, 9);
  });

  it('does not hoist a character that is under the surface for some other reason', () => {
    /*
     * A cellar, a tunnel, a spawn under the terrain. The rule is that only a descent *this tick*
     * could have caused is undone, because anything else means lifting a body through whatever is
     * over its head — which is a teleport wearing a floor's clothes.
     */
    const world = new PhysicsWorld();
    const controller = standingOn(0, floorAt(0));
    controller.teleport(0, -5, 0);
    controller.move(world, 1 / 60, { moveX: 0, moveZ: 0, jump: false });
    expect(controller.y, 'still down there').toBeLessThan(-4.9);
    expect(controller.state).toBe(AIRBORNE);
  });

  /**
   * The claim the seam is written around: a `GroundSurface` from `@driftengine/core` satisfies
   * `GroundProbe`. This package imports no other engine package, so the way to test it is a fake
   * carrying **every** field of a `SurfaceHit` — a superset, which is what a real surface is.
   *
   * It is the banked case that matters. A flat surface passed with the wrong field names still
   * behaved, because the scratch it writes into starts at `(0, 1, 0)` and flat is `(0, 1, 0)`.
   */
  it('reads a surface that fills in every field a SurfaceHit has', () => {
    const bank = 0.3;
    const surface: GroundProbe = {
      sample(_x, _z, out) {
        const full = out as typeof out & Record<string, number>;
        full.y = 0;
        full.normalX = Math.sin(bank);
        full.normalY = Math.cos(bank);
        full.normalZ = 0;
        full.tangentX = 1;
        full.tangentY = 0;
        full.tangentZ = 0;
        full.distanceM = 12;
        full.lateralM = 0;
        full.halfWidthM = 4;
        full.bankRad = bank;
        full.tiltX = 0;
        full.tiltY = 1;
        full.tiltZ = 0;
        return true;
      },
    };
    const world = new PhysicsWorld();
    const controller = standingOn(0, surface);
    controller.move(world, 1 / 60, { moveX: 0, moveZ: 0, jump: false });
    expect(controller.groundX, 'the bank arrived').toBeCloseTo(Math.sin(bank), 6);
    expect(controller.groundY).toBeCloseTo(Math.cos(bank), 6);
    expect(controller.state).toBe(GROUNDED);
  });
});
