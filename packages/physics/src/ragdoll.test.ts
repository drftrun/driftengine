import { describe, expect, it } from 'vitest';
import { BODY_STATIC } from './bodies.ts';
import { ragdollFromBones } from './ragdoll.ts';
import type { PoseTarget, RagdollOptions } from './ragdoll.ts';
import { boxShape } from './shape.ts';
import { PhysicsWorld } from './world.ts';

const DT = 1 / 60;

/**
 * A chain of `n + 1` joints descending from `top`, as world matrices.
 *
 * **`lean` is not decoration.** A perfectly vertical chain is an unstable equilibrium: with cone
 * limits holding it and nothing to perturb it, it stands like a pole and never falls — which is
 * physically right and made three tests here assert the opposite of what they measured. A lean
 * gives gravity something to work with.
 */
function chain(
  n: number,
  top = 4,
  spacing = 0.5,
  lean = 0.15,
): { parents: Int32Array; world: Float32Array } {
  const parents = new Int32Array(n + 1);
  const world = new Float32Array((n + 1) * 16);
  for (let j = 0; j <= n; j++) {
    parents[j] = j - 1;
    const o = j * 16;
    world[o] = 1;
    world[o + 5] = 1;
    world[o + 10] = 1;
    world[o + 15] = 1;
    world[o + 12] = j * lean;
    world[o + 13] = top - j * spacing;
    world[o + 14] = 0;
  }
  return { parents, world };
}

function pose(jointCount: number): PoseTarget {
  const p = {
    translation: new Float32Array(jointCount * 3),
    rotation: new Float32Array(jointCount * 4),
    scale: new Float32Array(jointCount * 3),
  };
  for (let j = 0; j < jointCount; j++) {
    p.rotation[j * 4 + 3] = 1;
    p.scale[j * 3] = 1;
    p.scale[j * 3 + 1] = 1;
    p.scale[j * 3 + 2] = 1;
  }
  return p;
}

function ground(): PhysicsWorld {
  const world = new PhysicsWorld({ allowSleep: false });
  world.addBody({ type: BODY_STATIC, shape: boxShape(30, 1, 30), y: -1, friction: 0.6 });
  return world;
}

const run = (w: PhysicsWorld, n: number): void => {
  for (let i = 0; i < n; i++) w.step(DT);
};

