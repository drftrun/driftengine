import { describe, expect, it } from 'vitest';
import { BODY_DYNAMIC, BODY_STATIC } from './bodies.ts';
import { AIRBORNE, CharacterController, GROUNDED, SLIDING } from './controller.ts';
import type { ControllerInput, ControllerOptions } from './controller.ts';
import { meshShape } from './meshShape.ts';
import { boxShape } from './shape.ts';
import { PhysicsWorld } from './world.ts';

const DT = 1 / 60;
const STILL: ControllerInput = { moveX: 0, moveZ: 0, jump: false };

function ground(): PhysicsWorld {
  const world = new PhysicsWorld();
  world.addBody({ type: BODY_STATIC, shape: boxShape(50, 1, 50), y: -1 });
  return world;
}

function stand(world: PhysicsWorld, options: ControllerOptions = {}): CharacterController {
  const c = new CharacterController(options);
  c.teleport(0, 1.5, 0);
  for (let i = 0; i < 60; i++) c.move(world, DT, STILL);
  return c;
}

function drive(
  world: PhysicsWorld,
  c: CharacterController,
  ticks: number,
  input: Partial<ControllerInput>,
): void {
  const full: ControllerInput = { moveX: 0, moveZ: 0, jump: false, ...input };
  for (let i = 0; i < ticks; i++) c.move(world, DT, full);
}

describe('standing and walking', () => {
  it('settles onto the ground and stays there', () => {
    const world = ground();
    const c = stand(world);
    expect(c.state).toBe(GROUNDED);
    expect(c.y).toBeGreaterThan(0.9);
    expect(c.y).toBeLessThan(1.05);
  });

  it('does not sink over ten seconds', () => {
    const world = ground();
    const c = stand(world);
    const settled = c.y;
    drive(world, c, 600, {});
    expect(Math.abs(c.y - settled)).toBeLessThan(0.01);
  });

  it('walks forward at its top speed', () => {
    const world = ground();
    const c = stand(world);
    drive(world, c, 120, { moveX: 5 });
    expect(c.velX).toBeCloseTo(5, 1);
    expect(c.x).toBeGreaterThan(5);
  });

  it('clamps a request above its top speed', () => {
    const world = ground();
    const c = stand(world);
    drive(world, c, 120, { moveX: 50 });
    expect(c.velX).toBeLessThan(5.1);
  });

  it('stops when the input stops', () => {
    const world = ground();
    const c = stand(world);
    drive(world, c, 60, { moveX: 5 });
    drive(world, c, 60, {});
    expect(Math.abs(c.velX)).toBeLessThan(0.05);
  });
});

describe('walls and steps', () => {
  it('slides along a wall rather than stopping dead', () => {
    const world = ground();
    world.addBody({ type: BODY_STATIC, shape: boxShape(0.5, 3, 10), x: 4 });
    const c = stand(world);
    drive(world, c, 180, { moveX: 5, moveZ: 2 });
    expect(c.x).toBeLessThan(4);
    // It kept moving along z despite the wall across x.
    expect(c.z).toBeGreaterThan(2);
  });

  it('climbs a step under the limit', () => {
    const world = ground();
    world.addBody({ type: BODY_STATIC, shape: boxShape(2, 0.15, 2), x: 3, y: 0.15 });
    const c = stand(world, { stepHeight: 0.4 });
    // The step spans x 1 to 5, so check while it is still on it rather than past the far edge.
    drive(world, c, 60, { moveX: 4 });
    expect(c.x).toBeGreaterThan(3);
    expect(c.y).toBeGreaterThan(1.2);
  });

  it('is blocked by a step above the limit', () => {
    const world = ground();
    world.addBody({ type: BODY_STATIC, shape: boxShape(2, 1.5, 2), x: 4, y: 1.5 });
    const c = stand(world, { stepHeight: 0.3 });
    drive(world, c, 200, { moveX: 4 });
    expect(c.x).toBeLessThan(2.2);
  });
});

