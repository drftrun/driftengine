import { describe, expect, it } from 'vitest';
import { BODY_DYNAMIC, BODY_STATIC } from './bodies.ts';
import type { Executor, IslandSolver } from './executor.ts';
import { JOINT_DISTANCE } from './joints.ts';
import { boxShape } from './shape.ts';
import { PhysicsWorld } from './world.ts';

/**
 * What bounds a worker pool's parallelism, asserted rather than assumed.
 *
 * **`executor.ts` said "a pool is slower than serial below some body count", and a body count is
 * the wrong quantity.** No two islands share a body, so a pool splits *islands*; a world with one
 * island has nothing to split however many bodies are in it. This file pins that, because the
 * sentence it corrects had been the reason nobody measured.
 *
 * `packages/physics/scripts/island-bench.ts` carries the timings; these are the shapes behind them.
 */

const DT = 1 / 60;

/** A character that records the island count it was handed, and then solves serially. */
class Counting implements Executor {
  readonly name = 'counting';
  islands = 0;

  run(count: number, solver: IslandSolver): void {
    this.islands = count;
    for (let i = 0; i < count; i++) solver.solveIsland(i);
  }
}

function withCounter(): { world: PhysicsWorld; counter: Counting } {
  const world = new PhysicsWorld({ allowSleep: false });
  const counter = new Counting();
  world.executor = counter;
  world.addBody({ type: BODY_STATIC, shape: boxShape(2000, 1, 2000), y: -1, friction: 0.8 });
  return { world, counter };
}

describe('what a worker pool would be able to split', () => {
  /**
   * **A hundred jointed bodies are one island, so a pool of any size gains nothing.**
   *
   * Joints are used rather than a stack because a stack topples: a hundred-box tower is one island
   * for about a second and seventy islands after that, which measures the opposite of the claim.
   * A joint puts two bodies in one island whatever they then do.
   */
  it('is one island for a hundred jointed bodies', () => {
    const { world, counter } = withCounter();
    let previous = -1;
    for (let i = 0; i < 100; i++) {
      const body = world.addBody({
        type: BODY_DYNAMIC,
        shape: boxShape(0.3, 0.3, 0.3),
        x: i * 0.8,
        y: 4,
        density: 500,
      });
      if (previous >= 0) {
        world.addJoint({ type: JOINT_DISTANCE, bodyA: previous, bodyB: body, length: 0.8 });
      }
      previous = body;
    }
    for (let i = 0; i < 30; i++) world.step(DT);
    expect(counter.islands).toBe(1);
  });

  /** And the same hundred bodies, apart, are a hundred islands a pool could take four at a time. */
  it('is a hundred islands for the same hundred bodies set apart', () => {
    const { world, counter } = withCounter();
    for (let i = 0; i < 100; i++) {
      world.addBody({
        type: BODY_DYNAMIC,
        shape: boxShape(0.3, 0.3, 0.3),
        x: i * 6,
        y: 0.31,
        density: 500,
      });
    }
    for (let i = 0; i < 30; i++) world.step(DT);
    expect(counter.islands).toBe(100);
  });
});
