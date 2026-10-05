import { expect, test } from 'vitest';
import { BOLT_FRAG } from './bolt.ts';
import { BOLT_FRAG_WGSL } from './generated/bolt.wgsl.ts';

test('AN ARC STAYS FINITE WHERE MULTISAMPLING SHADES A PIXEL OFF ITS QUAD', () => {
  /*
   * With samples, an edge pixel is shaded at its centre, outside the quad, where the side
   * coordinate passes one. Unclamped, the filament's 'pow' of a negative base is NaN on both
   * backends, and the bloom spreads it into a white disc around every arc.
   */
  expect(BOLT_FRAG).toContain('float across = clamp(1.0 - abs(vSide), 0.0, 1.0);');
  expect(BOLT_FRAG_WGSL).toMatch(/across = clamp\(\(1f - abs\(_e\d+\)\), 0f, 1f\);/);
});