describe('building a ragdoll', () => {
  it('makes one body per bone, not per joint', () => {
    const world = ground();
    const { parents, world: matrices } = chain(3);
    const doll = ragdollFromBones(world, parents, matrices);
    expect(doll.boneCount).toBe(3);
    expect(doll.bodyOf[0]).toBe(-1);
    expect(doll.bodyOf[1]).toBeGreaterThanOrEqual(0);
  });

  it('joints each bone to its parent', () => {
    const world = ground();
    const { parents, world: matrices } = chain(4);
    ragdollFromBones(world, parents, matrices);
    // Four bones, three of which have a parent bone.
    expect(world.joints.count).toBe(3);
  });

  it('builds no bodies at all for a rig of roots', () => {
    const world = ground();
    const parents = new Int32Array([-1, -1, -1]);
    const matrices = new Float32Array(3 * 16);
    for (let j = 0; j < 3; j++) {
      matrices[j * 16] = 1;
      matrices[j * 16 + 5] = 1;
      matrices[j * 16 + 10] = 1;
      matrices[j * 16 + 15] = 1;
    }
    const doll = ragdollFromBones(world, parents, matrices);
    expect(doll.boneCount).toBe(0);
    expect(world.joints.count).toBe(0);
  });

  it('skips a bone shorter than the floor', () => {
    const world = ground();
    const { parents, world: matrices } = chain(3, 4, 0.001, 0);
    const doll = ragdollFromBones(world, parents, matrices);
    expect(doll.boneCount).toBe(0);
  });

  it('gives a longer bone more mass', () => {
    const world = ground();
    const short = chain(1, 4, 0.3, 0);
    const long = chain(1, 8, 1.2, 0);
    const a = ragdollFromBones(world, short.parents, short.world);
    const b = ragdollFromBones(world, long.parents, long.world);
    const massA = 1 / (world.bodies.invMass[a.bodyOf[1] ?? 0] ?? 1);
    const massB = 1 / (world.bodies.invMass[b.bodyOf[1] ?? 0] ?? 1);
    expect(massB).toBeGreaterThan(massA * 4);
  });

  it('places each bone between its joint and its parent', () => {
    const world = ground();
    const { parents, world: matrices } = chain(2, 4, 0.5);
    const doll = ragdollFromBones(world, parents, matrices);
    // The first bone spans y 4 to 3.5, so its body sits at 3.75.
    expect(world.bodies.posY[doll.bodyOf[1] ?? 0]).toBeCloseTo(3.75, 4);
    expect(world.bodies.posX[doll.bodyOf[1] ?? 0]).toBeCloseTo(0.075, 4);
  });

  /**
   * A capsule stands along its own +y, so a bone that does not must be turned onto it.
   *
   * Nothing caught this: returning identity from the alignment passed every other test here,
   * because a leaning chain still falls and still stays jointed with vertical capsules. The shape
   * would simply not be where the bone is.
   */
  it('turns each capsule onto the direction of its bone', () => {
    const world = ground();
    // One horizontal bone, from the origin out along +x.
    const parents = new Int32Array([-1, 0]);
    const matrices = new Float32Array(2 * 16);
    for (let j = 0; j < 2; j++) {
      matrices[j * 16] = 1;
      matrices[j * 16 + 5] = 1;
      matrices[j * 16 + 10] = 1;
      matrices[j * 16 + 15] = 1;
      matrices[j * 16 + 13] = 4;
    }
    matrices[16 + 12] = 1.5;
    const doll = ragdollFromBones(world, parents, matrices);
    const b = doll.bodyOf[1] ?? 0;
    // Rotate the capsule's own axis by the body's quaternion; it must come out along the bone.
    const qx = world.bodies.rotX[b] ?? 0;
    const qy = world.bodies.rotY[b] ?? 0;
    const qz = world.bodies.rotZ[b] ?? 0;
    const qw = world.bodies.rotW[b] ?? 1;
    const tx = 2 * (qy * 0 - qz * 1);
    const ty = 2 * (qz * 0 - qx * 0);
    const tz = 2 * (qx * 1 - qy * 0);
    const ax = 0 + qw * tx + (qy * tz - qz * ty);
    const ay = 1 + qw * ty + (qz * tx - qx * tz);
    const az = 0 + qw * tz + (qx * ty - qy * tx);
    expect(ax).toBeCloseTo(1, 4);
    expect(ay).toBeCloseTo(0, 4);
    expect(az).toBeCloseTo(0, 4);
  });
});

describe('a ragdoll in the world', () => {
  it('falls and comes to rest on the ground', () => {
    const world = ground();
    const { parents, world: matrices } = chain(4);
    const doll = ragdollFromBones(world, parents, matrices);
    run(world, 600);
    for (let j = 1; j < parents.length; j++) {
      const b = doll.bodyOf[j] ?? 0;
      expect(world.bodies.posY[b] ?? 0).toBeLessThan(1);
      expect(world.bodies.posY[b] ?? 0).toBeGreaterThan(-0.5);
    }
  });

  it('stays jointed rather than coming apart', () => {
    const world = ground();
    const { parents, world: matrices } = chain(4);
    const doll = ragdollFromBones(world, parents, matrices);
    run(world, 600);
    for (let j = 2; j < parents.length; j++) {
      const a = doll.bodyOf[j - 1] ?? 0;
      const b = doll.bodyOf[j] ?? 0;
      const dx = (world.bodies.posX[b] ?? 0) - (world.bodies.posX[a] ?? 0);
      const dy = (world.bodies.posY[b] ?? 0) - (world.bodies.posY[a] ?? 0);
      const dz = (world.bodies.posZ[b] ?? 0) - (world.bodies.posZ[a] ?? 0);
      // Two 0.5-metre bones sharing an end can be at most a metre apart.
      expect(Math.sqrt(dx * dx + dy * dy + dz * dz)).toBeLessThan(1);
    }
  });

  it('never produces a NaN over ten seconds', () => {
    const world = ground();
    const { parents, world: matrices } = chain(6);
    ragdollFromBones(world, parents, matrices);
    run(world, 600);
    for (let i = 0; i < world.bodies.count; i++) {
      expect(Number.isFinite(world.bodies.posY[i] ?? NaN)).toBe(true);
      expect(Number.isFinite(world.bodies.rotW[i] ?? NaN)).toBe(true);
    }
  });
});

