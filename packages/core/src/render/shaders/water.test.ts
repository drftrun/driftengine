/**
 * Properties of the water shader a rewrite must not quietly drop.
 *
 * Same reasoning as `flat.test.ts`: GLSL cannot be run here, but the failure these guard
 * is a *missing term* rather than a wrong number, and a missing term in a surface this
 * large reads as a material choice rather than as a bug. Water that shades to flat
 * ambient looks like water somebody decided should be matte.
 */
import { expect, test } from 'vitest';
import { WATER_FRAG } from './water.ts';
import { MAX_POINT_LIGHTS } from '../lightBudget.ts';

test('water is lit by the lamps around it, not only by the sky', () => {
  /*
   * The surface answered to the directional source alone, which assumes water lives
   * outdoors. A flooded corridor, a cistern, an indoor pool and a harbour at night are
   * all water lit entirely by lamps, and under those this had no diffuse term and — worse
   * — no specular glitter at all, which is the strongest single cue that a surface is
   * water and not a coloured plane.
   */
  expect(WATER_FRAG, 'the light slots are declared').toContain(
    `#define MAX_LIGHTS ${MAX_POINT_LIGHTS}`,
  );
  expect(WATER_FRAG, 'and iterated').toContain('for (int i = 0; i < MAX_LIGHTS; i++)');
  expect(WATER_FRAG, 'lamps reach the diffuse term').toContain(
    'incident += uLightColor[i] * max(dot(n, lightDir), 0.0)',
  );
  expect(WATER_FRAG, 'and the glitter, which is the point').toContain(
    'highlight += uLightColor[i] * pow(max(dot(n, lampHalf), 0.0), 220.0)',
  );
  /*
   * Weighted by presence like every other consumer of these slots. Without it a lamp
   * entering the set switches on rather than fading in, and on water that is a highlight
   * appearing out of nothing.
   */
  expect(WATER_FRAG, 'lights fade in with their weight').toContain('uLightWeight[i]');
});

test('a lamp fades the same way over water as over the ground beside it', () => {
  /*
   * Both falloff shapes, chosen by the same uniform the surface shader reads. A lamp that
   * is inverse-square on stone and linear on the pool under it is one light behaving as
   * two, and the seam runs along the waterline where it is most visible.
   */
  expect(WATER_FRAG).toContain('if (uLightFalloff == 1)');
  expect(WATER_FRAG, 'windowed inverse-square, as the surface shader windows it').toContain(
    'falloff = window * window / max(lightDist * lightDist, 0.01);',
  );
});
