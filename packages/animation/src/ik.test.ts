import { describe, expect, it } from 'vitest';

import { solveTwoBone } from './ik.ts';
import { Skeleton } from './skeleton.ts';
import { createPose, restPose } from './pose.ts';
import type { Pose } from './pose.ts';

/** Three joints in a chain, identity binds so a palette entry is the world matrix. */
function armSkeleton(): Skeleton {
  const inverseBind = new Float32Array(3 * 16);
  for (let j = 0; j < 3; j++) {
    inverseBind[j * 16] = 1;
    inverseBind[j * 16 + 5] = 1;
    inverseBind[j * 16 + 10] = 1;
    inverseBind[j * 16 + 15] = 1;
  }
  return new Skeleton(
    [
      { parent: -1, name: 'root' },
      { parent: 0, name: 'mid' },
      { parent: 1, name: 'tip' },
    ],
    inverseBind,
  );
}

/** Root at the origin, mid one unit up, tip one unit above that: a straight chain of length 2. */
function armPose(): Pose {
  const pose = createPose(3);
  restPose(3, pose);
  pose.translation[4] = 1; /* mid, one unit along +Y of root */
  pose.translation[7] = 1; /* tip, one unit along +Y of mid */
  return pose;
}

/** A joint's world position, which is the translation column of its world matrix. */
function worldOf(skeleton: Skeleton, joint: number): number[] {
  return Array.from(skeleton.world.subarray(joint * 16 + 12, joint * 16 + 15));
}

