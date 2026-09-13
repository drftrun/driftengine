import { describe, expect, it } from 'vitest';
import { BODY_DYNAMIC, BODY_STATIC } from './bodies.ts';
import { ClothBody, makeClothGrid } from './cloth.ts';
import type { Aabb } from './collide/index.ts';
import { cylinderSupport, readCylinder } from './cylinder.ts';
import { collideShapes, createManifold } from './manifold.ts';
import { createMassProperties, shapeMassProperties } from './mass.ts';
import { createRayHit } from './query.ts';
import { boxShape, cylinderShape, shapeBounds, sphereShape } from './shape.ts';
import { PhysicsWorld } from './world.ts';

/**
 * The cylinder, and the four things a second shape representation had to earn.
 *
 * `shape.ts` refused a cylinder for as long as `ConvexShape` meant point-cloud-plus-uniform-radius,
 * and pointed consumers at an n-gon prism instead. `prismRoll.test.ts` measured what that cost and
 * found a floor: thirty-two sides is the most a 64-point hull can hold, and a thirty-two-sided
 * wheel of radius 1 still bobs. So this file asserts the four properties that make the second
 * representation worth its keep — an exact support in every radial direction, an exact inertia, a
 * contact that holds a rolling wheel at its own radius, and a closed-form ray — and the comparison
 * against the prism lives beside the prism, where the number it beats already is.
 */

const at = (x: number, y: number, z: number) => ({ x, y, z, qx: 0, qy: 0, qz: 0, qw: 1 });
const bounds = (): Aabb => ({ minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 });
const DT = 1 / 60;

describe('the cylinder shape', () => {
  it('refuses a degenerate one rather than producing a disc', () => {
    expect(() => cylinderShape(0, 1)).toThrow(/radius/);
    expect(() => cylinderShape(-1, 1)).toThrow(/radius/);
    /* Unlike a capsule, whose zero half-height degenerates into a sphere and is right. */
    expect(() => cylinderShape(1, 0)).toThrow(/halfHeight/);
  });

  /**
   * **The property the prism cannot have, and the whole reason for the shape kind.**
   *
   * A cylinder's support in *every* direction perpendicular to its axis is exactly its radius. An
   * n-gon's is `r` at a vertex and `r · cos(π / n)` at the middle of a flat, which is what makes a
   * rolling prism bob. Sampled at a hundred angles, none of which is a special case, and compared
   * against a hand-written constant rather than against anything the implementation produced.
   */
  it('reaches exactly its radius in every direction across the axis', () => {
    const cyl = new Float64Array(11);
    readCylinder(cylinderShape(0.75, 2), at(0, 0, 0), cyl);
    for (let i = 0; i < 100; i++) {
      const angle = (i / 100) * Math.PI * 2;
      expect(cylinderSupport(cyl, Math.cos(angle), 0, Math.sin(angle))).toBeCloseTo(0.75, 12);
    }
    /* And exactly its half-height along the axis, where the caps are. */
    expect(cylinderSupport(cyl, 0, 1, 0)).toBeCloseTo(2, 12);
    expect(cylinderSupport(cyl, 0, -1, 0)).toBeCloseTo(2, 12);
  });

  /**
   * The bounds grow by the disc's extent seen down each axis, not by the radius on all three.
   *
   * Upright, that is the radius across and nothing along; lying along x, the reverse. A cylinder
   * bounded as though it were a sphere would be correct and would cost the broad phase the
   * difference on every one in the world.
   */
  it('bounds itself by the disc rather than by a ball', () => {
    const upright = shapeBounds(cylinderShape(0.5, 2), bounds());
    expect(upright.maxX).toBeCloseTo(0.5, 12);
    expect(upright.maxY).toBeCloseTo(2, 12);
    expect(upright.maxZ).toBeCloseTo(0.5, 12);
  });

  /**
   * **Two textbook results, hand-derived here and never read off the implementation.**
   *
   * A solid cylinder of mass `m`, radius `r` and full length `L` has `m r² / 2` about its own axis
   * and `m (3r² + L²) / 12` across it. At r = 0.5, L = 2 and density 1000: the volume is
   * `π · 0.25 · 2`, the mass is that times 1000, and the two moments follow.
   */
  it('has the closed-form inertia of a solid cylinder', () => {
    const m = shapeMassProperties(cylinderShape(0.5, 1), 1000, createMassProperties());
    const volume = Math.PI * 0.25 * 2;
    const mass = volume * 1000;
    expect(m.volume).toBeCloseTo(volume, 10);
    // The axis is local y, so `iyy` is the one about the axis.
    expect(m.iyy).toBeCloseTo((mass * 0.25) / 2, 6);
    expect(m.ixx).toBeCloseTo((mass * (3 * 0.25 + 4)) / 12, 6);
    expect(m.izz).toBeCloseTo(m.ixx, 9);
    expect(m.ixy).toBeCloseTo(0, 12);
  });
});