describe('slopes', () => {
  it('walks up a slope under the limit', () => {
    const world = ground();
    /*
     * About 20 degrees, well under the default 45, **rising** with x.
     *
     * The sign matters and the first version had it backwards: rotated the other way the slab
     * descends, so its near edge stands 2.34 metres off the ground and the character is walking at
     * a cliff rather than up a ramp.
     */
    world.addBody({
      type: BODY_STATIC,
      shape: boxShape(6, 0.3, 6),
      x: 6,
      y: 1,
      qz: Math.sin(Math.PI / 36),
      qw: Math.cos(Math.PI / 36),
    });
    const c = stand(world);
    // The ramp spans x 0 to 12; stop while still on it.
    drive(world, c, 150, { moveX: 4 });
    expect(c.y).toBeGreaterThan(1.4);
  });

  it('reports sliding on a slope above the limit', () => {
    const world = new PhysicsWorld();
    // 60 degrees about z, so the surface normal is 60 degrees off vertical: well over the default.
    const half = Math.PI / 3;
    world.addBody({
      type: BODY_STATIC,
      shape: boxShape(8, 0.3, 8),
      qz: Math.sin(-half / 2),
      qw: Math.cos(-half / 2),
    });
    const c = new CharacterController();
    // Start above the surface at the origin, which the rotated slab still passes through.
    c.teleport(0, 1.2, 0);
    drive(world, c, 40, {});
    expect(c.state).toBe(SLIDING);
  });

  it('slides downhill rather than sticking', () => {
    const world = new PhysicsWorld();
    const half = Math.PI / 3;
    world.addBody({
      type: BODY_STATIC,
      shape: boxShape(8, 0.3, 8),
      qz: Math.sin(-half / 2),
      qw: Math.cos(-half / 2),
    });
    const c = new CharacterController();
    c.teleport(0, 1.2, 0);
    drive(world, c, 60, {});
    const x = c.x;
    drive(world, c, 60, {});
    expect(Math.abs(c.x - x)).toBeGreaterThan(0.1);
  });

  /**
   * Walking down a slope keeps the feet on it, which is what a ground snap would have been for.
   *
   * There is no snap: it was built, measured, and removed. Descending a sharp forty-degree crest at
   * six metres a second, the largest foot gap was 0.490 metres with it and 0.457 without — the
   * sweep-and-slide already puts the remaining motion along the surface rather than through it.
   * This test asserts the property the snap was meant to buy, so if it ever stops holding there is
   * something to fail rather than a feature to reinstate on faith.
   */
  it('follows a slope down rather than stepping off it', () => {
    const world = new PhysicsWorld();
    world.addBody({
      type: BODY_STATIC,
      shape: boxShape(10, 0.3, 6),
      qz: Math.sin(-Math.PI / 24),
      qw: Math.cos(-Math.PI / 24),
    });
    const c = new CharacterController();
    c.teleport(-9, 5, 0);
    drive(world, c, 120, {});
    expect(c.state).toBe(GROUNDED);
    let grounded = 0;
    for (let i = 0; i < 200; i++) {
      c.move(world, DT, { moveX: 5, moveZ: 0, jump: false });
      if (c.state === GROUNDED) grounded++;
    }
    expect(grounded).toBeGreaterThan(190);
    expect(c.x).toBeGreaterThan(5);
  });
});

