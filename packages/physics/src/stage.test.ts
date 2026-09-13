import { describe, expect, it } from 'vitest';
import { BODY_DYNAMIC, BODY_STATIC, BodySet } from './bodies.ts';
import { fingerprintBodies } from './fingerprint.ts';
import { IslandSet } from './island.ts';
import { JOINT_DISTANCE, JointSet } from './joints.ts';
import { boxShape } from './shape.ts';
import { ContactConstraints } from './solver.ts';
import { SolveStage, StagedExecutor, lanesOf } from './stage.ts';
import { PhysicsWorld } from './world.ts';

/**
 * The mirror, judged with nothing concurrent in the picture.
 *
 * A pooled tick mirrors the solve state, hands islands out, solves them elsewhere and copies back.
 * Three of those four are this file's subject and one is `workerPool.test.ts`'s, so a divergence has
 * somewhere to be before threads are involved.
 *
 * Two failures are possible and both are silent. A lane the plan does not know about leaves the
 * mirror reading a stale value, which moves the world only where that lane mattered. And a character
 * that quietly declines to stage agrees with serial perfectly — the shape the 2026-09-04 audit
 * removed 57 of. `Counting` answers the second and `lanesOf` answers the first.
 */

const DT = 1 / 60;

/** A staged character that says how much it actually staged, so agreement cannot be vacuous. */
class Counting extends StagedExecutor {
  islands = 0;
  ticks = 0;

  protected override solve(count: number, stage: SolveStage): boolean {
    this.islands += count;
    this.ticks += 1;
    return super.solve(count, stage);
  }
}

function scene(world: PhysicsWorld, stacks: number, high: number): void {
  world.addBody({ type: BODY_STATIC, shape: boxShape(2000, 1, 2000), y: -1, friction: 0.8 });
  let previous = -1;
  for (let s = 0; s < stacks; s++) {
    for (let i = 0; i < high; i++) {
      const body = world.addBody({
        type: BODY_DYNAMIC,
        shape: boxShape(0.5, 0.5, 0.5),
        x: s * 6,
        y: 0.5 + i * 1.02,
        density: 500,
        friction: 0.8,
        restitution: i === 0 ? 0.2 : 0,
      });
      if (s === 0 && i === high - 1 && previous >= 0) {
        world.addJoint({ type: JOINT_DISTANCE, bodyA: previous, bodyB: body, length: 1.02 });
      }
      previous = body;
    }
  }
}

