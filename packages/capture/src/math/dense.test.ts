import { mulberry32 } from '@driftengine/core';
import { expect, test } from 'vitest';

import { cholesky, levenbergMarquardt, svd3, svdN, symmetricEigen } from './dense.ts';

/**
 * **The decompositions structure from motion needs, held to their own identities.** A
 * decomposition is right when it reconstructs what it decomposed and when its factors have the
 * properties they claim — orthogonal columns, an ordered spectrum, a triangle whose square is the
 * matrix — so that is what these assert, rather than numbers copied from a library.
 *
 * Everything here is in double precision, and the tolerances are what double arithmetic leaves
 * after a few hundred rotations: 1e-12 relative on a reconstruction.
 */

const seeded = (seed: number): (() => number) => {
  const random = mulberry32(seed);
  return () => random() * 2 - 1;
};

const matrix = (rows: number, cols: number, next: () => number): Float64Array =>
  Float64Array.from({ length: rows * cols }, () => next());

/** `a · b` for row-major matrices, `[rows × inner] · [inner × cols]`. */
function multiply(
  a: Float64Array,
  b: Float64Array,
  rows: number,
  inner: number,
  cols: number,
): Float64Array {
  const out = new Float64Array(rows * cols);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      let sum = 0;
      for (let k = 0; k < inner; k += 1)
        sum += (a[r * inner + k] as number) * (b[k * cols + c] as number);
      out[r * cols + c] = sum;
    }
  }
  return out;
}

const worst = (a: Float64Array, b: Float64Array): number => {
  let out = 0;
  for (let i = 0; i < a.length; i += 1)
    out = Math.max(out, Math.abs((a[i] as number) - (b[i] as number)));
  return out;
};

test('A SINGULAR VALUE DECOMPOSITION RECONSTRUCTS WHAT IT DECOMPOSED, with orthogonal factors', () => {
  const next = seeded(20260920);
  for (const [rows, cols] of [
    [3, 3],
    [5, 3],
    [8, 6],
    [4, 4],
  ] as const) {
    const m = matrix(rows, cols, next);
    const u = new Float64Array(rows * cols);
    const s = new Float64Array(cols);
    const v = new Float64Array(cols * cols);
    svdN(m, rows, cols, u, s, v);
    /* U · diag(S) · Vᵀ is the matrix again. */
    const scaled = new Float64Array(rows * cols);
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1)
        scaled[r * cols + c] = (u[r * cols + c] as number) * (s[c] as number);
    }
    const transposed = new Float64Array(cols * cols);
    for (let r = 0; r < cols; r += 1) {
      for (let c = 0; c < cols; c += 1) transposed[r * cols + c] = v[c * cols + r] as number;
    }
    expect(
      worst(multiply(scaled, transposed, rows, cols, cols), m),
      `${rows}×${cols}`,
    ).toBeLessThan(1e-12);
    /* Vᵀ · V is the identity, and the values come down in order. */
    const gram = multiply(transposed, v, cols, cols, cols);
    for (let r = 0; r < cols; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        expect(Math.abs((gram[r * cols + c] as number) - (r === c ? 1 : 0))).toBeLessThan(1e-13);
      }
    }
    for (let c = 1; c < cols; c += 1) expect(s[c - 1]).toBeGreaterThanOrEqual(s[c] as number);
  }
});

test('a matrix short of full rank has a singular value at the size of the arithmetic, not a small one', () => {
  const next = seeded(7);
  /* Two independent columns, the third their sum: the last singular value is a rounding. */
  const m = matrix(6, 3, next);
  for (let r = 0; r < 6; r += 1) {
    m[r * 3 + 2] = (m[r * 3] as number) + (m[r * 3 + 1] as number);
  }
  const s = new Float64Array(3);
  svdN(m, 6, 3, new Float64Array(18), s, new Float64Array(9));
  expect(s[0]).toBeGreaterThan(0.5);
  expect(s[2]).toBeLessThan(1e-15 * (s[0] as number));
  /* A 3 × 3 of rank one: two of its three values are the arithmetic's noise. */
  const outer = new Float64Array(9);
  const column = [0.3, -0.7, 0.2];
  const row = [1.1, 0.5, -0.4];
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) outer[r * 3 + c] = (column[r] as number) * (row[c] as number);
  }
  const three = new Float64Array(3);
  svd3(outer, new Float64Array(9), three, new Float64Array(9));
  expect(three[0]).toBeCloseTo(Math.hypot(...column) * Math.hypot(...row), 12);
  expect(three[1]).toBeLessThan(1e-15 * (three[0] as number));
});