describe('jumping', () => {
  it('leaves the ground when told to', () => {
    const world = ground();
    const c = stand(world);
    drive(world, c, 1, { jump: true });
    expect(c.velY).toBeGreaterThan(1);
  });

  it('goes higher held than tapped', () => {
    const world = ground();
    const held = stand(world);
    const tapped = stand(world);
    let heldPeak = held.y;
    let tapPeak = tapped.y;
    for (let i = 0; i < 90; i++) {
      held.move(world, DT, { moveX: 0, moveZ: 0, jump: true });
      tapped.move(world, DT, { moveX: 0, moveZ: 0, jump: i < 2 });
      heldPeak = Math.max(heldPeak, held.y);
      tapPeak = Math.max(tapPeak, tapped.y);
    }
    expect(heldPeak).toBeGreaterThan(tapPeak + 0.2);
  });

  /** Coyote time is counted in ticks, so this is exact rather than approximate. */
  it('allows a jump within the coyote window after an edge', () => {
    const world = ground();
    world.addBody({ type: BODY_STATIC, shape: boxShape(2, 1, 2), x: 20, y: 1 });
    const c = new CharacterController({ coyoteTicks: 6 });
    c.teleport(20, 2.6, 0);
    drive(world, c, 60, {});
    expect(c.state).toBe(GROUNDED);
    // Walk until it actually leaves the platform, rather than guessing how many ticks that takes.
    let left = 0;
    while (c.state !== AIRBORNE && left < 200) {
      drive(world, c, 1, { moveX: 5 });
      left++;
    }
    expect(c.state).toBe(AIRBORNE);
    // Three ticks later is inside a six-tick window.
    drive(world, c, 3, { moveX: 5 });
    const before = c.velY;
    drive(world, c, 1, { moveX: 5, jump: true });
    expect(c.velY).toBeGreaterThan(before + 1);
  });

  it('refuses a jump past the coyote window', () => {
    const world = ground();
    world.addBody({ type: BODY_STATIC, shape: boxShape(2, 1, 2), x: 20, y: 1 });
    const c = new CharacterController({ coyoteTicks: 2 });
    c.teleport(20, 2.6, 0);
    drive(world, c, 60, {});
    let left = 0;
    while (c.state !== AIRBORNE && left < 200) {
      drive(world, c, 1, { moveX: 5 });
      left++;
    }
    drive(world, c, 10, { moveX: 5 });
    const before = c.velY;
    drive(world, c, 1, { moveX: 5, jump: true });
    expect(c.velY).toBeLessThan(before);
  });

  /**
   * A press before landing fires on landing, and the control is what makes the test mean anything.
   *
   * The first version dropped from 2.4 metres and checked `y > 1.1` after twenty ticks — which is
   * true whether or not it jumped, because it is still falling. And the buffer expired four ticks
   * before touchdown anyway, so it measured a jump that never happened. Two peaks measured against
   * each other: 0.95 with no buffer, 1.20 with one.
   */
  it('fires a jump buffered before landing', () => {
    const peak = (jumpBufferTicks: number): number => {
      const world = ground();
      const c = new CharacterController({ jumpBufferTicks });
      c.teleport(0, 1.15, 0);
      c.move(world, DT, { moveX: 0, moveZ: 0, jump: true });
      let high = 0;
      for (let i = 0; i < 90; i++) {
        c.move(world, DT, { moveX: 0, moveZ: 0, jump: false });
        if (i > 12) high = Math.max(high, c.y);
      }
      return high;
    };
    expect(peak(12)).toBeGreaterThan(peak(0) + 0.15);
  });
});

describe('the world pushes back', () => {
  it('pushes a dynamic crate it walks into', () => {
    const world = ground();
    const crate = world.addBody({
      type: BODY_DYNAMIC,
      shape: boxShape(0.4, 0.4, 0.4),
      x: 3,
      y: 0.4,
      density: 60,
    });
    const c = stand(world);
    const before = world.bodies.posX[crate] ?? 0;
    for (let i = 0; i < 200; i++) {
      c.move(world, DT, { moveX: 4, moveZ: 0, jump: false });
      world.step(DT);
    }
    expect(world.bodies.posX[crate] ?? 0).toBeGreaterThan(before + 0.2);
  });

  it('never produces a NaN', () => {
    const world = ground();
    for (let i = 0; i < 6; i++) {
      world.addBody({
        type: BODY_STATIC,
        shape: boxShape(0.5, 2, 0.5),
        x: i * 1.7 - 3,
        z: i * 0.9 - 2,
      });
    }
    const c = stand(world);
    for (let i = 0; i < 400; i++) {
      c.move(world, DT, { moveX: Math.cos(i) * 5, moveZ: Math.sin(i) * 5, jump: i % 37 === 0 });
    }
    expect(Number.isFinite(c.x)).toBe(true);
    expect(Number.isFinite(c.y)).toBe(true);
    expect(Number.isFinite(c.velY)).toBe(true);
  });
});

/**
 * A body whose up is not world up, which the controller could not represent at all.
 *
 * **Not badly — there was no orientation to give it.** `velY` was a scalar and vertical velocity
 * had no other representation; `gravity` was a scalar applied to it; `slopeCos` was measured
 * against world Y; `stepHeight` was a height only because up was fixed; and `GROUNDED` was decided
 * by a downward probe. Nothing in the file was wrong and all of it assumed one axis, so a
 * wall-crawler, an arbitrary-gravity level and a walker inside a rotating station were each a
 * reimplementation of the sweep, the step-over, the slope test and the ground probe.
 *
 * The frame is a parameter now. What is asserted is that the same body, given the wall's normal as
 * its up, stands on the wall exactly as it stands on a floor — and that it does not fall in world
 * Y while doing it, which is the whole of the defect.
 */
