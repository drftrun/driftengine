import { describe, expect, it } from 'vitest';
import { collideShapes, createManifold } from './manifold.ts';
import type { ShapePose } from './manifold.ts';
import { boxShape, capsuleShape, hullShape, sphereShape } from './shape.ts';

const at = (x: number, y: number, z: number): ShapePose => ({
  x,
  y,
  z,
  qx: 0,
  qy: 0,
  qz: 0,
  qw: 1,
});
/** A pose turned about z, so a face-vs-face case can be knocked off axis. */
const turned = (x: number, y: number, z: number, radians: number): ShapePose => ({
  x,
  y,
  z,
  qx: 0,
  qy: 0,
  qz: Math.sin(radians / 2),
  qw: Math.cos(radians / 2),
});
const M = createManifold();

describe('polytope against polytope', () => {
  it('separates two overlapping boxes along the shallow axis', () => {
    // Unit half-extents, centres 1.9 apart in x: 0.1 of overlap.
    expect(
      collideShapes(boxShape(1, 1, 1), at(0, 0, 0), boxShape(1, 1, 1), at(1.9, 0, 0), 0, M),
    ).toBe(true);
    expect(M.nx).toBeCloseTo(1, 5);
    expect(M.ny).toBeCloseTo(0, 5);
    expect(M.nz).toBeCloseTo(0, 5);
  });

  it('reports the overlap as a negative separation', () => {
    collideShapes(boxShape(1, 1, 1), at(0, 0, 0), boxShape(1, 1, 1), at(1.9, 0, 0), 0, M);
    for (let i = 0; i < M.count; i++) expect(M.separations[i]).toBeCloseTo(-0.1, 5);
  });

  it('gives a face-on-face contact four points', () => {
    collideShapes(boxShape(1, 1, 1), at(0, 0, 0), boxShape(1, 1, 1), at(1.9, 0, 0), 0, M);
    expect(M.count).toBe(4);
  });

  it('finds nothing when the boxes are apart and the margin is zero', () => {
    expect(
      collideShapes(boxShape(1, 1, 1), at(0, 0, 0), boxShape(1, 1, 1), at(2.5, 0, 0), 0, M),
    ).toBe(false);
  });

  it('finds a speculative contact inside the margin, with positive separation', () => {
    expect(
      collideShapes(boxShape(1, 1, 1), at(0, 0, 0), boxShape(1, 1, 1), at(2.2, 0, 0), 0.5, M),
    ).toBe(true);
    expect(M.separations[0]).toBeCloseTo(0.2, 5);
    expect(M.nx).toBeCloseTo(1, 5);
  });

  it('picks the shallow axis when two overlaps differ', () => {
    // 0.5 of overlap in x, 0.05 in y: y is the way out.
    collideShapes(boxShape(1, 1, 1), at(0, 0, 0), boxShape(1, 1, 1), at(1.5, 1.95, 0), 0, M);
    expect(Math.abs(M.ny)).toBeCloseTo(1, 5);
  });

  it('separates a turned box along its own face normal', () => {
    const a = boxShape(1, 1, 1);
    const b = boxShape(1, 1, 1);
    // B turned 45 degrees about z, so its corner leads.
    const half = Math.SQRT2;
    expect(collideShapes(a, at(0, 0, 0), b, turned(1 + half - 0.1, 0, 0, Math.PI / 4), 0, M)).toBe(
      true,
    );
    expect(M.nx).toBeCloseTo(1, 4);
    expect(M.separations[0]).toBeLessThan(0);
  });

  /**
   * The mirror of the test above, and it exists because skipping B's face axes entirely passed
   * every other test here. An axis-aligned box against a turned one is found by A's own face
   * normal, so nothing required B's to be considered at all. Here A is the turned one and its
   * corner leads, so the shallow axis is a face of **B** and no face of A points along it.
   */
  it("separates along B's face normal when only B has one pointing the right way", () => {
    const half = Math.SQRT2;
    expect(
      collideShapes(
        boxShape(1, 1, 1),
        turned(-(1 + half - 0.1), 0, 0, Math.PI / 4),
        boxShape(1, 1, 1),
        at(0, 0, 0),
        0,
        M,
      ),
    ).toBe(true);
    expect(M.nx).toBeCloseTo(1, 4);
    expect(M.ny).toBeCloseTo(0, 4);
    expect(M.separations[0]).toBeCloseTo(-0.1, 3);
  });

  it('never reports more than four points', () => {
    const a = hullShape([-1, -1, -1, 1, -1, -1, 1, -1, 1, -1, -1, 1, 0, 1, 0]);
    collideShapes(boxShape(2, 1, 2), at(0, 0, 0), a, at(0, 1.9, 0), 0, M);
    expect(M.count).toBeLessThanOrEqual(4);
  });
});

