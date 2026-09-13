/**
 * Properties of the caustics shader a rewrite must not quietly drop.
 *
 * Source-level for the same reason as `flat.test.ts`: GLSL cannot be run here, and what
 * these guard is a *missing term* rather than a wrong number.
 */
import { expect, test } from 'vitest';
import { CAUSTICS_FRAG } from './caustics.ts';

test('a pool floor is lit as well as a bridge soffit', () => {
  /*
   * The effect was gated on the sheet being *above* the water — `step(0.02, drop)` — which
   * is only right when the water is a ceiling to you. A pool floor, a flooded corridor and
   * a tank under a lamp are the same optics and the more ordinary sight, and every one of
   * them was masked to nothing.
   *
   * The distance from the surface is what the fade is about; which side it is on is not.
   */
  expect(CAUSTICS_FRAG, 'distance from the water, not height above it').toContain(
    'float distanceFromWater = abs(drop);',
  );
  expect(CAUSTICS_FRAG, 'and the fade reads that distance').toContain(
    'smoothstep(uMaxDrop * 0.45, uMaxDrop, distanceFromWater)',
  );
  expect(
    CAUSTICS_FRAG.includes('step(0.02, drop)'),
    'nothing excludes a surface for being under the water',
  ).toBe(false);
  /*
   * The coplanar band still goes: a sheet lying in the water's own plane has no path
   * length to focus over and the pattern would be meaningless there.
   */
  expect(CAUSTICS_FRAG).toContain('float clear = step(0.02, distanceFromWater);');
});

test('the path length keeps its sign, so the net lands on the right side', () => {
  /*
   * `d` is the signed slant path from the sheet to the water. Taking its magnitude would
   * make a floor sample the water on the wrong side of itself, and the pattern would slide
   * the wrong way as the source moves — which is subtle standing still and obvious walking.
   */
  expect(CAUSTICS_FRAG).toContain('float d = drop * slant;');
});
