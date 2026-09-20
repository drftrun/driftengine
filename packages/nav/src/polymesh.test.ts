import { describe, expect, it } from 'vitest';
import { buildContours } from './contour.ts';
import { buildRegions } from './regions.ts';
import {
  buildPolyMesh,
  polyArea,
  polyIsConvex,
  polyNeighbour,
  polyVertexCount,
  type PolyMesh,
} from './polymesh.ts';
import { fieldFromMap } from './testField.ts';

/** A mesh whose cells are metres and whose corner is the origin, for contours written by hand. */
const AT_ORIGIN = { origin: [0, 0, 0], cellSize: 1 };

function meshOf(rows: readonly string[], maxVerts = 6, deviation = 0.5): PolyMesh {
  const field = fieldFromMap(rows);
  const regions = buildRegions(field, { minRegionSpans: 1, maxStep: 1 });
  return buildPolyMesh(buildContours(field, regions, deviation), maxVerts, field);
}

/** How many cells the walkable part of a picture has, which is the area the mesh must cover. */
function cellsIn(rows: readonly string[]): number {
  return rows
    .join('')
    .split('')
    .filter((ch) => ch !== '#').length;
}

describe('a polygon mesh', () => {
  it('is one polygon for a square', () => {
    const mesh = meshOf(['....', '....', '....', '....']);
    expect(mesh.polyCount).toBe(1);
    expect(polyVertexCount(mesh, 0)).toBe(4);
  });

  it('makes every polygon convex', () => {
    for (const rows of [
      ['....', '....', '....'],
      ['..##', '..##', '....', '....'],
      ['.....#.....', '...........', '.....#.....'],
      ['..........', '.........#', '........##', '.......###'],
    ]) {
      const mesh = meshOf(rows);
      for (let poly = 0; poly < mesh.polyCount; poly += 1) {
        expect(polyIsConvex(mesh, poly), `${rows.join('/')} polygon ${poly}`).toBe(true);
      }
    }
  });

  /** Gaps are places an agent cannot stand; overlaps are two polygons claiming one point. */
  it('tiles the region: the areas sum to the region and nothing is counted twice', () => {
    const rows = ['..##', '..##', '....', '....'];
    const mesh = meshOf(rows);
    let total = 0;
    for (let poly = 0; poly < mesh.polyCount; poly += 1) total += polyArea(mesh, poly);
    expect(total, 'twelve cells of an L').toBeCloseTo(cellsIn(rows), 6);
  });

  it('tiles a plain rectangle exactly too', () => {
    const rows = ['.....', '.....', '.....'];
    const mesh = meshOf(rows);
    let total = 0;
    for (let poly = 0; poly < mesh.polyCount; poly += 1) total += polyArea(mesh, poly);
    expect(total).toBeCloseTo(cellsIn(rows), 6);
  });

  /**
   * **Adjacency has to be symmetric, and a one-directional build breaks it silently.** What it
   * produces is a mesh where a path from A to B exists and the same path from B to A does not,
   * which reads as a pathfinding bug and is a mesh-building one.
   */
  it('borders both ways or not at all', () => {
    const mesh = meshOf(['..........', '.........#', '........##', '.......###']);
    expect(mesh.polyCount).toBeGreaterThan(1);

    let borders = 0;
    for (let poly = 0; poly < mesh.polyCount; poly += 1) {
      for (let edge = 0; edge < polyVertexCount(mesh, poly); edge += 1) {
        const other = polyNeighbour(mesh, poly, edge);
        if (other < 0) continue;
        borders += 1;
        let back = false;
        for (let theirs = 0; theirs < polyVertexCount(mesh, other); theirs += 1) {
          if (polyNeighbour(mesh, other, theirs) === poly) back = true;
        }
        expect(back, `${poly} borders ${other} but not the other way`).toBe(true);
      }
    }
    expect(borders, 'and there were borders to check').toBeGreaterThan(0);
  });

  it('marks an outside edge as bordering nothing', () => {
    const mesh = meshOf(['....', '....']);
    let outside = 0;
    for (let edge = 0; edge < polyVertexCount(mesh, 0); edge += 1) {
      if (polyNeighbour(mesh, 0, edge) < 0) outside += 1;
    }
    expect(outside, 'every edge of a lone square is the outside').toBe(4);
  });

  it('honours the vertex limit', () => {
    const mesh = meshOf(['..........', '.........#', '........##', '.......###'], 3);
    for (let poly = 0; poly < mesh.polyCount; poly += 1) {
      expect(polyVertexCount(mesh, poly)).toBeLessThanOrEqual(3);
    }
  });

  it('is deterministic', () => {
    const rows = ['..##', '..##', '....', '....'];
    expect([...meshOf(rows).polys]).toEqual([...meshOf(rows).polys]);
    expect([...meshOf(rows).neighbours]).toEqual([...meshOf(rows).neighbours]);
  });

  it('is empty for no contours at all', () => {
    const mesh = buildPolyMesh([], 6, AT_ORIGIN);
    expect(mesh.polyCount).toBe(0);
  });

  /**
   * **`buildPolyMesh` takes contours, and a caller may build its own.** `buildContours` happens to
   * wind them all one way — measured, 1,709 of 1,709 — so nothing inside this package exercises
   * the other, and ear clipping tests a positive turn and would clip nothing at all. A square
   * written backwards is the whole test, and it is here because the input is public.
   */
  it('takes a contour wound either way', () => {
    const square = Int32Array.from([0, 0, 4, 0, 4, 4, 0, 4]);
    const backwards = Int32Array.from([0, 4, 4, 4, 4, 0, 0, 0]);

    for (const points of [square, backwards]) {
      const mesh = buildPolyMesh([{ region: 0, points, raw: points }], 6, AT_ORIGIN);
      expect(mesh.polyCount, 'one square either way round').toBe(1);
      expect(polyArea(mesh, 0)).toBeCloseTo(16, 6);
      expect(polyIsConvex(mesh, 0)).toBe(true);
    }
  });
});

