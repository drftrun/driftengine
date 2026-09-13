import { describe, expect, it } from 'vitest';
import { BODY_DYNAMIC, BODY_STATIC } from './bodies.ts';
import { createRayHit } from './query.ts';
import { boxShape, capsuleShape, hullShape, sphereShape } from './shape.ts';
import { PhysicsWorld } from './world.ts';

const at = (x: number, y: number, z: number) => ({ x, y, z, qx: 0, qy: 0, qz: 0, qw: 1 });
const hit = createRayHit();

/** Three boxes in a row along x, at 0, 5 and 10. */
function row(): PhysicsWorld {
  const world = new PhysicsWorld({ gravityY: 0 });
  for (let i = 0; i < 3; i++) {
    world.addBody({ type: BODY_STATIC, shape: boxShape(1, 1, 1), x: i * 5 });
  }
  return world;
}

describe('raycast', () => {
  it('finds the nearest of three boxes', () => {
    const world = row();
    expect(world.raycast(-10, 0, 0, 1, 0, 0, 100, hit)).toBe(true);
    expect(hit.body).toBe(0);
    expect(hit.x).toBeCloseTo(-1, 4);
  });

  it('reports the face normal it entered through', () => {
    const world = row();
    world.raycast(-10, 0, 0, 1, 0, 0, 100, hit);
    expect(hit.nx).toBeCloseTo(-1, 4);
    expect(hit.ny).toBeCloseTo(0, 4);
  });

  it('reports the fraction along the ray', () => {
    const world = row();
    world.raycast(-10, 0, 0, 1, 0, 0, 100, hit);
    expect(hit.fraction).toBeCloseTo(9 / 100, 4);
  });

  it('misses when nothing is in the way', () => {
    const world = row();
    expect(world.raycast(-10, 50, 0, 1, 0, 0, 100, hit)).toBe(false);
    expect(hit.body).toBe(-1);
  });

  it('stops at its maximum distance', () => {
    const world = row();
    expect(world.raycast(-10, 0, 0, 1, 0, 0, 5, hit)).toBe(false);
  });

  it('finds the far box when the near ones are excluded by layer', () => {
    const world = new PhysicsWorld({ gravityY: 0 });
    world.addBody({ type: BODY_STATIC, shape: boxShape(1, 1, 1), x: 0, layer: 1 });
    world.addBody({ type: BODY_STATIC, shape: boxShape(1, 1, 1), x: 5, layer: 2 });
    expect(world.raycast(-10, 0, 0, 1, 0, 0, 100, hit, { mask: 2 })).toBe(true);
    expect(hit.body).toBe(1);
  });

  it('ignores the body that asked', () => {
    const world = row();
    expect(world.raycast(-10, 0, 0, 1, 0, 0, 100, hit, { ignore: 0 })).toBe(true);
    expect(hit.body).toBe(1);
  });

  /**
   * A ray starting inside a body reports that body at zero, not nothing. Reporting nothing is the
   * tempting alternative and is worse: a line-of-sight test would say a wall it started inside was
   * not there.
   */
  it('reports the body it started inside, at fraction zero', () => {
    const world = row();
    expect(world.raycast(0, 0, 0, 1, 0, 0, 100, hit)).toBe(true);
    expect(hit.body).toBe(0);
    expect(hit.fraction).toBeCloseTo(0, 6);
    expect(Number.isFinite(hit.nx)).toBe(true);
  });

  it('finds a sphere', () => {
    const world = new PhysicsWorld({ gravityY: 0 });
    world.addBody({ type: BODY_STATIC, shape: sphereShape(1), x: 5 });
    expect(world.raycast(0, 0, 0, 1, 0, 0, 100, hit)).toBe(true);
    expect(hit.x).toBeCloseTo(4, 2);
    expect(hit.nx).toBeCloseTo(-1, 2);
  });

  it('finds a capsule on its side', () => {
    const world = new PhysicsWorld({ gravityY: 0 });
    world.addBody({
      type: BODY_STATIC,
      shape: capsuleShape(0.5, 2),
      y: 5,
      qz: Math.SQRT1_2,
      qw: Math.SQRT1_2,
    });
    expect(world.raycast(0, 0, 0, 0, 1, 0, 100, hit)).toBe(true);
    expect(hit.y).toBeCloseTo(4.5, 2);
  });

  it('answers the same on a world built in the opposite order', () => {
    const forward = row();
    const reversed = new PhysicsWorld({ gravityY: 0 });
    for (let i = 2; i >= 0; i--) {
      reversed.addBody({ type: BODY_STATIC, shape: boxShape(1, 1, 1), x: i * 5 });
    }
    forward.raycast(-10, 0, 0, 1, 0, 0, 100, hit);
    const forwardX = hit.x;
    reversed.raycast(-10, 0, 0, 1, 0, 0, 100, hit);
    expect(hit.x).toBeCloseTo(forwardX, 6);
  });

  /**
   * Eight identical boxes, not two.
   *
   * With two, a comparison of `<=` instead of `<` still happened to answer body 0, because the tree
   * gave them in index order — so the perturbation passed and the test proved nothing. Eight boxes
   * in a balanced tree are not enumerated in index order, so only an explicit tie-break by index
   * answers 0 every time.
   */
  /**
   * A stable answer across tree shapes, which is the property; the tie-break is not testable here.
   *
   * Two distinct bodies can only sit at the *identical* ray distance if they are coincident, and
   * the tree has never been observed to enumerate coincident proxies out of index order — so
   * replacing the explicit tie-break with a bare `<=` passes this and every variation of it tried:
   * two boxes, eight boxes, and six different tree shapes. The tie-break stays because it is one
   * comparison and it makes the guarantee true by construction rather than by observation, and this
   * comment is here so the next reader does not go looking for the test that pins it.
   */
  it('answers the same whatever shape the tree happens to have', () => {
    const answer = (decoys: number): number => {
      const world = new PhysicsWorld({ gravityY: 0 });
      for (let i = 0; i < 8; i++) {
        world.addBody({ type: BODY_STATIC, shape: boxShape(1, 1, 1), x: 5 });
      }
      for (let i = 0; i < decoys; i++) {
        world.addBody({ type: BODY_STATIC, shape: boxShape(1, 1, 1), x: 500 + i * 7, y: i * 3 });
      }
      world.raycast(-10, 0, 0, 1, 0, 0, 100, hit);
      return hit.body;
    };
    const shapes = [0, 1, 3, 7, 15, 31].map(answer);
    expect(new Set(shapes).size).toBe(1);
  });

  /**
   * A shape with faces *and* a rounding radius, which nothing else here has.
   *
   * A box's radius is zero and a sphere takes the segment path, so dropping the radius term from
   * the slab test changed no result at all. A rounded hull is the only shape that reaches it.
   */
  it("stops at a rounded hull's rounded surface, not at its planes", () => {
    const world = new PhysicsWorld({ gravityY: 0 });
    const corners: number[] = [];
    for (let i = 0; i < 8; i++) {
      corners.push(5 + (i & 1 ? 1 : -1), i & 2 ? 1 : -1, i & 4 ? 1 : -1);
    }
    world.addBody({ type: BODY_STATIC, shape: hullShape(corners, 0.3) });
    expect(world.raycast(-10, 0, 0, 1, 0, 0, 100, hit)).toBe(true);
    // The hull's face is at x = 4; the rounding puts the surface at 3.7.
    expect(hit.x).toBeCloseTo(3.7, 3);
  });
});

