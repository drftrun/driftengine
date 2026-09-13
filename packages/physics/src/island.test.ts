import { describe, expect, it } from 'vitest';
import { BODY_DYNAMIC, BODY_STATIC } from './bodies.ts';
import { ShuffledExecutor } from './executor.ts';
import { boxShape } from './shape.ts';
import { PhysicsWorld } from './world.ts';

const DT = 1 / 60;

function tower(world: PhysicsWorld, x: number, height: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < height; i++) {
    out.push(
      world.addBody({
        type: BODY_DYNAMIC,
        shape: boxShape(0.5, 0.5, 0.5),
        x,
        y: 0.5 + i * 1.02,
        density: 500,
        friction: 0.8,
      }),
    );
  }
  return out;
}

function settled(world: PhysicsWorld, ticks = 400): void {
  for (let i = 0; i < ticks; i++) world.step(DT);
}

/** Every dynamic body's state, to the bit, as one string. */
function snapshot(world: PhysicsWorld): string {
  const parts: string[] = [];
  for (let i = 0; i < world.bodies.count; i++) {
    parts.push(
      `${world.bodies.posX[i]},${world.bodies.posY[i]},${world.bodies.posZ[i]},` +
        `${world.bodies.rotX[i]},${world.bodies.rotY[i]},${world.bodies.rotZ[i]},${world.bodies.rotW[i]},` +
        `${world.bodies.velX[i]},${world.bodies.velY[i]},${world.bodies.velZ[i]}`,
    );
  }
  return parts.join(';');
}

function twoTowers(): PhysicsWorld {
  const world = new PhysicsWorld();
  world.addBody({ type: BODY_STATIC, shape: boxShape(50, 1, 50), y: -1, friction: 0.8 });
  tower(world, -20, 3);
  tower(world, 20, 3);
  return world;
}

describe('islands', () => {
  it('makes two towers that never touch into two islands', () => {
    const world = twoTowers();
    world.step(DT);
    expect(world.islandCount).toBe(2);
  });

  /**
   * The one that says what an island *is*. A static floor touches everything standing on it, so a
   * version that let statics merge would make one island of the whole world — and nothing would
   * ever sleep, because one moving body anywhere would hold every other awake.
   */
  it('does not merge two towers through the floor they both stand on', () => {
    const world = twoTowers();
    settled(world, 60);
    expect(world.islandCount).toBe(2);
  });

  it('merges two towers when a body bridges them', () => {
    const world = new PhysicsWorld();
    world.addBody({ type: BODY_STATIC, shape: boxShape(50, 1, 50), y: -1, friction: 0.8 });
    tower(world, -1, 2);
    tower(world, 1, 2);
    // A plank across both.
    world.addBody({ type: BODY_DYNAMIC, shape: boxShape(2, 0.2, 0.5), y: 2.3, density: 500 });
    settled(world, 120);
    expect(world.islandCount).toBe(1);
  });

  it('gives a body with no contacts an island of its own', () => {
    const world = new PhysicsWorld();
    world.addBody({ type: BODY_DYNAMIC, shape: boxShape(0.5, 0.5, 0.5), y: 100, density: 500 });
    world.addBody({ type: BODY_DYNAMIC, shape: boxShape(0.5, 0.5, 0.5), y: 200, density: 500 });
    world.step(DT);
    expect(world.islandCount).toBe(2);
  });

  it('still falls under gravity when it is a singleton island', () => {
    const world = new PhysicsWorld();
    const b = world.addBody({
      type: BODY_DYNAMIC,
      shape: boxShape(0.5, 0.5, 0.5),
      y: 100,
      density: 500,
    });
    settled(world, 60);
    // A second of 9.81 is about 4.9 metres, so it should be near 95.1 rather than under 95.
    expect(world.bodies.posY[b] ?? 0).toBeLessThan(95.5);
    expect(world.bodies.posY[b] ?? 0).toBeGreaterThan(94.5);
  });

  it('counts no islands for a world of statics alone', () => {
    const world = new PhysicsWorld();
    world.addBody({ type: BODY_STATIC, shape: boxShape(50, 1, 50), y: -1 });
    world.step(DT);
    expect(world.islandCount).toBe(0);
  });
});

describe('sleeping', () => {
  it('puts a settled stack to sleep', () => {
    const world = twoTowers();
    settled(world, 600);
    expect(world.sleeping(1)).toBe(true);
  });

  it('does not sleep a body that is still moving', () => {
    const world = new PhysicsWorld();
    const b = world.addBody({
      type: BODY_DYNAMIC,
      shape: boxShape(0.5, 0.5, 0.5),
      y: 100,
      density: 500,
    });
    settled(world, 200);
    expect(world.sleeping(b)).toBe(false);
  });

  /**
   * Sleeping is a property of an island, not of a body. One moving box in a stack holds the whole
   * stack awake, because a box that slept under it would be woken by it on the next tick anyway.
   */
  it('holds a whole island awake while one of its bodies moves', () => {
    const world = new PhysicsWorld();
    world.addBody({ type: BODY_STATIC, shape: boxShape(50, 1, 50), y: -1, friction: 0.8 });
    const boxes = tower(world, 0, 4);
    settled(world, 600);
    expect(world.sleeping(boxes[0] ?? 0)).toBe(true);
    world.bodies.velX[boxes[3] ?? 0] = 3;
    world.wakeIsland(boxes[3] ?? 0);
    world.step(DT);
    expect(world.sleeping(boxes[0] ?? 0)).toBe(false);
  });

  it('wakes the whole island rather than one body', () => {
    const world = new PhysicsWorld();
    world.addBody({ type: BODY_STATIC, shape: boxShape(50, 1, 50), y: -1, friction: 0.8 });
    const boxes = tower(world, 0, 3);
    settled(world, 600);
    world.wakeIsland(boxes[2] ?? 0);
    for (const b of boxes) expect(world.sleeping(b)).toBe(false);
  });

  it('leaves a sleeping stack exactly where it was', () => {
    const world = twoTowers();
    settled(world, 600);
    const before = snapshot(world);
    settled(world, 300);
    expect(snapshot(world)).toBe(before);
  });
});

describe('the executor seam', () => {
  /**
   * No two islands share a body, so solving them in any order must produce identical state. That
   * is the property a worker pool would rely on, and it is asserted rather than argued.
   */
  it('produces identical state whichever order the islands are solved in', () => {
    const serial = twoTowers();
    const shuffled = twoTowers();
    shuffled.executor = new ShuffledExecutor();
    settled(serial, 300);
    settled(shuffled, 300);
    expect(snapshot(shuffled)).toBe(snapshot(serial));
  });

  it('agrees on a scene of many independent islands too', () => {
    const build = (): PhysicsWorld => {
      const world = new PhysicsWorld();
      world.addBody({ type: BODY_STATIC, shape: boxShape(200, 1, 200), y: -1, friction: 0.8 });
      for (let i = 0; i < 8; i++) tower(world, i * 12 - 40, 3);
      return world;
    };
    const serial = build();
    const shuffled = build();
    shuffled.executor = new ShuffledExecutor();
    settled(serial, 240);
    settled(shuffled, 240);
    expect(shuffled.islandCount).toBe(8);
    expect(snapshot(shuffled)).toBe(snapshot(serial));
  });

  it('names which character produced a figure', () => {
    expect(new ShuffledExecutor().name).toBe('shuffled');
    expect(new PhysicsWorld().executor.name).toBe('serial');
  });
});
