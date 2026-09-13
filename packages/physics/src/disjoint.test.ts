import { describe, expect, it } from 'vitest';
import { BODY_DYNAMIC, BODY_KINEMATIC, BODY_STATIC, BodySet } from './bodies.ts';
import { DisjointExecutor } from './executor.ts';
import type { IslandSolver } from './executor.ts';
import { JOINT_DISTANCE } from './joints.ts';
import { boxShape } from './shape.ts';
import { PhysicsWorld } from './world.ts';

/**
 * The premise a worker pool rests on, and the proof that this file can see it break.
 *
 * **Two islands never write the same body.** Every other test here would stay green if that stopped
 * being true, because serial physics does not care: it is only a pool that turns a shared lane into
 * a race. So the invariant needs a test of its own, and that test needs to be one that fails.
 *
 * The last case is the one that matters. A detector nobody has seen fire is a detector that reports
 * clean on a scene it never examined — which is exactly the shape the 2026-09-04 claim audit spent a
 * release removing from `scripts/*-check.mjs`. `it('sees an overlap when there is one')` is the
 * guard against this whole file being decorative.
 */

const DT = 1 / 60;

function ground(world: PhysicsWorld): void {
  world.addBody({ type: BODY_STATIC, shape: boxShape(2000, 1, 2000), y: -1, friction: 0.8 });
}

function settle(world: PhysicsWorld, checker: DisjointExecutor, ticks = 40): void {
  for (let i = 0; i < ticks; i++) {
    world.step(DT);
    expect(checker.overlap).toBeNull();
  }
}

describe('no two islands write the same body', () => {
  /**
   * **The case the whole design turns on.** A static floor is in contact with every tower standing
   * on it, so it is read by every island and would be written by all of them if any write site
   * lacked its `invMass > 0` guard.
   */
  it('holds for eight towers sharing one static floor', () => {
    const world = new PhysicsWorld({ allowSleep: false });
    const checker = new DisjointExecutor(world.bodies);
    world.executor = checker;
    ground(world);
    for (let s = 0; s < 8; s++) {
      for (let i = 0; i < 5; i++) {
        world.addBody({
          type: BODY_DYNAMIC,
          shape: boxShape(0.5, 0.5, 0.5),
          x: s * 6,
          y: 0.5 + i * 1.02,
          density: 500,
          friction: 0.8,
        });
      }
    }
    settle(world, checker);
  });

  /**
   * A kinematic body is the other shape that could be written from two islands: it is not static,
   * so `integratePositions`' `BODY_STATIC` test does not exclude it, and it is not dynamic, so
   * `island.ts` never puts it in `bodyOrder`. The second fact is what saves it, and this asserts
   * that rather than the first.
   */
  it('holds for two stacks resting on one kinematic platform', () => {
    const world = new PhysicsWorld({ allowSleep: false });
    const checker = new DisjointExecutor(world.bodies);
    world.executor = checker;
    ground(world);
    world.addBody({ type: BODY_KINEMATIC, shape: boxShape(20, 0.5, 6), y: 2, friction: 0.8 });
    for (let s = 0; s < 2; s++) {
      for (let i = 0; i < 4; i++) {
        world.addBody({
          type: BODY_DYNAMIC,
          shape: boxShape(0.4, 0.4, 0.4),
          x: s * 8 - 4,
          y: 2.9 + i * 0.82,
          density: 400,
          friction: 0.8,
        });
      }
    }
    settle(world, checker);
  });

  /** A joint merges two groups into one island, so the merged bodies must have exactly one owner. */
  it('holds for a chain jointing two towers into one island', () => {
    const world = new PhysicsWorld({ allowSleep: false });
    const checker = new DisjointExecutor(world.bodies);
    world.executor = checker;
    ground(world);
    const left: number[] = [];
    const right: number[] = [];
    for (let i = 0; i < 4; i++) {
      left.push(
        world.addBody({
          type: BODY_DYNAMIC,
          shape: boxShape(0.4, 0.4, 0.4),
          x: 0,
          y: 0.4 + i * 0.82,
          density: 400,
        }),
      );
      right.push(
        world.addBody({
          type: BODY_DYNAMIC,
          shape: boxShape(0.4, 0.4, 0.4),
          x: 6,
          y: 0.4 + i * 0.82,
          density: 400,
        }),
      );
    }
    world.addJoint({
      type: JOINT_DISTANCE,
      bodyA: left[3] as number,
      bodyB: right[3] as number,
      length: 6,
    });
    settle(world, checker);
  });

  /** Sleeping islands write nothing, and a character that reported that as an overlap would be useless. */
  it('holds while islands fall asleep and stay asleep', () => {
    const world = new PhysicsWorld();
    const checker = new DisjointExecutor(world.bodies);
    world.executor = checker;
    ground(world);
    for (let s = 0; s < 6; s++) {
      world.addBody({
        type: BODY_DYNAMIC,
        shape: boxShape(0.5, 0.5, 0.5),
        x: s * 6,
        y: 0.5,
        density: 500,
        friction: 0.8,
      });
    }
    settle(world, checker, 150);
  });

  /**
   * **The detector detects.** Everything above is an absence, and an absence proves nothing until
   * the instrument has been seen to move. Two islands are handed a solver that writes one body from
   * both; the overlap must be reported, and it must name the body and the two islands.
   */
  it('sees an overlap when there is one', () => {
    const bodies = new BodySet();
    bodies.add({ type: BODY_DYNAMIC, shape: boxShape(0.5, 0.5, 0.5) });
    bodies.add({ type: BODY_DYNAMIC, shape: boxShape(0.5, 0.5, 0.5) });

    const clashing: IslandSolver = {
      solveIsland(): void {
        bodies.velY[1] = (bodies.velY[1] ?? 0) + 1;
      },
    };

    const checker = new DisjointExecutor(bodies);
    checker.run(2, clashing);
    expect(checker.overlap).toEqual({ body: 1, first: 0, second: 1 });
  });

  /** And it is quiet when the same two islands write a body each, which is the honest case. */
  it('stays quiet when each island writes only its own body', () => {
    const bodies = new BodySet();
    bodies.add({ type: BODY_DYNAMIC, shape: boxShape(0.5, 0.5, 0.5) });
    bodies.add({ type: BODY_DYNAMIC, shape: boxShape(0.5, 0.5, 0.5) });

    const tidy: IslandSolver = {
      solveIsland(island: number): void {
        bodies.velY[island] = (bodies.velY[island] ?? 0) + 1;
      },
    };

    const checker = new DisjointExecutor(bodies);
    checker.run(2, tidy);
    expect(checker.overlap).toBeNull();
  });
});