describe('a cylinder in contact', () => {
  it('meets a floor on its cap with a disc of contacts', () => {
    const m = createManifold();
    const hit = collideShapes(
      cylinderShape(0.5, 1),
      at(0, 1, 0),
      boxShape(10, 1, 10),
      at(0, -1, 0),
      0.02,
      m,
    );
    expect(hit).toBe(true);
    expect(m.count).toBe(4);
    expect(m.ny).toBeCloseTo(-1, 9);
    for (let i = 0; i < m.count; i++) expect(m.separations[i]).toBeCloseTo(0, 6);
    /* A cap is flat and turns with the body, so its anchor belongs in the body's frame. */
    expect(m.curvedA).toBe(false);
  });

  it('meets a floor on its side along a line, and calls that side curved', () => {
    const m = createManifold();
    const q = Math.SQRT1_2;
    const hit = collideShapes(
      cylinderShape(0.5, 1),
      { x: 0, y: 0.5, z: 0, qx: 0, qy: 0, qz: q, qw: q },
      boxShape(10, 1, 10),
      at(0, -1, 0),
      0.02,
      m,
    );
    expect(hit).toBe(true);
    expect(m.count).toBe(2);
    expect(m.ny).toBeCloseTo(-1, 9);
    /* The two ends of the contact line, a half-length either side of the centre. */
    expect(Math.abs(m.points[0] ?? 0)).toBeCloseTo(1, 6);
    expect(Math.abs(m.points[3] ?? 0)).toBeCloseTo(1, 6);
    expect(m.curvedA).toBe(true);
  });

  it('meets a sphere on its rim at the rim, not at the cap or the side', () => {
    const m = createManifold();
    /* Diagonally out from the rim of a unit cylinder standing at the origin. */
    const hit = collideShapes(
      cylinderShape(1, 1),
      at(0, 0, 0),
      sphereShape(0.5),
      at(1.3, 1.3, 0),
      0.02,
      m,
    );
    expect(hit).toBe(true);
    expect(m.count).toBe(1);
    /* The nearest point is the rim itself: radius across, half-height up. */
    expect(m.points[0]).toBeCloseTo(1, 6);
    expect(m.points[1]).toBeCloseTo(1, 6);
    /* And the separation is the diagonal gap less the ball. */
    expect(m.separations[0]).toBeCloseTo(Math.hypot(0.3, 0.3) - 0.5, 6);
  });
});

