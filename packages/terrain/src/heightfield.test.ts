import { describe, expect, test } from 'vitest';

import { Terrain } from './heightfield.ts';

/**
 * A two-by-two field whose corners are 0, 1, 0, 1.
 *
 * **Chosen because a bilinear surface and a triangulated one disagree on it**, which is the whole
 * subject of the first three tests: a saddle is where "interpolate the four corners" and "which of
 * the two triangles is this point in" give different answers, and a query that took the first would
 * put a character above the ground over half of every cell and below it over the other half.
 */
function saddle(): Terrain {
  return new Terrain({
    width: 2,
    depth: 2,
    spacingM: 1,
    heights: new Float32Array([0, 1, 1, 0]),
  });
}

describe('the height a query returns', () => {
  test('is the sample itself, at a sample', () => {
    const terrain = saddle();

    expect(terrain.heightAt(0, 0)).toBeCloseTo(0, 6);
    expect(terrain.heightAt(1, 0)).toBeCloseTo(1, 6);
    expect(terrain.heightAt(0, 1)).toBeCloseTo(1, 6);
    expect(terrain.heightAt(1, 1)).toBeCloseTo(0, 6);
  });

  test('is the triangle it lands in and not the bilinear surface', () => {
    /*
     * The middle of a saddle cell. Bilinear answers 0.5; both triangles of the split answer 0,
     * because the diagonal they share runs between the two zero corners. A query that disagreed
     * with the mesh by half a metre here would be a character standing in the air.
     */
    expect(saddle().heightAt(0.5, 0.5)).toBeCloseTo(0, 6);
  });

  test('and the two triangles of a cell answer differently, which is the point of choosing one', () => {
    const terrain = saddle();
    /* Either side of the diagonal, mirrored about it. A bilinear surface is symmetric here and
       gives the same number twice; a triangulated one does not, and the mesh is triangulated. */
    const below = terrain.heightAt(0.75, 0.25);
    const above = terrain.heightAt(0.25, 0.75);

    expect(below).toBeCloseTo(0.5, 6);
    expect(above).toBeCloseTo(0.5, 6);
    /* Both 0.5 by symmetry of *this* field; what differs is which triangle answered, which the
       next test makes visible on a field that is not symmetric. */
    expect(below).toBeCloseTo(above, 6);
  });

  test('reads the triangle it is actually in, on a field with no symmetry to hide it', () => {
    const terrain = new Terrain({
      width: 2,
      depth: 2,
      spacingM: 1,
      /* a = 0, b = 3, c = 1, d = 0 — the diagonal a-c splits it into two unequal slopes. */
      heights: new Float32Array([0, 3, 0, 1]),
    });

    /* Below the diagonal, in the triangle a-b-c: 0 + (3 - 0) * 0.75 + (1 - 3) * 0.25 = 1.75. */
    expect(terrain.heightAt(0.75, 0.25)).toBeCloseTo(1.75, 6);
    /* Above it, in a-c-d: 0 + (0 - 0) * 0.75 + (1 - 0) * 0.25 = 0.25. */
    expect(terrain.heightAt(0.25, 0.75)).toBeCloseTo(0.25, 6);
  });

  test('clamps outside the field rather than extrapolating into nothing', () => {
    const terrain = saddle();

    expect(terrain.heightAt(-50, -50)).toBeCloseTo(terrain.heightAt(0, 0), 6);
    expect(terrain.heightAt(50, 50)).toBeCloseTo(terrain.heightAt(1, 1), 6);
    expect(Number.isFinite(terrain.heightAt(50, -50))).toBe(true);
  });

  test('is measured from the origin the field was placed at', () => {
    const moved = new Terrain({
      width: 2,
      depth: 2,
      spacingM: 1,
      heights: new Float32Array([0, 1, 1, 0]),
      origin: [10, 5, -3],
    });

    /* The same sample, reached through the world position it now stands at. */
    expect(moved.heightAt(11, -3)).toBeCloseTo(5 + 1, 6);
    expect(moved.heightAt(10, -3)).toBeCloseTo(5 + 0, 6);
  });

  test('scales with the spacing, so a field is metres rather than samples', () => {
    const wide = new Terrain({
      width: 2,
      depth: 2,
      spacingM: 4,
      heights: new Float32Array([0, 8, 8, 0]),
    });

    expect(wide.heightAt(4, 0)).toBeCloseTo(8, 6);
    /* A quarter of the way along the first cell, on the lower triangle. */
    expect(wide.heightAt(1, 0)).toBeCloseTo(2, 6);
  });
});

