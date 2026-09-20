import { expect, test } from 'vitest';

import { MaterialChanges, ownsMaterial } from './materialChanges.ts';

/**
 * **What this file is for: one rule for what a material change is, which both backends count.**
 * The WebGPU backend rations material changes against a ring of per-frame slots and WebGL2 draws
 * them all; a line named `materials` on both is only worth reading if both count the same thing.
 * The rule lived in one backend's draw path as five separate assignments until 2026-09-19.
 */
test('A DRAW OWNS ITS MATERIAL when any option differs from the pass: dimmed, unlit, unfogged, not tone mapped, refracting', () => {
  const plain = { opacity: 1, lit: true, fog: true, toneMapped: true, refracting: false };
  expect(ownsMaterial(plain)).toBe(false);
  expect(ownsMaterial({ ...plain, opacity: 0.99 })).toBe(true);
  expect(ownsMaterial({ ...plain, lit: false })).toBe(true);
  expect(ownsMaterial({ ...plain, fog: false })).toBe(true);
  expect(ownsMaterial({ ...plain, toneMapped: false })).toBe(true);
  expect(ownsMaterial({ ...plain, refracting: true })).toBe(true);
});

test('A RUN OF DRAWS SHARES ONE MATERIAL until something dirties it', () => {
  const materials = new MaterialChanges();
  expect(materials.open).toBe(false);
  materials.slot = 0;
  expect(materials.open).toBe(true);
  materials.dirty();
  expect([materials.open, materials.slot]).toEqual([false, -1]);
});