describe('writing a pose back', () => {
  it('returns the bind pose when nothing has moved', () => {
    const world = new PhysicsWorld({ gravityY: 0, allowSleep: false });
    // A straight chain here, with no lean, so every joint is unrotated relative to its parent.
    const { parents, world: matrices } = chain(3, 4, 0.5, 0);
    const doll = ragdollFromBones(world, parents, matrices);
    const out = pose(parents.length);
    doll.writePose(out);
    for (let j = 1; j < parents.length; j++) {
      expect(Math.abs(out.rotation[j * 4 + 3] ?? 0)).toBeCloseTo(1, 3);
      expect(out.rotation[j * 4] ?? 0).toBeCloseTo(0, 3);
      expect(out.rotation[j * 4 + 1] ?? 0).toBeCloseTo(0, 3);
      expect(out.rotation[j * 4 + 2] ?? 0).toBeCloseTo(0, 3);
    }
  });

  it('keeps bone lengths, because bones do not stretch', () => {
    const world = ground();
    const { parents, world: matrices } = chain(3, 4, 0.5);
    const doll = ragdollFromBones(world, parents, matrices);
    run(world, 300);
    const out = pose(parents.length);
    doll.writePose(out);
    const expected = Math.sqrt(0.15 * 0.15 + 0.5 * 0.5);
    for (let j = 1; j < parents.length; j++) {
      const tx = out.translation[j * 3] ?? 0;
      const ty = out.translation[j * 3 + 1] ?? 0;
      const tz = out.translation[j * 3 + 2] ?? 0;
      expect(Math.sqrt(tx * tx + ty * ty + tz * tz)).toBeCloseTo(expected, 4);
    }
  });

  it('reports a rotation once the ragdoll has fallen over', () => {
    const world = ground();
    const { parents, world: matrices } = chain(4);
    const doll = ragdollFromBones(world, parents, matrices);
    run(world, 400);
    const out = pose(parents.length);
    doll.writePose(out);
    let moved = false;
    for (let j = 1; j < parents.length; j++) {
      if (Math.abs(out.rotation[j * 4 + 3] ?? 1) < 0.999) moved = true;
    }
    expect(moved).toBe(true);
  });

  it('writes unit scale', () => {
    const world = ground();
    const { parents, world: matrices } = chain(2);
    const doll = ragdollFromBones(world, parents, matrices);
    const out = pose(parents.length);
    doll.writePose(out);
    expect(out.scale[3]).toBeCloseTo(1, 6);
  });
});

describe('driving a ragdoll toward a pose', () => {
  it('holds a chain up at full weight where it would fall at none', () => {
    const upright = (weight: number): number => {
      const world = ground();
      const { parents, world: matrices } = chain(4);
      const doll = ragdollFromBones(world, parents, matrices);
      const target = pose(parents.length);
      for (let i = 0; i < 240; i++) {
        doll.drive(world, target, weight);
        world.step(DT);
      }
      return world.bodies.posY[doll.bodyOf[4] ?? 0] ?? 0;
    };
    /*
     * **0.12 and not the 0.2 this asked for until the joints were anchored at the bone ends.**
     * The old default pinned each bone's *centre* to a point rigidly attached to its parent, which
     * carries the child along with the parent's rotation and over-constrains the chain into
     * something stiffer than an articulated one. Driving looked stronger against it. Hanging from
     * the shared end is what a chain does, and the drive now has a real lever to work against.
     */
    expect(upright(1)).toBeGreaterThan(upright(0) + 0.12);
  });

  it('does nothing at all at weight zero', () => {
    const world = ground();
    const { parents, world: matrices } = chain(3);
    const doll = ragdollFromBones(world, parents, matrices);
    const target = pose(parents.length);
    const before = world.bodies.angX[doll.bodyOf[1] ?? 0] ?? 0;
    doll.drive(world, target, 0);
    expect(world.bodies.angX[doll.bodyOf[1] ?? 0] ?? 0).toBe(before);
  });
});

