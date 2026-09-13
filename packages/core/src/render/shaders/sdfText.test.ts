import { expect, test } from 'vitest';
import { SDF_TEXT_FRAG, SDF_TEXT_VERT } from './sdfText.ts';

test('the vertex stage passes the atlas coordinate through', () => {
  expect(SDF_TEXT_VERT).toContain('vUv = aUv;');
});

/*
 * The median of three channels is what makes this a *multi*-channel field: it is what
 * keeps a corner sharp where a single channel rounds it off. Asserted because dropping to
 * one channel still renders, just worse, and worse is hard to see in a diff.
 */
test('the fragment stage takes the median of three channels', () => {
  expect(SDF_TEXT_FRAG).toContain('median(');
});

/*
 * `fwidth` is what makes one atlas legible at every size: the smoothstep band has to be
 * the pixel footprint, not a constant. A constant looks right at the size it was tuned at
 * and blurs or aliases at every other one.
 */
test('the edge is antialiased against the screen-space derivative', () => {
  expect(SDF_TEXT_FRAG).toContain('fwidth');
});

/* House rule: a texture read in non-uniform control flow must state its level. */
test('the atlas is sampled at an explicit level', () => {
  expect(SDF_TEXT_FRAG).toMatch(/textureLod\(\s*uAtlas/);
});
