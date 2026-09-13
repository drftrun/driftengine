import { describe, expect, it } from 'vitest';
import { BODY_DYNAMIC, BODY_STATIC } from './bodies.ts';
import {
  JOINT_CONE_TWIST,
  JOINT_DISTANCE,
  JOINT_FIXED,
  JOINT_PRISMATIC,
  JOINT_REVOLUTE,
  JOINT_SPHERICAL,
} from './joints.ts';
import { boxShape, sphereShape } from './shape.ts';
import { PhysicsWorld } from './world.ts';

const DT = 1 / 60;

/**
 * Jointed bodies are put on layers that do not see each other.
 *
 * A hinge's post and its door touch at the hinge by construction, and a slider's car sits inside
 * its rail. Left colliding, the contact fights the joint and every measurement is of the two
 * together — which is what four of these tests measured before they said so.
 */
const A_ONLY = { layer: 1, mask: 4 };
const B_ONLY = { layer: 2, mask: 4 };
const run = (w: PhysicsWorld, n: number): void => {
  for (let i = 0; i < n; i++) w.step(DT);
};

/** An anchor body pinned in space, and a free body hanging off it. */
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
    y: 3,
    density: 500,
    ...B_ONLY,
  });
  return { world, anchor, free };
}

const dist = (w: PhysicsWorld, a: number, b: number): number => {
  const dx = (w.bodies.posX[b] ?? 0) - (w.bodies.posX[a] ?? 0);
  const dy = (w.bodies.posY[b] ?? 0) - (w.bodies.posY[a] ?? 0);
  const dz = (w.bodies.posZ[b] ?? 0) - (w.bodies.posZ[a] ?? 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
};

describe('a distance joint', () => {
  it('holds two bodies the length apart', () => {
    const { world, anchor, free } = pair();
    world.addJoint({ type: JOINT_DISTANCE, bodyA: anchor, bodyB: free, length: 2 });
    run(world, 300);
    expect(dist(world, anchor, free)).toBeCloseTo(2, 2);
  });

  it('holds it while the body swings sideways', () => {
    const { world, anchor, free } = pair();
    world.addJoint({ type: JOINT_DISTANCE, bodyA: anchor, bodyB: free, length: 2 });
    world.bodies.velX[free] = 5;
    run(world, 200);
    expect(dist(world, anchor, free)).toBeCloseTo(2, 1);
    expect(Math.abs(world.bodies.posX[free] ?? 0)).toBeGreaterThan(0.2);
  });

  it('lets a body hang free between its limits and catches it at the end', () => {
    const { world, anchor, free } = pair();
    world.addJoint({ type: JOINT_DISTANCE, bodyA: anchor, bodyB: free, lower: 0.5, upper: 3 });
    run(world, 300);
    expect(dist(world, anchor, free)).toBeCloseTo(3, 1);
  });
});

describe('a spherical joint', () => {
  it('keeps two anchors coincident under load', () => {
    const { world, anchor, free } = pair();
    world.addJoint({
      type: JOINT_SPHERICAL,
      bodyA: anchor,
      bodyB: free,
      anchorAY: -0.2,
      anchorBY: 0.3,
    });
    run(world, 300);
    const ax = world.bodies.posX[anchor] ?? 0;
    const ay = (world.bodies.posY[anchor] ?? 0) - 0.2;
    expect(Math.abs((world.bodies.posX[free] ?? 0) - ax)).toBeLessThan(0.05);
    expect(Math.abs((world.bodies.posY[free] ?? 0) + 0.3 - ay)).toBeLessThan(0.05);
  });

  /**
   * A ball joint frees rotation about the anchor, not about the body's own centre.
   *
   * The first version of this test put the anchor 0.3 off the centre and expected the spin to
   * survive. It should not: spinning about the centre moves an offset anchor, so the point
   * constraint converts the spin into orbital motion, which is exactly what a ball joint is for.
   * Coincident anchors are where free spin actually lives.
   */
  it('lets the body spin freely when the anchor is its own centre', () => {
    const world = new PhysicsWorld({ gravityY: 0, allowSleep: false });
    const anchor = world.addBody({ type: BODY_STATIC, shape: boxShape(0.2, 0.2, 0.2), ...A_ONLY });
    const free = world.addBody({
      type: BODY_DYNAMIC,
      shape: boxShape(0.3, 0.3, 0.3),
      density: 500,
      ...B_ONLY,
    });
    world.addJoint({ type: JOINT_SPHERICAL, bodyA: anchor, bodyB: free });
    world.bodies.angZ[free] = 8;
    run(world, 60);
    expect(Math.abs(world.bodies.angZ[free] ?? 0)).toBeGreaterThan(6);
  });
});

describe('a revolute joint', () => {
  it('lets a door swing about its hinge and not otherwise', () => {
    const world = new PhysicsWorld({ allowSleep: false });
    const post = world.addBody({
      type: BODY_STATIC,
      shape: boxShape(0.1, 1, 0.1),
      y: 2,
      ...A_ONLY,
    });
    const door = world.addBody({
      type: BODY_DYNAMIC,
      shape: boxShape(0.8, 1, 0.05),
      x: 0.9,
      y: 2,
      density: 300,
      ...B_ONLY,
    });
    world.addJoint({
      type: JOINT_REVOLUTE,
      bodyA: post,
      bodyB: door,
      anchorAX: 0.1,
      anchorBX: -0.8,
      axisX: 0,
      axisY: 1,
      axisZ: 0,
    });
    world.bodies.angY[door] = 3;
    run(world, 120);
    // It turned about y, and barely at all about the other two.
    expect(Math.abs(world.bodies.rotY[door] ?? 0)).toBeGreaterThan(0.1);
    expect(Math.abs(world.bodies.rotX[door] ?? 0)).toBeLessThan(0.05);
    expect(Math.abs(world.bodies.rotZ[door] ?? 0)).toBeLessThan(0.05);
  });

  it('keeps the hinge anchor together', () => {
    const world = new PhysicsWorld({ allowSleep: false });
    const post = world.addBody({
      type: BODY_STATIC,
      shape: boxShape(0.1, 1, 0.1),
      y: 2,
      ...A_ONLY,
    });
    const door = world.addBody({
      type: BODY_DYNAMIC,
      shape: boxShape(0.8, 1, 0.05),
      x: 0.9,
      y: 2,
      density: 300,
      ...B_ONLY,
    });
    world.addJoint({
      type: JOINT_REVOLUTE,
      bodyA: post,
      bodyB: door,
      anchorAX: 0.1,
      anchorBX: -0.8,
      axisY: 1,
    });
    run(world, 300);
    expect(world.bodies.posY[door] ?? 0).toBeGreaterThan(1.9);
  });

  it('drives a hinge with a motor', () => {
    const world = new PhysicsWorld({ gravityY: 0, allowSleep: false });
    const post = world.addBody({ type: BODY_STATIC, shape: boxShape(0.1, 1, 0.1), ...A_ONLY });
    const arm = world.addBody({
      type: BODY_DYNAMIC,
      shape: boxShape(0.8, 0.1, 0.1),
      x: 0.9,
      density: 300,
      ...B_ONLY,
    });
    world.addJoint({
      type: JOINT_REVOLUTE,
      bodyA: post,
      bodyB: arm,
      anchorAX: 0.1,
      anchorBX: -0.8,
      axisY: 1,
      motorSpeed: 4,
      motorMaxForce: 500,
    });
    run(world, 60);
    expect(world.bodies.angY[arm] ?? 0).toBeGreaterThan(2);
  });

  it('leaves a hinge alone when its motor has no force', () => {
    const world = new PhysicsWorld({ gravityY: 0, allowSleep: false });
    const post = world.addBody({ type: BODY_STATIC, shape: boxShape(0.1, 1, 0.1), ...A_ONLY });
    const arm = world.addBody({
      type: BODY_DYNAMIC,
      shape: boxShape(0.8, 0.1, 0.1),
      x: 0.9,
      density: 300,
      ...B_ONLY,
    });
    world.addJoint({
      type: JOINT_REVOLUTE,
      bodyA: post,
      bodyB: arm,
      anchorAX: 0.1,
      anchorBX: -0.8,
      axisY: 1,
      motorSpeed: 4,
      motorMaxForce: 0,
    });
    run(world, 60);
    expect(Math.abs(world.bodies.angY[arm] ?? 0)).toBeLessThan(0.2);
  });

  it('stops a hinge at its limit', () => {
    const world = new PhysicsWorld({ gravityY: 0, allowSleep: false });
    const post = world.addBody({ type: BODY_STATIC, shape: boxShape(0.1, 1, 0.1), ...A_ONLY });
    const arm = world.addBody({
      type: BODY_DYNAMIC,
      shape: boxShape(0.8, 0.1, 0.1),
      x: 0.9,
      density: 300,
      ...B_ONLY,
    });
    // Limits are sines of half-angles, never angles: 0.2 is about 23 degrees.
    world.addJoint({
      type: JOINT_REVOLUTE,
      bodyA: post,
      bodyB: arm,
      anchorAX: 0.1,
      anchorBX: -0.8,
      axisY: 1,
      lower: -0.2,
      upper: 0.2,
      motorSpeed: 6,
      motorMaxForce: 2000,
    });
    run(world, 180);
    expect(Math.abs(world.bodies.rotY[arm] ?? 0)).toBeLessThan(0.35);
  });
});

describe('a prismatic joint', () => {
  it('slides along its axis and rotates about none', () => {
    const world = new PhysicsWorld({ allowSleep: false });
    const rail = world.addBody({
      type: BODY_STATIC,
      shape: boxShape(0.1, 2, 0.1),
      y: 3,
      ...A_ONLY,
    });
    const car = world.addBody({
      type: BODY_DYNAMIC,
      shape: boxShape(0.3, 0.3, 0.3),
      y: 3,
      density: 400,
      ...B_ONLY,
    });
    world.addJoint({ type: JOINT_PRISMATIC, bodyA: rail, bodyB: car, axisY: 1 });
    run(world, 120);
    expect(world.bodies.posY[car] ?? 0).toBeLessThan(2.5);
    expect(Math.abs(world.bodies.posX[car] ?? 0)).toBeLessThan(0.02);
    expect(Math.abs(world.bodies.posZ[car] ?? 0)).toBeLessThan(0.02);
    expect(Math.abs(world.bodies.rotZ[car] ?? 0)).toBeLessThan(0.02);
  });

  it('stops at its lower limit', () => {
    const world = new PhysicsWorld({ allowSleep: false });
    const rail = world.addBody({
      type: BODY_STATIC,
      shape: boxShape(0.1, 2, 0.1),
      y: 3,
      ...A_ONLY,
    });
    const car = world.addBody({
      type: BODY_DYNAMIC,
      shape: boxShape(0.3, 0.3, 0.3),
      y: 3,
      density: 400,
      ...B_ONLY,
    });
    world.addJoint({
      type: JOINT_PRISMATIC,
      bodyA: rail,
      bodyB: car,
      axisY: 1,
      lower: -1,
      upper: 1,
    });
    run(world, 300);
    expect(world.bodies.posY[car] ?? 0).toBeGreaterThan(1.85);
    expect(world.bodies.posY[car] ?? 0).toBeLessThan(2.15);
  });
});

describe('a fixed joint', () => {
  it('holds a relative pose against gravity', () => {
    const { world, anchor, free } = pair();
    world.addJoint({ type: JOINT_FIXED, bodyA: anchor, bodyB: free });
    run(world, 300);
    expect(Math.abs((world.bodies.posY[free] ?? 0) - 3)).toBeLessThan(0.15);
    expect(Math.abs(world.bodies.rotZ[free] ?? 0)).toBeLessThan(0.05);
  });

  it('holds the rotation too, not only the position', () => {
    const world = new PhysicsWorld({ gravityY: 0, allowSleep: false });
    const a = world.addBody({ type: BODY_STATIC, shape: boxShape(0.2, 0.2, 0.2), ...A_ONLY });
    const b = world.addBody({
      type: BODY_DYNAMIC,
      shape: boxShape(0.2, 0.2, 0.2),
      x: 1,
      density: 400,
      ...B_ONLY,
    });
    world.addJoint({ type: JOINT_FIXED, bodyA: a, bodyB: b });
    world.bodies.angY[b] = 6;
    run(world, 120);
    expect(Math.abs(world.bodies.rotY[b] ?? 0)).toBeLessThan(0.05);
  });
});

describe('a cone-twist joint', () => {
  it('holds a limb inside its cone', () => {
    const world = new PhysicsWorld({ allowSleep: false });
    const torso = world.addBody({
      type: BODY_STATIC,
      shape: boxShape(0.3, 0.3, 0.3),
      y: 4,
      ...A_ONLY,
    });
    const limb = world.addBody({
      type: BODY_DYNAMIC,
      shape: boxShape(0.1, 0.5, 0.1),
      y: 3.2,
      density: 400,
      ...B_ONLY,
    });
    world.addJoint({
      type: JOINT_CONE_TWIST,
      bodyA: torso,
      bodyB: limb,
      anchorAY: -0.3,
      anchorBY: 0.5,
      axisY: -1,
      // cos(30 degrees): the limb may swing 30 degrees off the axis and no further.
      swingCos: Math.cos(Math.PI / 6),
    });
    world.bodies.velX[limb] = 6;
    run(world, 300);
    const dx = (world.bodies.posX[limb] ?? 0) - (world.bodies.posX[torso] ?? 0);
    const dy = (world.bodies.posY[limb] ?? 0) - (world.bodies.posY[torso] ?? 0);
    // Inside a 30 degree cone about straight down, tan(30) is about 0.58.
    expect(Math.abs(dx / dy)).toBeLessThan(0.75);
  });
});

describe('joints and the rest of the world', () => {
  it('makes two jointed bodies one island', () => {
    const world = new PhysicsWorld({ gravityY: 0 });
    const a = world.addBody({ type: BODY_DYNAMIC, shape: sphereShape(0.3), density: 400 });
    const b = world.addBody({ type: BODY_DYNAMIC, shape: sphereShape(0.3), x: 3, density: 400 });
    world.addJoint({ type: JOINT_DISTANCE, bodyA: a, bodyB: b, length: 3 });
    world.step(DT);
    expect(world.islandCount).toBe(1);
  });

  it('breaks a joint carrying more than it was told to', () => {
    const { world, anchor, free } = pair();
    const j = world.addJoint({
      type: JOINT_DISTANCE,
      bodyA: anchor,
      bodyB: free,
      length: 2,
      breakImpulse: 1,
    });
    run(world, 120);
    expect(world.joints.broken[j]).toBe(1);
    expect(world.bodies.posY[free] ?? 0).toBeLessThan(0);
  });

  it('does not break one within its threshold', () => {
    const { world, anchor, free } = pair();
    const j = world.addJoint({
      type: JOINT_DISTANCE,
      bodyA: anchor,
      bodyB: free,
      length: 2,
      breakImpulse: 1e9,
    });
    run(world, 300);
    expect(world.joints.broken[j]).toBe(0);
  });

  it('leaves a broken joint out of the island graph', () => {
    const world = new PhysicsWorld({ gravityY: 0 });
    const a = world.addBody({ type: BODY_DYNAMIC, shape: sphereShape(0.3), density: 400 });
    const b = world.addBody({ type: BODY_DYNAMIC, shape: sphereShape(0.3), x: 3, density: 400 });
    const j = world.addJoint({ type: JOINT_DISTANCE, bodyA: a, bodyB: b, length: 3 });
    world.joints.broken[j] = 1;
    world.step(DT);
    expect(world.islandCount).toBe(2);
  });

  it('never produces a NaN in a chain of joints', () => {
    const world = new PhysicsWorld({ allowSleep: false });
    let previous = world.addBody({ type: BODY_STATIC, shape: sphereShape(0.2), y: 8 });
    for (let i = 0; i < 8; i++) {
      const link = world.addBody({
        type: BODY_DYNAMIC,
        shape: sphereShape(0.2),
        y: 8 - (i + 1) * 0.5,
        density: 400,
      });
      world.addJoint({
        type: JOINT_SPHERICAL,
        bodyA: previous,
        bodyB: link,
        anchorAY: -0.25,
        anchorBY: 0.25,
      });
      previous = link;
    }
    run(world, 400);
    for (let i = 0; i < world.bodies.count; i++) {
      expect(Number.isFinite(world.bodies.posY[i] ?? NaN)).toBe(true);
      expect(Number.isFinite(world.bodies.rotW[i] ?? NaN)).toBe(true);
    }
  });

  it('hangs a chain roughly straight down', () => {
    const world = new PhysicsWorld({ allowSleep: false });
    let previous = world.addBody({ type: BODY_STATIC, shape: sphereShape(0.2), y: 8 });
    const links: number[] = [];
    for (let i = 0; i < 6; i++) {
      const link = world.addBody({
        type: BODY_DYNAMIC,
        shape: sphereShape(0.2),
        y: 8 - (i + 1) * 0.5,
        density: 400,
      });
      world.addJoint({
        type: JOINT_SPHERICAL,
        bodyA: previous,
        bodyB: link,
        anchorAY: -0.25,
        anchorBY: 0.25,
      });
      links.push(link);
      previous = link;
    }
    run(world, 400);
    const last = links[5] ?? 0;
    expect(world.bodies.posY[last] ?? 0).toBeLessThan(6);
    expect(Math.abs(world.bodies.posX[last] ?? 0)).toBeLessThan(0.6);
  });
});
