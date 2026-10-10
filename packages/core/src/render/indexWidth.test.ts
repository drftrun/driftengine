import { expect, it } from 'vitest';

import { MAX_UINT16_VERTICES, compactIndices } from './indexWidth.ts';

/*
 * **Sixteen bits where they hold every vertex, padded to whole words, the values untouched**;
 * thirty-two where a mesh has more vertices than sixteen bits can name. 65,536 vertices is the
 * last that fits: its highest index is 65,535.
 */
it('NARROWS INDICES TO SIXTEEN BITS WHERE EVERY VERTEX FITS, PADDED TO WHOLE WORDS', () => {
  const three = compactIndices(new Uint32Array([0, 1, 2]), 3);
  expect(three).toBeInstanceOf(Uint16Array);
  expect(Array.from(three)).toEqual([0, 1, 2, 0]);
  const last = compactIndices(new Uint32Array([65535, 0, 1, 2]), MAX_UINT16_VERTICES);
  expect(last).toBeInstanceOf(Uint16Array);
  expect(Array.from(last)).toEqual([65535, 0, 1, 2]);
  const wide = new Uint32Array([65536, 0, 1]);
  expect(compactIndices(wide, MAX_UINT16_VERTICES + 1)).toBe(wide);
});