describe('two-bone IK', () => {
  /*
   * A target inside the chain's reach must be hit. Two unit bones reach anything within two units,
   * and (1, 1, 0) is at distance sqrt(2).
   */
  it('reaches a target inside its range', () => {
    const skeleton = armSkeleton();
    const pose = armPose();
    const reached = solveTwoBone(skeleton, pose, 0, 1, 2, [1, 1, 0], [0, 0, 1]);
    expect(reached).toBe(true);
    const tip = worldOf(skeleton, 2);
    expect(tip[0]).toBeCloseTo(1, 3);
    expect(tip[1]).toBeCloseTo(1, 3);
    expect(tip[2]).toBeCloseTo(0, 3);
  });

  it('reaches a target straight out to one side', () => {
    const skeleton = armSkeleton();
    const pose = armPose();
    expect(solveTwoBone(skeleton, pose, 0, 1, 2, [1.5, 0, 0], [0, 0, 1])).toBe(true);
    const tip = worldOf(skeleton, 2);
    expect(tip[0]).toBeCloseTo(1.5, 3);
    expect(tip[1]).toBeCloseTo(0, 3);
  });

  /*
   * An unreachable target straightens toward it rather than failing or producing NaN. A NaN here
   * reaches the palette and takes every vertex the joint touches with it, which is why the
   * assertion is on finiteness and not only on the flag.
   */
  it('straightens toward a target beyond its reach and reports it', () => {
    const skeleton = armSkeleton();
    const pose = armPose();
    expect(solveTwoBone(skeleton, pose, 0, 1, 2, [50, 0, 0], [0, 0, 1])).toBe(false);
    for (const value of pose.rotation) expect(Number.isNaN(value)).toBe(false);
    /* Straightened: the tip is two units from the root, pointing at the target. */
    const tip = worldOf(skeleton, 2);
    expect(Math.hypot(tip[0] as number, tip[1] as number, tip[2] as number)).toBeCloseTo(2, 3);
    expect(tip[0]).toBeCloseTo(2, 3);
  });

  /*
   * A target at the root is the degenerate case every closed-form solver divides by zero on: the
   * direction to it has no length and the law of cosines takes an argument outside [-1, 1].
   */
  it('survives a target at the root', () => {
    const skeleton = armSkeleton();
    const pose = armPose();
    solveTwoBone(skeleton, pose, 0, 1, 2, [0, 0, 0], [0, 0, 1]);
    for (const value of pose.rotation) expect(Number.isFinite(value)).toBe(true);
    for (const value of skeleton.world) expect(Number.isFinite(value)).toBe(true);
  });

  /*
   * A target the chain can only reach folded is the other end of the same problem: `d` below
   * |a - b| makes the cosine greater than one.
   */
  it('survives a target closer than the chain can fold', () => {
    const skeleton = armSkeleton();
    const pose = armPose();
    solveTwoBone(skeleton, pose, 0, 1, 2, [0.001, 0, 0], [0, 0, 1]);
    for (const value of pose.rotation) expect(Number.isFinite(value)).toBe(true);
  });

  /*
   * The pole decides the one thing the target cannot: which way the elbow points. Two solves to
   * the same target with opposite poles must bend the mid joint to opposite sides, or the hint is
   * being ignored — and an ignored pole is an elbow that flips unpredictably as a character turns.
   */
  it('bends toward the pole it is given', () => {
    const front = armSkeleton();
    const back = armSkeleton();
    solveTwoBone(front, armPose(), 0, 1, 2, [1, 1, 0], [0, 0, 1]);
    solveTwoBone(back, armPose(), 0, 1, 2, [1, 1, 0], [0, 0, -1]);
    const a = worldOf(front, 1);
    const b = worldOf(back, 1);
    expect(Math.sign(a[2] as number)).not.toBe(Math.sign(b[2] as number));
  });

  /*
   * **Where the elbow actually ends up, which is a stronger claim than the test above.** Comparing
   * two opposite poles only shows that the *bend axis* flipped, and `bendAxis` alone achieves that
   * — perturbing the roll away left that assertion green. What the roll guarantees is that after
   * the aim rotation, which is free to spin the chain about the line to the target, the elbow
   * still faces the pole. So this projects both onto the plane that spin cannot change and checks
   * they point the same way.
   */
  it('leaves the elbow facing the pole after aiming', () => {
    const skeleton = armSkeleton();
    const pose = armPose();
    const target = [1.2, 0.4, 0.6];
    const pole = [0.2, -1, 0.9];
    solveTwoBone(skeleton, pose, 0, 1, 2, target, pole);

    const root = worldOf(skeleton, 0);
    const elbow = worldOf(skeleton, 1);
    const aim = normalise(sub(target, root));
    const elbowFlat = normalise(reject(sub(elbow, root), aim));
    const poleFlat = normalise(reject(sub(pole, root), aim));

    /* Same side of the target line, within a degree or so. */
    expect(dot(elbowFlat, poleFlat)).toBeGreaterThan(0.99);
  });

  it('refuses a chain whose joints are not parent to child', () => {
    const skeleton = armSkeleton();
    expect(() => solveTwoBone(skeleton, armPose(), 0, 2, 1, [1, 1, 0], [0, 0, 1])).toThrow(
      /chain/i,
    );
  });

  /* Deterministic: the same inputs, the same pose, which is what a replay needs. */
  it('is a pure function of its inputs', () => {
    const first = armSkeleton();
    const second = armSkeleton();
    const poseA = armPose();
    const poseB = armPose();
    solveTwoBone(first, poseA, 0, 1, 2, [1, 0.6, 0.2], [0, 0, 1]);
    solveTwoBone(second, poseB, 0, 1, 2, [1, 0.6, 0.2], [0, 0, 1]);
    expect(Array.from(poseA.rotation)).toEqual(Array.from(poseB.rotation));
  });

  /*
   * **A bent chain reaches on the first call, and this is the case that said it did not.**
   *
   * Reported from outside against a crouching leg: `solveTwoBone` returned true and left the tip
   * short, a second call from that state reached the target, and further calls stayed there. A
   * closed-form solver has nothing to converge, so "converges over two passes" is the symptom of an
   * angle applied about the wrong axis — the bend rotated the bone out of the plane the interior
   * angle is measured in, so `|tip - root|` came out short and the aim then landed the tip on the
   * right ray at the wrong distance. See `bendAxis`.
   *
   * The rig is the reporter's: a thigh and a shin of unequal length, a hip well above the target,
   * and a starting pose already bent — a straight chain would have hidden it, because a straight
   * chain has no plane and takes the pole fallback that was always correct.
   */
  it('puts a bent chain on its target in one call, not two', () => {
    const skeleton = legSkeleton();
    const pose = legPose();
    skeleton.applyPose(pose);

    const hip = worldOf(skeleton, 0);
    const foot = worldOf(skeleton, 2);
    /* Straight down from where the foot started, which is the ground under a crouching leg. */
    const target = [foot[0] as number, 0, foot[2] as number];
    /*
     * **The pole is off the chain's plane, and that is the whole trigger.** The old bend axis was
     * the bone crossed with the pole, which is perpendicular to the chain's plane exactly when the
     * pole lies *in* it — so a pole in the plane made the wrong axis right by accident and this
     * case passed against the unfixed solver. A knee's pole points where the character faces, which
     * is not in the plane its leg happens to be bending in.
     */
    const knee = worldOf(skeleton, 1);
    const pole = [(knee[0] as number) + 0.6, knee[1] as number, (knee[2] as number) + 0.8];

    /* Inside the chain's reach, so the solver has an exact answer and no clamp is involved. */
    const reach = Math.hypot(
      (target[0] as number) - (hip[0] as number),
      (target[1] as number) - (hip[1] as number),
      (target[2] as number) - (hip[2] as number),
    );
    expect(reach).toBeLessThan(THIGH + SHIN);
    expect(reach).toBeGreaterThan(Math.abs(THIGH - SHIN));

    expect(solveTwoBone(skeleton, pose, 0, 1, 2, target, pole)).toBe(true);

    /*
     * **The residual as a number, which is what the report asked for.** A micrometre over a
     * half-metre reach is the arithmetic's own noise; the defect this holds was 87 millimetres,
     * three orders above it.
     */
    const landed = worldOf(skeleton, 2);
    const residual = Math.hypot(...sub(landed, target));
    expect(residual).toBeLessThan(1e-6);

    /* And a second call changes nothing, which is what "already solved" means. */
    solveTwoBone(skeleton, pose, 0, 1, 2, target, pole);
    const again = worldOf(skeleton, 2);
    expect(Math.hypot(...sub(again, landed))).toBeLessThan(1e-6);
  });
});

