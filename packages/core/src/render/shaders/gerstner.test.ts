import { expect, test } from 'vitest';
import { GERSTNER_GLSL } from './gerstner.ts';
import { WATER_VERT } from './water.ts';
import { CAUSTICS_FRAG } from './caustics.ts';

test('the water surface and the light it throws compile the same wave field', () => {
  /*
   * The one contract this feature has. The light crawling across a bridge soffit
   * is worth having only because it belongs to the crests visible five metres
   * away, and the *only* thing that keeps those two in step is that they are
   * computed from one table, one dispersion relation and one clock.
   *
   * A future edit that tunes the sea and leaves a second copy of the waves
   * behind would not fail any other test in this suite, would not look wrong in a
   * still, and would quietly turn the marketing shot back into an animated
   * texture. This is the tripwire for that, and it is cheap.
   */
  for (const [name, source] of [
    ['the sea surface', WATER_VERT],
    ['the caustics it throws', CAUSTICS_FRAG],
  ] as const) {
    expect(source, name).toContain(GERSTNER_GLSL);
  }
});
