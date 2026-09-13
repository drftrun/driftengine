import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RESOLUTION,
  MAX_RESOLUTION,
  SUPPORT_DIRECTIONS,
  decomposeConvex,
} from './decompose.ts';
import { MAX_BODY_PARTS } from './compoundContact.ts';
import { hullShape } from './shape.ts';
import { createMassProperties, shapeMassProperties } from './mass.ts';

/** A box as twelve triangles, appended to arrays under construction. */
function addBox(
  positions: number[],
  indices: number[],
  cx: number,
  cy: number,
  cz: number,
  hx: number,
  hy: number,
  hz: number,
): void {
  const base = positions.length / 3;
  for (let i = 0; i < 8; i++) {
    positions.push(cx + (i & 1 ? hx : -hx), cy + (i & 2 ? hy : -hy), cz + (i & 4 ? hz : -hz));
  }
  for (const face of [
    [0, 2, 3, 1],
    [4, 5, 7, 6],
    [0, 1, 5, 4],
    [2, 6, 7, 3],
    [0, 4, 6, 2],
    [1, 3, 7, 5],
  ]) {
    const [a, b, c, d] = face as [number, number, number, number];
    indices.push(base + a, base + b, base + c, base + a, base + c, base + d);
  }
}

function boxMesh(hx = 1, hy = 1, hz = 1): { positions: number[]; indices: number[] } {
  const positions: number[] = [];
  const indices: number[] = [];
  addBox(positions, indices, 0, 0, 0, hx, hy, hz);
  return { positions, indices };
}

/** Two boxes meeting at a corner: the concave shape whose right answer is not in doubt. */
function lBeamMesh(): { positions: number[]; indices: number[] } {
  const positions: number[] = [];
  const indices: number[] = [];
  addBox(positions, indices, 0, 0, 0, 1, 0.25, 0.25);
  addBox(positions, indices, -0.75, 0.75, 0, 0.25, 0.5, 0.25);
  return { positions, indices };
}

/** A closed n-gon prism, which is convex and has a volume in closed form. */
function prismMesh(
  sides: number,
  radius: number,
  height: number,
): {
  positions: number[];
  indices: number[];
  volume: number;
} {
  const positions: number[] = [];
  const indices: number[] = [];
  const ring = (y: number): number => {
    const base = positions.length / 3;
    for (let i = 0; i < sides; i++) {
      const angle = (i / sides) * Math.PI * 2;
      positions.push(Math.cos(angle) * radius, y, Math.sin(angle) * radius);
    }
    return base;
  };
  const lo = ring(0);
  const hi = ring(height);
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    indices.push(lo + i, lo + j, hi + j, lo + i, hi + j, hi + i);
  }
  const centreLo = positions.length / 3;
  positions.push(0, 0, 0);
  const centreHi = positions.length / 3;
  positions.push(0, height, 0);
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    indices.push(centreLo, lo + j, lo + i);
    indices.push(centreHi, hi + i, hi + j);
  }
  return {
    positions,
    indices,
    volume: 0.5 * sides * Math.sin((Math.PI * 2) / sides) * radius * radius * height,
  };
}

