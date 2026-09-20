import { expect, test } from 'vitest';
import {
  clearDirty,
  createGpuScene,
  dirtyRange,
  setInstanceBounds,
  setInstanceMaterial,
  setInstanceTransform,
} from './gpuScene.ts';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

test('a fresh scene has nothing to upload', () => {
  const scene = createGpuScene(16);
  expect(dirtyRange(scene).count).toBe(0);
});

test('writing one instance marks exactly that instance', () => {
  const scene = createGpuScene(16);
  setInstanceTransform(scene, 4, IDENTITY);
  expect(dirtyRange(scene)).toEqual({ first: 4, count: 1 });
});

test('two writes mark the span between them, not two ranges', () => {
  const scene = createGpuScene(16);
  setInstanceTransform(scene, 2, IDENTITY);
  setInstanceMaterial(scene, 5, 9);
  expect(dirtyRange(scene)).toEqual({ first: 2, count: 4 });
});

test('clearing the dirty range does not clear the data', () => {
  const scene = createGpuScene(16);
  setInstanceMaterial(scene, 3, 7);
  clearDirty(scene);
  expect(dirtyRange(scene).count).toBe(0);
  expect(scene.materials[3]).toBe(7);
});

test('bounds are written as centre then radius, in that order', () => {
  const scene = createGpuScene(16);
  setInstanceBounds(scene, 1, 10, 20, 30, 40);
  expect(Array.from(scene.bounds.subarray(4, 8))).toEqual([10, 20, 30, 40]);
});

test('a transform lands at its own stride and leaves its neighbour alone', () => {
  const scene = createGpuScene(4);
  const moved = new Float32Array(IDENTITY);
  moved[12] = 5;
  setInstanceTransform(scene, 1, moved);
  expect(scene.transforms[16 + 12]).toBe(5);
  expect(scene.transforms[12]).toBe(0);
});
