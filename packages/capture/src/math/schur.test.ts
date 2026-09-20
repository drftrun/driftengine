import { mulberry32 } from '@driftengine/core';
import { expect, test } from 'vitest';

import { cholesky, choleskySolve } from './dense.ts';
import { schurSolve, type BlockNormals } from './schur.ts';

/**
 * **The Schur complement is an ordering, not an approximation**, and that is what these assert: the
 * step it answers is the step a dense solve of the same normal equations answers, to the last few
 * digits a double carries. A bundle adjuster uses it because the points outnumber the cameras by
 * orders of magnitude and each point touches only its own rows — eliminating them leaves a system
 * the size of the cameras, which is the difference between a solve that is possible and one that
 * is not.
 */

const CAMERA = 6;
const POINT = 3;

/** A small block system whose whole matrix is positive definite, and its links. */
function problem(
  cameras: number,
  points: number,
  links: readonly (readonly [number, number])[],
  seed: number,
): BlockNormals {
  const random = mulberry32(seed);
  const next = (): number => random() * 2 - 1;
  const block = (n: number, weight: number): Float64Array => {
    const a = Float64Array.from({ length: n * n }, () => next());
    const out = new Float64Array(n * n);
    for (let r = 0; r < n; r += 1) {
      for (let c = 0; c < n; c += 1) {
        let sum = 0;
        for (let k = 0; k < n; k += 1) sum += (a[k * n + r] as number) * (a[k * n + c] as number);
        out[r * n + c] = sum + (r === c ? weight : 0);
      }
    }
    return out;
  };
  const cameraBlocks = new Float64Array(cameras * CAMERA * CAMERA);
  for (let c = 0; c < cameras; c += 1) cameraBlocks.set(block(CAMERA, 12), c * CAMERA * CAMERA);
  const pointBlocks = new Float64Array(points * POINT * POINT);
  for (let p = 0; p < points; p += 1) pointBlocks.set(block(POINT, 12), p * POINT * POINT);
  return {
    cameras,
    cameraSize: CAMERA,
    points,
    cameraBlocks,
    pointBlocks,
    links: Float64Array.from({ length: links.length * CAMERA * POINT }, () => next()),
    linkCamera: Int32Array.from(links.map(([camera]) => camera)),
    linkPoint: Int32Array.from(links.map(([, point]) => point)),
    cameraGradient: Float64Array.from({ length: cameras * CAMERA }, () => next()),
    pointGradient: Float64Array.from({ length: points * POINT }, () => next()),
  };
}

/** The same system as one dense matrix, and the step a dense Cholesky answers for it. */
function dense(normals: BlockNormals, damping: number): Float64Array {
  const { cameras, points } = normals;
  const n = cameras * CAMERA + points * POINT;
  const m = new Float64Array(n * n);
  const rhs = new Float64Array(n);
  for (let c = 0; c < cameras; c += 1) {
    for (let r = 0; r < CAMERA; r += 1) {
      rhs[c * CAMERA + r] = normals.cameraGradient[c * CAMERA + r] as number;
      for (let k = 0; k < CAMERA; k += 1) {
        const value = normals.cameraBlocks[(c * CAMERA + r) * CAMERA + k] as number;
        m[(c * CAMERA + r) * n + c * CAMERA + k] =
          r === k ? value * (1 + damping) + damping : value;
      }
    }
  }
  const first = cameras * CAMERA;
  for (let p = 0; p < points; p += 1) {
    for (let r = 0; r < POINT; r += 1) {
      rhs[first + p * POINT + r] = normals.pointGradient[p * POINT + r] as number;
      for (let k = 0; k < POINT; k += 1) {
        const value = normals.pointBlocks[(p * POINT + r) * POINT + k] as number;
        m[(first + p * POINT + r) * n + first + p * POINT + k] =
          r === k ? value * (1 + damping) + damping : value;
      }
    }
  }
  for (let link = 0; link < normals.linkCamera.length; link += 1) {
    const camera = normals.linkCamera[link] as number;
    const point = normals.linkPoint[link] as number;
    for (let r = 0; r < CAMERA; r += 1) {
      for (let k = 0; k < POINT; k += 1) {
        const value = normals.links[(link * CAMERA + r) * POINT + k] as number;
        m[(camera * CAMERA + r) * n + first + point * POINT + k] += value;
        m[(first + point * POINT + k) * n + camera * CAMERA + r] += value;
      }
    }
  }
  const factor = new Float64Array(n * n);
  expect(cholesky(m, n, factor), 'the dense system is positive definite').toBe(true);
  const step = Float64Array.from(rhs);
  choleskySolve(factor, n, step);
  return step;
}

test('THE SCHUR COMPLEMENT ANSWERS THE STEP A DENSE SOLVE ANSWERS, cameras and points alike', () => {
  const links = [
    [0, 0],
    [0, 1],
    [0, 2],
    [1, 0],
    [1, 2],
    [2, 1],
    [2, 2],
    [2, 3],
    [1, 3],
  ] as const;
  const normals = problem(3, 4, links, 20260920);
  for (const damping of [0, 1e-3, 5]) {
    const expected = dense(normals, damping);
    const cameraStep = new Float64Array(3 * CAMERA);
    const pointStep = new Float64Array(4 * POINT);
    expect(schurSolve(normals, damping, cameraStep, pointStep)).toBe(true);
    for (let i = 0; i < cameraStep.length; i += 1) {
      expect(Math.abs((cameraStep[i] as number) - (expected[i] as number))).toBeLessThan(1e-9);
    }
    for (let i = 0; i < pointStep.length; i += 1) {
      const at = 3 * CAMERA + i;
      expect(Math.abs((pointStep[i] as number) - (expected[at] as number))).toBeLessThan(1e-9);
    }
  }
});

test('a point nothing constrains is refused rather than divided by, and so is a singular reduction', () => {
  const normals = problem(2, 2, [[0, 0]], 5);
  /* A point whose own block is zero: eliminating it would divide by nothing. */
  const empty = { ...normals, pointBlocks: new Float64Array(normals.pointBlocks.length) };
  expect(schurSolve(empty, 0, new Float64Array(2 * CAMERA), new Float64Array(2 * POINT))).toBe(
    false,
  );
  /*
   * A point no camera saw, whose block is zero: nothing links it, so the cameras' own system would
   * factor happily and the point's step would come back as a division by nothing. It is refused at
   * the point rather than answered as a step full of infinities.
   */
  const lonely = { ...normals, pointBlocks: Float64Array.from(normals.pointBlocks) };
  lonely.pointBlocks.fill(0, POINT * POINT);
  const cameraStep = new Float64Array(2 * CAMERA);
  const pointStep = new Float64Array(2 * POINT);
  expect(schurSolve(lonely, 0, cameraStep, pointStep)).toBe(false);
  expect(pointStep.every((value) => Number.isFinite(value))).toBe(true);
  /* And a camera nothing constrains leaves the reduced system singular, which is also refused. */
  const loose = { ...normals, cameraBlocks: new Float64Array(normals.cameraBlocks.length) };
  expect(schurSolve(loose, 0, new Float64Array(2 * CAMERA), new Float64Array(2 * POINT))).toBe(
    false,
  );
});