test('THE EIGENVECTORS OF A SYMMETRIC MATRIX DIAGONALISE IT, in falling order', () => {
  const next = seeded(11);
  const n = 5;
  const a = matrix(n, n, next);
  const m = new Float64Array(n * n);
  for (let r = 0; r < n; r += 1) {
    for (let c = 0; c < n; c += 1)
      m[r * n + c] = ((a[r * n + c] as number) + (a[c * n + r] as number)) / 2;
  }
  const values = new Float64Array(n);
  const vectors = new Float64Array(n * n);
  symmetricEigen(m, n, values, vectors);
  for (let c = 1; c < n; c += 1) expect(values[c - 1]).toBeGreaterThanOrEqual(values[c] as number);
  /* M · v = λ · v for each, which is the whole claim. */
  for (let c = 0; c < n; c += 1) {
    for (let r = 0; r < n; r += 1) {
      let sum = 0;
      for (let k = 0; k < n; k += 1)
        sum += (m[r * n + k] as number) * (vectors[k * n + c] as number);
      expect(Math.abs(sum - (values[c] as number) * (vectors[r * n + c] as number))).toBeLessThan(
        1e-12,
      );
    }
  }
});

test('CHOLESKY REFUSES A MATRIX THAT IS NOT POSITIVE DEFINITE rather than answering NaN', () => {
  /* A positive definite one factors, and the triangle times its transpose is the matrix. */
  const m = Float64Array.from([4, 12, -16, 12, 37, -43, -16, -43, 98]);
  const lower = new Float64Array(9);
  expect(cholesky(m, 3, lower)).toBe(true);
  /* The textbook answer: [[2,0,0],[6,1,0],[-8,5,3]]. */
  expect(Array.from(lower)).toEqual([2, 0, 0, 6, 1, 0, -8, 5, 3]);
  /* One that is symmetric but indefinite, and one that is only semi-definite. */
  expect(cholesky(Float64Array.from([1, 2, 2, 1]), 2, new Float64Array(4))).toBe(false);
  expect(cholesky(Float64Array.from([1, 1, 1, 1]), 2, new Float64Array(4))).toBe(false);
  const refused = new Float64Array(4).fill(7);
  expect(cholesky(Float64Array.from([0, 0, 0, 0]), 2, refused)).toBe(false);
  expect(refused.every((value) => Number.isFinite(value))).toBe(true);
});

/**
 * A pinhole at a known pose, seen through six points: the residual is where each point lands
 * against where it was seen. The parameters are the translation and a small rotation.
 */
function cameraProblem(truth: readonly number[], points: readonly (readonly number[])[]) {
  const project = (x: Float64Array, point: readonly number[], out: [number, number]): void => {
    const [rx, ry, rz, tx, ty, tz] = [x[0], x[1], x[2], x[3], x[4], x[5]] as number[];
    /* A rotation by the vector's own axis and angle, to first order in the angle's sine. */
    const [px, py, pz] = point as [number, number, number];
    const cx = px + (ry as number) * pz - (rz as number) * py + (tx as number);
    const cy = py + (rz as number) * px - (rx as number) * pz + (ty as number);
    const cz = pz + (rx as number) * py - (ry as number) * px + (tz as number);
    out[0] = cx / cz;
    out[1] = cy / cz;
  };
  const seen = points.map((point) => {
    const out: [number, number] = [0, 0];
    project(Float64Array.from(truth), point, out);
    return out;
  });
  return {
    residuals: points.length * 2,
    parameters: 6,
    project,
    evaluate(x: Float64Array, residuals: Float64Array, jacobian: Float64Array | null): void {
      const out: [number, number] = [0, 0];
      points.forEach((point, at) => {
        project(x, point, out);
        residuals[at * 2] = out[0] - ((seen[at] as [number, number])[0] as number);
        residuals[at * 2 + 1] = out[1] - ((seen[at] as [number, number])[1] as number);
      });
      if (jacobian === null) return;
      /* Derivatives by a central difference, which is what a caller without gradients would do. */
      const step = 1e-6;
      const moved = Float64Array.from(x);
      for (let p = 0; p < 6; p += 1) {
        for (const sign of [1, -1]) {
          moved[p] = (x[p] as number) + sign * step;
          points.forEach((point, at) => {
            project(moved, point, out);
            const first = out[0] - ((seen[at] as [number, number])[0] as number);
            const second = out[1] - ((seen[at] as [number, number])[1] as number);
            const scale = sign / (2 * step);
            if (sign > 0) {
              jacobian[at * 2 * 6 + p] = first * scale;
              jacobian[(at * 2 + 1) * 6 + p] = second * scale;
            } else {
              jacobian[at * 2 * 6 + p] += first * scale;
              jacobian[(at * 2 + 1) * 6 + p] += second * scale;
            }
          });
        }
        moved[p] = x[p] as number;
      }
    },
  };
}

