import { expect, test } from 'vitest';

import { ALPHA_TEST_OFF, alphaKept } from './alphaTest.ts';

test('A CUTOFF OF ZERO KEEPS EVERYTHING, which is what makes the default free', () => {
  /* Including a fully transparent texel: cutoff zero means the material never asked for a test,
     not that it asked for one at zero. A material that says nothing draws what it drew before. */
  expect(alphaKept(0, ALPHA_TEST_OFF)).toBe(true);
  expect(alphaKept(1, ALPHA_TEST_OFF)).toBe(true);
});

test('THE TEST IS >=, so a texel exactly at the cutoff is kept', () => {
  /* The boundary every alpha test gets wrong, and it shows as a one-texel seam around every leaf
     rather than as anything failing. GLSL's own `discard(a < cutoff)` convention is this one. */
  expect(alphaKept(0.5, 0.5)).toBe(true);
  expect(alphaKept(0.4999, 0.5)).toBe(false);
  expect(alphaKept(0.5001, 0.5)).toBe(true);
});

test('a cutoff above one discards everything, and does not throw', () => {
  /* A consumer may write 255 meaning "opaque only". The honest answer is an invisible surface,
     which they can see, rather than an exception inside a frame. */
  expect(alphaKept(1, 2)).toBe(false);
});

test('a NaN alpha is discarded rather than kept', () => {
  /* Every comparison against NaN is false, so `a < cutoff` keeps it and `a >= cutoff` drops it.
     Dropping is right: a texel whose alpha is not a number is a broken texture, and an invisible
     surface is findable where a surface lit by nonsense is not. */
  expect(alphaKept(Number.NaN, 0.5)).toBe(false);
});

test('A MATERIAL THAT ASKED FOR NO TEST CANNOT BE DISCARDED BY ONE, EVEN ON A NAN', () => {
  /*
   * **The one input the guard is visible at**, and without it the guard is a line that can be
   * deleted with nothing failing — which is how it was found. Everywhere else `alpha >= 0` is true
   * anyway, so the early return and the comparison agree; at a NaN alpha they part company, because
   * every comparison against NaN is false and the bare comparison would discard the fragment.
   *
   * Discarding it would be wrong rather than merely different. A material with no cutout never
   * reads a base-colour texture at all, so there is no alpha for it to have an opinion about; what
   * reaches here is whatever the caller had in a register. A surface that vanishes because of a
   * value nothing asked for is the worst kind of defect — it is invisible, and it is invisible in
   * exactly the geometry it destroys.
   */
  expect(alphaKept(Number.NaN, ALPHA_TEST_OFF)).toBe(true);

  /*
   * **And the guard is `<=` rather than `=== 0`** for the same reason one step along: a consumer
   * who wrote -1 for "no test" — which is what this engine's own light records use for an absent
   * cone and an absent photometric profile, so it is the value somebody reaches for — must get the
   * same answer as one who wrote 0.
   */
  expect(alphaKept(Number.NaN, -1)).toBe(true);
  expect(alphaKept(0, -1)).toBe(true);
});

test('A CUTOFF THAT IS NOT A NUMBER IS NOT A TEST, which a device settled', () => {
  /*
   * **The device disagreed with this file and the device was right.** WGSL does not require an
   * implementation to support NaN, so a shader may be compiled on the assumption that one never
   * arrives; written as `cutoff <= 0` the guard let a NaN cutoff fall through to `alpha >= NaN`,
   * which is false for every alpha, so this file discarded the whole surface while the device drew
   * all of it — four disagreements the first time `scripts/gpu-parity.mjs` ran the pair.
   *
   * Keeping is also the answer to prefer on its own merits: a cutoff that is not a number is a
   * material somebody built wrong, and a surface they can see is findable where one that silently
   * vanished is not.
   */
  expect(alphaKept(0, Number.NaN)).toBe(true);
  expect(alphaKept(0.5, Number.NaN)).toBe(true);
  expect(alphaKept(1, Number.NaN)).toBe(true);
  expect(alphaKept(Number.NaN, Number.NaN)).toBe(true);
});