describe('a round shape against a polytope', () => {
  it('rests a sphere on a box face with one point', () => {
    expect(
      collideShapes(sphereShape(0.5), at(0, 1.4, 0), boxShape(2, 1, 2), at(0, 0, 0), 0, M),
    ).toBe(true);
    expect(M.count).toBe(1);
    expect(M.ny).toBeCloseTo(-1, 5);
    expect(M.separations[0]).toBeCloseTo(-0.1, 5);
  });

  it('points the normal from A to B whichever way round they are given', () => {
    collideShapes(boxShape(2, 1, 2), at(0, 0, 0), sphereShape(0.5), at(0, 1.4, 0), 0, M);
    expect(M.ny).toBeCloseTo(1, 5);
  });

  it('finds a sphere against a box corner, which no face normal points at', () => {
    // Just outside the corner (1,1,1), along the diagonal.
    const d = 1 / Math.sqrt(3);
    const r = 0.5;
    const gap = 0.05;
    const c = 1 + (r + gap) * d;
    expect(collideShapes(sphereShape(r), at(c, c, c), boxShape(1, 1, 1), at(0, 0, 0), 0.2, M)).toBe(
      true,
    );
    expect(M.separations[0]).toBeCloseTo(gap, 4);
    // The normal is the corner diagonal, which is not any face normal of the box.
    expect(M.nx).toBeCloseTo(-d, 4);
    expect(M.ny).toBeCloseTo(-d, 4);
    expect(M.nz).toBeCloseTo(-d, 4);
  });

  it('gives a capsule lying on a face two points, which is what stops it rocking', () => {
    expect(
      collideShapes(
        capsuleShape(0.3, 1),
        turned(0, 1.29, 0, Math.PI / 2),
        boxShape(3, 1, 3),
        at(0, 0, 0),
        0,
        M,
      ),
    ).toBe(true);
    expect(M.count).toBe(2);
    for (let i = 0; i < 2; i++) expect(M.separations[i]).toBeCloseTo(-0.01, 4);
  });

  it('gives a capsule standing on its end one point', () => {
    expect(
      collideShapes(capsuleShape(0.3, 1), at(0, 2.29, 0), boxShape(3, 1, 3), at(0, 0, 0), 0, M),
    ).toBe(true);
    expect(M.count).toBe(1);
  });

  it('reports a sphere fully inside a box as penetrating, not as separate', () => {
    expect(collideShapes(sphereShape(0.2), at(0, 0, 0), boxShape(1, 1, 1), at(0, 0, 0), 0, M)).toBe(
      true,
    );
    expect(M.separations[0]).toBeLessThan(0);
  });
});

