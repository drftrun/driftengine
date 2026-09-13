import { describe, expect, it, vi } from 'vitest';
import { BODY_DYNAMIC, BODY_STATIC } from './bodies.ts';
import {
  DOF_FREE,
  DOF_LIMITED,
  DOF_LOCKED,
  JOINT_FIXED,
  JOINT_SIX_DOF,
  relativeRotation,
} from './joints.ts';
import { boxShape } from './shape.ts';
import { PhysicsWorld } from './world.ts';

const DT = 1 / 60;

/* The same layer split `joints.test.ts` uses: a jointed pair touches by construction, and a
   contact fighting the joint would make every measurement here about the two together. */
const A_ONLY = { layer: 1, mask: 4 };
const B_ONLY = { layer: 2, mask: 4 };

const run = (w: PhysicsWorld, n: number): void => {
  for (let i = 0; i < n; i++) w.step(DT);
};

/** A static anchor at y = 5 and a free body one metre under it. */
function pair(gravityY = -9.81): { world: PhysicsWorld; anchor: number; free: number } {
  const world = new PhysicsWorld({ gravityY, allowSleep: false });
  const anchor = world.addBody({
    type: BODY_STATIC,
    shape: boxShape(0.2, 0.2, 0.2),
    y: 5,
    ...A_ONLY,
  });
  const free = world.addBody({
    type: BODY_DYNAMIC,
    shape: boxShape(0.3, 0.3, 0.3),
    y: 4,
    density: 500,
    ...B_ONLY,
  });
  return { world, anchor, free };
}

/** The offset of B from A along world y, which is A's local y because the anchor never turns. */
const dropOf = (w: PhysicsWorld, a: number, b: number): number =>
  (w.bodies.posY[b] ?? 0) - (w.bodies.posY[a] ?? 0);

/** The relative rotation's component about a world axis: the sine of half the angle turned. */
function twistAbout(w: PhysicsWorld, a: number, b: number, k: 0 | 1 | 2): number {
  const rel = new Float64Array(4);
  relativeRotation(w.bodies, a, b, rel, 0);
  return rel[k] as number;
}