/**
 * **A rig authored at one scale and played at another, which is the ordinary way to reuse one.**
 *
 * Reported from outside against an animal 46 mm long whose model is authored in metres: the chain
 * came out the right length and pointed 108.8 degrees wrong, and `solveTwoBone` returned `true`
 * while doing it. A scale in the hierarchy is invisible to every other case in this file, because
 * they all author at play scale and their world matrices have determinant 1.
 *
 * The scale is the reporter's own, to three significant figures, so the arithmetic here is the
 * arithmetic that failed there.
 */
const PLAY_SCALE = 0.007132;

/**
 * A limb hanging off a body, which is where a scale actually bites.
 *
 * **Four joints rather than three, and that is the whole of what makes this reproduce.** The aim
 * step rotates the chain's *root*, and reads the frame of that joint's **parent** — so on a bare
 * three-joint chain the parent is the world and `parentFrame` returns the identity, scale or no
 * scale. A first attempt at this case put the scale on the chain root and passed against the broken
 * solver for exactly that reason. A real rig hangs its limbs off a body, and the body is what
 * carries the authoring scale.
 *
 * The body is rotated as well as scaled, and that matters too: `quat.fromMat3` on a scaled
 * *identity* still recovers the identity, because the off-diagonal terms are zero and normalising
 * rescues it. It is a scaled **rotation** that comes back as a different rotation.
 */
function bodySkeleton(): Skeleton {
  const inverseBind = new Float32Array(4 * 16);
  for (let j = 0; j < 4; j++) {
    inverseBind[j * 16] = 1;
    inverseBind[j * 16 + 5] = 1;
    inverseBind[j * 16 + 10] = 1;
    inverseBind[j * 16 + 15] = 1;
  }
  return new Skeleton(
    [
      { parent: -1, name: 'body' },
      { parent: 0, name: 'root' },
      { parent: 1, name: 'mid' },
      { parent: 2, name: 'tip' },
    ],
    inverseBind,
  );
}

/** The body scaled and turned; the limb below it two unit bones, as every other case here uses. */
function bodyPose(): Pose {
  const pose = createPose(4);
  restPose(4, pose);
  for (let k = 0; k < 3; k++) pose.scale[k] = PLAY_SCALE;
  /* A rotation with all three axes in it, so no component of the frame is accidentally spared. */
  const axis = [0.3, 0.8, -0.5];
  const length = Math.hypot(axis[0] as number, axis[1] as number, axis[2] as number);
  const half = 1.1 / 2;
  const sin = Math.sin(half) / length;
  pose.rotation[0] = (axis[0] as number) * sin;
  pose.rotation[1] = (axis[1] as number) * sin;
  pose.rotation[2] = (axis[2] as number) * sin;
  pose.rotation[3] = Math.cos(half);
  pose.translation[7] = 1; /* mid, one unit along +Y of root */
  pose.translation[10] = 1; /* tip, one unit along +Y of mid */
  return pose;
}