describe('overlap', () => {
  it('reports every body in a region and no more', () => {
    const world = row();
    const out = new Int32Array(8);
    expect(world.overlap(boxShape(3, 1, 1), at(2.5, 0, 0), out)).toBe(2);
    expect([...out.slice(0, 2)]).toEqual([0, 1]);
  });

  it('reports nothing where there is nothing', () => {
    const world = row();
    expect(world.overlap(boxShape(1, 1, 1), at(0, 50, 0), new Int32Array(8))).toBe(0);
  });

  it('respects the layer mask', () => {
    const world = new PhysicsWorld({ gravityY: 0 });
    world.addBody({ type: BODY_STATIC, shape: boxShape(1, 1, 1), layer: 1 });
    world.addBody({ type: BODY_STATIC, shape: boxShape(1, 1, 1), x: 1, layer: 2 });
    const out = new Int32Array(8);
    expect(world.overlap(boxShape(2, 1, 1), at(0.5, 0, 0), out, { mask: 2 })).toBe(1);
    expect(out[0]).toBe(1);
  });

  it('fills a small buffer without overrunning it', () => {
    const world = row();
    const out = new Int32Array(1);
    expect(world.overlap(boxShape(20, 1, 1), at(5, 0, 0), out)).toBe(1);
  });

  it('finds a sphere overlapping a box', () => {
    const world = row();
    const out = new Int32Array(8);
    expect(world.overlap(sphereShape(0.6), at(1.5, 0, 0), out)).toBe(1);
    expect(out[0]).toBe(0);
  });

  it('reports in ascending body index', () => {
    const world = row();
    const out = new Int32Array(8);
    const n = world.overlap(boxShape(20, 1, 1), at(5, 0, 0), out);
    for (let i = 1; i < n; i++) expect(out[i] ?? 0).toBeGreaterThan(out[i - 1] ?? 0);
  });
});