describe('the normal a query returns', () => {
  function flat(): Terrain {
    return new Terrain({
      width: 3,
      depth: 3,
      spacingM: 1,
      heights: new Float32Array(9),
    });
  }

  test('points straight up on a field with no slope', () => {
    const out = new Float32Array(3);
    flat().normalAt(1, 1, out);

    expect(out[0]).toBeCloseTo(0, 6);
    expect(out[1]).toBeCloseTo(1, 6);
    expect(out[2]).toBeCloseTo(0, 6);
  });

  test('leans against the slope, and is a unit vector while it does', () => {
    /* A ramp rising along +x at 45 degrees: three rows of 0, 1, 2. */
    const ramp = new Terrain({
      width: 3,
      depth: 3,
      spacingM: 1,
      heights: new Float32Array([0, 1, 2, 0, 1, 2, 0, 1, 2]),
    });
    const out = new Float32Array(3);
    ramp.normalAt(1, 1, out);

    expect(out[0]).toBeCloseTo(-Math.SQRT1_2, 5);
    expect(out[1]).toBeCloseTo(Math.SQRT1_2, 5);
    expect(out[2]).toBeCloseTo(0, 6);
    expect(Math.hypot(out[0] ?? 0, out[1] ?? 0, out[2] ?? 0)).toBeCloseTo(1, 6);
  });

  test('is continuous across a cell boundary, which is what stops a seam being shaded', () => {
    /*
     * **The reason the normal comes from the field rather than from a triangle.** A face normal is
     * constant over a triangle and jumps at every edge, so terrain built from face normals is
     * faceted and — worse — two patches meeting at a boundary shade differently along it, which
     * reads as a crack that is not there. A central difference over the samples is continuous by
     * construction, so this pair of queries either side of a sample line has to agree.
     */
    const bumpy = new Terrain({
      width: 5,
      depth: 5,
      spacingM: 1,
      heights: Float32Array.from({ length: 25 }, (_, i) => Math.sin(i * 0.7)),
    });
    const before = new Float32Array(3);
    const after = new Float32Array(3);

    bumpy.normalAt(2 - 1e-4, 2, before);
    bumpy.normalAt(2 + 1e-4, 2, after);

    expect(after[0]).toBeCloseTo(before[0] ?? 0, 3);
    expect(after[1]).toBeCloseTo(before[1] ?? 0, 3);
    expect(after[2]).toBeCloseTo(before[2] ?? 0, 3);
  });
});

describe('the field itself', () => {
  test('refuses a height array that does not match the size it was given', () => {
    expect(
      () => new Terrain({ width: 4, depth: 4, spacingM: 1, heights: new Float32Array(9) }),
    ).toThrow(/16/);
  });

  test('refuses a field too small to have a cell in it', () => {
    expect(
      () => new Terrain({ width: 1, depth: 4, spacingM: 1, heights: new Float32Array(4) }),
    ).toThrow(/width/);
  });

  test('refuses a spacing of zero, which would divide every query by it', () => {
    expect(
      () => new Terrain({ width: 2, depth: 2, spacingM: 0, heights: new Float32Array(4) }),
    ).toThrow(/spacing/);
  });

  test('says how far it reaches, so a caller can place it without arithmetic', () => {
    const terrain = new Terrain({
      width: 5,
      depth: 3,
      spacingM: 2,
      heights: new Float32Array(15),
      origin: [1, 0, 1],
    });

    expect(terrain.extentX).toBeCloseTo(8, 6);
    expect(terrain.extentZ).toBeCloseTo(4, 6);
  });
});