describe('a hierarchy that carries a scale', () => {
  it('reaches its target, rather than the right length in the wrong direction', () => {
    const skeleton = bodySkeleton();
    const pose = bodyPose();
    skeleton.applyPose(pose);

    const root = worldOf(skeleton, 1);
    /* Two unit bones under the body's scale reach twice it, so this is well inside the band. */
    const target = [
      (root[0] as number) + PLAY_SCALE * 1.2,
      (root[1] as number) + PLAY_SCALE * 0.9,
      (root[2] as number) + PLAY_SCALE * 0.4,
    ];

    expect(solveTwoBone(skeleton, pose, 1, 2, 3, target, [0, 0, 1])).toBe(true);

    const tip = worldOf(skeleton, 3);
    const reach = Math.hypot(...sub(target, root));
    const length = Math.hypot(...sub(tip, root));
    const residual = Math.hypot(...sub(tip, target));

    /*
     * **Both halves, because the failure separates into them and only one was broken.** The bend
     * sets the chain's length and was always scale-proof: it transforms an *axis* through the parent
     * frame and normalises it, so a uniform scale divides out. The aim read quaternions straight out
     * of that frame, and `quat.fromMat3` recovers a rotation from the trace by way of
     * `sqrt(trace + 1)` — scale the matrix and the trace scales while the 1 does not, so what comes
     * back is a *different* rotation rather than the same one at a different length. Normalising it
     * afterwards fixes the length of something already pointing the wrong way.
     *
     * Reported as the right length to a part in ten million and 108.8 degrees out.
     */
    expect(Math.abs(length - reach)).toBeLessThan(reach * 1e-4);
    expect(residual).toBeLessThan(reach * 1e-4);
  });

  it('is unaffected at unit scale, which is what every other case here uses', () => {
    const skeleton = bodySkeleton();
    const pose = bodyPose();
    for (let k = 0; k < 3; k++) pose.scale[k] = 1;
    skeleton.applyPose(pose);
    const root = worldOf(skeleton, 1);
    const target = [
      (root[0] as number) + 1.2,
      (root[1] as number) + 0.9,
      (root[2] as number) + 0.4,
    ];
    expect(solveTwoBone(skeleton, pose, 1, 2, 3, target, [0, 0, 1])).toBe(true);
    expect(Math.hypot(...sub(worldOf(skeleton, 3), target))).toBeLessThan(1e-5);
  });
});

/** Bone lengths from the report: a thigh and a shin, unequal, so the triangle is not isoceles. */
const THIGH = 0.46;
const SHIN = 0.44;

/** Hip, knee, foot, with identity binds so a palette entry is the world matrix. */
function legSkeleton(): Skeleton {
  const inverseBind = new Float32Array(3 * 16);
  for (let j = 0; j < 3; j++) {
    inverseBind[j * 16] = 1;
    inverseBind[j * 16 + 5] = 1;
    inverseBind[j * 16 + 10] = 1;
    inverseBind[j * 16 + 15] = 1;
  }
  return new Skeleton(
    [
      { parent: -1, name: 'hip' },
      { parent: 0, name: 'knee' },
      { parent: 1, name: 'foot' },
    ],
    inverseBind,
  );
}

/**
 * A leg already bent, with the hip at 0.565 and the foot short of the ground.
 *
 * The knee is pushed forward and the shin back, which is a crouch: the three joints are not
 * collinear, so the chain has a plane and the bend axis has something to be wrong about.
 */
function legPose(): Pose {
  const pose = createPose(3);
  restPose(3, pose);
  pose.translation[1] = 0.565;
  const knee = [0.3, -Math.sqrt(THIGH * THIGH - 0.3 * 0.3), 0];
  const foot = [-0.3, -Math.sqrt(SHIN * SHIN - 0.3 * 0.3), 0];
  pose.translation[3] = knee[0] as number;
  pose.translation[4] = knee[1] as number;
  pose.translation[5] = knee[2] as number;
  pose.translation[6] = foot[0] as number;
  pose.translation[7] = foot[1] as number;
  pose.translation[8] = foot[2] as number;
  return pose;
}

const sub = (a: readonly number[], b: readonly number[]): number[] => [
  (a[0] as number) - (b[0] as number),
  (a[1] as number) - (b[1] as number),
  (a[2] as number) - (b[2] as number),
];
const dot = (a: readonly number[], b: readonly number[]): number =>
  (a[0] as number) * (b[0] as number) +
  (a[1] as number) * (b[1] as number) +
  (a[2] as number) * (b[2] as number);
const normalise = (v: readonly number[]): number[] => {
  const length = Math.hypot(v[0] as number, v[1] as number, v[2] as number);
  return length > 0
    ? [(v[0] as number) / length, (v[1] as number) / length, (v[2] as number) / length]
    : [0, 0, 0];
};
/** `v` with its component along the unit vector `n` removed. */
const reject = (v: readonly number[], n: readonly number[]): number[] => {
  const along = dot(v, n);
  return [
    (v[0] as number) - (n[0] as number) * along,
    (v[1] as number) - (n[1] as number) * along,
    (v[2] as number) - (n[2] as number) * along,
  ];
};
