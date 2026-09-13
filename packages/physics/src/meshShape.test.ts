import { describe, expect, it } from 'vitest';
import { BODY_DYNAMIC, BODY_KINEMATIC, BODY_STATIC } from './bodies.ts';
import { colliderFromShape } from './colliderSet.ts';
import { createMassProperties, shapeMassProperties } from './mass.ts';
import { meshShape } from './meshShape.ts';
import { boxShape, cylinderShape, sphereShape } from './shape.ts';
import { createRayHit } from './query.ts';
import { PhysicsWorld } from './world.ts';

/**
 * A static triangle mesh as a collision shape.
 *
 * The three things worth testing here are the three that are not a picture: that the limit is
 * enforced rather than documented, that a body rests on a mesh where the arithmetic says it should,
 * and — the one that decides whether it feels right — that a box slid across a seam between two
 * coplanar triangles does not catch on it.
 */
const DT = 1 / 60;

/** A flat floor as `n` by `n` quads, so a slide crosses many seams rather than one. */
function grid(n: number, size: number, y = 0): { positions: Float32Array; indices: Uint32Array } {
  const positions = new Float32Array((n + 1) * (n + 1) * 3);
  for (let r = 0; r <= n; r++) {
    for (let c = 0; c <= n; c++) {
      const i = r * (n + 1) + c;
      positions[i * 3] = (c / n - 0.5) * size;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = (r / n - 0.5) * size;
    }
  }
  const indices: number[] = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const a = r * (n + 1) + c;
      const b = a + 1;
      const d = a + (n + 1);
      const e = d + 1;
      /* Counter-clockwise seen from above, so the outward normal is +y. */
      indices.push(a, d, b, b, d, e);
    }
  }
  return { positions, indices: Uint32Array.from(indices) };
}

/** A V-shaped valley: two ramps meeting in a concave seam, which no convex hull can be. */
function valley(): { positions: Float32Array; indices: Uint32Array } {
  const positions = new Float32Array([-4, 2, -4, 0, 0, -4, 4, 2, -4, -4, 2, 4, 0, 0, 4, 4, 2, 4]);
  const indices = Uint32Array.from([0, 3, 1, 1, 3, 4, 1, 4, 2, 2, 4, 5]);
  return { positions, indices };
}

describe('a triangle mesh as a shape', () => {
  it('bounds itself by its own extent, with no separating axes of its own', () => {
    const { positions, indices } = grid(2, 10);
    const shape = meshShape(positions, indices);
    expect(shape.triangles?.triangleCount).toBe(8);
    /* Eight corners, so `shapeBounds` and the broad phase need no special case. */
    expect(shape.vertices.length).toBe(24);
    /* And nothing that would let the kinematic sweep mistake a hollow level for a brick. */
    expect(shape.faceNormals.length).toBe(0);
    expect(shape.edgeDirs.length).toBe(0);
  });

  it('has no mass properties, because a surface encloses nothing', () => {
    const { positions, indices } = grid(1, 4);
    const m = shapeMassProperties(meshShape(positions, indices), 1000, createMassProperties());
    expect(m.volume).toBe(0);
    expect(m.ixx).toBe(0);
  });

  it('refuses an index count that is not whole triangles', () => {
    expect(() => meshShape(new Float32Array(9), Uint32Array.from([0, 1]))).toThrow(/triangles/);
    expect(() => meshShape(new Float32Array(9), new Uint32Array(0))).toThrow(/triangles/);
  });

  /**
   * The static-only limit, **enforced rather than documented**.
   *
   * A moving concave mesh needs its tree refitted every tick and a mass tensor a triangle soup does
   * not have. Refused at `addBody`, because a body with no volume and no inertia falls through the
   * world rather than reporting anything.
   */
  it('may only be static, and says so rather than falling through the world', () => {
    const world = new PhysicsWorld();
    const { positions, indices } = grid(1, 4);
    const shape = meshShape(positions, indices);
    expect(() => world.addBody({ type: BODY_DYNAMIC, shape })).toThrow(/static/);
    expect(() => world.addBody({ type: BODY_KINEMATIC, shape })).toThrow(/static/);
    expect(() => world.addBody({ type: BODY_STATIC, shape })).not.toThrow();
  });

  /** And it is not a kinematic collider, which would arrive as its own bounding box. */
  it('is refused by the collider set rather than bounded into a solid brick', () => {
    const { positions, indices } = grid(1, 4);
    expect(() => colliderFromShape(meshShape(positions, indices))).toThrow(/mesh/);
  });
});