describe('a controller whose up is a parameter', () => {
  /** A slab whose +X face sits at x = 0, so +X is the up of anything standing on it. */
  function wall(): PhysicsWorld {
    const world = new PhysicsWorld();
    world.addBody({ type: BODY_STATIC, shape: boxShape(1, 50, 50), x: -1 });
    return world;
  }

  it('defaults to world up, so nothing that never asks is changed', () => {
    const c = new CharacterController();
    expect([c.upX, c.upY, c.upZ]).toEqual([0, 1, 0]);
  });

  it('stands on a wall when the wall normal is its up', () => {
    const world = wall();
    const c = new CharacterController();
    c.setUp(1, 0, 0);
    c.teleport(1.5, 0, 0);
    for (let i = 0; i < 90; i++) c.move(world, DT, STILL);

    expect(c.state, 'the wall is ground in this frame').toBe(GROUNDED);
    /* Resting distance is the same as on a floor: halfHeight + radius clear of the face. */
    expect(c.x).toBeGreaterThan(0.9);
    expect(c.x).toBeLessThan(1.05);
    expect(Math.abs(c.y), 'and it did not fall in world Y').toBeLessThan(0.05);
  });

  it('reports the wall normal as the ground normal rather than world up', () => {
    const world = wall();
    const c = new CharacterController();
    c.setUp(1, 0, 0);
    c.teleport(1.5, 0, 0);
    for (let i = 0; i < 90; i++) c.move(world, DT, STILL);
    expect(c.groundX).toBeGreaterThan(0.99);
    expect(Math.abs(c.groundY)).toBeLessThan(0.01);
  });

  /**
   * The support normal and the direction a body falls are not the same thing, which is why gravity
   * keeps a direction of its own rather than being derived from the frame.
   */
  it('lets gravity point somewhere other than the frame it stands in', () => {
    const world = wall();
    const c = new CharacterController();
    c.setUp(1, 0, 0);
    /* Clinging to the wall, but falling the way the world falls. */
    c.setGravityDirection(0, 1, 0);
    c.teleport(1.5, 0, 0);
    for (let i = 0; i < 60; i++) c.move(world, DT, STILL);
    expect(c.y, 'it fell in world Y rather than toward the wall').toBeLessThan(-0.5);
  });

  /**
   * **The input plane has to be three-dimensional or a wall cannot be walked up.**
   *
   * With up at +X the tangent plane is world YZ, and `moveX`/`moveZ` span only world XZ — so the
   * one direction they can express on that wall is Z, and Y, which is up the wall, is unreachable.
   * Reported from outside by a consumer that gave up on the whole feel layer to get it back.
   */
  it('walks up a wall when the input has a component along it', () => {
    const world = wall();
    const c = new CharacterController({ maxSpeed: 4 });
    c.setUp(1, 0, 0);
    /* No fall, so what moves the body is the steering and nothing else. */
    c.setGravityDirection(1, 0, 0);
    c.teleport(1.5, 0, 0);
    for (let i = 0; i < 60; i++) c.move(world, DT, STILL);
    const startY = c.y;
    drive(world, c, 60, { moveY: 4 });
    expect(c.y - startY, 'it climbed the wall').toBeGreaterThan(1);
  });

  /**
   * And the case that was impossible before it: the same request through the old two components.
   * `moveX` is straight into the wall, so the projection removes all of it and nothing is left.
   */
  it('cannot express that direction with the two components alone', () => {
    const world = wall();
    const c = new CharacterController({ maxSpeed: 4 });
    c.setUp(1, 0, 0);
    c.setGravityDirection(1, 0, 0);
    c.teleport(1.5, 0, 0);
    for (let i = 0; i < 60; i++) c.move(world, DT, STILL);
    const startY = c.y;
    drive(world, c, 60, { moveX: 4 });
    expect(Math.abs(c.y - startY), 'nothing in world XZ climbs a +X wall').toBeLessThan(0.05);
  });

  /** A caller that never mentions it gets what it always got, which is the whole compatibility claim. */
  it('is identical to omitting it when it is zero', () => {
    const world = ground();
    const withOut = stand(world);
    const withZero = stand(world);
    drive(world, withOut, 60, { moveX: 3, moveZ: 1 });
    drive(world, withZero, 60, { moveX: 3, moveZ: 1, moveY: 0 });
    expect([withZero.x, withZero.y, withZero.z]).toEqual([withOut.x, withOut.y, withOut.z]);
  });
});

/**
 * **A body between two surfaces, which is the one case the tangent projection cannot serve.**
 *
 * Steering holds the along-up component out and puts it back, because on one surface that component
 * is gravity and the jump rather than the stick. A body crossing a convex edge has a third thing
 * there: the correct direction is a blend of two faces, held by the contacts already on the far
 * side, and flattening it onto the face the body is still nominally on turns it aside. Reported
 * from outside as twenty-one ticks of ninety with nothing under the body, against none when the
 * velocity was written directly — and separated from acceleration first, the same crossing giving
 * twenty-one ticks at acceleration times 15, 60, 240 and 2000.
 *
 * Airborne with no contacts, so what is measured is the steering and not a resolution: gravity acts
 * equally on both, and the difference between them is exactly what the projection removed.
 */
