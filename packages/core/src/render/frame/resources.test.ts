import { expect, test } from 'vitest';
import { FRAME_RESOURCES, RESOURCE_COUNT, maskOf, namesIn, resourceBit } from './resources.ts';

test('the table fits in a 32-bit mask, which is what lets a mask be a number', () => {
  expect(RESOURCE_COUNT).toBe(FRAME_RESOURCES.length);
  expect(RESOURCE_COUNT).toBeLessThanOrEqual(31);
});

test('every resource has a distinct bit', () => {
  const bits = FRAME_RESOURCES.map(resourceBit);
  expect(new Set(bits).size).toBe(bits.length);
  expect(bits.every((b) => b > 0)).toBe(true);
});

test('a mask round-trips through the names it was built from', () => {
  const mask = maskOf('sceneColor', 'sceneDepth', 'canvas');
  expect(namesIn(mask).sort()).toEqual(['canvas', 'sceneColor', 'sceneDepth']);
});

test('an empty mask names nothing', () => {
  expect(namesIn(0)).toEqual([]);
});
