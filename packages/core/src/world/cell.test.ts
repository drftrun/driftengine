import { mat4 } from 'gl-matrix';
import { describe, expect, test } from 'vitest';
import {
  cellBounds,
  cellCoord,
  cellCoordInRange,
  cellCoordsOf,
  cellIdFor,
  cellIdFrom,
  cellsInFrustum,
  cellsInRadius,
  createCellGrid,
} from './cell.ts';

test('a position maps to one cell and the cell bounds contain it', () => {
  const id = cellIdFor(300, 10, -50, 256);
  const bounds = new Float64Array(4);
  cellBounds(id, 256, bounds);
  expect(300).toBeGreaterThanOrEqual(bounds[0] as number);
  expect(300).toBeLessThan((bounds[0] as number) + (bounds[3] as number));
  expect(-50).toBeGreaterThanOrEqual(bounds[2] as number);
});

test('a position exactly on a boundary picks one side, not both and not neither', () => {
  expect(cellCoord(0, 256)).toBe(0);
  expect(cellCoord(256, 256)).toBe(1);
  expect(cellCoord(-0.000001, 256)).toBe(-1);
  expect(cellIdFor(256, 0, 0, 256)).not.toBe(cellIdFor(255.999, 0, 0, 256));
});

test('negative coordinates work, which a naive bit-packing breaks', () => {
  const coords = new Int32Array(3);
  cellCoordsOf(cellIdFrom(-5, -600, -60000), coords);
  expect(Array.from(coords)).toEqual([-5, -600, -60000]);
});

test('a coordinate past the packing throws rather than aliasing a distant cell', () => {
  expect(() => cellIdFrom(-5, -600, -70000)).toThrow(RangeError);
  expect(() => cellIdFrom(70000, 0, 0)).toThrow(/outside/);
});

test('the range boundary itself is in range on one side and not the other', () => {
  expect(cellCoordInRange(-65536)).toBe(true);
  expect(cellCoordInRange(65535)).toBe(true);
  expect(cellCoordInRange(65536)).toBe(false);
});

test('identifiers round-trip across the whole declared range', () => {
  const coords = new Int32Array(3);
  for (const c of [-65536, -1, 0, 1, 65535]) {
    cellCoordsOf(cellIdFrom(c, c, c), coords);
    expect(Array.from(coords)).toEqual([c, c, c]);
  }
});

test('an identifier stays an exact integer in a double', () => {
  const id = cellIdFrom(65535, 65535, 65535);
  expect(Number.isSafeInteger(id)).toBe(true);
});

test('two different cells never share an identifier', () => {
  const seen = new Set<number>();
  for (let x = -3; x <= 3; x += 1) {
    for (let y = -3; y <= 3; y += 1) {
      for (let z = -3; z <= 3; z += 1) seen.add(cellIdFrom(x, y, z));
    }
  }
  expect(seen.size).toBe(7 * 7 * 7);
});

test('a radius query is symmetric about its centre', () => {
  const a: number[] = [];
  const b: number[] = [];
  cellsInRadius(0, 0, 0, 300, 256, a);
  cellsInRadius(512, 512, 512, 300, 256, b);
  expect(a.length).toBe(b.length);
});

test('a radius query includes the cell the point is in', () => {
  const out: number[] = [];
  cellsInRadius(300, 10, -50, 1, 256, out);
  expect(out).toContain(cellIdFor(300, 10, -50, 256));
});

test('a radius touching a neighbouring cell includes it, because conservative is the safe way', () => {
  const out: number[] = [];
  cellsInRadius(255, 0, 0, 2, 256, out);
  expect(out).toContain(cellIdFor(257, 0, 0, 256));
});

/** A camera's view-projection in double precision, as gl-matrix builds one. */
function lens(
  eye: readonly [number, number, number],
  target: readonly [number, number, number],
  fovy: number,
  aspect: number,
  near: number,
  far: number,
): Float64Array {
  const projection = mat4.perspective(new Float64Array(16), fovy, aspect, near, far);
  const view = mat4.lookAt(new Float64Array(16), eye, target, [0, 1, 0]);
  return mat4.multiply(new Float64Array(16), projection, view) as Float64Array;
}

/** A point the view can see: a clip-space position inside the unit cube, taken back to the world. */
function unproject(
  viewProj: Float64Array,
  x: number,
  y: number,
  z: number,
): [number, number, number] {
  const inverse = mat4.invert(new Float64Array(16), viewProj) as Float64Array;
  const m = inverse;
  const w = (m[3] as number) * x + (m[7] as number) * y + (m[11] as number) * z + (m[15] as number);
  return [
    ((m[0] as number) * x + (m[4] as number) * y + (m[8] as number) * z + (m[12] as number)) / w,
    ((m[1] as number) * x + (m[5] as number) * y + (m[9] as number) * z + (m[13] as number)) / w,
    ((m[2] as number) * x + (m[6] as number) * y + (m[10] as number) * z + (m[14] as number)) / w,
  ];
}

