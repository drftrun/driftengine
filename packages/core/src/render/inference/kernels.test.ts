import { expect, test } from 'vitest';
import { OPERATORS } from '@driftengine/texture';

import { DEVICE_KERNELS } from './kernels.ts';

/**
 * **The device has a kernel for every operator the reference has, and for nothing else.**
 *
 * Two tables keyed by one set of names, in two packages that cannot import each other at run time —
 * `@driftengine/texture` holds the references and the shape rules, this holds the kernels. An
 * operator added to one and not the other is a graph that validates and then cannot run, or a
 * kernel nothing can ever reach. Held here because this package imports texture for its tests.
 */
test('THE KERNELS AND THE REFERENCES ARE THE SAME OPERATORS', () => {
  expect([...DEVICE_KERNELS.keys()].sort()).toEqual([...OPERATORS.keys()].sort());
});

test('every kernel names its inputs and its output in the binding order the runner uses', () => {
  /* Inputs at bindings 0..n−1, read-only; the output at binding n, the only one written. */
  const source = (DEVICE_KERNELS.get('add') as NonNullable<ReturnType<typeof DEVICE_KERNELS.get>>)({
    inputShapes: [[4], [4]],
    outputShape: [4],
    attributes: {},
    inputTypes: ['f32', 'f32'],
  });
  expect(source.code).toMatch(/@binding\(0\) var<storage, read> input0/);
  expect(source.code).toMatch(/@binding\(1\) var<storage, read> input1/);
  expect(source.code).toMatch(/@binding\(2\) var<storage, read_write> output/);
});

test('a weight stored at half precision is read as half and widened, and the module enables it', () => {
  const source = (
    DEVICE_KERNELS.get('linear') as NonNullable<ReturnType<typeof DEVICE_KERNELS.get>>
  )({
    inputShapes: [[2, 3], [4, 3], [4]],
    outputShape: [2, 4],
    attributes: {},
    inputTypes: ['f32', 'f16', 'f16'],
  });
  expect(source.code.startsWith('enable f16;')).toBe(true);
  expect(source.code).toMatch(/var<storage, read> input1: array<f16>/);
  expect(source.code).toMatch(/var<storage, read> input0: array<f32>/);
});
