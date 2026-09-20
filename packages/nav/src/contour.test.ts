import { describe, expect, it } from 'vitest';
import { buildContours, contourSelfIntersects, maxDeviationOf } from './contour.ts';
import { buildRegions } from './regions.ts';
import { fieldFromMap } from './testField.ts';

function contoursOf(rows: readonly string[], maxDeviation = 1.3): ReturnType<typeof buildContours> {
  const field = fieldFromMap(rows);
  const regions = buildRegions(field, { minRegionSpans: 1, maxStep: 1 });
  return buildContours(field, regions, maxDeviation);
}

describe('a contour', () => {
  it('has four corners for a square region', () => {
    const contours = contoursOf(['....', '....', '....', '....']);
    expect(contours.length).toBe(1);
    expect(contours[0]?.points.length / 2, 'four corners and no more').toBe(4);
  });

  it('closes, so the last point joins the first', () => {
    const contour = contoursOf(['....', '....', '....'])[0]!;
    const n = contour.points.length / 2;
    const first = [contour.points[0], contour.points[1]];
    const last = [contour.points[(n - 1) * 2], contour.points[(n - 1) * 2 + 1]];
    expect(first, 'a closed loop is not a repeated point').not.toEqual(last);
    expect(n).toBeGreaterThanOrEqual(3);
  });

  it('wraps the region and nothing outside it', () => {
    const contour = contoursOf(['...', '...', '...'])[0]!;
    const xs: number[] = [];
    const zs: number[] = [];
    for (let at = 0; at < contour.points.length; at += 2) {
      xs.push(contour.points[at] as number);
      zs.push(contour.points[at + 1] as number);
    }
    expect(Math.min(...xs)).toBe(0);
    expect(Math.max(...xs), 'three cells wide is a boundary at x = 3').toBe(3);
    expect(Math.min(...zs)).toBe(0);
    expect(Math.max(...zs)).toBe(3);
  });

  /**
   * **The deviation is in cells, so a value near one cuts the corners off a small shape** — and
   * that is correct rather than a bug. This L's inner corner sits 1.2 cells from the chord that
   * skips it, so at the 1.3 the other tests use it is legitimately a triangle. The corners survive
   * a bound that does not permit cutting them, which is what this asserts.
   */
  it('keeps the corners of an L when the deviation does not allow cutting them', () => {
    const tight = contoursOf(['..##', '..##', '....', '....'], 0.5)[0]!;
    expect(tight.points.length / 2, 'six corners for an L').toBe(6);

    const loose = contoursOf(['..##', '..##', '....', '....'], 1.3)[0]!;
    expect(loose.points.length / 2, 'and 1.3 cells is licence to cut one').toBe(3);
    expect(
      maxDeviationOf(loose.raw, loose.points),
      'within what was asked for',
    ).toBeLessThanOrEqual(1.3);
  });

  it('gives one contour per region', () => {
    const contours = contoursOf(['..#..', '..#..', '..#..']);
    expect(contours.length).toBe(2);
    expect(new Set(contours.map((c) => c.region)).size).toBe(2);
  });

  it('is deterministic', () => {
    const a = contoursOf(['..##', '....', '....']);
    const b = contoursOf(['..##', '....', '....']);
    expect(a.map((c) => [...c.points])).toEqual(b.map((c) => [...c.points]));
  });
});