describe('re-seeding a ragdoll where the character actually is', () => {
  /**
   * **A hit reaction starts from the pose the character is in now, and there was no way to say so.**
   *
   * A ragdoll is built once, because building one allocates bodies and joints and a hit is not the
   * moment to do that. But between reactions the character keeps moving, and the bodies do not:
   * they sit wherever the last reaction left them, or — for a character that has never been hit —
   * wherever they were on the frame the ragdoll was built. The next hit then blends the pose
   * toward *that*, and the character snaps to a stale shape somewhere else entirely before the
   * reaction begins.
   *
   * Found in production, by playing: *"the impact ragdoll is really messy and not working properly,
   * it's very fast and just messes up the character."*
   *
   * `sync` is the missing verb. It puts every body back on its bone, clears the velocities, and
   * leaves the joints alone — so a reaction begins at rest, in the pose the animation is in.
   */
  it('puts the bodies back on the bones, wherever the bones have gone', () => {
    const world = new PhysicsWorld({ gravityY: -10 });
    const { parents, world: bones } = chain(3);
    const ragdoll = ragdollFromBones(world, parents, bones);

    /* Let it fall well away from where it was built. */
    for (let i = 0; i < 120; i++) world.step(DT);
    const fallen = world.bodies.posY[ragdoll.bodyOf[1] ?? 0] ?? 0;
    expect(fallen, 'it has to have actually moved for this to mean anything').toBeLessThan(3);

    /* The character, meanwhile, has walked 10 m sideways and is standing upright. */
    const moved = chain(3);
    for (let j = 0; j <= 3; j++) moved.world[j * 16 + 12] = (moved.world[j * 16 + 12] ?? 0) + 10;

    ragdoll.sync(world, moved.world);

    /* Every body is back on its bone: the midpoint of the segment it spans. */
    for (let j = 1; j <= 3; j++) {
      const body = ragdoll.bodyOf[j] ?? -1;
      if (body < 0) continue;
      const p = parents[j] ?? -1;
      const wantX = ((moved.world[p * 16 + 12] ?? 0) + (moved.world[j * 16 + 12] ?? 0)) / 2;
      const wantY = ((moved.world[p * 16 + 13] ?? 0) + (moved.world[j * 16 + 13] ?? 0)) / 2;
      expect(world.bodies.posX[body] ?? 0).toBeCloseTo(wantX, 5);
      expect(world.bodies.posY[body] ?? 0).toBeCloseTo(wantY, 5);
    }
  });

  it('clears the velocities, so a reaction begins at rest', () => {
    /*
     * The half that makes it a *reaction* rather than a continuation. A body carrying the speed
     * of a two-second fall is thrown across the character the instant it is written into the pose,
     * which is the "very fast" half of the report.
     */
    const world = new PhysicsWorld({ gravityY: -10 });
    const { parents, world: bones } = chain(3);
    const ragdoll = ragdollFromBones(world, parents, bones);
    for (let i = 0; i < 120; i++) world.step(DT);

    const body = ragdoll.bodyOf[1] ?? 0;
    expect(Math.abs(world.bodies.velY[body] ?? 0), 'falling first').toBeGreaterThan(1);

    ragdoll.sync(world, bones);
    expect(world.bodies.velX[body] ?? 0).toBe(0);
    expect(world.bodies.velY[body] ?? 0).toBe(0);
    expect(world.bodies.velZ[body] ?? 0).toBe(0);
    expect(world.bodies.angX[body] ?? 0).toBe(0);
    expect(world.bodies.angY[body] ?? 0).toBe(0);
    expect(world.bodies.angZ[body] ?? 0).toBe(0);
  });

  it('a synced ragdoll writes back the pose it was synced to', () => {
    /*
     * The property that makes a reaction start invisibly: sync, then write, and nothing moved.
     * Without it the first frame of every hit is a snap.
     */
    const world = new PhysicsWorld({ gravityY: -10 });
    const { parents, world: bones } = chain(3);
    const ragdoll = ragdollFromBones(world, parents, bones);
    for (let i = 0; i < 120; i++) world.step(DT);

    ragdoll.sync(world, bones);
    const out = pose(4);
    ragdoll.writePose(out);

    /* The chain was built straight, so every local rotation is identity. */
    for (let j = 1; j <= 3; j++) {
      expect(Math.abs(out.rotation[j * 4 + 3] ?? 0), `joint ${j}`).toBeCloseTo(1, 4);
    }
  });
});