const POINTS = [
  [0.2, 0.1, 4],
  [-0.4, 0.3, 5],
  [0.6, -0.2, 3.5],
  [-0.1, -0.5, 6],
  [0.35, 0.45, 4.5],
  [-0.6, 0.15, 5.5],
] as const;
const TRUTH = [0.04, -0.03, 0.02, 0.15, -0.1, 0.05];

test('LEVENBERG–MARQUARDT RECOVERS A KNOWN CAMERA FROM EXACT CORRESPONDENCES', () => {
  const problem = cameraProblem(TRUTH, POINTS);
  const x = Float64Array.from([0, 0, 0, 0, 0, 0]);
  const { cost } = levenbergMarquardt(problem, x);
  expect(cost).toBeLessThan(1e-18);
  for (let p = 0; p < 6; p += 1) expect(x[p]).toBeCloseTo(TRUTH[p] as number, 9);
});

test('THE DAMPING IS THE REASON IT EXISTS: it steps where Gauss–Newton has no step to take', () => {
  /*
   * Six points on the optical axis. Turning the camera about that axis moves none of them, so one
   * parameter has no derivative anywhere and `JᵀJ` is singular: Gauss–Newton's normal equations
   * cannot be factored and it stops where it started. The damping makes them positive definite,
   * and what is left of the pose is recovered exactly — the turn about the axis stays where it
   * began, which is the honest answer, since nothing observed it.
   */
  const axis = [
    [0, 0, 4],
    [0, 0, 5],
    [0, 0, 3.5],
    [0, 0, 6],
    [0, 0, 4.5],
    [0, 0, 5.5],
  ] as const;
  const problem = cameraProblem(TRUTH, axis);
  const start = [1.5, -1.5, 1.5, 0, 0, -3];
  const plain = Float64Array.from(start);
  const damped = Float64Array.from(start);
  const undamped = levenbergMarquardt(problem, plain, { damping: 0, maxIterations: 60 });
  const proper = levenbergMarquardt(problem, damped, { maxIterations: 60 });
  expect(proper.cost).toBeLessThan(1e-16);
  expect(undamped.cost).toBeGreaterThan(1);
  /* Gauss–Newton moved nothing at all: there was no step it could take. */
  expect(Array.from(plain)).toEqual(start);
  /* Every parameter the points can see is the truth's; the turn about the axis is not one. */
  for (const p of [0, 1, 3, 4, 5]) expect(damped[p]).toBeCloseTo(TRUTH[p] as number, 7);
});

test('a step that would cost more is rejected, which is what stops it cycling for ever', () => {
  /*
   * One parameter, one residual: x / √(1 + x²), zero at the origin. Its derivative falls away as
   * fast as it does, so the Gauss–Newton step is −x(1 + x²): from 10 it lands a thousand away, and
   * from there further still. Levenberg–Marquardt tries that step, sees it cost more, raises the
   * damping and takes a shorter one — **without that rejection this same code runs away to 10⁴**,
   * so the test starts far enough out for the rejection rather than the damping to be what decides.
   */
  const problem = {
    residuals: 1,
    parameters: 1,
    evaluate(x: Float64Array, residuals: Float64Array, jacobian: Float64Array | null): void {
      const value = x[0] as number;
      const root = Math.sqrt(1 + value * value);
      residuals[0] = value / root;
      if (jacobian !== null) jacobian[0] = 1 / (root * root * root);
    },
  };
  const damped = Float64Array.from([10]);
  const plain = Float64Array.from([10]);
  const proper = levenbergMarquardt(problem, damped, { maxIterations: 200 });
  const undamped = levenbergMarquardt(problem, plain, { damping: 0, maxIterations: 200 });
  expect(proper.cost).toBeLessThan(1e-20);
  expect(Math.abs(damped[0] as number)).toBeLessThan(1e-10);
  /* Gauss–Newton is exactly where it started, two hundred steps later. */
  expect(Math.abs(plain[0] as number)).toBeGreaterThan(1);
  expect(undamped.cost).toBeGreaterThan(0.4);
});

test('the factor is a triangle: whatever was above its diagonal is gone', () => {
  const m = Float64Array.from([4, 12, -16, 12, 37, -43, -16, -43, 98]);
  const out = new Float64Array(9).fill(7);
  expect(cholesky(m, 3, out)).toBe(true);
  expect([out[1], out[2], out[5]]).toEqual([0, 0, 0]);
  /* And factoring in place answers the same, since only the lower triangle is read. */
  const both = Float64Array.from(m);
  expect(cholesky(both, 3, both)).toBe(true);
  expect(Array.from(both)).toEqual(Array.from(out));
});
