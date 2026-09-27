import { expect, test } from 'vitest';
import { cutoutOf } from './cutoutCaster.ts';

/**
 * Which casters cut their shadow out of their texture: the one decision both backends' depth
 * passes make, written once so the two cannot disagree about a leaf.
 */

const leafMap = { name: 'leaf' };

test('A MATERIAL WITH AN ALBEDO AND A CUTOFF CASTS A CUTOUT, with its own UV scale', () => {
  const cut = cutoutOf({ albedo: leafMap, cutout: 0.5, uScale: 2, vScale: 3 });
  expect(cut).not.toBeNull();
  expect(cut?.albedo).toBe(leafMap);
  expect(cut?.cutoff).toBe(0.5);
  expect([cut?.u, cut?.v]).toEqual([2, 3]);
});

test('no albedo, no cutoff, or no material at all is an ordinary caster', () => {
  expect(cutoutOf({ albedo: leafMap, cutout: 0 })).toBeNull();
  expect(cutoutOf({ albedo: null, cutout: 0.5 })).toBeNull();
  expect(cutoutOf({ cutout: 0.5 })).toBeNull();
  expect(cutoutOf(null)).toBeNull();
  expect(cutoutOf(undefined)).toBeNull();
});

test('the answer is written into one object and returned again, so a draw allocates nothing', () => {
  const a = cutoutOf({ albedo: leafMap, cutout: 0.5 });
  const b = cutoutOf({ albedo: leafMap, cutout: 0.25 });
  expect(a).toBe(b);
  expect(b?.cutoff).toBe(0.25);
  /* An absent scale is one, which is what an unscaled material means everywhere else. */
  expect([b?.u, b?.v]).toEqual([1, 1]);
});
