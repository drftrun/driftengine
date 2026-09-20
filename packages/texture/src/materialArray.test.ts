import { expect, test } from 'vitest';
import { arrayDescriptor, assignLayer, createMaterialArray, layerOf } from './materialArray.ts';

test('assigning a material returns a layer and looking it up returns the same one', () => {
  const array = createMaterialArray(4, 256);
  const layer = assignLayer(array, 7, 'aaaa');
  expect(layerOf(array, 7)).toBe(layer);
});

test('two materials with different content get two layers', () => {
  const array = createMaterialArray(4, 256);
  expect(assignLayer(array, 1, 'aaaa')).not.toBe(assignLayer(array, 2, 'bbbb'));
});

test('assigning the same material twice reuses its layer', () => {
  const array = createMaterialArray(4, 256);
  expect(assignLayer(array, 1, 'aaaa')).toBe(assignLayer(array, 1, 'aaaa'));
  expect(arrayDescriptor(array).layers).toBe(1);
});

test('two materials with identical content share one layer', () => {
  const array = createMaterialArray(4, 256);
  expect(assignLayer(array, 1, 'same')).toBe(assignLayer(array, 2, 'same'));
  expect(arrayDescriptor(array).layers).toBe(1);
});

test('a full array reports failure rather than evicting something still in use', () => {
  const array = createMaterialArray(2, 256);
  assignLayer(array, 1, 'a');
  assignLayer(array, 2, 'b');
  expect(assignLayer(array, 3, 'c')).toBe(-1);
  expect(layerOf(array, 1)).toBe(0);
});

test('an unassigned material has no layer', () => {
  expect(layerOf(createMaterialArray(4, 256), 99)).toBe(-1);
});

test('the descriptor reports what a bind group needs', () => {
  const array = createMaterialArray(8, 512);
  assignLayer(array, 1, 'a');
  expect(arrayDescriptor(array)).toEqual({ layers: 1, size: 512 });
});