describe('the cells a view looks into', () => {
  test('a grid states its cell and its limit, and refuses ones that are not', () => {
    expect(createCellGrid(256)).toEqual({ size: 256, maxCells: 65_536 });
    expect(createCellGrid(4, 100).maxCells).toBe(100);
    for (const size of [0, -1, Number.NaN, Infinity]) {
      expect(() => createCellGrid(size), String(size)).toThrow(RangeError);
    }
    for (const limit of [0, 1.5, Number.NaN]) {
      expect(() => createCellGrid(4, limit), String(limit)).toThrow(RangeError);
    }
  });

  /**
   * **Conservative is the only safe direction**, and this is the test that holds it: every point
   * the view can see is in a cell the query returned. It is the plan's "a frustum query is a
   * superset of a radius query at the same distance", asked of the cells a view can actually see
   * into — a radius query also returns the cells behind the eye, which no view wants.
   */
  test('every point a view can see is in a returned cell, over many views', () => {
    let seed = 3;
    const next = (): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed / 0x100000000;
    };
    const grid = createCellGrid(40);
    const out: number[] = [];
    let points = 0;
    for (let trial = 0; trial < 60; trial += 1) {
      const eye = [next() * 400 - 200, next() * 100 - 50, next() * 400 - 200] as const;
      const target = [
        eye[0] + next() * 2 - 1,
        eye[1] + next() - 0.5,
        eye[2] + next() * 2 - 1,
      ] as const;
      const far = 20 + next() * 180;
      const viewProj = lens(eye, target, 0.4 + next() * 1.6, 0.5 + next() * 2, 0.1 + next(), far);
      const count = cellsInFrustum(grid, viewProj, out);
      const found = new Set(out);
      expect(found.size).toBe(count);
      const radius: number[] = [];
      cellsInRadius(eye[0], eye[1], eye[2], far * 4, grid.size, radius);
      const around = new Set(radius);
      for (let at = 0; at < 200; at += 1) {
        const p = unproject(viewProj, next() * 2 - 1, next() * 2 - 1, next() * 2 - 1);
        const id = cellIdFor(p[0], p[1], p[2], grid.size);
        expect(around.has(id)).toBe(true);
        expect(found.has(id), `trial ${String(trial)} point ${p.join()}`).toBe(true);
        points += 1;
      }
    }
    expect(points).toBe(12_000);
  });

  test('does not return a cell behind the eye, beside the view or past the far plane', () => {
    /* From the middle of a cell looking down -z through ninety degrees, 240 units deep. */
    const grid = createCellGrid(100);
    const out: number[] = [];
    cellsInFrustum(grid, lens([50, 50, 50], [50, 50, -50], Math.PI / 2, 1, 1, 240), out);
    expect(out).toContain(cellIdFor(50, 50, 50, 100));
    expect(out).toContain(cellIdFor(50, 50, -150, 100));
    /* Its near corner, (200, 50, -150), is 200 deep and 150 right: inside the right-hand plane. */
    expect(out).toContain(cellIdFor(250, 50, -150, 100));
    expect(out, 'behind').not.toContain(cellIdFor(50, 50, 150, 100));
    expect(out, 'beside, level with the eye').not.toContain(cellIdFor(250, 50, 50, 100));
    expect(out, 'past the far plane').not.toContain(cellIdFor(50, 50, -350, 100));
    /* The pyramid's bounding box is 5 by 5 by 3 cells, and its corners are not all in the view. */
    expect(out.length).toBeGreaterThan(20);
    expect(out.length).toBeLessThan(75);
  });

  test('lists the cells in coordinate order and clears what the array held', () => {
    const grid = createCellGrid(100);
    const out = Array.from({ length: 200 }, () => -1);
    const count = cellsInFrustum(
      grid,
      lens([50, 50, 50], [50, 50, -50], Math.PI / 2, 1, 1, 240),
      out,
    );
    expect(out).toHaveLength(count);
    const coords = new Int32Array(3);
    const keys = out.map((id) => {
      cellCoordsOf(id, coords);
      return [coords[0] as number, coords[1] as number, coords[2] as number];
    });
    const at = (key: number[], axis: number): number => key[axis] as number;
    const sorted = [...keys].sort(
      (a, b) => at(a, 0) - at(b, 0) || at(a, 1) - at(b, 1) || at(a, 2) - at(b, 2),
    );
    expect(keys).toEqual(sorted);
  });

  describe('past the precision a single float holds', () => {
    /* 2^25 rounded down to a whole kilometre: a float's spacing here is four metres. */
    const BASE = 33_554_000;
    const grid = createCellGrid(1000);

    test('finds the same cells as at the origin, a whole number of cells along', () => {
      /*
       * The eye off every cell boundary, so that no plane passes through a cell's corner: a cell
       * that only touches the view is kept or not by the last bit of a rounding, and the last bit
       * is not the same thirty-three million units out.
       */
      const at = (x: number): Float64Array =>
        lens([x + 437.5, 263.25, 391.75], [x + 437.5, 263.25, -600], Math.PI / 2, 1, 1, 2400);
      const out: number[] = [];
      cellsInFrustum(grid, at(BASE), out);
      const home: number[] = [];
      cellsInFrustum(grid, at(0), home);
      const coords = new Int32Array(3);
      const shifted = home.map((id) => {
        cellCoordsOf(id, coords);
        return cellIdFrom(
          (coords[0] as number) + BASE / 1000,
          coords[1] as number,
          coords[2] as number,
        );
      });
      expect(out).toEqual(shifted);
      expect(out).toContain(cellIdFor(BASE + 500, 500, -1500, 1000));
      expect(out).not.toContain(cellIdFor(BASE + 500, 500, 1500, 1000));
    });

    test('decides a sliver of a cell a tenth of a metre either side of the view', () => {
      /*
       * The eye a metre short of a cell edge, just above the next row of cells, looking down -z
       * with its near plane a centimetre out: the right-hand plane passes the cell beyond that edge
       * 0.07 m inside it with the eye 1.1 m above the row, and 0.07 m outside it at 0.9. **Planes
       * held in single precision are wrong by a third of a metre out here** — they keep both — and
       * the difference between the two is not a distance they can decide.
       */
      const sliver = cellIdFor(BASE + 1000, 500, 0, 1000);
      const at = (height: number): Float64Array => {
        const eye = [BASE + 999, 500, height] as const;
        return lens(eye, [eye[0], eye[1], eye[2] - 1], Math.PI / 2, 1, 0.01, 100);
      };
      const inside: number[] = [];
      cellsInFrustum(grid, at(1.1), inside);
      expect(inside).toContain(sliver);
      /* A point 1.05 m ahead and 0.05 m into the cell, which the view does see. */
      const seen = unproject(at(1.1), 0.999, 0, 0.98115);
      expect(cellIdFor(seen[0], seen[1], seen[2], 1000)).toBe(sliver);

      const outside: number[] = [];
      cellsInFrustum(grid, at(0.9), outside);
      expect(outside).not.toContain(sliver);
      expect(outside).toContain(cellIdFor(BASE + 500, 500, 0, 1000));
    });
  });

  test('refuses a view with no far plane, and one wider than the grid allows', () => {
    const grid = createCellGrid(10, 1000);
    const endless = mat4.multiply(
      new Float64Array(16),
      mat4.perspective(new Float64Array(16), Math.PI / 2, 1, 1, Infinity),
      mat4.lookAt(new Float64Array(16), [0, 0, 0], [0, 0, -1], [0, 1, 0]),
    ) as Float64Array;
    expect(() => cellsInFrustum(grid, endless, [])).toThrow(/far plane/);
    expect(() => cellsInFrustum(grid, new Float64Array(16), [])).toThrow(/far plane/);
    /* A far plane behind the eye: some corners come back from behind it, with w below zero. */
    const inverted = mat4.multiply(
      new Float64Array(16),
      mat4.perspective(new Float64Array(16), Math.PI / 2, 1, 1, -10),
      mat4.lookAt(new Float64Array(16), [0, 0, 0], [0, 0, -1], [0, 1, 0]),
    ) as Float64Array;
    expect(() => cellsInFrustum(grid, inverted, [])).toThrow(/far plane/);
    /*
     * A lens so wide and so deep its far corners would be past the largest number there is: in
     * double precision its far plane is at infinity, and that is how it is refused.
     */
    expect(() =>
      cellsInFrustum(grid, lens([0, 0, 0], [0, 0, -1], Math.PI * 0.999999, 1, 1, 1e308), []),
    ).toThrow(/far plane/);
    /* Two hundred units deep through ninety degrees is a box of about 41 by 41 by 20 cells of ten. */
    expect(() =>
      cellsInFrustum(grid, lens([0, 0, 0], [0, 0, -1], Math.PI / 2, 1, 1, 200), []),
    ).toThrow(/spans \d+ cells, more than the 1000/);
    /* The limit is inclusive: a grid allowing exactly the span walks it, one fewer refuses. */
    let span = 0;
    try {
      cellsInFrustum(grid, lens([0, 0, 0], [0, 0, -1], Math.PI / 2, 1, 1, 200), []);
    } catch (error) {
      span = Number(/spans (\d+) cells/.exec(String(error))?.[1]);
    }
    expect(span).toBeGreaterThan(30_000);
    expect(() =>
      cellsInFrustum(
        createCellGrid(10, span - 1),
        lens([0, 0, 0], [0, 0, -1], Math.PI / 2, 1, 1, 200),
        [],
      ),
    ).toThrow(RangeError);
    expect(
      cellsInFrustum(
        createCellGrid(10, span),
        lens([0, 0, 0], [0, 0, -1], Math.PI / 2, 1, 1, 200),
        [],
      ),
    ).toBeGreaterThan(0);
  });
});
