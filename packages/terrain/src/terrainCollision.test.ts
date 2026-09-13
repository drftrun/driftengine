import { describe, expect, test } from 'vitest';
import {
  BODY_STATIC,
  PhysicsWorld,
  createRayHit,
  heightfieldShape,
  meshShape,
} from '@driftengine/physics';

import { Terrain } from './heightfield.ts';
import { heightfieldPatch } from './heightfieldPatch.ts';

/**
 * Terrain collides today, and this is the assertion that says so rather than the prose that claims
 * it.
 *
 * **There is no terrain-shaped collider and there does not need to be one for terrain to collide.**
 * `heightfieldPatch` hands back `MeshData`, `meshShape` takes exactly those two arrays, and
 * `PhysicsWorld` takes a static body made from it — so the geometry a consumer draws is the
 * geometry a consumer collides with, with nothing authored twice and nothing to fall out of step.
 *
 * **What this file asserts is that the three surfaces are one surface.** The query answers where
 * the ground is, the mesh draws it there, and the solver stops a body there. Each pair of those has
 * a way of going quietly wrong — a query interpolated bilinearly against a mesh triangulated, a
 * collider built from a different patch than the one drawn — and the failures are of the kind
 * nothing raises: a character hovers, or sinks, by a few centimetres.
 *
 * **What does not exist is a heightfield-*specialised* collider**, which would index the cell under
 * a body straight from its x and z rather than walking a tree of triangles. That is a real saving
 * and it is measured below rather than asserted about; `docs/IMPROVEMENTS.md` carries the price.
 */

/**
 * A field with a **cross term**, and that is the load-bearing part of it.
 *
 * A field of the form `f(x) + g(z)` is separable, and for a separable field a bilinear patch and
 * the two triangles that span it are the same surface — so a test comparing a query against a mesh
 * over one passes whichever interpolation the query uses. Measured: with `sin(x) + cos(z)` alone,
 * making `heightAt` bilinear turned nothing in this file red.
 */
function ridges(size: number): Terrain {
  return new Terrain({
    width: size,
    depth: size,
    spacingM: 1,
    heights: Float32Array.from({ length: size * size }, (_, i) => {
      const x = i % size;
      const z = Math.floor(i / size);
      return (
        Math.sin(x * 0.5) * 1.4 + Math.cos(z * 0.7) * 0.8 + Math.sin(x * 0.35 + z * 0.45) * 0.9
      );
    }),
    origin: [-8, 0, -8],
  });
}

describe('the ground a body stands on', () => {
  test('is the ground the query answers, everywhere a ray can find it', () => {
    /*
     * **The whole claim, and it is asserted over the patch rather than at a point.** A ray dropped
     * from above lands on the triangle the mesh drew; `heightAt` reads the triangle the query
     * believes in. They are the same triangulation or a character hovers over half of every cell —
     * which is the defect `heightfield.ts` exists to prevent, arriving through physics this time.
     */
    const terrain = ridges(17);
    const patch = heightfieldPatch(terrain, { x: 0, z: 0, cells: 16 });
    const world = new PhysicsWorld();
    world.addBody({ type: BODY_STATIC, shape: meshShape(patch.positions, patch.indices) });

    const hit = createRayHit();
    let checked = 0;
    for (let i = 0; i < 40; i++) {
      /* Points deliberately off the lattice, since a query that only agreed at the samples would
         agree with a bilinear surface too. */
      const x = -7.5 + (i % 8) * 1.9 + 0.37;
      const z = -7.5 + Math.floor(i / 8) * 1.9 + 0.61;
      if (!world.raycast(x, 40, z, 0, -1, 0, 100, hit)) continue;
      expect(hit.y).toBeCloseTo(terrain.heightAt(x, z), 3);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(20);
  });

  test('follows the picture when the picture is coarse, rather than the field', () => {
    /*
     * A patch drawn at a quarter detail collides at a quarter detail, because the collider is that
     * patch. That is the *right* answer and the one worth pinning: a consumer who collides against
     * the field while drawing a coarse patch gets a character walking through the ground it can
     * see, which is the worse of the two disagreements.
     */
    const terrain = ridges(17);
    const coarse = heightfieldPatch(terrain, { x: 0, z: 0, cells: 16, step: 4 });
    const world = new PhysicsWorld();
    world.addBody({ type: BODY_STATIC, shape: meshShape(coarse.positions, coarse.indices) });

    const hit = createRayHit();
    /* Mid-cell of a coarse quad, where the chord sits below the field. */
    const x = -6.1;
    const z = -5.9;
    expect(world.raycast(x, 40, z, 0, -1, 0, 100, hit)).toBe(true);

    /* The drawn surface at that point, read off the mesh the collider was made from. */
    const drawn = heightAtOf(coarse, x, z);
    expect(hit.y).toBeCloseTo(drawn, 3);
    /* And it is genuinely below the field, so this is not the same assertion twice. */
    expect(drawn).toBeLessThan(terrain.heightAt(x, z) - 0.01);
  });
});

describe('what a heightfield collider would save', () => {
  test('the triangles a field costs as a mesh, against the heights it is', () => {
    /*
     * **Measured rather than estimated**, and recorded here so the entry in `IMPROVEMENTS.md` is
     * not prose. A mesh collider carries a vertex buffer, an index buffer and a tree over them; a
     * heightfield collider would carry the heights and index the cell under a body directly.
     */
    const size = 129;
    const terrain = ridges(size);
    const patch = heightfieldPatch(terrain, { x: 0, z: 0, cells: size - 1 });
    const asMesh = patch.positions.byteLength + patch.indices.byteLength;
    const asField = terrain.heights.byteLength;

    /* Six times, near enough, before the tree `meshShape` builds over the triangles is counted. */
    expect(asMesh / asField).toBeGreaterThan(5);
  });
});

/** The height of a drawn mesh at a point, by finding the triangle under it. Test-only. */
function heightAtOf(
  mesh: { positions: Float32Array; indices: Uint32Array },
  x: number,
  z: number,
): number {
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const a = (mesh.indices[i] ?? 0) * 3;
    const b = (mesh.indices[i + 1] ?? 0) * 3;
    const c = (mesh.indices[i + 2] ?? 0) * 3;
    const ax = mesh.positions[a] ?? 0;
    const az = mesh.positions[a + 2] ?? 0;
    const bx = mesh.positions[b] ?? 0;
    const bz = mesh.positions[b + 2] ?? 0;
    const cx = mesh.positions[c] ?? 0;
    const cz = mesh.positions[c + 2] ?? 0;
    const area = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(area) < 1e-12) continue;
    const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / area;
    const v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / area;
    const w = 1 - u - v;
    if (u < -1e-6 || v < -1e-6 || w < -1e-6) continue;
    return (
      u * (mesh.positions[a + 1] ?? 0) +
      v * (mesh.positions[b + 1] ?? 0) +
      w * (mesh.positions[c + 1] ?? 0)
    );
  }
  throw new Error(`no triangle under ${x}, ${z}`);
}