describe('two round shapes', () => {
  it('separates two spheres along the line of centres', () => {
    expect(collideShapes(sphereShape(1), at(0, 0, 0), sphereShape(1), at(1.5, 0, 0), 0, M)).toBe(
      true,
    );
    expect(M.nx).toBeCloseTo(1, 6);
    expect(M.separations[0]).toBeCloseTo(-0.5, 6);
    expect(M.count).toBe(1);
  });

  it('finds nothing between two spheres that do not touch', () => {
    expect(collideShapes(sphereShape(1), at(0, 0, 0), sphereShape(1), at(3, 0, 0), 0, M)).toBe(
      false,
    );
  });

  it('separates two crossed capsules at their closest approach', () => {
    const a = capsuleShape(0.25, 2);
    const b = capsuleShape(0.25, 2);
    /*
     * A runs along y through the origin; B runs along x, offset in **z**. Offsetting in y instead
     * makes the two segments genuinely intersect, which is a distance of zero rather than of the
     * offset — the first version of this test did that and read the resulting refusal as a bug in
     * the code rather than in itself. It was both, as it turned out.
     */
    expect(collideShapes(a, at(0, 0, 0), b, turned(0, 0, 0.4, Math.PI / 2), 0, M)).toBe(true);
    expect(M.nz).toBeCloseTo(1, 5);
    expect(M.separations[0]).toBeCloseTo(-0.1, 5);
  });

  it('reports two capsules crossing exactly as fully overlapped, not as apart', () => {
    const a = capsuleShape(0.25, 2);
    expect(collideShapes(a, at(0, 0, 0), a, turned(0, 0, 0, Math.PI / 2), 0, M)).toBe(true);
    expect(M.separations[0]).toBeCloseTo(-0.5, 6);
  });

  it('does not divide by zero when two capsules share an axis', () => {
    const a = capsuleShape(0.5, 1);
    expect(collideShapes(a, at(0, 0, 0), a, at(0, 0, 0), 0, M)).toBe(true);
    expect(Number.isFinite(M.nx)).toBe(true);
    expect(Number.isFinite(M.separations[0] ?? 0)).toBe(true);
  });
});

describe('feature ids', () => {
  /**
   * The load-bearing property. A manifold is matched to the previous tick's by feature id so
   * accumulated impulses warm-start the next solve. Matching by proximity within a tolerance is
   * the usual alternative and is both order-dependent and tolerance-dependent.
   */
  it('keeps the same ids when a box slides along a face it stays on', () => {
    /*
     * Both positions are offset, deliberately. Sliding from *exactly aligned* to offset changes
     * which features touch — four incident corners become two corners and two clipped points — so
     * the ids differ for a real reason and the test would be asserting the wrong thing.
     */
    collideShapes(boxShape(1, 1, 1), at(0, 0, 0), boxShape(1, 1, 1), at(0.02, 1.9, 0), 0, M);
    const before = [...M.featureIds.slice(0, M.count)].sort((a, b) => a - b);
    collideShapes(boxShape(1, 1, 1), at(0, 0, 0), boxShape(1, 1, 1), at(0.04, 1.9, 0), 0, M);
    const after = [...M.featureIds.slice(0, M.count)].sort((a, b) => a - b);
    expect(after).toEqual(before);
  });

  it('gives a clipped point a different id from the vertex its edge left', () => {
    collideShapes(boxShape(1, 1, 1), at(0, 0, 0), boxShape(1, 1, 1), at(0.5, 1.9, 0), 0, M);
    expect(new Set(M.featureIds.slice(0, M.count)).size).toBe(M.count);
    expect(M.count).toBe(4);
  });

  it('gives different ids to different contact points', () => {
    collideShapes(boxShape(1, 1, 1), at(0, 0, 0), boxShape(1, 1, 1), at(0, 1.9, 0), 0, M);
    expect(new Set(M.featureIds.slice(0, M.count)).size).toBe(M.count);
  });

  it('changes the id when the contact moves to a different face', () => {
    collideShapes(boxShape(1, 1, 1), at(0, 0, 0), boxShape(1, 1, 1), at(0, 1.9, 0), 0, M);
    const top = M.featureIds[0] ?? 0;
    collideShapes(boxShape(1, 1, 1), at(0, 0, 0), boxShape(1, 1, 1), at(1.9, 0, 0), 0, M);
    expect(M.featureIds[0] ?? 0).not.toBe(top);
  });

  it('names the endpoint that produced a capsule contact', () => {
    collideShapes(
      capsuleShape(0.3, 1),
      turned(0, 1.29, 0, Math.PI / 2),
      boxShape(3, 1, 3),
      at(0, 0, 0),
      0,
      M,
    );
    expect(M.featureIds[0]).not.toBe(M.featureIds[1]);
  });
});
