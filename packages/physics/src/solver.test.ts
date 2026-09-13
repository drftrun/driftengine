import { describe, expect, it } from 'vitest';
import { BODY_DYNAMIC, BODY_STATIC } from './bodies.ts';
import { boxShape, capsuleShape, sphereShape } from './shape.ts';
import { PhysicsWorld } from './world.ts';
import type { WorldOptions } from './world.ts';

const DT = 1 / 60;

function ground(world: PhysicsWorld): number {
  return world.addBody({
    type: BODY_STATIC,
    shape: boxShape(50, 1, 50),
    y: -1,
    friction: 0.8,
  });
}

function run(world: PhysicsWorld, ticks: number): void {
  for (let i = 0; i < ticks; i++) world.step(DT);
}

/** A single box dropped a little above the ground, and the world it rests in. */
function resting(options: WorldOptions = {}): { world: PhysicsWorld; box: number } {
  const world = new PhysicsWorld(options);
  ground(world);
  const box = world.addBody({
    type: BODY_DYNAMIC,
    shape: boxShape(0.5, 0.5, 0.5),
    y: 0.55,
    density: 500,
    friction: 0.8,
  });
  return { world, box };
}

describe('a body at rest', () => {
  it('settles onto the ground and stays there', () => {
    const { world, box } = resting();
    run(world, 600);
    expect(world.bodies.posY[box]).toBeGreaterThan(0.49);
    expect(world.bodies.posY[box]).toBeLessThan(0.51);
  });

  it('does not sink over ten seconds', () => {
    const { world, box } = resting();
    run(world, 120);
    const settled = world.bodies.posY[box] ?? 0;
    run(world, 480);
    expect(Math.abs((world.bodies.posY[box] ?? 0) - settled)).toBeLessThan(0.001);
  });

  /**
   * Settling asymmetry is real and bounded; creep is neither, and only the second is a bug.
   *
   * Sequential impulses solve contact points in order, so the first point of a resting box is
   * corrected against a slightly different velocity from the last, and a box shifts a little while
   * it beds in. Measured here: 696 micrometres after a second, 940 after five, **941 after ten**.
   * It converges. An absolute bound would have been asserting where that plateau happens to sit,
   * which is tuning; what matters is that the box stops.
   */
  it('settles laterally and then stops, rather than creeping', () => {
    const { world, box } = resting();
    run(world, 600);
    const x = world.bodies.posX[box] ?? 0;
    const z = world.bodies.posZ[box] ?? 0;
    run(world, 1200);
    expect(Math.abs((world.bodies.posX[box] ?? 0) - x)).toBeLessThan(0.0001);
    expect(Math.abs((world.bodies.posZ[box] ?? 0) - z)).toBeLessThan(0.0001);
    // And the settle itself is small, not a slide across the floor.
    expect(Math.abs(x)).toBeLessThan(0.01);
    expect(Math.abs(z)).toBeLessThan(0.01);
  });

  /**
   * The property soft constraints are chosen for, and the one a Baumgarte bias does not have.
   * Stiffness stated as a frequency means the same thing at every substep length, so the dial
   * buys accuracy without changing behaviour.
   */
  it('rests at the same height whatever the substep count', () => {
    const four = resting({ substeps: 4 });
    const eight = resting({ substeps: 8 });
    run(four.world, 300);
    run(eight.world, 300);
    const a = four.world.bodies.posY[four.box] ?? 0;
    const b = eight.world.bodies.posY[eight.box] ?? 0;
    expect(Math.abs(a - b)).toBeLessThan(0.001);
  });
});