describe('a command that leaves the plane', () => {
  const FAST: ControllerOptions = { maxSpeed: 5, acceleration: 400, airControl: 1, gravity: 20 };

  function velocityAfterOneTick(projectMove: boolean | undefined): number[] {
    const world = new PhysicsWorld();
    const c = new CharacterController(FAST);
    /* Nothing under it, so it is airborne and no contact resolves the velocity away. */
    c.teleport(0, 200, 0);
    c.move(world, DT, {
      moveX: 0,
      moveZ: 0,
      moveY: 5,
      jump: false,
      ...(projectMove === undefined ? {} : { projectMove }),
    });
    return [c.velX, c.velY, c.velZ];
  }

  /**
   * Measured against a body given *no* command at all rather than against a gravity term, so the
   * assertion is about the steering and nothing else. Whatever the fall contributes it contributes
   * to all three of these equally.
   */
  function velocityWithNoCommand(): number[] {
    const world = new PhysicsWorld();
    const c = new CharacterController(FAST);
    c.teleport(0, 200, 0);
    c.move(world, DT, { moveX: 0, moveZ: 0, jump: false });
    return [c.velX, c.velY, c.velZ];
  }

  it('is flattened onto the tangent plane by default, which is what it always did', () => {
    /* Up is world Y, so a command that is purely along up survives the projection as nothing —
       which makes it indistinguishable from asking for nothing, and that is the sharp form. */
    expect(velocityAfterOneTick(undefined)).toEqual(velocityWithNoCommand());
  });

  it('is taken whole when the caller says it is already the velocity', () => {
    const projected = velocityAfterOneTick(undefined)[1] as number;
    const whole = velocityAfterOneTick(false)[1] as number;
    /* At this acceleration one tick reaches the command, so the difference between the two is the
       command itself: the part the projection was removing. */
    expect(whole - projected).toBeCloseTo(5, 6);
  });

  it('passing true is the default rather than a third behaviour', () => {
    expect(velocityAfterOneTick(true)).toEqual(velocityAfterOneTick(undefined));
  });

  /**
   * The whole point of retiring the velocity bypass: what a caller gets back is the feel. A direct
   * write has no clamp, no curve and no air control, and this has all three.
   */
  it('still clamps to the top speed', () => {
    const world = new PhysicsWorld();
    const c = new CharacterController(FAST);
    c.teleport(0, 200, 0);
    /* Forty times the top speed asked for, on an axis gravity does not touch. */
    for (let i = 0; i < 10; i++) {
      c.move(world, DT, { moveX: 200, moveZ: 0, moveY: 0, jump: false, projectMove: false });
    }
    expect(c.velX).toBeLessThanOrEqual(FAST.maxSpeed! + 1e-6);
    expect(c.velX).toBeGreaterThan(FAST.maxSpeed! - 1e-6);
  });

  it('still spends air control on the way there', () => {
    const world = new PhysicsWorld();
    const full = new CharacterController({ ...FAST, acceleration: 10, airControl: 1 });
    const half = new CharacterController({ ...FAST, acceleration: 10, airControl: 0.25 });
    for (const c of [full, half]) {
      c.teleport(0, 200, 0);
      c.move(world, DT, { moveX: 5, moveZ: 0, moveY: 0, jump: false, projectMove: false });
    }
    /* A quarter of the authority is a quarter of the step toward the same command. */
    expect(half.velX).toBeCloseTo(full.velX * 0.25, 9);
    expect(half.velX).toBeGreaterThan(0);
  });
});

/**
 * **A controller on a triangle mesh, which nothing in this file tested until 2026-09-20.**
 *
 * Every other test here stands the capsule on a box: one shape, one manifold, one plane under the
 * feet. A captured room is thousands of triangles, and a sweep against a mesh asks for a *set* —
 * which is where two defects lived, both silent, both found the first time a character was put on
 * one.
 *
 * The room below is written by hand rather than captured, because a regression test for physics
 * must not need `@driftengine/capture` to run.
 */
