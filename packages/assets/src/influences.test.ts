import { expect, it } from 'vitest';

import { writeInfluences } from './influences.ts';

function sets(vertices: number): {
  joints: Float32Array;
  weights: Float32Array;
  joints2: Float32Array;
  weights2: Float32Array;
} {
  return {
    joints: new Float32Array(vertices * 4),
    weights: new Float32Array(vertices * 4),
    joints2: new Float32Array(vertices * 4),
    weights2: new Float32Array(vertices * 4),
  };
}

/*
 * Six influences survive as six: the four heaviest in the first set, heaviest first, and the other
 * two in the second. Hand-derived: they sum to one already, so nothing is rescaled.
 */
it('KEEPS SIX INFLUENCES AS SIX, the heaviest four first', () => {
  const out = sets(1);
  const report = writeInfluences(
    [
      { joint: 1, weight: 0.3 },
      { joint: 3, weight: 0.05 },
      { joint: 5, weight: 0.4 },
      { joint: 2, weight: 0.1 },
      { joint: 4, weight: 0.05 },
      { joint: 6, weight: 0.1 },
    ],
    out,
    0,
  );
  expect(Array.from(out.joints)).toEqual([5, 1, 2, 6]);
  expect(Array.from(out.weights).map((w) => +w.toFixed(4))).toEqual([0.4, 0.3, 0.1, 0.1]);
  expect(Array.from(out.joints2)).toEqual([3, 4, 0, 0]);
  expect(Array.from(out.weights2).map((w) => +w.toFixed(4))).toEqual([0.05, 0.05, 0, 0]);
  expect(report).toEqual({ dropped: false, rescaled: false, second: true });
});

/* Nine keep the eight heaviest, renormalised over what is kept, and say one was dropped. */
it('keeps the eight heaviest of nine and renormalises them', () => {
  const out = sets(1);
  const nine = [0.2, 0.15, 0.15, 0.1, 0.1, 0.1, 0.1, 0.05, 0.05].map((weight, joint) => ({
    joint,
    weight,
  }));
  const report = writeInfluences(nine, out, 0);
  let sum = 0;
  for (const w of [...out.weights, ...out.weights2]) sum += w;
  expect(sum).toBeCloseTo(1, 6);
  /* 0.95 was kept, so each weight is scaled by 1/0.95: the heaviest 0.2 becomes 0.2105. */
  expect(out.weights[0]).toBeCloseTo(0.2 / 0.95, 6);
  expect(report).toEqual({ dropped: true, rescaled: false, second: true });
});

/* Four or fewer leave the second set empty, and say so, so a mesh of them carries no second set. */
it('leaves the second set empty for four influences or fewer', () => {
  const out = sets(2);
  const report = writeInfluences(
    [
      { joint: 2, weight: 0.5 },
      { joint: 7, weight: 0.5 },
    ],
    out,
    1,
  );
  expect(Array.from(out.joints.subarray(4))).toEqual([2, 7, 0, 0]);
  expect(Array.from(out.weights2)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  expect(report.second).toBe(false);
});

/* A set that does not sum to one is rescaled over all eight, and reported. */
it('rescales a set that does not sum to one, and reports it', () => {
  const out = sets(1);
  const report = writeInfluences(
    [
      { joint: 0, weight: 0.25 },
      { joint: 1, weight: 0.25 },
    ],
    out,
    0,
  );
  expect(out.weights[0]).toBeCloseTo(0.5, 6);
  expect(report.rescaled).toBe(true);
});