describe('friction', () => {
  it('stops a box slid across a rough floor', () => {
    const { world, box } = resting();
    run(world, 60);
    world.bodies.velX[box] = 4;
    run(world, 300);
    expect(Math.abs(world.bodies.velX[box] ?? 0)).toBeLessThan(0.05);
  });

  it('lets a box keep sliding on a floor with none', () => {
    const world = new PhysicsWorld();
    world.addBody({ type: BODY_STATIC, shape: boxShape(200, 1, 200), y: -1, friction: 0 });
    const box = world.addBody({
      type: BODY_DYNAMIC,
      shape: boxShape(0.5, 0.5, 0.5),
      y: 0.55,
      density: 500,
      friction: 0,
    });
    run(world, 60);
    world.bodies.velX[box] = 4;
    run(world, 120);
    expect(world.bodies.velX[box] ?? 0).toBeGreaterThan(3.5);
  });

  it('travels further on a slippery floor than on a rough one', () => {
    const rough = resting();
    const slick = new PhysicsWorld();
    slick.addBody({ type: BODY_STATIC, shape: boxShape(200, 1, 200), y: -1, friction: 0.05 });
    const slickBox = slick.addBody({
      type: BODY_DYNAMIC,
      shape: boxShape(0.5, 0.5, 0.5),
      y: 0.55,
      density: 500,
      friction: 0.05,
    });
    run(rough.world, 60);
    run(slick, 60);
    rough.world.bodies.velX[rough.box] = 4;
    slick.bodies.velX[slickBox] = 4;
    run(rough.world, 180);
    run(slick, 180);
    expect(slick.bodies.posX[slickBox] ?? 0).toBeGreaterThan(
      rough.world.bodies.posX[rough.box] ?? 0,
    );
  });
});

describe('a stack', () => {
  function stack(
    count: number,
    options: WorldOptions = {},
  ): { world: PhysicsWorld; boxes: number[] } {
    const world = new PhysicsWorld(options);
    ground(world);
    const boxes: number[] = [];
    for (let i = 0; i < count; i++) {
      boxes.push(
        world.addBody({
          type: BODY_DYNAMIC,
          shape: boxShape(0.5, 0.5, 0.5),
          y: 0.5 + i * 1.02,
          density: 500,
          friction: 0.8,
        }),
      );
    }
    return { world, boxes };
  }

  it('holds ten boxes up over ten seconds', () => {
    const { world, boxes } = stack(10);
    run(world, 600);
    const top = world.bodies.posY[boxes[9] ?? 0] ?? 0;
    expect(top).toBeGreaterThan(9);
    expect(top).toBeLessThan(9.7);
  });

  it('does not let a stack sink into the ground', () => {
    const { world, boxes } = stack(10);
    run(world, 600);
    for (const b of boxes) expect(world.bodies.posY[b] ?? 0).toBeGreaterThan(0.4);
  });

  it('stops moving rather than breathing', () => {
    const { world, boxes } = stack(6);
    run(world, 300);
    const before = boxes.map((b) => world.bodies.posY[b] ?? 0);
    run(world, 120);
    boxes.forEach((b, i) => {
      expect(Math.abs((world.bodies.posY[b] ?? 0) - (before[i] ?? 0))).toBeLessThan(0.002);
    });
  });
});

describe('restitution', () => {
  it('bounces a ball back to a fraction of its drop', () => {
    const world = new PhysicsWorld({ substeps: 4 });
    world.addBody({ type: BODY_STATIC, shape: boxShape(50, 1, 50), y: -1, restitution: 0.6 });
    const ball = world.addBody({
      type: BODY_DYNAMIC,
      shape: sphereShape(0.5),
      y: 3,
      density: 500,
      restitution: 0.6,
    });
    let peak = 0;
    let bounced = false;
    for (let i = 0; i < 240; i++) {
      world.step(DT);
      const y = world.bodies.posY[ball] ?? 0;
      if (!bounced && (world.bodies.velY[ball] ?? 0) > 0) bounced = true;
      if (bounced && y > peak) peak = y;
      if (bounced && (world.bodies.velY[ball] ?? 0) < 0 && peak > 0) break;
    }
    // Dropped from 3 with a coefficient of 0.6: energy scales with the square, so about 1.1.
    expect(peak).toBeGreaterThan(0.6);
    expect(peak).toBeLessThan(1.8);
  });

  it('does not bounce a ball with no restitution', () => {
    const world = new PhysicsWorld();
    world.addBody({ type: BODY_STATIC, shape: boxShape(50, 1, 50), y: -1, restitution: 0 });
    const ball = world.addBody({
      type: BODY_DYNAMIC,
      shape: sphereShape(0.5),
      y: 3,
      density: 500,
      restitution: 0,
    });
    run(world, 120);
    expect(world.bodies.posY[ball] ?? 0).toBeLessThan(0.55);
    expect(world.bodies.velY[ball] ?? 0).toBeGreaterThan(-0.2);
  });

  it('bounces to the same height whatever the substep count', () => {
    const peaks: number[] = [];
    for (const substeps of [2, 8]) {
      const world = new PhysicsWorld({ substeps });
      world.addBody({ type: BODY_STATIC, shape: boxShape(50, 1, 50), y: -1, restitution: 0.6 });
      const ball = world.addBody({
        type: BODY_DYNAMIC,
        shape: sphereShape(0.5),
        y: 3,
        density: 500,
        restitution: 0.6,
      });
      let peak = 0;
      let bounced = false;
      for (let i = 0; i < 240; i++) {
        world.step(DT);
        if (!bounced && (world.bodies.velY[ball] ?? 0) > 0) bounced = true;
        if (bounced) peak = Math.max(peak, world.bodies.posY[ball] ?? 0);
      }
      peaks.push(peak);
    }
    expect(Math.abs((peaks[0] ?? 0) - (peaks[1] ?? 0))).toBeLessThan(0.25);
  });
});