describe('the heightfield collider, against the mesh the picture is made of', () => {
  /**
   * **The guard on a rule that exists in two packages.**
   *
   * `@driftengine/physics` imports no other engine package, so it cannot see `Terrain` and the
   * triangulation — split along `a`-`c`, halves `a, d, c` and `a, c, b` — is written out in both
   * `heightfieldPatch.ts` and `heightfieldShape.ts`. Two copies of a rule is exactly what this
   * track already paid for once, when a mesh was split one way and its query read the other, so
   * the copies are asserted equal here rather than trusted.
   *
   * This is the same arrangement `glDepthFunc` has with `DEPTH_COMPARE` in the renderer, and for
   * the same reason: a boundary that forbids sharing the code does not forbid sharing a test.
   */
  test('is the same surface, ray for ray', () => {
    const terrain = ridges(17);
    const patch = heightfieldPatch(terrain, { x: 0, z: 0, cells: 16 });

    const drawn = new PhysicsWorld();
    drawn.addBody({ type: BODY_STATIC, shape: meshShape(patch.positions, patch.indices) });
    const generated = new PhysicsWorld();
    /* A `Terrain` *is* a `Heightfield`: same names, same meanings, no import in either direction. */
    generated.addBody({ type: BODY_STATIC, shape: heightfieldShape(terrain) });

    const a = createRayHit();
    const b = createRayHit();
    let checked = 0;
    for (let i = 0; i < 60; i++) {
      const x = -7.6 + (i % 10) * 1.53 + 0.31;
      const z = -7.6 + Math.floor(i / 10) * 2.4 + 0.47;
      const hitDrawn = drawn.raycast(x, 40, z, 0, -1, 0, 100, a);
      const hitField = generated.raycast(x, 40, z, 0, -1, 0, 100, b);
      expect(hitField).toBe(hitDrawn);
      if (!hitDrawn) continue;
      expect(b.y).toBeCloseTo(a.y, 4);
      expect(b.ny).toBeCloseTo(a.ny, 4);
      expect(b.nx).toBeCloseTo(a.nx, 4);
      expect(b.nz).toBeCloseTo(a.nz, 4);
      /* And it is the ground the *query* answers, which is the whole chain closed. */
      expect(b.y).toBeCloseTo(terrain.heightAt(x, z), 3);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(40);
  });

  test('and it holds the field rather than a copy of the triangles', () => {
    const terrain = ridges(65);
    const shape = heightfieldShape(terrain);

    expect(shape.triangles?.positions.byteLength).toBe(0);
    expect(shape.triangles?.indices.byteLength).toBe(0);
    expect(shape.triangles?.tree).toBe(null);
    /* Two triangles per cell, over a field one sample wider than its cells each way. */
    expect(shape.triangles?.triangleCount).toBe(64 * 64 * 2);
  });
});
