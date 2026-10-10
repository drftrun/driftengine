import { expect, test } from 'vitest';

import { OUTPUT_TRANSFORM_GLSL } from '../outputTransform.ts';
import { GPU_DRIVEN_BLIT_DEPTH_WGSL, GPU_DRIVEN_BLIT_WGSL, GRADE_WGSL } from './present.wgsl.ts';

/** Every decimal constant in a source, comments left out, in the order the code states them. */
function constants(source: string): number[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  return [...code.matchAll(/\d+\.\d+/g)].map((match) => Number(match[0]));
}

/*
 * **THE BLIT'S GRADE IS THE FORWARD PASSES' GRADE, CONSTANT FOR CONSTANT AND IN ORDER**: the ACES
 * fit, both matrices column by column — so a transposed copy, the mistake a hand-written `mat3x3`
 * invites, is a different sequence — the sRGB encode's segments and the shoulder's knee. The two are
 * one curve written twice because the generator cannot reach a hand-written blit; this is what holds
 * them together.
 */
test('THE GPU-DRIVEN BLIT GRADES WITH THE SAME CONSTANTS, IN THE SAME ORDER, AS EVERY OTHER PASS', () => {
  const glsl = constants(OUTPUT_TRANSFORM_GLSL);
  expect(glsl.length, 'the GLSL has its constants').toBeGreaterThan(30);
  expect(constants(GRADE_WGSL)).toEqual(glsl);
  /* And both blits carry it: the one that hands the frame its depth as well. */
  expect(GPU_DRIVEN_BLIT_WGSL).toContain(GRADE_WGSL);
  expect(GPU_DRIVEN_BLIT_DEPTH_WGSL).toContain(GRADE_WGSL);
  expect(GPU_DRIVEN_BLIT_WGSL).toContain('return graded(texel);');
  expect(GPU_DRIVEN_BLIT_DEPTH_WGSL).toContain('out.colour = graded(texel);');
});