describe('the staging mirror', () => {
  /**
   * **The lane census.** Everything else here would still pass if the plan silently omitted a
   * field, because a stale lane only shows up in a world that reads it. So the plan is checked
   * against reflection over each class, which is the same reflection `lanesOf` performs — the point
   * is that the four classes are enumerated at all, and that a field added tomorrow appears.
   */
  it('plans every typed array the four sets own, and nothing else', () => {
    const live = {
      bodies: new BodySet(8),
      constraints: new ContactConstraints(8),
      joints: new JointSet(8),
      islands: new IslandSet(8),
      dials: new Float64Array(16),
    };
    const plan = SolveStage.planFor(live);

    for (const [set, owner] of [
      ['bodies', live.bodies],
      ['constraints', live.constraints],
      ['joints', live.joints],
      ['islands', live.islands],
    ] as const) {
      const planned = plan.lanes
        .filter((l) => l.set === set)
        .map((l) => l.name)
        .sort();
      expect(planned).toEqual(Object.keys(lanesOf(owner)).sort());
      expect(planned.length).toBeGreaterThan(0);
    }

    expect(
      plan.lanes
        .filter((l) => l.set === 'meta')
        .map((l) => l.name)
        .sort(),
    ).toEqual(['counts', 'dials']);
    /* Object arrays are not lanes: BodySet keeps shapes in plain arrays and the solve never reads
       them, so staging them would be dead bytes and a false claim about what crossed. */
    expect(plan.lanes.some((l) => l.name === 'shape' || l.name === 'shapes')).toBe(false);
  });

  /** No two lanes may overlap, or one set's writes land in another's arrays. */
  it('lays the lanes out without overlap', () => {
    const plan = SolveStage.planFor({
      bodies: new BodySet(8),
      constraints: new ContactConstraints(8),
      joints: new JointSet(8),
      islands: new IslandSet(8),
      dials: new Float64Array(16),
    });
    const sorted = [...plan.lanes].sort((a, b) => a.offset - b.offset);
    let end = 0;
    for (const lane of sorted) {
      expect(lane.offset).toBeGreaterThanOrEqual(end);
      const width = {
        Float32Array: 4,
        Float64Array: 8,
        Int32Array: 4,
        Uint32Array: 4,
        Uint16Array: 2,
        Uint8Array: 1,
      }[lane.kind];
      end = lane.offset + lane.length * width;
      expect(end).toBeLessThanOrEqual(plan.bytes);
    }
  });

  /**
   * **The mirror is faithful, tick for tick.** Contacts, a joint, restitution and sleeping all
   * flow through it, and the fingerprint is over every body's pose and velocity.
   */
  it('solves through the mirror to the same state as solving in place', () => {
    const direct = new PhysicsWorld({ allowSleep: false });
    const staged = new PhysicsWorld({ allowSleep: false });
    const counter = new Counting();
    staged.executor = counter;
    scene(direct, 6, 5);
    scene(staged, 6, 5);

    for (let tick = 0; tick < 240; tick++) {
      direct.step(DT);
      staged.step(DT);
      expect(fingerprintBodies(staged.bodies)).toBe(fingerprintBodies(direct.bodies));
    }

    /* Without this the assertion above is satisfied by a character that never staged anything. */
    expect(counter.ticks).toBe(240);
    expect(counter.islands).toBeGreaterThan(240);
  });

  /** Sleeping is a dial the mirror carries, and a slept island writes nothing on either side. */
  it('agrees while islands fall asleep', () => {
    const direct = new PhysicsWorld();
    const staged = new PhysicsWorld();
    staged.executor = new StagedExecutor();
    scene(direct, 4, 2);
    scene(staged, 4, 2);
    for (let tick = 0; tick < 200; tick++) {
      direct.step(DT);
      staged.step(DT);
    }
    expect(fingerprintBodies(staged.bodies)).toBe(fingerprintBodies(direct.bodies));
  });

  /**
   * **A grow re-plans, and the tick after it must still agree.** `BodySet` starts at 64 and doubles,
   * so adding past that mid-run is what moves every lane's offset. A mirror that kept its old views
   * would write into a buffer nothing reads, and the world would freeze rather than diverge.
   */
  it('follows the sets through a grow', () => {
    const direct = new PhysicsWorld({ allowSleep: false });
    const staged = new PhysicsWorld({ allowSleep: false });
    staged.executor = new StagedExecutor();
    scene(direct, 4, 4);
    scene(staged, 4, 4);
    for (let tick = 0; tick < 20; tick++) {
      direct.step(DT);
      staged.step(DT);
    }
    /* Past 64 bodies, so `grow` runs and every offset moves. */
    for (const world of [direct, staged]) {
      for (let i = 0; i < 60; i++) {
        world.addBody({
          type: BODY_DYNAMIC,
          shape: boxShape(0.4, 0.4, 0.4),
          x: 40 + i * 3,
          y: 0.4,
          density: 400,
          friction: 0.8,
        });
      }
    }
    expect(direct.bodies.count).toBeGreaterThan(64);
    for (let tick = 0; tick < 60; tick++) {
      direct.step(DT);
      staged.step(DT);
      expect(fingerprintBodies(staged.bodies)).toBe(fingerprintBodies(direct.bodies));
    }
  });

  /** A world whose dials change between ticks must be followed, since they cross as numbers. */
  it('carries a dial changed between ticks', () => {
    const direct = new PhysicsWorld({ allowSleep: false });
    const staged = new PhysicsWorld({ allowSleep: false });
    staged.executor = new StagedExecutor();
    scene(direct, 3, 4);
    scene(staged, 3, 4);
    for (let tick = 0; tick < 90; tick++) {
      if (tick === 30) {
        for (const world of [direct, staged]) {
          world.gravityX = 4;
          world.frictionModel = 'elliptical';
        }
      }
      direct.step(DT);
      staged.step(DT);
      expect(fingerprintBodies(staged.bodies)).toBe(fingerprintBodies(direct.bodies));
    }
  });
});