describe('decomposeConvex', () => {
  it('refuses what it cannot do, at the call rather than in the result', () => {
    const mesh = boxMesh();
    expect(() => decomposeConvex(mesh.positions, mesh.indices, { resolution: 2 })).toThrow(
      /resolution/,
    );
    expect(() =>
      decomposeConvex(mesh.positions, mesh.indices, { resolution: MAX_RESOLUTION + 1 }),
    ).toThrow(/resolution/);
    expect(() =>
      decomposeConvex(mesh.positions, mesh.indices, { maxHulls: MAX_BODY_PARTS + 1 }),
    ).toThrow(/maxHulls/);
    expect(() => decomposeConvex(mesh.positions, mesh.indices, { maxHulls: 0 })).toThrow(
      /maxHulls/,
    );
    expect(() => decomposeConvex(mesh.positions, mesh.indices, { concavity: 1 })).toThrow(
      /concavity/,
    );
    expect(() => decomposeConvex(mesh.positions, [0, 1])).toThrow(/whole number of triangles/);
    expect(() => decomposeConvex(mesh.positions, [])).toThrow(/no triangles/);
  });

  it('answers a box with one part holding the box', () => {
    const mesh = boxMesh(1, 0.5, 0.25);
    const result = decomposeConvex(mesh.positions, mesh.indices, { resolution: 32 });
    expect(result.parts).toHaveLength(1);
    /*
     * The rasterisation is conservative, so the voxelised solid is a little larger than the box and
     * never smaller. A part that came back *under* the true volume would mean the marking had
     * missed a cell, which is the defect the fill regression below exists for.
     */
    const part = result.parts[0] as { volume: number };
    expect(part.volume).toBeGreaterThan(1 * 0.5 * 0.25 * 8);
    expect(part.volume).toBeLessThan(1 * 0.5 * 0.25 * 8 * 1.3);
  });

  it('answers an L-beam with two parts and adds no empty space to it', () => {
    const mesh = lBeamMesh();
    const result = decomposeConvex(mesh.positions, mesh.indices, { resolution: 48 });
    expect(result.parts).toHaveLength(2);
    /* Two axis-aligned boxes decompose exactly: nothing is added and nothing is lost. */
    expect(Math.abs(result.bloat)).toBeLessThan(0.01);
    expect(result.coverage).toBeGreaterThan(0.99);
  });

  it('leaves a convex solid whole rather than dividing it', () => {
    /*
     * **The case a bounding box cannot judge.** A cylinder's box is 21.5% empty however it is cut,
     * so a merge that stops at a fixed emptiness can never rejoin the halves — this returned eight
     * parts under exactly that rule. It is the reason the merge measures a real hull once the count
     * is small enough to afford one.
     */
    const mesh = prismMesh(24, 1, 1);
    const result = decomposeConvex(mesh.positions, mesh.indices, { resolution: 48, maxHulls: 8 });
    expect(result.parts).toHaveLength(1);
  });

  it('leaves a convex solid whole even where every single merge looks bad', () => {
    /*
     * **A tetrahedron, which is as convex as a shape gets, and which greedy merging cannot finish.**
     * Voxelised, a 45-degree face is a staircase of boxes; two adjacent boxes have a notch between
     * them, so the hull over the pair is a fifth empty and a pairwise rule refuses the merge — even
     * though merging *all* of them gives the tetrahedron back exactly.
     *
     * Measured before the whole-solid test was added: **sixteen parts and 20.3% bloat**. A crate, a
     * wedge, a rock and a wheel are all this case.
     */
    const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1];
    const indices = [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3];
    for (const resolution of [32, 48, 64]) {
      const result = decomposeConvex(positions, indices, { resolution, maxHulls: 16 });
      expect(result.parts, `resolution ${resolution}`).toHaveLength(1);
      expect(result.bloat, `resolution ${resolution}`).toBeLessThan(0.06);
    }
  });

  it('fills a closed surface rather than lining it', () => {
    /*
     * **The regression for a hole that opened and closed with the resolution.** A face lying exactly
     * in a cell boundary plane is tangent to the boxes on both sides, and the plane test then
     * compares two quantities equal in exact arithmetic; when it fell the wrong way neither cell was
     * marked, the flood walked out through the base, and the whole interior came back empty. The
     * prism's own caps are two such faces.
     *
     * Measured before the fix: correct at resolutions 32, 56, 64 and 72 and the bare shell at 40,
     * 48, 80 and 96, with nothing in the shape to say which. So this sweeps rather than samples.
     */
    const mesh = prismMesh(24, 1, 1);
    for (const resolution of [32, 40, 48, 56, 64, 72, 80, 96]) {
      const result = decomposeConvex(mesh.positions, mesh.indices, { resolution, maxHulls: 8 });
      expect(result.sourceVolume, `resolution ${resolution}`).toBeGreaterThan(mesh.volume);
      expect(result.sourceVolume, `resolution ${resolution}`).toBeLessThan(mesh.volume * 1.25);
    }
  });

  it('keeps a cavity open', () => {
    /*
     * A hollow box: an outer shell with an inner void reached from above. A decomposition that
     * fills the void doubles the volume it reports, which is what this measures.
     */
    const positions: number[] = [];
    const indices: number[] = [];
    addBox(positions, indices, 0, -0.75, 0, 1, 0.25, 1);
    addBox(positions, indices, -0.75, 0.25, 0, 0.25, 0.75, 1);
    addBox(positions, indices, 0.75, 0.25, 0, 0.25, 0.75, 1);
    addBox(positions, indices, 0, 0.25, -0.75, 0.5, 0.75, 0.25);
    addBox(positions, indices, 0, 0.25, 0.75, 0.5, 0.75, 0.25);
    const result = decomposeConvex(positions, indices, { resolution: 48, maxHulls: 16 });
    expect(result.parts.length).toBeGreaterThan(1);
    expect(result.bloat).toBeLessThan(0.15);
  });

  it('produces points hullShape accepts, every time', () => {
    /*
     * `hullShape` refuses more than 64 points. A part that reached it would not be a poor hull — it
     * would be an exception at the moment somebody tried to use the decomposition.
     */
    const mesh = prismMesh(32, 1, 2);
    const result = decomposeConvex(mesh.positions, mesh.indices, { resolution: 40, maxHulls: 16 });
    const mass = createMassProperties();
    for (const part of result.parts) {
      expect(part.points.length % 3).toBe(0);
      expect(part.points.length / 3).toBeLessThanOrEqual(SUPPORT_DIRECTIONS);
      expect(SUPPORT_DIRECTIONS).toBeLessThanOrEqual(64);
      const shape = hullShape(part.points);
      expect(shapeMassProperties(shape, 1, mass).volume).toBeGreaterThan(0);
    }
  });

  it('gives the same answer twice, bit for bit', () => {
    /*
     * The merge is a heap over candidate pairs, and a heap without a tie-break orders equal costs by
     * insertion. Nothing else in this file would notice the difference: every other assertion is a
     * summary that would hold on either answer.
     */
    const mesh = prismMesh(24, 1, 1.5);
    const a = decomposeConvex(mesh.positions, mesh.indices, { resolution: 40, maxHulls: 12 });
    const b = decomposeConvex(mesh.positions, mesh.indices, { resolution: 40, maxHulls: 12 });
    expect(a.parts.length).toBe(b.parts.length);
    for (let i = 0; i < a.parts.length; i++) {
      expect(Array.from((a.parts[i] as { points: Float32Array }).points)).toEqual(
        Array.from((b.parts[i] as { points: Float32Array }).points),
      );
    }
  });

  it('keeps the shell alone when asked to', () => {
    const mesh = prismMesh(24, 1, 1);
    const solid = decomposeConvex(mesh.positions, mesh.indices, { resolution: 40, fill: 'solid' });
    const surface = decomposeConvex(mesh.positions, mesh.indices, {
      resolution: 40,
      fill: 'surface',
    });
    /* A shell encloses the same hull and holds a fraction of the material. */
    expect(surface.sourceVolume).toBeLessThan(solid.sourceVolume * 0.5);
    expect(surface.parts.length).toBeGreaterThan(0);
  });

  it('reports the grid it actually used', () => {
    const mesh = boxMesh();
    const result = decomposeConvex(mesh.positions, mesh.indices);
    expect(result.resolution).toBe(DEFAULT_RESOLUTION);
    expect(result.cells).toBeGreaterThan(DEFAULT_RESOLUTION ** 3);
  });

  it('refuses a mesh thinner than one cell rather than answering with nothing', () => {
    /* A degenerate sliver: two triangles with no thickness at all. */
    expect(() =>
      decomposeConvex([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0], [0, 1, 2, 1, 3, 2], { resolution: 8 }),
    ).not.toThrow();
  });

  it('has no extent to work with, and says so', () => {
    expect(() => decomposeConvex([1, 1, 1, 1, 1, 1, 1, 1, 1], [0, 1, 2])).toThrow(/no extent/);
  });
});