/**
 * **Reported from outside 2026-08-28, and the report's own diagnosis was half wrong.**
 *
 * A consumer read `rootX`, `rootY` and `rootZ` as the doc comment describes them — the first
 * bone's parent end, so a character's node can be moved to where the physics put it — and found
 * two of the three were the body's *centre* instead. What they could not see from outside is that
 * the third was too: `rootX` reached it through a helper called `boneHeadX` that returned `posX`,
 * so the name promised a head and the arithmetic never went looking for one.
 *
 * These are here because that mistake is invisible until something says where the head should be.
 * A body sits at its bone's middle by construction, which every other test in this file asserts,
 * so an accessor answering the centre passes anything that does not know the difference.
 */
describe('where the root bone ends up', () => {
  it('answers the bone head at rest, not the body centre', () => {
    const world = ground();
    // The first bone spans (0, 4, 0) to (0.15, 3.5, 0), so its body sits at (0.075, 3.75, 0).
    const { parents, world: matrices } = chain(2, 4, 0.5, 0.15);
    const doll = ragdollFromBones(world, parents, matrices);
    expect(doll.rootX()).toBeCloseTo(0, 4);
    expect(doll.rootY()).toBeCloseTo(4, 4);
    expect(doll.rootZ()).toBeCloseTo(0, 4);
  });

  it('answers it on every axis, including one no vertical chain can separate', () => {
    const world = ground();
    // One horizontal bone from (0, 4, 0) out along +z: head and centre differ in z alone.
    const parents = new Int32Array([-1, 0]);
    const matrices = new Float32Array(2 * 16);
    for (let j = 0; j < 2; j++) {
      matrices[j * 16] = 1;
      matrices[j * 16 + 5] = 1;
      matrices[j * 16 + 10] = 1;
      matrices[j * 16 + 15] = 1;
      matrices[j * 16 + 13] = 4;
    }
    matrices[16 + 14] = 1.5;
    const doll = ragdollFromBones(world, parents, matrices);
    expect(doll.rootZ()).toBeCloseTo(0, 4);
    expect(doll.rootY()).toBeCloseTo(4, 4);
    expect(doll.rootX()).toBeCloseTo(0, 4);
  });

  /**
   * The head travels with the body, which is the whole point of asking for it: a caller moves a
   * character's node there every frame of a fall.
   */
  it('follows the body once it has fallen', () => {
    const world = ground();
    const { parents, world: matrices } = chain(3);
    const doll = ragdollFromBones(world, parents, matrices);
    run(world, 600);
    const body = doll.bodyOf[1] ?? 0;
    /* Half the bone, and the bone leans: a 0.15 m step across a 0.5 m drop is 0.522015 long. */
    const half = 0.261008;
    const dx = doll.rootX() - (world.bodies.posX[body] ?? 0);
    const dy = doll.rootY() - (world.bodies.posY[body] ?? 0);
    const dz = doll.rootZ() - (world.bodies.posZ[body] ?? 0);
    // Half a bone from the centre it is measured off, whatever direction the bone has ended up in.
    expect(Math.sqrt(dx * dx + dy * dy + dz * dz)).toBeCloseTo(half, 3);
  });

  it('answers zero for a rig with no bones at all', () => {
    const world = ground();
    const parents = new Int32Array([-1, -1]);
    const matrices = new Float32Array(2 * 16);
    for (let j = 0; j < 2; j++) {
      matrices[j * 16] = 1;
      matrices[j * 16 + 5] = 1;
      matrices[j * 16 + 10] = 1;
      matrices[j * 16 + 15] = 1;
    }
    const doll = ragdollFromBones(world, parents, matrices);
    expect(doll.rootX()).toBe(0);
    expect(doll.rootY()).toBe(0);
    expect(doll.rootZ()).toBe(0);
  });
});

/**
 * **Reported from outside 2026-08-28: one pair of limits for a whole body is a body that knots.**
 *
 * `swingCos` and `twistSin` applied to every joint a rig has, and a knee is a hinge with no twist
 * where a shoulder is nearly a ball. With one pair a consumer chooses which of the two is wrong.
 * The one who reported this chose loose — a 78° cone and 74° of twist everywhere, with a comment
 * saying tight limits look like a wooden puppet — and what it produced was reported from play as *a
 * scrambled ball of things, limbs torso head mixed together*: at 78° nothing stops a knee or an
 * elbow folding a limb through the torso, so a body that lands rolls itself into a knot.
 *
 * A limit is per joint now, indexed the way `parents` is, so the knee can be tight while the
 * shoulder stays loose.
 */
