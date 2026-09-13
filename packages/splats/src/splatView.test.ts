import { describe, expect, it } from 'vitest';
import { createSplatViewLocal, resolveSplatView } from './splatView.ts';

/**
 * A view matrix built from a rotation and a camera position, so both are known by construction.
 *
 * `view` takes world to camera, so it is `[R | -R c]` — which means the test never has to invert
 * anything to know what answer it is expecting.
 */
function viewFrom(rows: readonly number[][], camera: readonly number[]): Float32Array {
  const view = new Float32Array(16);
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 3; column++) view[column * 4 + row] = rows[row]?.[column] ?? 0;
  }
  for (let row = 0; row < 3; row++) {
    let t = 0;
    for (let column = 0; column < 3; column++)
      t += (rows[row]?.[column] ?? 0) * (camera[column] ?? 0);
    view[12 + row] = -t;
  }
  view[15] = 1;
  return view;
}

/** A column-major model matrix from a 3x3 linear part written as rows, plus a translation. */
function modelFrom(rows: readonly number[][], translation: readonly number[]): Float32Array {
  const model = new Float32Array(16);
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 3; column++) model[column * 4 + row] = rows[row]?.[column] ?? 0;
  }
  model[12] = translation[0] ?? 0;
  model[13] = translation[1] ?? 0;
  model[14] = translation[2] ?? 0;
  model[15] = 1;
  return model;
}

const IDENTITY = modelFrom(
  [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
  [0, 0, 0],
);

/** Where a capture-space point lands in the world, straight from the definition of the matrix. */
function toWorld(model: Float32Array, p: readonly number[]): number[] {
  const out: number[] = [];
  for (let row = 0; row < 3; row++) {
    out.push(
      (model[row] ?? 0) * (p[0] ?? 0) +
        (model[4 + row] ?? 0) * (p[1] ?? 0) +
        (model[8 + row] ?? 0) * (p[2] ?? 0) +
        (model[12 + row] ?? 0),
    );
  }
  return out;
}

describe('resolveSplatView', () => {
  it('hands back the camera itself when the capture is where it was authored', () => {
    /*
     * A camera at (4, 1, 0) turned to look down -x. With an identity model the capture's own space
     * *is* the world, so the answer is the camera's own forward and position and nothing else.
     */
    const view = viewFrom(
      [
        [0, 0, -1],
        [0, 1, 0],
        [1, 0, 0],
      ],
      [4, 1, 0],
    );
    const out = createSplatViewLocal();

    resolveSplatView(view, IDENTITY, out);

    /* `toBeCloseTo` rather than `toEqual`, because a negated zero is a real answer here and
       `Object.is(-0, 0)` is false — which is a difference in the test's comparison and not in the
       direction it is comparing. */
    expect(out.dirX).toBeCloseTo(-1, 6);
    expect(out.dirY).toBeCloseTo(0, 6);
    expect(out.dirZ).toBeCloseTo(0, 6);
    expect([out.originX, out.originY, out.originZ]).toEqual([4, 1, 0]);
  });

  it('orders a transformed capture exactly as the world orders it', () => {
    /*
     * **The contract, asserted rather than the arithmetic that implements it.** The sort ranks
     * splats by `dot(p - origin, dir)` in the capture's own space; what has to be true is that the
     * ranking matches the depth those splats actually have in the world once the model matrix has
     * moved them. So this takes a model with a rotation, a *non-uniform* scale and a translation —
     * the case where transforming the direction the obvious way, by the inverse, quietly stops
     * agreeing — and checks the two depths are one positive multiple of each other for every
     * point tried.
     */
    const view = viewFrom(
      [
        [0, 0, -1],
        [0, 1, 0],
        [1, 0, 0],
      ],
      [12, 3, -2],
    );
    /* A quarter turn about z, then x stretched by three and y squashed by a half. */
    const model = modelFrom(
      [
        [0, -0.5, 0],
        [3, 0, 0],
        [0, 0, 2],
      ],
      [1, -2, 4],
    );
    const camera = [12, 3, -2];
    const forward = [-1, 0, 0];

    const out = createSplatViewLocal();
    resolveSplatView(view, model, out);

    const points = [
      [0, 0, 0],
      [1, 2, 3],
      [-4, 0.5, 2],
      [7, -3, -1],
      [0.25, 0.25, 0.25],
    ];
    const ratios = points.map((p) => {
      const world = toWorld(model, p);
      const worldDepth =
        ((world[0] ?? 0) - (camera[0] ?? 0)) * (forward[0] ?? 0) +
        ((world[1] ?? 0) - (camera[1] ?? 0)) * (forward[1] ?? 0) +
        ((world[2] ?? 0) - (camera[2] ?? 0)) * (forward[2] ?? 0);
      const localDepth =
        ((p[0] ?? 0) - out.originX) * out.dirX +
        ((p[1] ?? 0) - out.originY) * out.dirY +
        ((p[2] ?? 0) - out.originZ) * out.dirZ;
      return worldDepth / localDepth;
    });

    const first = ratios[0] ?? 0;
    expect(first, 'and the multiple is positive, so far stays far').toBeGreaterThan(0);
    for (const ratio of ratios) expect(ratio).toBeCloseTo(first, 5);
  });

  it('gives a unit direction, because the re-sort gate is a dot product', () => {
    const model = modelFrom(
      [
        [0, -0.5, 0],
        [3, 0, 0],
        [0, 0, 2],
      ],
      [1, -2, 4],
    );
    const out = createSplatViewLocal();
    resolveSplatView(
      viewFrom(
        [
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1],
        ],
        [0, 0, 9],
      ),
      model,
      out,
    );

    expect(Math.hypot(out.dirX, out.dirY, out.dirZ)).toBeCloseTo(1, 6);
  });

  it('falls back to the world rather than to NaN when a capture is squashed flat', () => {
    /*
     * A singular model has no inverse, so there is no camera position in the capture's own space
     * at all. This runs inside a frame and the loop may not throw, and a NaN direction is a sort
     * whose every comparison is false — an order that is silently input order. Falling back to the
     * world leaves a capture drawing in whatever order it had, which is wrong in the same way the
     * matrix is and is at least visible.
     */
    const flat = modelFrom(
      [
        [1, 0, 0],
        [0, 0, 0],
        [0, 0, 1],
      ],
      [0, 0, 0],
    );
    const out = createSplatViewLocal();

    resolveSplatView(
      viewFrom(
        [
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1],
        ],
        [0, 0, 9],
      ),
      flat,
      out,
    );

    expect(out.dirX, 'the world forward').toBeCloseTo(0, 6);
    expect(out.dirY).toBeCloseTo(0, 6);
    expect(out.dirZ).toBeCloseTo(-1, 6);
    expect([out.originX, out.originY, out.originZ], 'and the world camera').toEqual([0, 0, 9]);
  });
});