describe('a body resting on a mesh', () => {
  function rest(shape: ReturnType<typeof boxShape>, dropFrom: number, ticks = 180): number {
    const world = new PhysicsWorld({ gravityY: -9.81, allowSleep: false });
    const { positions, indices } = grid(4, 20);
    world.addBody({ type: BODY_STATIC, shape: meshShape(positions, indices), friction: 1 });
    const body = world.addBody({
      type: BODY_DYNAMIC,
      shape,
      y: dropFrom,
      density: 500,
      friction: 1,
    });
    for (let i = 0; i < ticks; i++) world.step(DT);
    return world.bodies.posY[body] ?? 0;
  }

  it('holds a box up at its own half-height', () => {
    /* The floor is at y = 0 and the box is 0.5 tall, so it rests at 0.5 less the solver's slop. */
    expect(rest(boxShape(0.5, 0.5, 0.5), 2)).toBeGreaterThan(0.49);
    expect(rest(boxShape(0.5, 0.5, 0.5), 2)).toBeLessThan(0.501);
  });

  it('holds a sphere and a cylinder up too, through the same three narrow-phase cases', () => {
    expect(rest(sphereShape(0.4), 2)).toBeCloseTo(0.4, 2);
    expect(rest(cylinderShape(0.5, 0.6), 2)).toBeCloseTo(0.6, 2);
  });

  /**
   * **A concave shape, which is the whole point of the row.**
   *
   * The valley's two ramps meet in a seam no convex hull contains: a hull over the same six points
   * would be a wedge with a flat lid, and a ball dropped into it would rest on that lid at y = 2
   * rather than sliding to the bottom at y = 0.
   */
  it('lets a ball settle in a concave valley rather than on a hull over it', () => {
    const world = new PhysicsWorld({ gravityY: -9.81, allowSleep: false });
    const { positions, indices } = valley();
    world.addBody({ type: BODY_STATIC, shape: meshShape(positions, indices), friction: 0.2 });
    const ball = world.addBody({
      type: BODY_DYNAMIC,
      shape: sphereShape(0.3),
      x: 2,
      y: 4,
      density: 500,
      friction: 0.2,
    });
    for (let i = 0; i < 400; i++) world.step(DT);
    /* At the bottom of the V, not on a lid at the top of it. */
    expect(Math.abs(world.bodies.posX[ball] ?? 0), 'rolled to the seam').toBeLessThan(0.6);
    expect(world.bodies.posY[ball] ?? 0, 'and down to it').toBeLessThan(1);
  });
});

/**
 * **The interior-edge filter, which is what decides whether a mesh floor feels like a floor.**
 *
 * A box sliding across two coplanar triangles meets their shared edge, and without the filter the
 * narrow phase finds an edge normal there and shoves the box backwards along it — a character
 * stumbling on a flat floor once a metre. The measurement is how much of its speed a sliding box
 * keeps: friction takes some of it either way, and catching on a seam takes far more.
 */
describe('sliding across a seam', () => {
  function slide(): { kept: number; lifted: number } {
    const world = new PhysicsWorld({ gravityY: -9.81, allowSleep: false });
    /* Sixteen quads across twenty metres, so a slide at 6 m/s crosses a seam every fifth of a
       second and there is no chance of it settling between two of them. */
    const { positions, indices } = grid(16, 20);
    world.addBody({ type: BODY_STATIC, shape: meshShape(positions, indices), friction: 0.05 });
    const box = world.addBody({
      type: BODY_DYNAMIC,
      shape: boxShape(0.4, 0.2, 0.4),
      x: -6,
      y: 0.2,
      density: 500,
      friction: 0.05,
    });
    for (let i = 0; i < 60; i++) world.step(DT);
    world.bodies.velX[box] = 6;
    let highest = -Infinity;
    for (let i = 0; i < 120; i++) {
      world.step(DT);
      highest = Math.max(highest, world.bodies.posY[box] ?? 0);
    }
    return { kept: (world.bodies.velX[box] ?? 0) / 6, lifted: highest - 0.2 };
  }

  it('keeps its speed and stays down, rather than tripping on every edge', () => {
    const { kept, lifted } = slide();
    /* Friction at 0.05 over two seconds costs a few per cent; catching on a seam costs most of it. */
    expect(kept, 'most of its speed survived').toBeGreaterThan(0.8);
    /* And it did not hop: an edge normal points up and along, so a trip shows as a lift. */
    expect(lifted, 'and it never left the floor').toBeLessThan(0.01);
  });
});

/**
 * A ray against a mesh, which is what a line-of-sight test is made of.
 *
 * Two-sided, unlike the contact path: a ray is a question about geometry rather than a body being
 * pushed, and a sight line that saw through a wall from behind would be a worse answer than one
 * that did not.
 */
describe('a ray against a mesh', () => {
  function world(): PhysicsWorld {
    const w = new PhysicsWorld();
    const { positions, indices } = grid(4, 20, 1.5);
    w.addBody({ type: BODY_STATIC, shape: meshShape(positions, indices) });
    return w;
  }

  it('hits the floor at the distance the arithmetic says, with the face normal', () => {
    const hit = createRayHit();
    /* Straight down from 5 m at a floor at 1.5: three and a half metres. */
    expect(world().raycast(0, 5, 0, 0, -1, 0, 10, hit)).toBe(true);
    expect(hit.fraction * 10).toBeCloseTo(3.5, 5);
    expect(hit.ny).toBeCloseTo(1, 6);
    expect(hit.y).toBeCloseTo(1.5, 5);
  });

  it('reports the side it was hit on when the ray comes from below', () => {
    const hit = createRayHit();
    expect(world().raycast(0, -1, 0, 0, 1, 0, 10, hit)).toBe(true);
    expect(hit.fraction * 10).toBeCloseTo(2.5, 5);
    /* Turned to face the ray, so a caller reflecting off it does not reflect into the surface. */
    expect(hit.ny).toBeCloseTo(-1, 6);
  });

  it('misses past the edge of the mesh rather than hitting its bounding box', () => {
    const hit = createRayHit();
    /* The floor spans twenty metres; this is fifteen out, inside the bounds and off the geometry. */
    expect(world().raycast(15, 5, 0, 0, -1, 0, 10, hit)).toBe(false);
  });

  it('finds the nearest of two surfaces rather than the first the tree returned', () => {
    const w = new PhysicsWorld();
    const low = grid(2, 20, 0);
    const high = grid(2, 20, 3);
    /* The higher one added second, so tree order and depth order disagree. */
    w.addBody({ type: BODY_STATIC, shape: meshShape(low.positions, low.indices) });
    w.addBody({ type: BODY_STATIC, shape: meshShape(high.positions, high.indices) });
    const hit = createRayHit();
    expect(w.raycast(0, 8, 0, 0, -1, 0, 20, hit)).toBe(true);
    expect(hit.y, 'the one it met first').toBeCloseTo(3, 5);
  });
});