describe('shapes other than boxes', () => {
  it('rests a sphere on the ground', () => {
    const world = new PhysicsWorld();
    ground(world);
    const ball = world.addBody({ type: BODY_DYNAMIC, shape: sphereShape(0.5), y: 2, density: 500 });
    run(world, 300);
    expect(world.bodies.posY[ball]).toBeGreaterThan(0.45);
    expect(world.bodies.posY[ball]).toBeLessThan(0.55);
  });

  it('rests a capsule on its side without rocking', () => {
    const world = new PhysicsWorld();
    ground(world);
    const capsule = world.addBody({
      type: BODY_DYNAMIC,
      shape: capsuleShape(0.3, 0.8),
      y: 1.5,
      qz: Math.SQRT1_2,
      qw: Math.SQRT1_2,
      density: 500,
      friction: 0.8,
    });
    run(world, 300);
    expect(world.bodies.posY[capsule]).toBeGreaterThan(0.25);
    expect(world.bodies.posY[capsule]).toBeLessThan(0.35);
    const before = world.bodies.rotZ[capsule] ?? 0;
    run(world, 120);
    expect(Math.abs((world.bodies.rotZ[capsule] ?? 0) - before)).toBeLessThan(0.01);
  });
});

describe('the tick as a whole', () => {
  it('leaves a static body exactly where it was put', () => {
    const world = new PhysicsWorld();
    const g = ground(world);
    world.addBody({ type: BODY_DYNAMIC, shape: boxShape(0.5, 0.5, 0.5), y: 0.55, density: 500 });
    run(world, 120);
    expect(world.bodies.posY[g]).toBe(-1);
    expect(world.bodies.velY[g]).toBe(0);
  });

  it('never produces a NaN', () => {
    const world = new PhysicsWorld();
    ground(world);
    for (let i = 0; i < 12; i++) {
      world.addBody({
        type: BODY_DYNAMIC,
        shape: i % 2 === 0 ? boxShape(0.4, 0.4, 0.4) : sphereShape(0.4),
        x: (i % 4) * 0.3 - 0.5,
        y: 0.5 + i * 0.9,
        z: Math.floor(i / 4) * 0.3,
        density: 500,
      });
    }
    run(world, 400);
    for (let i = 0; i < world.bodies.count; i++) {
      expect(Number.isFinite(world.bodies.posY[i] ?? NaN)).toBe(true);
      expect(Number.isFinite(world.bodies.rotW[i] ?? NaN)).toBe(true);
    }
  });

  it('falls under gravity with nothing to hit', () => {
    const world = new PhysicsWorld();
    const b = world.addBody({ type: BODY_DYNAMIC, shape: sphereShape(0.5), y: 0, density: 500 });
    run(world, 60);
    // One second of 9.81 is about 4.9 metres, plus the half-step the integrator keeps.
    expect(world.bodies.posY[b] ?? 0).toBeLessThan(-4.5);
    expect(world.bodies.posY[b] ?? 0).toBeGreaterThan(-5.5);
  });
});