describe('a controller on a triangle mesh', () => {
  /** A floor of small triangles at y = 0, with four walls around it. */
  function roomMesh(cells: number, half: number, wallHeight: number) {
    const positions: number[] = [];
    const indices: number[] = [];
    const step = (half * 2) / cells;
    const at = (x: number, y: number, z: number): number => {
      const index = positions.length / 3;
      positions.push(x, y, z);
      return index;
    };
    for (let j = 0; j < cells; j++) {
      for (let i = 0; i < cells; i++) {
        const x0 = -half + i * step;
        const z0 = -half + j * step;
        const a = at(x0, 0, z0);
        const b = at(x0 + step, 0, z0);
        const c = at(x0, 0, z0 + step);
        const d = at(x0 + step, 0, z0 + step);
        /* Wound so the normal points up, which is the side the character is on. */
        indices.push(a, c, b, b, c, d);
      }
    }
    /* Four walls, each a quad of two triangles facing inwards. */
    const wall = (ax: number, az: number, bx: number, bz: number): void => {
      const a = at(ax, 0, az);
      const b = at(bx, 0, bz);
      const c = at(ax, wallHeight, az);
      const d = at(bx, wallHeight, bz);
      indices.push(a, b, c, c, b, d);
    };
    wall(-half, -half, half, -half);
    wall(half, -half, half, half);
    wall(half, half, -half, half);
    wall(-half, half, -half, -half);
    return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
  }

  function meshWorld(): PhysicsWorld {
    const { positions, indices } = roomMesh(24, 3, 2.5);
    const world = new PhysicsWorld();
    world.addBody({ type: BODY_STATIC, shape: meshShape(positions, indices) });
    return world;
  }

  /**
   * **A sweep against a mesh must step by the nearest triangle, not by whichever one it saw
   * first.** `collideMesh` fills its manifolds in the order its tree hands triangles over; the
   * sweep read one of them and advanced by its separation, which is a bound only if it is the
   * *smallest*. With the walls in the tree the first triangle was often a wall, so the capsule
   * stepped straight past the floor — and the same floor with the walls removed held it, which is
   * what made the fault so hard to see.
   */
  it('SETTLES ONTO A TRIANGLE FLOOR AND DOES NOT FALL THROUGH IT', () => {
    const world = meshWorld();
    const c = new CharacterController();
    c.teleport(-1.2, 1.0, -1.2);
    for (let i = 0; i < 120; i++) c.move(world, DT, STILL);
    expect(c.state).toBe(GROUNDED);
    expect(c.y).toBeGreaterThan(0.9);
    expect(c.y).toBeLessThan(1.05);
  });

  it('walks a square on it and comes back to where it started', () => {
    const world = meshWorld();
    const c = new CharacterController();
    c.teleport(-1.2, 1.0, -1.2);
    for (let i = 0; i < 120; i++) c.move(world, DT, STILL);
    const floor = c.y;

    let lowest = floor;
    for (const [moveX, moveZ] of [
      [1, 0],
      [0, 1],
      [-1, 0],
      [0, -1],
    ] as const) {
      for (let i = 0; i < 90; i++) {
        c.move(world, DT, { moveX, moveZ, jump: false });
        lowest = Math.min(lowest, c.y);
      }
    }
    /* Never through the floor, and back where it began. */
    expect(lowest).toBeGreaterThan(floor - 0.1);
    expect(Math.abs(c.x + 1.2)).toBeLessThan(0.25);
    expect(Math.abs(c.z + 1.2)).toBeLessThan(0.25);
    expect(c.state).toBe(GROUNDED);
  });

  /**
   * **Which triangle stopped the sweep is a different question from which one is nearest**, and a
   * crease is where they differ. Walking into the corner where a wall meets the floor, the wall is
   * always the nearer contact; reporting its horizontal normal for a downward sweep leaves nothing
   * to stop the fall, and the capsule sinks into the floor while still calling itself grounded.
   */
  it('KEEPS ITS HEIGHT WALKING INTO A CORNER, where the nearest triangle is not the one below', () => {
    const world = meshWorld();
    const c = new CharacterController();
    c.teleport(2.0, 1.0, 2.0);
    for (let i = 0; i < 120; i++) c.move(world, DT, STILL);
    const floor = c.y;
    let lowest = floor;
    for (let i = 0; i < 180; i++) {
      c.move(world, DT, { moveX: 1, moveZ: 1, jump: false });
      lowest = Math.min(lowest, c.y);
    }
    expect(lowest).toBeGreaterThan(floor - 0.1);
    expect(c.state).toBe(GROUNDED);
  });
});