describe('a six-degree-of-freedom joint', () => {
  /*
   * **Every axis locked is a fixed joint, and the two must agree.** They do not agree *exactly*,
   * and the difference is the design: `JOINT_FIXED` solves its three linear rows and its three
   * angular rows through a coupled 3x3 effective mass, where this solves six independent scalar
   * rows — because a coupled solve has no meaning when a caller has made only some of the rows
   * exist. So an all-locked six-DOF joint is *softer* at the same substep count, which is why the
   * comment on the type says to reach for `JOINT_FIXED` when all six are locked.
   */
  it('holds a body where a fixed joint would, to within a millimetre', () => {
    const locked = pair();
    locked.world.addJoint({ type: JOINT_FIXED, bodyA: locked.anchor, bodyB: locked.free });
    run(locked.world, 200);

    const six = pair();
    six.world.addJoint({ type: JOINT_SIX_DOF, bodyA: six.anchor, bodyB: six.free });
    run(six.world, 200);

    expect(dropOf(six.world, six.anchor, six.free)).toBeCloseTo(
      dropOf(locked.world, locked.anchor, locked.free),
      3,
    );
  });

  /* Nothing configured is everything locked, which is the safe default: a joint somebody forgot
     to describe is rigid rather than one whose bodies fly apart. */
  it('locks every axis when nothing is said about them', () => {
    const { world, anchor, free } = pair();
    world.addJoint({ type: JOINT_SIX_DOF, bodyA: anchor, bodyB: free });
    run(world, 200);
    expect(dropOf(world, anchor, free)).toBeCloseTo(-1, 2);
  });

  /*
   * A free axis is **skipped entirely**, not given a zero error. A row with `C = 0` still removes
   * all velocity along its axis, so a body that should fall would be held exactly where it is —
   * the same distinction `solveDistance` draws between its bounds.
   */
  it('lets a body fall along a free linear axis', () => {
    const { world, anchor, free } = pair();
    world.addJoint({
      type: JOINT_SIX_DOF,
      bodyA: anchor,
      bodyB: free,
      dof: [DOF_LOCKED, DOF_FREE, DOF_LOCKED, DOF_LOCKED, DOF_LOCKED, DOF_LOCKED],
    });
    run(world, 60);
    /* One second of gravity is about 4.9 m; anything past half a metre proves it is not held. */
    expect(dropOf(world, anchor, free)).toBeLessThan(-1.5);
  });

  it('holds a body on a locked linear axis while the others are free', () => {
    const { world, anchor, free } = pair();
    world.addJoint({
      type: JOINT_SIX_DOF,
      bodyA: anchor,
      bodyB: free,
      dof: [DOF_FREE, DOF_LOCKED, DOF_FREE, DOF_FREE, DOF_FREE, DOF_FREE],
    });
    run(world, 200);
    expect(dropOf(world, anchor, free)).toBeCloseTo(-1, 2);
  });

  /*
   * A limited axis is free between its bounds and one-sided at each end. The anchor defaults to
   * where B already is, so the offset starts at zero: bounds of [-2, 0] let it fall exactly two
   * metres and no further, ending at y = 5 - 1 - 2.
   */
  it('lets a body travel to a linear limit and catches it there', () => {
    const { world, anchor, free } = pair();
    world.addJoint({
      type: JOINT_SIX_DOF,
      bodyA: anchor,
      bodyB: free,
      dof: [DOF_LOCKED, DOF_LIMITED, DOF_LOCKED, DOF_LOCKED, DOF_LOCKED, DOF_LOCKED],
      dofLower: [0, -2, 0, 0, 0, 0],
      dofUpper: [0, 0, 0, 0, 0, 0],
    });
    run(world, 300);
    expect(dropOf(world, anchor, free)).toBeCloseTo(-3, 1);
  });

  /* A free angular axis keeps whatever spin it was given; a locked one takes it away. */
  it('lets a body spin about a free angular axis and stops it about a locked one', () => {
    const spinning = pair(0);
    spinning.world.addJoint({
      type: JOINT_SIX_DOF,
      bodyA: spinning.anchor,
      bodyB: spinning.free,
      dof: [DOF_LOCKED, DOF_LOCKED, DOF_LOCKED, DOF_LOCKED, DOF_FREE, DOF_LOCKED],
    });
    spinning.world.bodies.angY[spinning.free] = 3;
    run(spinning.world, 60);
    expect(Math.abs(spinning.world.bodies.angY[spinning.free] ?? 0)).toBeGreaterThan(2);

    const held = pair(0);
    held.world.addJoint({ type: JOINT_SIX_DOF, bodyA: held.anchor, bodyB: held.free });
    held.world.bodies.angY[held.free] = 3;
    run(held.world, 60);
    expect(Math.abs(held.world.bodies.angY[held.free] ?? 0)).toBeLessThan(0.05);
  });

  /**
   * **Angular bounds are sines of half-angles**, which is this package's own convention: a twist
   * limit compares a quaternion component against the half-angle's sine, and `Math.acos` and
   * `Math.atan2` are both on the banned list.
   *
   * Hand-derived: a quarter turn is 90 degrees, so the bound is `sin 45deg` = 0.70711. A body spun
   * about the free-then-limited axis must come to rest at that component and not past it.
   */
  it('catches a spin at an angular limit', () => {
    const { world, anchor, free } = pair(0);
    const bound = Math.SQRT1_2;
    world.addJoint({
      type: JOINT_SIX_DOF,
      bodyA: anchor,
      bodyB: free,
      dof: [DOF_LOCKED, DOF_LOCKED, DOF_LOCKED, DOF_LOCKED, DOF_LIMITED, DOF_LOCKED],
      dofLower: [0, 0, 0, 0, -bound, 0],
      dofUpper: [0, 0, 0, 0, bound, 0],
    });
    world.bodies.angY[free] = 4;
    run(world, 300);

    const twist = twistAbout(world, anchor, free, 1);
    expect(twist).toBeGreaterThan(0.5);
    expect(twist).toBeLessThan(bound + 0.05);
  });

  /* Between its bounds an angular axis is genuinely free, or a ragdoll's elbow would be welded. */
  it('leaves an angular axis alone inside its bounds', () => {
    const { world, anchor, free } = pair(0);
    world.addJoint({
      type: JOINT_SIX_DOF,
      bodyA: anchor,
      bodyB: free,
      dof: [DOF_LOCKED, DOF_LOCKED, DOF_LOCKED, DOF_LOCKED, DOF_LIMITED, DOF_LOCKED],
      dofLower: [0, 0, 0, 0, -0.9, 0],
      dofUpper: [0, 0, 0, 0, 0.9, 0],
    });
    world.bodies.angY[free] = 1;
    run(world, 10);
    expect(Math.abs(world.bodies.angY[free] ?? 0)).toBeGreaterThan(0.9);
  });

  /* The break impulse reads the same three linear rows every other joint accumulates into. */
  it('gives way when its linear rows carry more than it was told to', () => {
    const { world, anchor, free } = pair();
    world.addJoint({
      type: JOINT_SIX_DOF,
      bodyA: anchor,
      bodyB: free,
      breakImpulse: 0.5,
    });
    run(world, 60);
    expect(world.joints.broken[0]).toBe(1);
    expect(dropOf(world, anchor, free)).toBeLessThan(-1.5);
  });

  /**
   * **A motor asked for and not delivered would be a silent no-op**, which is the failure this
   * repository's rules exist to prevent — nothing throws, the axis simply never drives, and it
   * reads as a broken motor rather than as an unsupported one.
   *
   * Said at `add`, which is init, where the house rule allows a loud refusal.
   */
  it('refuses a motor out loud rather than ignoring it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { world, anchor, free } = pair();
      world.addJoint({
        type: JOINT_SIX_DOF,
        bodyA: anchor,
        bodyB: free,
        motorSpeed: 2,
        motorMaxForce: 100,
      });
      world.addJoint({
        type: JOINT_SIX_DOF,
        bodyA: anchor,
        bodyB: free,
        motorSpeed: 2,
        motorMaxForce: 100,
      });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  /* A short mode array locks the axes it does not mention, rather than leaving them undefined. */
  it('locks the axes a short description does not mention', () => {
    const { world, anchor, free } = pair();
    world.addJoint({
      type: JOINT_SIX_DOF,
      bodyA: anchor,
      bodyB: free,
      dof: [DOF_FREE],
    });
    run(world, 200);
    expect(dropOf(world, anchor, free)).toBeCloseTo(-1, 2);
  });
});
