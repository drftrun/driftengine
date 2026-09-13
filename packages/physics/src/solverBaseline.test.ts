import { describe, expect, it } from 'vitest';
import { BODY_DYNAMIC, BODY_STATIC } from './bodies.ts';
import type { BodyDesc } from './bodies.ts';
import { ShuffledExecutor } from './executor.ts';
import { fingerprintBodies } from './fingerprint.ts';
import { boxShape, capsuleShape, sphereShape } from './shape.ts';
import { PhysicsWorld } from './world.ts';

/**
 * What the solver produced, frozen so a change to it has to be deliberate.
 *
 * The same instrument as the collision baseline, one layer up: a scene run for a fixed number of
 * ticks and hashed by `fingerprintBodies`. **What it gives up** is that it agrees with a bug that
 * was already there, which is why the property tests in `solver.test.ts` are what say the
 * simulation is *right* and this only says it has not changed. **What would make it wrong** is a
 * deliberate change to the solver, at which point the hash is re-frozen in the same commit and the
 * message says what moved and why.
 */

/**
 * A stack, a ramp with a sphere on it, and a capsule on its side.
 *
 * **The ground is 400 metres long, and the length is load-bearing rather than generous.** Nothing
 * here models rolling resistance, so the sphere that comes off the ramp keeps rolling, and it was
 * only staying on a 60-metre floor because a solver bug was quietly braking it: a rolling body's
 * contact anchor turned with the body, climbed its side, and reported a gap that was not there.
 * Fixed on 2026-08-27 — see `Manifold.curvedA` — the sphere rolls the way the model says it
 * should, leaves a short floor, and lands in the permutation test below as a metre of free fall
 * that has nothing to do with the property being tested. A floor it is still on at tick 600 is
 * what makes "an equivalent rest" a question about rest.
 */
function scene(): readonly BodyDesc[] {
  const out: BodyDesc[] = [
    { type: BODY_STATIC, shape: boxShape(200, 1, 30), y: -1, friction: 0.7 },
    // A ramp, tilted about z.
    {
      type: BODY_STATIC,
      shape: boxShape(4, 0.3, 3),
      x: -8,
      y: 1.5,
      qz: Math.sin(Math.PI / 12),
      qw: Math.cos(Math.PI / 12),
      friction: 0.5,
    },
    { type: BODY_DYNAMIC, shape: sphereShape(0.4), x: -10, y: 3.2, density: 400, friction: 0.5 },
    {
      type: BODY_DYNAMIC,
      shape: capsuleShape(0.3, 0.7),
      x: 5,
      y: 1.2,
      qz: Math.SQRT1_2,
      qw: Math.SQRT1_2,
      density: 400,
      friction: 0.7,
    },
  ];
  for (let i = 0; i < 6; i++) {
    out.push({
      type: BODY_DYNAMIC,
      shape: boxShape(0.5, 0.5, 0.5),
      x: i % 2 === 0 ? 0 : 0.03,
      y: 0.5 + i * 1.03,
      density: 500,
      friction: 0.7,
    });
  }
  return out;
}

function build(descs: readonly BodyDesc[]): PhysicsWorld {
  const world = new PhysicsWorld();
  for (const d of descs) world.addBody(d);
  return world;
}

function run(world: PhysicsWorld, ticks = 600): PhysicsWorld {
  for (let i = 0; i < ticks; i++) world.step(1 / 60);
  return world;
}

/** Every body's resting height, sorted, so the list does not depend on insertion order. */
function places(world: PhysicsWorld): string[] {
  const out: number[] = [];
  for (let i = 0; i < world.bodies.count; i++) out.push(world.bodies.posY[i] ?? 0);
  return out.sort((a, b) => a - b).map((v) => v.toFixed(4));
}

describe('the solver baseline', () => {
  /**
   * **Re-frozen 2026-08-27**, for the two changes named in the scene comment above: the floor grew,
   * and a contact anchor on a curved surface is now held in world frame instead of turning with its
   * body. The visible half of the second is that the sphere rests at **exactly 0.4000**, its own
   * radius, where it used to rest at 0.3916 — eight and a half millimetres of sink that were an
   * artefact of the anchor and not of the contact.
   */
  it('produces the state frozen when the solver was built', () => {
    expect(fingerprintBodies(run(build(scene())).bodies)).toBe('0882e17a473cd8c8');
  });

  it('is a scene that actually moved', () => {
    const world = run(build(scene()));
    // The sphere fell onto a tilted ramp and rolled off it onto the ground. Nothing here models
    // rolling resistance, so it keeps going; what matters is that it left the ramp and is resting
    // on the floor at exactly its own radius, which is the anchor fix in one number.
    expect(world.bodies.posY[2] ?? 0).toBeCloseTo(0.4, 4);
    expect(world.bodies.posX[2] ?? 0).toBeLessThan(-11);
    // And the stack is still a stack.
    expect(world.bodies.posY[9] ?? 0).toBeGreaterThan(4.5);
  });

  it('gives the same answer twice', () => {
    expect(fingerprintBodies(run(build(scene())).bodies)).toBe(
      fingerprintBodies(run(build(scene())).bodies),
    );
  });

  /**
   * Insertion order is part of the scene, and this is what that means.
   *
   * The design's §3c asked for *identical state* under a permutation of insertion order. That is
   * not achievable and should not be: body index is what orders the solve, sequential impulses are
   * order-dependent by construction, and a scene built in a different order is a different, equally
   * valid simulation. Measured on this stack of six: **40 millimetres of difference on a tower 5.4
   * metres tall**, with both towers standing.
   *
   * The property that *is* required, and is asserted where it belongs: tree shape must not leak
   * into the pair list (`pairs.test.ts`) and island order must not leak into the result
   * (`island.test.ts`). What determinism needs is that one scene definition always produces one
   * answer, which the two tests above this cover.
   */
  it('reaches an equivalent rest whichever order the bodies were added in', () => {
    const forward = places(run(build(scene()))).map(Number);
    const reversed = places(run(build([...scene()].reverse()))).map(Number);
    expect(reversed.length).toBe(forward.length);
    for (let i = 0; i < forward.length; i++) {
      expect(Math.abs((reversed[i] ?? 0) - (forward[i] ?? 0))).toBeLessThan(0.1);
    }
  });

  it('does not depend on which character solved the islands', () => {
    const serial = run(build(scene()));
    const shuffled = build(scene());
    shuffled.executor = new ShuffledExecutor();
    run(shuffled);
    expect(fingerprintBodies(shuffled.bodies)).toBe(fingerprintBodies(serial.bodies));
  });
});
