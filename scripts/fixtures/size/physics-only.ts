/**
 * The collision kernel with no engine at all.
 *
 * **This is what the package's independence is worth**, and it is measured rather than claimed: it
 * imports no `@driftengine/*`, so a consumer who wants collision and no renderer pays for collision
 * and no renderer. `boundaries.test.mjs` asserts the import graph; this asserts the consequence,
 * which is the number.
 *
 * It is also the baseline every later plan in Track B measures against: the solver, the joints and
 * the queries all land in this package, and each one's cost is this figure's growth rather than an
 * estimate.
 */
import {
  AXIS_Y,
  BODY_DYNAMIC,
  BODY_STATIC,
  CharacterController,
  ColliderSet,
  JOINT_REVOLUTE,
  PhysicsWorld,
  boxCollider,
  boxShape,
  capsuleShape,
  ClothBody,
  Vehicle,
  createRayHit,
  makeClothGrid,
  moveAxis,
  ragdollFromBones,
} from '@driftengine/physics';
import type { Body } from '@driftengine/physics';

/** The kinematic half: a swept body against a static set. */
export function fall(): number {
  const boxes = new ColliderSet([boxCollider(0, -0.5, 0, 10, 0.5, 10)]);
  const body: Body = { x: 0, y: 2, z: 0, hx: 0.4, hy: 0.9, hz: 0.4, shape: capsuleShape(0.4, 0.9) };
  moveAxis(body, boxes, AXIS_Y, -0.1);
  return body.y;
}

/** And the dynamics: a world, a floor, a body, a tick. */
export function settle(): number {
  const world = new PhysicsWorld();
  world.addBody({ type: BODY_STATIC, shape: boxShape(20, 1, 20), y: -1 });
  const box = world.addBody({ type: BODY_DYNAMIC, shape: boxShape(0.5, 0.5, 0.5), y: 2 });
  for (let i = 0; i < 60; i++) world.step(1 / 60);
  return world.bodies.posY[box] ?? 0;
}

/** Joints, queries, the controller and a ragdoll, so the whole package is in the figure. */
export function everything(): number {
  const world = new PhysicsWorld();
  const floor = world.addBody({ type: BODY_STATIC, shape: boxShape(20, 1, 20), y: -1 });
  const arm = world.addBody({ type: BODY_DYNAMIC, shape: boxShape(0.5, 0.1, 0.1), x: 1, y: 2 });
  world.addJoint({
    type: JOINT_REVOLUTE,
    bodyA: floor,
    bodyB: arm,
    axisY: 1,
    motorSpeed: 1,
    motorMaxForce: 10,
  });

  const parents = new Int32Array([-1, 0, 1]);
  const matrices = new Float32Array(3 * 16);
  for (let j = 0; j < 3; j++) {
    matrices[j * 16] = 1;
    matrices[j * 16 + 5] = 1;
    matrices[j * 16 + 10] = 1;
    matrices[j * 16 + 15] = 1;
    matrices[j * 16 + 13] = 4 - j * 0.5;
    matrices[j * 16 + 12] = j * 0.1;
  }
  const doll = ragdollFromBones(world, parents, matrices);

  const player = new CharacterController();
  player.teleport(0, 2, 0);
  const hit = createRayHit();
  for (let i = 0; i < 10; i++) {
    player.move(world, 1 / 60, { moveX: 1, moveZ: 0, jump: false });
    world.step(1 / 60);
  }
  world.raycast(0, 5, 0, 0, -1, 0, 20, hit);
  world.overlap(
    boxShape(1, 1, 1),
    { x: 0, y: 1, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 },
    new Int32Array(8),
  );
  return doll.boneCount + hit.body + player.y + world.events.count;
}

/** The vehicle and the cloth, so the figure covers the whole package. */
export function driveAndDrape(): number {
  const world = new PhysicsWorld();
  world.addBody({ type: BODY_STATIC, shape: boxShape(50, 1, 50), y: -1 });
  const chassis = world.addBody({ type: BODY_DYNAMIC, shape: boxShape(1, 0.4, 2), y: 1.2 });
  const car = new Vehicle(chassis, {
    wheels: [
      { x: -0.8, y: -0.3, z: 1.2, steers: true },
      { x: 0.8, y: -0.3, z: 1.2, steers: true },
      { x: -0.8, y: -0.3, z: -1.2, driven: true },
      { x: 0.8, y: -0.3, z: -1.2, driven: true },
    ],
  });
  const grid = makeClothGrid(6, 6, 0.2);
  const cloth = new ClothBody(grid.positions, grid.links, grid.bendLinks);
  cloth.pin(0);
  for (let i = 0; i < 10; i++) {
    car.update(world, 1 / 60, { throttle: 1, brake: 0, steer: 0.2 });
    cloth.step(world, 1 / 60);
    world.step(1 / 60);
  }
  return (world.bodies.posZ[chassis] ?? 0) + (cloth.position[1] ?? 0);
}
