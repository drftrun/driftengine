import { describe, expect, test } from 'vitest';

import type { Aabb } from './collide/index.ts';
import {
  fieldCandidates,
  fieldConvexEdges,
  fieldCorners,
  fieldPlane,
  heightfieldShape,
} from './heightfieldShape.ts';

function field(width: number, depth: number, heights: number[], spacingM = 1) {
  return {
    width,
    depth,
    spacingM,
    heights: Float32Array.from(heights),
  };
}

/** Flat, three by three, so every interior edge is a seam between two coplanar triangles. */
const FLAT = () => field(3, 3, new Array(9).fill(0));

function box(
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
): Aabb {
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

describe('the shape a field makes', () => {
  test('is two triangles per cell and no geometry at all', () => {
    const shape = heightfieldShape(FLAT());

    expect(shape.triangles?.triangleCount).toBe(2 * 2 * 2);
    /* **The whole point of the thing.** A mesh collider carries a vertex buffer, an index buffer
       and a tree; this carries the heights it was handed and nothing else. */
    expect(shape.triangles?.positions.length).toBe(0);
    expect(shape.triangles?.indices.length).toBe(0);
    expect(shape.triangles?.planes.length).toBe(0);
    expect(shape.triangles?.tree).toBe(null);
    expect(shape.triangles?.field).toBeDefined();
  });

  test('bounds the field it covers, so the broad phase finds it', () => {
    const shape = heightfieldShape(field(3, 3, [0, 0, 0, 0, 5, 0, 0, 0, 0]));

    let minY = Infinity;
    let maxY = -Infinity;
    let maxX = -Infinity;
    for (let v = 0; v < shape.vertices.length; v += 3) {
      minY = Math.min(minY, shape.vertices[v + 1] ?? 0);
      maxY = Math.max(maxY, shape.vertices[v + 1] ?? 0);
      maxX = Math.max(maxX, shape.vertices[v] ?? 0);
    }

    expect(minY).toBeCloseTo(0, 6);
    expect(maxY).toBeCloseTo(5, 6);
    expect(maxX).toBeCloseTo(2, 6);
  });

  test('refuses a field too small to have a cell in it', () => {
    expect(() => heightfieldShape(field(1, 3, [0, 0, 0]))).toThrow(/width/);
  });

  test('refuses a height array that does not match the size', () => {
    expect(() => heightfieldShape(field(3, 3, [0, 0, 0]))).toThrow(/9/);
  });
});

describe('the triangles it generates', () => {
  test('splits each cell along the diagonal from its first sample to its last', () => {
    /*
     * **The rule that has to match `@driftengine/terrain`'s**, which draws the picture this
     * collides with. Half 0 is `a, d, c` and half 1 is `a, c, b`, where `a` is the cell's own
     * sample and `c` is the one diagonally across it — so both triangles share the `a`-`c` edge.
     * A collider split the other way disagrees with the picture by up to the height of a cell
     * everywhere except along the anti-diagonal, which is the defect Track L already found once.
     */
    const out = new Float64Array(9);
    const f = field(3, 3, [0, 1, 2, 3, 4, 5, 6, 7, 8]);

    /* Cell (0, 0): a = (0,0) at height 0, b = (1,0) at 1, c = (1,1) at 4, d = (0,1) at 3. */
    fieldCorners(f, 0, out);
    expect([...out]).toEqual([0, 0, 0, 0, 3, 1, 1, 4, 1]);
    fieldCorners(f, 1, out);
    expect([...out]).toEqual([0, 0, 0, 1, 4, 1, 1, 1, 0]);
  });

  test('numbers cells row by row, so a triangle names one cell and one half', () => {
    const out = new Float64Array(9);
    const f = field(3, 3, [0, 0, 0, 0, 0, 0, 0, 0, 0], 2);

    /* Cell (1, 0) is the second cell of the first row: triangles 2 and 3. */
    fieldCorners(f, 2, out);
    expect(out[0]).toBeCloseTo(2, 6);
    /* Cell (0, 1) is the first cell of the second row: triangles 4 and 5. */
    fieldCorners(f, 4, out);
    expect(out[2]).toBeCloseTo(2, 6);
  });

  test('places every vertex through the spacing and the origin', () => {
    const out = new Float64Array(9);
    const f = {
      ...field(3, 3, [0, 0, 0, 0, 0, 0, 0, 0, 0], 4),
      origin: [-10, 3, 7],
    };

    fieldCorners(f, 0, out);
    expect(out[0]).toBeCloseTo(-10, 6);
    expect(out[1]).toBeCloseTo(3, 6);
    expect(out[2]).toBeCloseTo(7, 6);
    /* The third corner of half 0 is the sample diagonally across the cell. */
    expect(out[6]).toBeCloseTo(-6, 6);
    expect(out[8]).toBeCloseTo(11, 6);
  });

  test('gives every triangle a plane whose normal points up, a field having no overhangs', () => {
    const plane = new Float64Array(4);
    const f = field(3, 3, [0, 2, 1, 3, 0, 4, 1, 5, 2]);

    for (let t = 0; t < 8; t++) {
      fieldPlane(f, t, plane);
      expect(plane[1]).toBeGreaterThan(0);
      expect(Math.hypot(plane[0] ?? 0, plane[1] ?? 0, plane[2] ?? 0)).toBeCloseTo(1, 6);
    }
  });

  test('puts the plane through the triangle it belongs to', () => {
    const plane = new Float64Array(4);
    const corners = new Float64Array(9);
    const f = field(3, 3, [0, 2, 1, 3, 0, 4, 1, 5, 2]);

    for (let t = 0; t < 8; t++) {
      fieldPlane(f, t, plane);
      fieldCorners(f, t, corners);
      for (let k = 0; k < 3; k++) {
        const height =
          (corners[k * 3] ?? 0) * (plane[0] ?? 0) +
          (corners[k * 3 + 1] ?? 0) * (plane[1] ?? 0) +
          (corners[k * 3 + 2] ?? 0) * (plane[2] ?? 0) -
          (plane[3] ?? 0);
        expect(height).toBeCloseTo(0, 6);
      }
    }
  });
});

describe('which edges a body may be caught on', () => {
  test('none of the interior ones, on a floor that is flat', () => {
    /*
     * **The interior-edge filter is what decides whether terrain feels right.** A box sliding
     * across two coplanar triangles meets their shared edge, where the narrow phase finds an edge
     * normal rather than the face's and shoves the box backwards — a character stumbling on a flat
     * floor once a metre. A coplanar seam must therefore be reported as *not* convex, exactly as
     * `meshShape` reports it.
     */
    const f = FLAT();
    /* Cell (0, 0): its diagonal and the two edges it shares with the cells beside it. */
    expect((fieldConvexEdges(f, 0) >> 2) & 1).toBe(0); /* half 0, the diagonal */
    expect((fieldConvexEdges(f, 1) >> 0) & 1).toBe(0); /* half 1, the same diagonal */
    /* Cell (0, 0) half 0 edge 1 is the seam with the cell below it, which exists. */
    expect((fieldConvexEdges(f, 0) >> 1) & 1).toBe(0);
  });

  test('the ones at the edge of the field, because there is nothing on the other side', () => {
    const f = FLAT();
    /* Cell (0, 0) half 0 edge 0 runs along x = 0: the field stops there. */
    expect((fieldConvexEdges(f, 0) >> 0) & 1).toBe(1);
    /* And half 1 edge 2 runs along z = 0, likewise. */
    expect((fieldConvexEdges(f, 1) >> 2) & 1).toBe(1);
  });

  test('a ridge, where the fold really does turn away and a body should feel it', () => {
    /*
     * A roof: the middle row raised, so the two cells either side of it meet at a genuine convex
     * ridge. `meshShape` keeps an edge normal there and so must this — a consumer who wants a ridge
     * softened bevels it.
     */
    const ridge = field(3, 3, [0, 2, 0, 0, 2, 0, 0, 2, 0]);
    /* Cell (0, 0) half 1 edge 1 runs along x = 1, which is the crest. */
    expect((fieldConvexEdges(ridge, 1) >> 1) & 1).toBe(1);
  });

  test('and not a valley, where an edge normal would point into ground that is there', () => {
    const valley = field(3, 3, [2, 0, 2, 2, 0, 2, 2, 0, 2]);
    expect((fieldConvexEdges(valley, 1) >> 1) & 1).toBe(0);
  });
});

describe('the cells a query has to look at', () => {
  test('are the ones the box covers and no others', () => {
    const f = field(5, 5, new Array(25).fill(0));
    const out = new Int32Array(64);

    /* A box over the first cell only. */
    const found = fieldCandidates(f, box(0.1, -1, 0.1, 0.9, 1, 0.9), out);
    expect(found).toBe(2);
    expect([...out.slice(0, 2)].sort((a, b) => a - b)).toEqual([0, 1]);
  });

  test('grow with the box, and stop at the edge of the field', () => {
    const f = field(5, 5, new Array(25).fill(0));
    const out = new Int32Array(64);

    /* The whole field, and then some. */
    expect(fieldCandidates(f, box(-100, -1, -100, 100, 1, 100), out)).toBe(4 * 4 * 2);
  });

  test('are none where the box misses the field entirely', () => {
    const f = field(5, 5, new Array(25).fill(0));
    const out = new Int32Array(64);

    expect(fieldCandidates(f, box(20, -1, 20, 30, 1, 30), out)).toBe(0);
  });

  test('skip a cell the box cannot reach in height, which is most of a hill', () => {
    /*
     * **The pruning that makes this cheap.** A body on a hillside overlaps a wide footprint of
     * cells in x and z and touches almost none of them, because they are metres above or below it.
     * Without a height test every one of those would go through the narrow phase.
     */
    const hill = field(
      5,
      5,
      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9],
    );
    const out = new Int32Array(64);

    /*
     * A slab just above the flat part. The plateau's own cells — the last row, whose four samples
     * are all at nine — are skipped; the cells of the slope between them are not, and should not
     * be: a cell running from zero to nine genuinely does pass through the slab.
     */
    const found = fieldCandidates(hill, box(-1, -0.5, -1, 5, 0.5, 5), out);
    expect(found).toBe(4 * 3 * 2);
  });

  test('answer nothing rather than overrunning a buffer that is too small', () => {
    const f = field(5, 5, new Array(25).fill(0));
    const out = new Int32Array(4);

    /* Filled to its length and no further; the caller grows and asks again, as the mesh path does. */
    expect(fieldCandidates(f, box(-100, -1, -100, 100, 1, 100), out)).toBe(4);
  });
});
