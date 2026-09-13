import { describe, expect, it } from 'vitest';
import { AXIS_X, AXIS_Y, AXIS_Z, moveAxis } from './collide/index.ts';
import type { Body } from './collide/index.ts';
import { ColliderSet, boxCollider } from './colliderSet.ts';

/**
 * What the sweep produced, frozen before the kernel moved packages.
 *
 * **An expectation produced by the code under test agrees with that code however wrong it is.** A
 * hand-derived literal is the house rule and 600 ticks of swept collision cannot be hand-derived,
 * so the substitute is the audio baseline's: a reference captured from code that predates the
 * change it judges. This one guards a file move, where the correct diff is zero and nothing else
 * in the suite could say so.
 *
 * **What this gives up:** it agrees with a bug that was already there, which is why it is a
 * supplement to the behavioural tests beside it rather than a replacement. **What would make it
 * wrong** is a deliberate change to the sweep, at which point the hash is re-frozen in the same
 * commit and the message says what moved.
 */

/** A staircase, a wall and a lid: enough geometry to exercise step-up, block and ceiling. */
function worldBoxes() {
  return [
    boxCollider(0, -0.5, 0, 20, 0.5, 20),
    boxCollider(3, 0.15, 0, 1, 0.15, 4),
    boxCollider(5, 0.45, 0, 1, 0.15, 4),
    boxCollider(7, 0.75, 0, 1, 0.15, 4),
    boxCollider(10, 1.5, 0, 0.5, 1.5, 4),
    boxCollider(-4, 2.2, 0, 2, 0.2, 2),
  ];
}

function world(): ColliderSet {
  return new ColliderSet(worldBoxes());
}

/** The same solids, handed over back to front. Nothing about the world differs. */
function reversedWorld(): ColliderSet {
  return new ColliderSet([...worldBoxes()].reverse());
}

/**
 * FNV-1a over the raw bytes of the state, carried as two 32-bit halves.
 *
 * The same construction `fingerprintColliders` uses, and for the same reason it gives: a float's
 * decimal rendering is a platform question and its bit pattern is not.
 */
function digest(samples: Float64Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let low = 0x811c9dc5;
  let high = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    low = Math.imul(low ^ (bytes[i] ?? 0), 0x01000193) >>> 0;
    high = Math.imul(high ^ (bytes[bytes.length - 1 - i] ?? 0), 0x01000193) >>> 0;
  }
  return `${low.toString(16).padStart(8, '0')}${high.toString(16).padStart(8, '0')}`;
}

/** 600 ticks of a scripted walk, sampling the body's position each tick. */
function run(build: () => ColliderSet = world): Float64Array {
  const boxes = build();
  const body: Body = { x: -8, y: 1, z: 0, hx: 0.35, hy: 0.9, hz: 0.35 };
  const samples = new Float64Array(600 * 3);
  for (let tick = 0; tick < 600; tick++) {
    // A fixed, seedless script: forward, a little lateral weave, and gravity every tick.
    moveAxis(body, boxes, AXIS_X, 0.05);
    moveAxis(body, boxes, AXIS_Z, tick % 120 < 60 ? 0.01 : -0.01);
    moveAxis(body, boxes, AXIS_Y, -0.02);
    samples[tick * 3] = body.x;
    samples[tick * 3 + 1] = body.y;
    samples[tick * 3 + 2] = body.z;
  }
  return samples;
}

describe('the collision baseline', () => {
  it('produces the state frozen before the kernel moved packages', () => {
    expect(digest(run())).toBe('2ac12043271a32d3');
  });

  it('is a walk rather than a body sitting still', () => {
    const samples = run();
    const startX = samples[0] ?? 0;
    const endX = samples[599 * 3] ?? 0;
    expect(endX - startX).toBeGreaterThan(5);
  });

  it('never ends inside the floor', () => {
    const samples = run();
    for (let tick = 0; tick < 600; tick++) {
      expect(samples[tick * 3 + 1] ?? 0).toBeGreaterThan(-0.1);
    }
  });

  /**
   * The third of the design's three determinism gates, in the form this layer can carry it.
   *
   * A frozen hash compares this build against the last one and agrees with both if both are wrong
   * the same way. A permutation is a *property*: the geometry is the same set of solids whatever
   * order they were handed over in, so the walk over it must be identical. It is what catches an
   * answer that depends on insertion history rather than on the world.
   *
   * The solver's version of this — pair and island ordering — lands with the solver, because until
   * there is accumulation across bodies there is nothing else for order to leak into.
   */
  it('does not depend on the order the colliders were given in', () => {
    expect(digest(run(reversedWorld))).toBe(digest(run(world)));
  });
});