describe('a cylinder in a world', () => {
  /**
   * **The number the shape kind exists for.**
   *
   * A wheel of radius 1 rolling at 6 m/s rests at exactly its own radius and stays there. The
   * thirty-two-sided prism it replaces bobs sixteen millimetres doing the same thing, and cannot
   * do better because a 64-point hull cannot hold more sides — `prismRoll.test.ts` measures both.
   */
  it('rolls at its own radius without bobbing', () => {
    const world = new PhysicsWorld({ gravityY: -9.81, allowSleep: false });
    world.addBody({ type: BODY_STATIC, shape: boxShape(100, 1, 100), y: -1, friction: 1 });
    const q = Math.SQRT1_2;
    const wheel = world.addBody({
      type: BODY_DYNAMIC,
      shape: cylinderShape(1, 0.3),
      y: 1.2,
      density: 500,
      friction: 1,
      qx: q,
      qy: 0,
      qz: 0,
      qw: q,
    });
    for (let i = 0; i < 90; i++) world.step(DT);
    world.bodies.velX[wheel] = 6;
    world.bodies.angZ[wheel] = -6;
    let lowest = Infinity;
    let highest = -Infinity;
    for (let i = 0; i < 180; i++) {
      world.step(DT);
      const y = world.bodies.posY[wheel] ?? 0;
      if (y < lowest) lowest = y;
      if (y > highest) highest = y;
    }
    /* Well inside the solver's own five-millimetre slop, and a tenth of the prism's bob. */
    expect(highest - lowest).toBeLessThan(0.005);
    expect(highest).toBeGreaterThan(0.99);
    expect(lowest).toBeLessThan(1.001);
  });

  it('stands on its cap without tipping', () => {
    const world = new PhysicsWorld({ gravityY: -9.81, allowSleep: false });
    world.addBody({ type: BODY_STATIC, shape: boxShape(100, 1, 100), y: -1, friction: 1 });
    const b = world.addBody({
      type: BODY_DYNAMIC,
      shape: cylinderShape(0.5, 1),
      y: 2,
      density: 500,
    });
    for (let i = 0; i < 240; i++) world.step(DT);
    expect(world.bodies.posY[b] ?? 0).toBeGreaterThan(0.99);
    expect(world.bodies.posY[b] ?? 0).toBeLessThan(1.001);
    expect(Math.abs(world.bodies.rotX[b] ?? 0)).toBeLessThan(0.01);
    expect(Math.abs(world.bodies.rotZ[b] ?? 0)).toBeLessThan(0.01);
  });

  /**
   * A ray against a cylinder is a quadratic and two discs, so the answers are exact rather than
   * within the tolerance the capsule's march has to accept.
   */
  it('answers a ray exactly, on the side and on the cap', () => {
    const world = new PhysicsWorld();
    world.addBody({ type: BODY_STATIC, shape: cylinderShape(1, 2), y: 0 });
    const hit = createRayHit();

    expect(world.raycast(-5, 0, 0, 1, 0, 0, 10, hit)).toBe(true);
    expect(hit.fraction * 10).toBeCloseTo(4, 6);
    expect(hit.nx).toBeCloseTo(-1, 6);

    expect(world.raycast(0, 6, 0, 0, -1, 0, 10, hit)).toBe(true);
    expect(hit.fraction * 10).toBeCloseTo(4, 6);
    expect(hit.ny).toBeCloseTo(1, 6);

    /* Past the rim by a hair: a sphere of the same bound radius would have been hit. */
    expect(world.raycast(-5, 2.001, 1.001, 1, 0, 0, 10, hit)).toBe(false);
  });

  /**
   * Cloth meets a cylinder through the same four-region closest point the contacts use, so a
   * sheet draped over a barrel follows the curve rather than a facet.
   */
  it('drapes cloth over a barrel without letting it through', () => {
    const world = new PhysicsWorld({ gravityY: -9.81 });
    const q = Math.SQRT1_2;
    world.addBody({
      type: BODY_STATIC,
      shape: cylinderShape(1, 2),
      y: 0,
      qx: q,
      qy: 0,
      qz: 0,
      qw: q,
    });
    const grid = makeClothGrid(9, 9, 0.4);
    /* Centred over the barrel, a little above it. */
    for (let i = 0; i < grid.positions.length; i += 3) {
      grid.positions[i] = (grid.positions[i] ?? 0) - 1.6;
      grid.positions[i + 1] = 1.6;
      grid.positions[i + 2] = (grid.positions[i + 2] ?? 0) - 1.6;
    }
    const cloth = new ClothBody(grid.positions, grid.links, grid.bendLinks, { thickness: 0.05 });
    for (let i = 0; i < 240; i++) cloth.step(world, DT);
    for (let i = 0; i < cloth.count; i++) {
      const x = cloth.position[i * 3] ?? 0;
      const y = cloth.position[i * 3 + 1] ?? 0;
      const z = cloth.position[i * 3 + 2] ?? 0;
      /* The barrel's axis is z after the rotation, so a particle's distance from it is in xy. */
      if (Math.abs(z) > 2) continue;
      expect(Math.sqrt(x * x + y * y)).toBeGreaterThan(1.0);
    }
  });
});
