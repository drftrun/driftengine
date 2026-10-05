import { describe, expect, it } from 'vitest';

import { SkinnedCloth } from './skinnedCloth.ts';
import type { ClothCollider, SkinnedClothSetup } from './skinnedClothSetup.ts';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Column-major translations, `count` of them, joint `j` moved by `moves[j]` where given. */
function joints(count: number, moves: Record<number, [number, number, number]> = {}): Float32Array {
  const out = new Float32Array(count * 16);
  for (let j = 0; j < count; j++) {
    out.set(IDENTITY, j * 16);
    const move = moves[j];
    if (move !== undefined) out.set(move, j * 16 + 12);
  }
  return out;
}

const translation = (x: number, y: number, z: number): Float32Array =>
  Float32Array.from([...IDENTITY.slice(0, 12), x, y, z, 1]);

/**
 * One particle, or several, each skinned wholly to joint 0 of an eight-joint rig whose inverse bind
 * matrices are identities, with a rest normal of +z, no gravity and no constraints.
 */
function particles(
  positions: number[],
  inverseMass: number[],
  extra: Partial<SkinnedClothSetup> = {},
): SkinnedClothSetup {
  const count = positions.length / 3;
  const weights = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) weights[i * 4] = 1;
  return {
    positions: new Float32Array(positions),
    normals: Float32Array.from({ length: count * 3 }, (_, i) => (i % 3 === 2 ? 1 : 0)),
    inverseMass: new Float32Array(inverseMass),
    joints: new Float32Array(count * 4),
    weights,
    inverseBind: joints(8),
    distance: {
      pairs: new Uint32Array(0),
      rest: new Float32Array(0),
      compliance: new Float32Array(0),
    },
    parameters: { gravity: [0, 0, 0] },
    ...extra,
  };
}

const at = (cloth: SkinnedCloth, i: number): number[] =>
  Array.from(cloth.positions.subarray(i * 3, i * 3 + 3));

const near = (actual: number[], expected: number[], digits = 4): void => {
  expect(actual.length).toBe(expected.length);
  actual.forEach((v, i) => expect(v, `component ${i}`).toBeCloseTo(expected[i] as number, digits));
};