describe('simplification', () => {
  /**
   * A stair-stepped diagonal is where simplification earns its keep and where it can go wrong: the
   * raw boundary has a vertex per cell, and the answer is a line that stays within the stated
   * deviation of every one of them.
   */
  it('stays within the stated deviation of the true boundary', () => {
    const rows = ['...#####', '....####', '.....###', '......##', '.......#'];
    const loose = contoursOf(rows, 2)[0]!;
    const tight = contoursOf(rows, 0.1)[0]!;

    expect(loose.points.length, 'a looser bound gives fewer points').toBeLessThan(
      tight.points.length,
    );
    expect(maxDeviationOf(loose.raw, loose.points)).toBeLessThanOrEqual(2 + 1e-6);
    expect(maxDeviationOf(tight.raw, tight.points)).toBeLessThanOrEqual(0.1 + 1e-6);
  });

  it('keeps the raw boundary beside the simplified one', () => {
    const contour = contoursOf(['....', '....'])[0]!;
    expect(contour.raw.length).toBeGreaterThan(contour.points.length);
  });

  /**
   * **A self-intersecting contour produces a polygon the funnel algorithm walks out of**, which is
   * a path that leaves the mesh and an agent that walks through a wall. Simplification is checked
   * and refused rather than trusted: Douglas–Peucker on a simple closed polygon is *usually*
   * simple, and "usually" is not a property a pathfinder can rest on.
   */
  it('never crosses itself, whatever the deviation allows', () => {
    const shapes = [
      ['....', '....', '....'],
      ['..##', '..##', '....', '....'],
      ['...#####', '....####', '.....###', '......##', '.......#'],
      ['.#.#.', '.....', '.#.#.'],
      ['..........', '.........#', '........##', '.......###'],
    ];
    for (const rows of shapes) {
      for (const deviation of [0.1, 0.5, 1.3, 3, 10]) {
        for (const contour of contoursOf(rows, deviation)) {
          expect(
            contourSelfIntersects(contour.points),
            `${rows.join('/')} at deviation ${deviation}`,
          ).toBe(false);
        }
      }
    }
  });

  it('recognises a contour that does cross itself', () => {
    /* A bow tie: two triangles sharing a crossing. */
    const bowTie = Int32Array.from([0, 0, 4, 4, 4, 0, 0, 4]);
    expect(contourSelfIntersects(bowTie)).toBe(true);
  });

  /**
   * **Five hand-picked shapes said this was fine and it was not.** Run over blobs instead — 200
   * seeds at four deviations, some twelve thousand contours — the first version produced 46
   * self-intersecting results, every one from a region that pinches at a corner. A vertex there
   * has two outgoing boundary edges and the walk was keeping one of them, so half the loop was
   * silently dropped and the *raw* boundary already crossed itself, which no amount of
   * re-simplifying could fix.
   *
   * Kept as a test rather than thrown away with the bug, because a shape somebody draws by hand is
   * a shape somebody thought of.
   */
  it('never crosses itself across twelve thousand shapes nobody chose', () => {
    let checked = 0;
    for (let seed = 1; seed <= 200; seed += 1) {
      const rows = blob(seed, 14, 14);
      const field = fieldFromMap(rows);
      const regions = buildRegions(field, { minRegionSpans: 1, maxStep: 1 });
      for (const deviation of [1, 2, 4, 8]) {
        for (const contour of buildContours(field, regions, deviation)) {
          checked += 1;
          expect(contourSelfIntersects(contour.points), `seed ${seed} at ${deviation}`).toBe(false);
        }
      }
    }
    expect(checked, 'and it really did look at that many').toBeGreaterThan(8_000);
  });
});

/** A deterministic pseudo-random blob, so a failing seed can be reproduced from its number alone. */
function blob(seed: number, w: number, h: number): string[] {
  let state = seed >>> 0;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const rows: string[] = [];
  for (let z = 0; z < h; z += 1) {
    let row = '';
    for (let x = 0; x < w; x += 1) row += next() < 0.62 ? '.' : '#';
    rows.push(row);
  }
  return rows;
}

