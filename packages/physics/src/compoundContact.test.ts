import { describe, expect, it } from 'vitest';
import { BODY_DYNAMIC, BODY_STATIC } from './bodies.ts';
import { MAX_BODY_PARTS } from './compoundContact.ts';
import { combineMassProperties, createMassProperties, shapeMassProperties } from './mass.ts';
import { meshShape } from './meshShape.ts';
import { boxShape, hullShape } from './shape.ts';
import { createManifold } from './manifold.ts';
import type { Manifold, ShapePose } from './manifold.ts';
import { MAX_PAIR_MANIFOLDS, collideCompound } from './compoundContact.ts';
import { PhysicsWorld } from './world.ts';

const IDENTITY: ShapePose = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 };

/** A sawtooth floor: no two triangles under one foot are coplanar, so each foot finds several. */
function sawtoothFloor(
  span: number,
  step: number,
): { positions: Float32Array; indices: Uint32Array } {
  const positions: number[] = [];
  const indices: number[] = [];
  const cells = Math.round((span * 2) / step);
  for (let ix = 0; ix <= cells; ix++) {
    for (let iz = 0; iz <= cells; iz++) {
      positions.push(-span + ix * step, ((ix + iz) % 2) * 0.02, -span + iz * step);
    }
  }
  const at = (ix: number, iz: number): number => ix * (cells + 1) + iz;
  for (let ix = 0; ix < cells; ix++) {
    for (let iz = 0; iz < cells; iz++) {
      indices.push(at(ix, iz), at(ix, iz + 1), at(ix + 1, iz));
      indices.push(at(ix + 1, iz), at(ix, iz + 1), at(ix + 1, iz + 1));
    }
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

/** A box of the given half-extents, centred where asked, as a hull in the body's own frame. */
function boxAt(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number) {
  const points: number[] = [];
  for (let i = 0; i < 8; i++) {
    points.push(cx + (i & 1 ? hx : -hx), cy + (i & 2 ? hy : -hy), cz + (i & 4 ? hz : -hz));
  }
  return hullShape(points);
}

describe('a body made of several shapes', () => {
  it('is built from exactly one of shape or shapes', () => {
    const world = new PhysicsWorld();
    const box = boxShape(0.5, 0.5, 0.5);
    expect(() => world.addBody({ type: BODY_DYNAMIC, shape: box, shapes: [box] })).toThrow(/both/);
    expect(() => world.addBody({ type: BODY_DYNAMIC })).toThrow(/neither/);
    expect(() => world.addBody({ type: BODY_DYNAMIC, shapes: [] })).toThrow(/empty/);
  });

  it('refuses more parts than a pair has contact planes for', () => {
    /*
     * A dropped part is a limb of the body that stops colliding, so this is a refusal at
     * construction and not a truncation in the tick.
     */
    const world = new PhysicsWorld();
    const parts = Array.from({ length: MAX_BODY_PARTS + 1 }, (_, i) =>
      boxAt(i * 2, 0, 0, 0.5, 0.5, 0.5),
    );
    expect(() => world.addBody({ type: BODY_DYNAMIC, shapes: parts })).toThrow(/MAX_BODY_PARTS/);
  });

  it('refuses a triangle mesh as a part', () => {
    const world = new PhysicsWorld();
    const mesh = meshShape(
      new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]),
      new Uint32Array([0, 1, 2]),
    );
    expect(() => world.addBody({ type: BODY_STATIC, shapes: [mesh] })).toThrow(/cannot be a part/);
  });

  it('weighs what the solid it stands for weighs', () => {
    /*
     * **The parallel axis theorem, checked against a shape with a closed form.** Two unit cubes side
     * by side are a 2 x 1 x 1 box, so every term of the combined tensor has an exact answer that
     * owes nothing to this code. Dropping the offset term leaves `iyy` and `izz` at a third of what
     * they should be, which is a body that spins up when it is released at rest.
     */
    const left = boxAt(-0.5, 0, 0, 0.5, 0.5, 0.5);
    const right = boxAt(0.5, 0, 0, 0.5, 0.5, 0.5);
    const whole = boxAt(0, 0, 0, 1, 0.5, 0.5);

    const combined = combineMassProperties([left, right], 1000, createMassProperties());
    const exact = shapeMassProperties(whole, 1000, createMassProperties());

    expect(combined.volume).toBeCloseTo(exact.volume, 6);
    expect(combined.comX).toBeCloseTo(exact.comX, 6);
    expect(combined.comY).toBeCloseTo(exact.comY, 6);
    expect(combined.comZ).toBeCloseTo(exact.comZ, 6);
    expect(combined.ixx).toBeCloseTo(exact.ixx, 3);
    expect(combined.iyy).toBeCloseTo(exact.iyy, 3);
    expect(combined.izz).toBeCloseTo(exact.izz, 3);
    expect(combined.ixy).toBeCloseTo(exact.ixy, 3);
  });

  it('puts its centre of mass where the parts put it, not at the origin', () => {
    /* One part far off to a side: the centre follows it, weighted by volume. */
    const small = boxAt(0, 0, 0, 0.5, 0.5, 0.5);
    const far = boxAt(4, 0, 0, 0.5, 0.5, 0.5);
    const combined = combineMassProperties([small, far], 1000, createMassProperties());
    expect(combined.comX).toBeCloseTo(2, 6);
  });

  it('collides as its parts rather than as its first one', () => {
    /*
     * Two feet, a metre apart, on a floor. If only the first part collided the body would tip; if
     * the bounds were the first part's the second would never reach the broad phase at all.
     */
    const world = new PhysicsWorld();
    world.addBody({ type: BODY_STATIC, shape: boxShape(10, 0.5, 10), y: -0.5 });
    const body = world.addBody({
      type: BODY_DYNAMIC,
      shapes: [boxAt(-1, 0, 0, 0.4, 0.4, 0.4), boxAt(1, 0, 0, 0.4, 0.4, 0.4)],
      y: 1.5,
    });
    for (let i = 0; i < 400; i++) world.step(1 / 120);
    /* Resting on both feet: the centre sits a part's half-height above the floor. */
    expect(world.bodies.posY[body] as number).toBeGreaterThan(0.35);
    expect(world.bodies.posY[body] as number).toBeLessThan(0.45);
    const tilt = Math.hypot(world.bodies.rotX[body] as number, world.bodies.rotZ[body] as number);
    expect(tilt).toBeLessThan(0.02);
  });

  it('rests as still on a mesh floor as on a box floor', () => {
    /*
     * **The manifold budget, which nothing else here would see.** A compound against a mesh shares
     * one set of contact planes between its parts; handing the whole set to whichever part is tried
     * first leaves the far parts without one and the body settles differently. A box floor is one
     * convex shape, so every part gets a plane by construction — the same scene reached twice.
     */
    const feet = [boxAt(-1, 0, 0, 0.4, 0.4, 0.4), boxAt(1, 0, 0, 0.4, 0.4, 0.4)];
    const settle = (onMesh: boolean): number => {
      const world = new PhysicsWorld();
      if (onMesh) {
        world.addBody({
          type: BODY_STATIC,
          shape: meshShape(
            new Float32Array([-8, 0, -8, 8, 0, -8, -8, 0, 8, 8, 0, 8]),
            new Uint32Array([0, 2, 1, 1, 2, 3]),
          ),
        });
      } else {
        world.addBody({ type: BODY_STATIC, shape: boxShape(8, 0.5, 8), y: -0.5 });
      }
      const body = world.addBody({ type: BODY_DYNAMIC, shapes: feet, y: 1.2 });
      for (let i = 0; i < 500; i++) world.step(1 / 120);
      return world.bodies.posY[body] as number;
    };
    /* The solver's own slop is 5 mm, so that is what "the same" means. */
    expect(Math.abs(settle(true) - settle(false))).toBeLessThan(0.005);
  });

  it('holds still once it has settled', () => {
    /*
     * Warm starting pairs an accumulated impulse to a contact by identity, and the part pair is
     * folded into every feature id so a body resting across two parts cannot hand one part's
     * impulse to the other. Without the fold the body creeps.
     */
    const world = new PhysicsWorld();
    world.addBody({ type: BODY_STATIC, shape: boxShape(10, 0.5, 10), y: -0.5 });
    const body = world.addBody({
      type: BODY_DYNAMIC,
      shapes: [boxAt(-0.6, 0, 0, 0.5, 0.5, 0.5), boxAt(0.6, 0, 0, 0.5, 0.5, 0.5)],
      y: 0.5,
    });
    for (let i = 0; i < 240; i++) world.step(1 / 120);
    const settledX = world.bodies.posX[body] as number;
    const settledZ = world.bodies.posZ[body] as number;
    for (let i = 0; i < 240; i++) world.step(1 / 120);
    const driftX = Math.abs((world.bodies.posX[body] as number) - settledX);
    const driftZ = Math.abs((world.bodies.posZ[body] as number) - settledZ);
    expect(driftX).toBeLessThan(0.002);
    expect(driftZ).toBeLessThan(0.002);
  });

  it('follows a compound through a removal', () => {
    /* A swap-remove moves the last body into the hole; its parts have to move with it. */
    const world = new PhysicsWorld();
    const first = world.addBody({ type: BODY_DYNAMIC, shape: boxShape(0.5, 0.5, 0.5), y: 5 });
    world.addBody({
      type: BODY_DYNAMIC,
      shapes: [boxAt(-1, 0, 0, 0.4, 0.4, 0.4), boxAt(1, 0, 0, 0.4, 0.4, 0.4)],
      y: 2,
    });
    world.removeBody(first);
    expect(world.bodies.shapes[0]).toHaveLength(2);
    expect(world.bodies.shape[0]).toBeUndefined();
  });
});