/**
 * **The contour before this had five hand-picked shapes and 46 defects hiding behind them.** The
 * same treatment applied here, before anything is trusted: convexity, area and symmetry over
 * shapes nobody chose. Area is the strongest of the three — it catches an ear-clipping that
 * swallowed a vertex, a merge that overlapped, and a triangulation that gave up part way, none of
 * which convexity alone would notice.
 */
describe('across shapes nobody chose', () => {
  function blob(seed: number, w: number, h: number): string[] {
    let state = seed >>> 0;
    const next = (): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x100000000;
    };
    const rows: string[] = [];
    for (let z = 0; z < h; z += 1) {
      let row = '';
      for (let x = 0; x < w; x += 1) row += next() < 0.6 ? '.' : '#';
      rows.push(row);
    }
    return rows;
  }

  it('is convex, symmetric and exactly covering, every time', () => {
    let polygons = 0;
    for (let seed = 1; seed <= 150; seed += 1) {
      const rows = blob(seed, 12, 12);
      const field = fieldFromMap(rows);
      const regions = buildRegions(field, { minRegionSpans: 1, maxStep: 1 });
      const contours = buildContours(field, regions, 0.5);
      const mesh = buildPolyMesh(contours, 6, AT_ORIGIN);

      let area = 0;
      for (let poly = 0; poly < mesh.polyCount; poly += 1) {
        polygons += 1;
        expect(polyIsConvex(mesh, poly), `seed ${seed} polygon ${poly}`).toBe(true);
        area += polyArea(mesh, poly);
        for (let edge = 0; edge < polyVertexCount(mesh, poly); edge += 1) {
          const other = polyNeighbour(mesh, poly, edge);
          if (other < 0) continue;
          let back = false;
          for (let theirs = 0; theirs < polyVertexCount(mesh, other); theirs += 1) {
            if (polyNeighbour(mesh, other, theirs) === poly) back = true;
          }
          expect(back, `seed ${seed}: ${poly} borders ${other} one way only`).toBe(true);
        }
      }

      /* The contours are what the mesh is built from, so that is what its area must come to. */
      let contourArea = 0;
      for (const contour of contours) contourArea += Math.abs(shoelace(contour.points));
      expect(area, `seed ${seed} area`).toBeCloseTo(contourArea, 6);
    }
    expect(polygons, 'and there were polygons to check').toBeGreaterThan(500);
  });

  function shoelace(points: Int32Array): number {
    const count = points.length / 2;
    let twice = 0;
    for (let at = 0; at < count; at += 1) {
      const b = (at + 1) % count;
      twice +=
        (points[at * 2] as number) * (points[b * 2 + 1] as number) -
        (points[b * 2] as number) * (points[at * 2 + 1] as number);
    }
    return twice / 2;
  }
});

describe('several regions', () => {
  it('puts every region into the same mesh and keeps them apart', () => {
    const mesh = meshOf(['..#..', '..#..', '..#..']);
    expect(mesh.polyCount).toBe(2);
    expect(polyNeighbour(mesh, 0, 0), 'two rooms that do not touch share no edge').toBe(-1);
  });
});