describe('a region with a hole in it', () => {
  /**
   * **A free-standing pillar is a hole, and a contour that drops it does worse than lose the
   * pillar — it claims ground that belongs to somebody else.** The watershed leaves this room as a
   * ring plus a small region beside the pillar, and the ring's boundary is *three* closed loops:
   * the map's perimeter, a loop round the pillar and a loop round the neighbouring region. Taking
   * the longest takes the perimeter, which simplifies to the whole map — so the ring's polygon
   * covers the pillar it goes round and the region next to it, and an agent walks through a wall.
   *
   * The fix is the standard one: bridge each hole into the outer loop along a segment traversed
   * once in each direction, so what comes out is a single closed loop with a zero-width slit
   * leading into each hole. It is not a *simple* polygon and is not meant to be — it is the weakly
   * simple one every implementation of this uses, and `segmentsCross` requires a strict crossing,
   * so the two coincident bridge edges do not read as a self-intersection.
   */
  const PILLAR = ['..........', '....##....', '....##....', '..........'];

  /** Twice the signed area of a closed loop. The thing that says a hole was subtracted. */
  function twiceArea(points: Int32Array): number {
    let total = 0;
    const count = points.length / 2;
    for (let at = 0; at < count; at += 1) {
      const next = (at + 1) % count;
      total +=
        (points[at * 2] as number) * (points[next * 2 + 1] as number) -
        (points[next * 2] as number) * (points[at * 2 + 1] as number);
    }
    return total;
  }

  it('KEEPS ITS HOLES, rather than taking the longest of the loops and dropping the rest', () => {
    const contours = contoursOf(PILLAR, 0.1);
    const ring = contours.find((c) => c.region === 0)!;

    /* Every corner of the pillar is on the boundary now. The 2x2 at x 4..5, z 1..2 has corners
       at (4,1), (6,1), (6,3) and (4,3) in cell-corner units. */
    const on = new Set<string>();
    for (let at = 0; at < ring.points.length / 2; at += 1) {
      on.add(`${ring.points[at * 2]},${ring.points[at * 2 + 1]}`);
    }
    for (const corner of ['4,1', '6,1', '6,3', '4,3']) {
      expect(on.has(corner), `the pillar's corner ${corner} is on the boundary`).toBe(true);
    }
  });

  it('AND THE HOLES ARE SUBTRACTED, which is the winding being opposite', () => {
    /*
     * **A hole wound the same way as the outer loop adds its area instead of removing it**, and
     * every test about corners passes either way — the loop visits the same points. The shoelace
     * sum is what tells them apart. Ten by four is 40; the pillar takes 4 and the region beside it
     * takes 4, so the ring is 32. Wound the wrong way it comes to 48.
     */
    const ring = contoursOf(PILLAR, 0.1).find((c) => c.region === 0)!;
    expect(Math.abs(twiceArea(ring.points)) / 2).toBeCloseTo(32, 6);
    expect(Math.abs(twiceArea(ring.raw)) / 2).toBeCloseTo(32, 6);
  });

  it('and the bridged loop still does not cross itself, simplified or raw', () => {
    for (const deviation of [0.1, 1.3]) {
      const ring = contoursOf(PILLAR, deviation).find((c) => c.region === 0)!;
      expect(contourSelfIntersects(ring.points), `simplified at ${deviation}`).toBe(false);
      expect(contourSelfIntersects(ring.raw), `raw at ${deviation}`).toBe(false);
    }
  });

  it('TAKES THE LARGEST LOOP BY AREA AND NOT BY POINT COUNT', () => {
    /*
     * **A hole can carry more vertices than the boundary containing it**, and picking the outer
     * loop by length then makes the hole the region — the old heuristic failing in the direction
     * nobody looks for, and the one that turns a room into a wall. A spiral corridor is the case:
     * the wall it winds around has a boundary twice the length of the room's own.
     *
     * The area is the whole assertion. One region covering every walkable cell means its contour's
     * shoelace sum is the count of them, and any other choice of outer loop gets it wrong.
     */
    const SPIRAL = [
      '.........',
      '.#######.',
      '.......#.',
      '.#####.#.',
      '.#...#.#.',
      '.#.#.#.#.',
      '.#.#...#.',
      '.#.#####.',
      '.#.......',
      '.........',
    ];
    const contours = contoursOf(SPIRAL, 0.1);
    expect(contours.length, 'one region, wound round the spiral').toBe(1);

    let walkable = 0;
    for (const row of SPIRAL) for (const cell of row) if (cell === '.') walkable += 1;
    expect(Math.abs(twiceArea(contours[0]!.raw)) / 2).toBeCloseTo(walkable, 6);
  });

  it('leaves a region with no hole exactly as it was', () => {
    /*
     * The bridge must be reachable only by a region that has one, or every mesh anybody has built
     * moves. A plain square keeps its four points and its exact raw boundary.
     *
     * **Its *simplified* area is 14 against a raw 16, and that is Douglas–Peucker inside its own
     * tolerance rather than a defect.** The loop does not start at a corner, the anchor at index
     * zero is always kept, and a real corner 0.97 cells from the chain replacing it is under the
     * 1.3 this is asked for — so it goes. `maxDeviationOf` is what states that bound and the tests
     * above it are what hold it; the thing to check about a *hole* is therefore the raw boundary,
     * which is exact, and the simplified one at a tolerance tight enough to keep every corner.
     */
    const plain = contoursOf(['....', '....', '....', '....'], 1.3)[0]!;
    expect(plain.points.length / 2).toBe(4);
    expect(Math.abs(twiceArea(plain.raw)) / 2).toBeCloseTo(16, 6);
    const other = contoursOf(PILLAR, 0.1).find((c) => c.region === 1)!;
    expect(other.points.length / 2).toBe(4);
    expect(Math.abs(twiceArea(other.raw)) / 2).toBeCloseTo(4, 6);
  });
});
