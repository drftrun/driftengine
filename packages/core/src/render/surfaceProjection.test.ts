import { expect, it } from 'vitest';

import { PROJECTION_FLOATS, packSurfaceProjection, projects } from './surfaceProjection.ts';

/*
 * **The vector is a contract with `shaders/flat/worldUv.ts`**, which reads its kind in x — above a
 * half for any projection, above one and a half for triplanar — its repeats a metre in y and its
 * sharpness in z. Written out by hand.
 */
it('PACKS A PROJECTION AS ITS KIND, ITS REPEATS A METRE AND ITS SHARPNESS', () => {
  const out = new Float32Array(PROJECTION_FLOATS).fill(9);
  packSurfaceProjection({ kind: 'planar', scale: 2 }, out);
  expect(Array.from(out)).toEqual([1, 2, 4, 0]);
  packSurfaceProjection({ kind: 'triplanar', scale: 0.5, sharpness: 8 }, out);
  expect(Array.from(out)).toEqual([2, 0.5, 8, 0]);
  packSurfaceProjection(null, out);
  expect(Array.from(out)).toEqual([0, 0, 0, 0]);
});

/* A scale that would collapse the texture to a point projects nothing, and says so to the switch. */
it('PROJECTS NOTHING AT A SCALE THAT IS NOT A POSITIVE NUMBER', () => {
  const out = new Float32Array(PROJECTION_FLOATS);
  for (const scale of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    packSurfaceProjection({ kind: 'planar', scale }, out);
    expect(out[0], `scale ${scale}`).toBe(0);
    expect(projects({ kind: 'planar', scale }), `scale ${scale}`).toBe(false);
  }
  expect(projects({ kind: 'triplanar', scale: 1 })).toBe(true);
});