describe('shapecast', () => {
  it('stops at the first body in the way', () => {
    const world = row();
    expect(world.shapecast(sphereShape(0.5), at(-10, 0, 0), 30, 0, 0, hit)).toBe(true);
    expect(hit.body).toBe(0);
    expect(hit.x).toBeLessThan(-1.4);
    expect(hit.x).toBeGreaterThan(-1.7);
  });

  /** The surface normal, out of the body toward the sweeper — the same convention a ray answers in. */
  it('reports the surface normal, not the direction of travel', () => {
    const world = row();
    world.shapecast(sphereShape(0.5), at(-10, 0, 0), 30, 0, 0, hit);
    expect(hit.nx).toBeCloseTo(-1, 1);
  });

  it('agrees with a ray about which way a surface faces', () => {
    const world = row();
    const ray = createRayHit();
    world.raycast(-10, 0, 0, 1, 0, 0, 100, ray);
    world.shapecast(sphereShape(0.5), at(-10, 0, 0), 30, 0, 0, hit);
    expect(Math.sign(hit.nx)).toBe(Math.sign(ray.nx));
  });

  it('does not report a surface the sweep is only travelling along', () => {
    const world = new PhysicsWorld({ gravityY: 0 });
    world.addBody({ type: BODY_STATIC, shape: boxShape(20, 1, 20), y: -1 });
    // A sphere resting exactly on the floor, swept sideways along it.
    expect(world.shapecast(sphereShape(0.5), at(0, 0.5, 0), 5, 0, 0, hit)).toBe(false);
  });

  it('finds nothing on a clear sweep', () => {
    const world = row();
    expect(world.shapecast(sphereShape(0.5), at(-10, 50, 0), 30, 0, 0, hit)).toBe(false);
  });

  it('sweeps a box, not only a sphere', () => {
    const world = row();
    expect(world.shapecast(boxShape(0.4, 0.4, 0.4), at(0, 20, 0), 0, -30, 0, hit)).toBe(true);
    expect(hit.body).toBe(0);
    expect(hit.y).toBeCloseTo(1.4, 1);
  });

  it('respects the layer mask', () => {
    const world = new PhysicsWorld({ gravityY: 0 });
    world.addBody({ type: BODY_STATIC, shape: boxShape(1, 1, 1), x: 0, layer: 1 });
    world.addBody({ type: BODY_STATIC, shape: boxShape(1, 1, 1), x: 5, layer: 2 });
    expect(world.shapecast(sphereShape(0.5), at(-10, 0, 0), 30, 0, 0, hit, { mask: 2 })).toBe(true);
    expect(hit.body).toBe(1);
  });
});

describe('queries see moving bodies', () => {
  it('finds a body where it is now, not where it started', () => {
    const world = new PhysicsWorld();
    world.addBody({ type: BODY_STATIC, shape: boxShape(50, 1, 50), y: -1 });
    world.addBody({ type: BODY_DYNAMIC, shape: sphereShape(0.5), y: 10, density: 400 });
    for (let i = 0; i < 120; i++) world.step(1 / 60);
    expect(world.raycast(0, 20, 0, 0, -1, 0, 100, hit)).toBe(true);
    expect(hit.body).toBe(1);
    expect(hit.y).toBeLessThan(2);
  });
});