describe('joint limits per joint', () => {
  it('takes an array indexed like `parents`, one limit per joint', () => {
    const world = ground();
    const { parents, world: matrices } = chain(3);
    /* Joint 0 has no bone and therefore no joint; 1, 2 and 3 do. Three cones, deliberately
       different, and read back off the joint store in the order the builder added them. */
    const swingCos = [0, 0.9, 0.5, 0.1];
    const twistSin = [0, 0.05, 0.2, 0.7];
    ragdollFromBones(world, parents, matrices, { swingCos, twistSin });

    expect(world.joints.count).toBe(2);
    /* A joint exists per bone that has a parent *bone*, so the first is the one at joint 2. */
    expect(world.joints.swingCos[0]).toBeCloseTo(0.5, 6);
    expect(world.joints.twistSin[0]).toBeCloseTo(0.2, 6);
    expect(world.joints.swingCos[1]).toBeCloseTo(0.1, 6);
    expect(world.joints.twistSin[1]).toBeCloseTo(0.7, 6);
  });

  it('still takes one number for the whole rig, which is what every caller passed before', () => {
    const world = ground();
    const { parents, world: matrices } = chain(3);
    ragdollFromBones(world, parents, matrices, { swingCos: 0.25, twistSin: 0.6 });
    expect(world.joints.swingCos[0]).toBeCloseTo(0.25, 6);
    expect(world.joints.swingCos[1]).toBeCloseTo(0.25, 6);
    expect(world.joints.twistSin[1]).toBeCloseTo(0.6, 6);
  });

  /**
   * A rig is longer than the array somebody wrote by hand, sooner or later. The default is what a
   * missing entry means, because the alternative — a zero — is a cone of 90° at exactly the joint
   * nobody thought about, which is the failure this entry is about.
   */
  it('falls back to the default where the array does not reach', () => {
    const world = ground();
    const { parents, world: matrices } = chain(3);
    ragdollFromBones(world, parents, matrices, { swingCos: [0, 0.9, 0.4] });
    expect(world.joints.swingCos[0]).toBeCloseTo(0.4, 6);
    /* Past the end of the array: 45°, which is `Math.SQRT1_2` and the engine's own default. */
    expect(world.joints.swingCos[1]).toBeCloseTo(0.7071067811865476, 6);
  });

  it('and where an entry is not a number at all', () => {
    const world = ground();
    const { parents, world: matrices } = chain(2);
    ragdollFromBones(world, parents, matrices, { swingCos: [0, 0.9, Number.NaN] });
    expect(world.joints.swingCos[0]).toBeCloseTo(0.7071067811865476, 6);
  });

  /**
   * The measured consequence, as an assertion: a body with the reported loose limits folds through
   * itself and one with a tight knee does not. Read as the distance between the head and the hips
   * once everything has settled, which is what a knotted body loses.
   */
  it('holds a landed body further from itself when the knees are tight', () => {
    const settle = (options: RagdollOptions): number => {
      const world = ground();
      const { parents, world: matrices } = chain(4, 4, 0.5, 0.35);
      const doll = ragdollFromBones(world, parents, matrices, options);
      run(world, 600);
      const hips = doll.bodyOf[1] ?? 0;
      const tip = doll.bodyOf[4] ?? 0;
      const dx = (world.bodies.posX[tip] ?? 0) - (world.bodies.posX[hips] ?? 0);
      const dy = (world.bodies.posY[tip] ?? 0) - (world.bodies.posY[hips] ?? 0);
      const dz = (world.bodies.posZ[tip] ?? 0) - (world.bodies.posZ[hips] ?? 0);
      return Math.sqrt(dx * dx + dy * dy + dz * dz);
    };
    /* The reported pair, everywhere: a 78° cone and 74° of twist at every joint. */
    const loose = settle({ swingCos: 0.2, twistSin: 0.6 });
    /* The same rig with the two lower joints held near-straight, which is what a knee is. */
    const kneed = settle({
      swingCos: [0, 0.2, 0.97, 0.97, 0.2],
      twistSin: [0, 0.6, 0.02, 0.02, 0.6],
    });
    expect(kneed).toBeGreaterThan(loose);
  });
});