describe('a skinned cloth posed by a skeleton', () => {
  /*
   * **A kinematic particle is where skinning puts it, exactly.** Rest (1, 0, 0); joint 0 moved
   * (0, 2, 0), the model moved (5, 0, 0): it lands at (6, 2, 0). And through the second set of four:
   * half on joint 0 at rest and half on joint 6, moved (0, 2, 0) and named only in `joints2`, it
   * lands half way, at (1, 1, 0).
   */
  it('A KINEMATIC PARTICLE IS WHERE ITS SKINNING PUTS IT, BY ALL EIGHT INFLUENCES', () => {
    const cloth = new SkinnedCloth(particles([1, 0, 0], [0]));
    cloth.setPose(joints(8, { 0: [0, 2, 0] }), translation(5, 0, 0));
    cloth.advance(1 / 60);
    near(at(cloth, 0), [6, 2, 0]);

    const eight = new SkinnedCloth(
      particles([1, 0, 0], [0], {
        weights: new Float32Array([0.5, 0, 0, 0]),
        joints2: new Float32Array([6, 0, 0, 0]),
        weights2: new Float32Array([0.5, 0, 0, 0]),
      }),
    );
    eight.setPose(joints(8, { 6: [0, 2, 0] }), translation(0, 0, 0));
    eight.advance(1 / 60);
    near(at(eight, 0), [1, 1, 0]);
  });

  /*
   * **A max distance is a sphere around the skinned position.** A free particle at rest at the
   * origin, gravity −10, max distance 0.5: it hangs at (0, −0.5, 0) and no lower, and a scale of 2
   * on every max distance lets it hang to −1.
   */
  it('A MAX DISTANCE HOLDS A PARTICLE WITHIN ITS SPHERE, SCALED AS ASKED', () => {
    for (const [scale, depth] of [
      [1, -0.5],
      [2, -1],
    ] as const) {
      const cloth = new SkinnedCloth(
        particles([0, 0, 0], [1], {
          limits: { maxDistance: new Float32Array([0.5]) },
          parameters: { gravity: [0, -10, 0], maxDistanceScale: scale },
        }),
      );
      cloth.setPose(joints(8), translation(0, 0, 0));
      cloth.advance(2);
      near(at(cloth, 0), [0, depth, 0], 3);
    }
  });

  /*
   * **A backstop is a sphere behind the skinned position the particle may not enter.** Normal +z,
   * backstop distance 0.1 and radius 1: its centre is 1.1 behind, at z = −1.1, so the particle can
   * come no closer to the body than z = −0.1. Dropped in at z = −0.5 it is put out at −0.1. A
   * frontstop is the same in front: distance 0.2, radius 1, centre at z = 1.2, surface at z = 0.2.
   */
  it('A BACKSTOP KEEPS A PARTICLE OUT OF ITS SPHERE BEHIND, AND A FRONTSTOP IN FRONT', () => {
    const back = new SkinnedCloth(
      particles([0, 0, 0], [1], { limits: { backstop: new Float32Array([0.1, 1]) } }),
    );
    back.setPose(joints(8), translation(0, 0, 0));
    back.positions[2] = -0.5;
    back.advance(1 / 60);
    near(at(back, 0), [0, 0, -0.1]);

    const front = new SkinnedCloth(
      particles([0, 0, 0], [1], { limits: { frontstop: new Float32Array([0.2, 1]) } }),
    );
    front.setPose(joints(8), translation(0, 0, 0));
    front.positions[2] = 0.6;
    front.advance(1 / 60);
    near(at(front, 0), [0, 0, 0.2]);
  });

  /*
   * **Colliders ride their joints.** A sphere of radius 0.5 on joint 1, which is moved to
   * (0, 3, 0): a particle at (0, 3.2, 0) is put out to its surface plus its thickness of 0.05, at
   * (0, 3.55, 0). A tapered capsule on joint 0 along +z from 0 to 2, radius 1 narrowing to 0.5: half
   * way along its radius is 0.75, so a particle at (0.3, 0, 1) goes to (0.8, 0, 1) with the 0.05.
   * And a collider sits where its frame puts it on its joint: a sphere framed 5 m along x on joint 2
   * puts a particle at (5.2, 0, 0) out to (5.55, 0, 0).
   */
  it('A SPHERE AND A TAPERED CAPSULE ON JOINTS PUT A PARTICLE OUT TO THEIR SURFACE PLUS ITS THICKNESS', () => {
    const sphere: ClothCollider = { joint: 1, radius: 0.5 };
    const capsule: ClothCollider = { joint: 0, radius: 1, radius2: 0.5, length: 2 };
    const framed: ClothCollider = { joint: 2, radius: 0.5, frame: translation(5, 0, 0) };
    const cloth = new SkinnedCloth(
      particles([0, 3.2, 0, 0.3, 0, 1, 5.2, 0, 0], [1, 1, 1], {
        colliders: [sphere, capsule, framed],
        limits: { thickness: new Float32Array([0.05, 0.05, 0.05]) },
      }),
    );
    cloth.setPose(joints(8, { 1: [0, 3, 0] }), translation(0, 0, 0));
    /* Free particles start where they are told, not where their joints would skin them. */
    cloth.positions.set([0, 3.2, 0, 0.3, 0, 1, 5.2, 0, 0]);
    cloth.advance(1 / 60);
    near(at(cloth, 0), [0, 3.55, 0]);
    near(at(cloth, 1), [0.8, 0, 1]);
    near(at(cloth, 2), [5.55, 0, 0]);
  });

  /*
   * **A teleport resets rather than flings.** The model jumps 100 m in one pose; past a teleport
   * distance of 1 m the cloth resets, so the free particle is at its skinned position with no
   * velocity, instead of a hundred metres behind its body at six kilometres an hour.
   */
  it('A TELEPORT PAST ITS THRESHOLD RESETS THE CLOTH TO ITS SKINNED POSE', () => {
    const cloth = new SkinnedCloth(
      particles([0, 1, 0], [1], { parameters: { gravity: [0, 0, 0], teleportDistance: 1 } }),
    );
    cloth.setPose(joints(8), translation(0, 0, 0));
    cloth.advance(1 / 60);
    cloth.setPose(joints(8), translation(100, 0, 0));
    cloth.advance(1 / 60);
    near(at(cloth, 0), [100, 1, 0]);
    near(Array.from(cloth.velocities), [0, 0, 0]);
  });

  /*
   * **Inertia is how much of the character's motion the cloth keeps as its own.** A free particle
   * at rest at the origin, the model moved 1 m along x in one step. At inertia 1 — fully in the world
   * — it stays where it was; at 0 it moves with the character, as if simulated in its space.
   */
  it('INERTIA 1 LEAVES A FREE PARTICLE IN THE WORLD, AND 0 CARRIES IT WITH THE CHARACTER', () => {
    for (const [inertia, x] of [
      [1, 0],
      [0, 1],
    ] as const) {
      const cloth = new SkinnedCloth(
        particles([0, 0, 0], [1], {
          parameters: { gravity: [0, 0, 0], linearInertia: inertia, angularInertia: inertia },
        }),
      );
      cloth.setPose(joints(8), translation(0, 0, 0));
      cloth.advance(1 / 60);
      cloth.setPose(joints(8), translation(1, 0, 0));
      cloth.advance(1 / 60);
      near(at(cloth, 0), [x, 0, 0]);
    }
  });

  /* A reset puts every particle where skinning puts it, at rest, and blends from there. */
  it('reset puts every particle at its skinned position with no velocity', () => {
    const cloth = new SkinnedCloth(particles([0, 0, 0, 1, 0, 0], [1, 1]));
    cloth.setPose(joints(8, { 0: [0, 0, 3] }), translation(0, 0, 0));
    cloth.positions.fill(9);
    cloth.velocities.fill(9);
    cloth.reset();
    near(Array.from(cloth.positions), [0, 0, 3, 1, 0, 3]);
    near(Array.from(cloth.velocities), [0, 0, 0, 0, 0, 0]);
  });

  /*
   * **A frame's steps reach its pose step by step, and drawing on alpha falls between them.** The
   * model moves 2 m along x and the frame runs two steps: the kinematic particle is 1 m along after
   * the first and 2 m after the second, so the last step drawn at alpha 0 shows 1 and at 0.5 shows
   * 1.5. And a frame of two more steps given no new pose leaves it at 2 throughout, rather than
   * reaching back for the old pose and walking it forward again.
   */
  it('A FRAME REACHES ITS POSE STEP BY STEP, AND A FRAME WITH NO NEW POSE STAYS PUT', () => {
    const cloth = new SkinnedCloth(particles([0, 0, 0], [0]));
    cloth.setPose(joints(8), translation(0, 0, 0));
    cloth.setPose(joints(8), translation(2, 0, 0));
    expect(cloth.advance(1 / 30)).toBe(2);
    const drawn = new Float32Array(3);
    cloth.interpolate(0, drawn);
    near(Array.from(drawn), [1, 0, 0]);
    cloth.interpolate(0.5, drawn);
    near(Array.from(drawn), [1.5, 0, 0]);
    /* Two more steps with no new pose: both at 2, so the last one starts there too. */
    cloth.advance(1 / 30);
    cloth.interpolate(0, drawn);
    near(Array.from(drawn), [2, 0, 0]);
    near(at(cloth, 0), [2, 0, 0]);
  });

  /*
   * **Settle steps run at the reset; blend steps share the simulation in after it.** Hanging 0.5
   * below its max distance under gravity, a settled particle is already there when the first pose
   * resets it. A blend of two steps draws half of the first step's fall: one step of −10 m/s² at
   * 1/60 s falls 10/3600 m, and blended it falls half that.
   */
  it('settles at a reset, and blends the simulation in over the steps after it', () => {
    const settled = new SkinnedCloth(
      particles([0, 0, 0], [1], {
        limits: { maxDistance: new Float32Array([0.5]) },
        parameters: { gravity: [0, -10, 0], settleSteps: 120 },
      }),
    );
    settled.setPose(joints(8), translation(0, 0, 0));
    near(at(settled, 0), [0, -0.5, 0], 3);

    const fall = (blendSteps: number): number => {
      const cloth = new SkinnedCloth(
        particles([0, 0, 0], [1], { parameters: { gravity: [0, -10, 0], blendSteps } }),
      );
      cloth.setPose(joints(8), translation(0, 0, 0));
      cloth.advance(1 / 60);
      return at(cloth, 0)[1] as number;
    };
    expect(fall(0)).toBeCloseTo(-10 / 3600, 6);
    expect(fall(2)).toBeCloseTo(-10 / 3600 / 2, 6);
  });
});