/** Where a body's own +y axis puts a point `ly` along it, in world space. */
function alongY(world: PhysicsWorld, body: number, ly: number): [number, number, number] {
  const x = world.bodies.rotX[body] ?? 0;
  const y = world.bodies.rotY[body] ?? 0;
  const z = world.bodies.rotZ[body] ?? 0;
  const w = world.bodies.rotW[body] ?? 1;
  return [
    (world.bodies.posX[body] ?? 0) + 2 * ly * (x * y - w * z),
    (world.bodies.posY[body] ?? 0) + ly * (1 - 2 * (x * x + z * z)),
    (world.bodies.posZ[body] ?? 0) + 2 * ly * (y * z + w * x),
  ];
}

describe('where a ragdoll is jointed', () => {
  /*
   * **The contract the anchors exist for, and the one nothing asserted.**
   *
   * A knee is not the middle of a shin. Anchored at the child's centre the shin is pinned by its
   * middle and free to turn about it inside its cone, so the knee end of the shin walks away from
   * the knee end of the thigh — 23 cm on this half-metre chain, and reported from a human rig at
   * 56 to 100 cm in flight. Measuring the two ends that share a joint is the only thing that sees
   * it: every body is still exactly one bone from its parent's *centre* either way, so a distance
   * between centres reads as healthy while the limb hangs off nothing.
   */
  it('holds the two ends that share a joint together', () => {
    const world = ground();
    const { parents, world: matrices } = chain(4);
    const doll = ragdollFromBones(world, parents, matrices);
    run(world, 240);
    const half = Math.hypot(0.5, 0.15) / 2;
    for (let j = 2; j < parents.length; j++) {
      const tail = alongY(world, doll.bodyOf[j - 1] ?? 0, half);
      const head = alongY(world, doll.bodyOf[j] ?? 0, -half);
      const apart = Math.hypot(tail[0] - head[0], tail[1] - head[1], tail[2] - head[2]);
      expect(apart, `joint ${j} is ${(apart * 100).toFixed(1)} cm open`).toBeLessThan(0.02);
    }
  });

  /** Both anchors resolve to the same world point at rest, so the first tick still moves nothing. */
  it('does not move the doll on the first tick', () => {
    const world = ground();
    const { parents, world: matrices } = chain(4);
    const doll = ragdollFromBones(world, parents, matrices);
    const before = Array.from(parents, (_, j) => world.bodies.posY[doll.bodyOf[j] ?? 0] ?? 0);
    world.step(DT);
    for (let j = 1; j < parents.length; j++) {
      expect(world.bodies.posY[doll.bodyOf[j] ?? 0] ?? 0).toBeCloseTo(before[j] ?? 0, 2);
    }
  });
});

describe('what a ragdoll collides with inside itself', () => {
  it('excludes a bone from the one it hangs off, and from its siblings', () => {
    const world = ground();
    /* A root with two children, so there is a sibling pair as well as a parent pair. */
    const parents = new Int32Array([-1, 0, 1, 1]);
    const matrices = new Float32Array(4 * 16);
    const place = (j: number, x: number, y: number): void => {
      const o = j * 16;
      matrices[o] = 1;
      matrices[o + 5] = 1;
      matrices[o + 10] = 1;
      matrices[o + 15] = 1;
      matrices[o + 12] = x;
      matrices[o + 13] = y;
    };
    place(0, 0, 4);
    place(1, 0, 3.5);
    place(2, -0.3, 3.1);
    place(3, 0.3, 3.1);
    const doll = ragdollFromBones(world, parents, matrices);
    const [, upper, left, right] = Array.from(doll.bodyOf);
    expect(world.pairIgnored(upper ?? 0, left ?? 0), 'a bone and the one it hangs off').toBe(true);
    expect(world.pairIgnored(left ?? 0, right ?? 0), 'two bones sharing a parent joint').toBe(true);
  });

  it('leaves bones that share no end colliding', () => {
    const world = ground();
    const { parents, world: matrices } = chain(4);
    const doll = ragdollFromBones(world, parents, matrices);
    expect(world.pairIgnored(doll.bodyOf[1] ?? 0, doll.bodyOf[4] ?? 0)).toBe(false);
  });

  /* The cheap answer, and the reason the option is not the default: with it on, the cones alone
     do not stop a limb folding through the torso. */
  it('excludes every pair in the doll when self-collision is off', () => {
    const world = ground();
    const { parents, world: matrices } = chain(4);
    const doll = ragdollFromBones(world, parents, matrices, { selfCollision: false });
    expect(world.pairIgnored(doll.bodyOf[1] ?? 0, doll.bodyOf[4] ?? 0)).toBe(true);
  });
});
