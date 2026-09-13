import { expect, test } from 'vitest';

import { TEMPORAL_RESOLVE_FRAG } from './temporalResolve.ts';

/**
 * These are guards and not a specification.
 *
 * A shader's behaviour is settled by pixels, and `scripts/temporal-aa-check.mjs` is where that is
 * asserted on a device. What is held here is the set of mistakes this repository has already paid
 * for in shaders shaped like this one — each of them compiled, validated, and failed somewhere
 * else — because a source assertion is the only thing that catches them before a capture does.
 */

/**
 * **An implicit derivative under a non-uniform branch fails to compile in WGSL.** It invalidates
 * the pipeline and the command buffer while the frame still presents, so the symptom arrives far
 * from the cause. `film.ts` carries the same note; this pass is nothing but texture fetches under
 * branches, so it is worth holding mechanically rather than by memory.
 */
test('every fetch takes an explicit level, because the branches above them are not uniform', () => {
  expect(TEMPORAL_RESOLVE_FRAG).toContain('textureLod(uScene');
  expect(TEMPORAL_RESOLVE_FRAG).toContain('textureLod(uHistory');
  expect(TEMPORAL_RESOLVE_FRAG).toContain('textureLod(uDepth');
  expect(TEMPORAL_RESOLVE_FRAG).not.toContain('texture(uScene');
  expect(TEMPORAL_RESOLVE_FRAG).not.toContain('texture(uHistory');
  expect(TEMPORAL_RESOLVE_FRAG).not.toContain('texture(uDepth');
});

/**
 * **A sampler's default precision is lowp**, whatever the file's `precision highp float` says —
 * that line sets the default for float and not for a sampler. Depth read at eight bits reprojects
 * to visibly the wrong place, and it does it without failing.
 */
test('the depth sampler asks for highp, which its default is not', () => {
  expect(TEMPORAL_RESOLVE_FRAG).toContain('uniform highp sampler2D uDepth;');
});

/**
 * **Off has to cost nothing**, and the frames with nothing to sample have to take the same exit:
 * the first frame, the frame after a resize and the frame after a cut all pass a blend of zero.
 * A resolve that reached for the history anyway would blend against whatever the texture held.
 */
test('a zero blend returns this frame before it touches depth or history', () => {
  const early = TEMPORAL_RESOLVE_FRAG.indexOf('if (uHistoryBlend <= 0.0)');
  const depth = TEMPORAL_RESOLVE_FRAG.indexOf('textureLod(uDepth');
  const history = TEMPORAL_RESOLVE_FRAG.indexOf('textureLod(uHistory');
  expect(early).toBeGreaterThan(-1);
  expect(depth).toBeGreaterThan(early);
  expect(history).toBeGreaterThan(early);
});

/**
 * **The clip is towards the centre, not a per-channel clamp.** The difference is a hue shift along
 * every moving edge, and `clamp` is the easy thing to reach for when editing this later.
 */
test('the history is clipped along the line to the centre rather than clamped', () => {
  expect(TEMPORAL_RESOLVE_FRAG).toContain('return centre + offset / ratio;');
  expect(TEMPORAL_RESOLVE_FRAG).not.toContain('clamp(history');
});

/**
 * **A sample off the edge of the last frame is a disocclusion.** Sampling it anyway takes the
 * clamped border texel, which drags one row of pixels inward as a smear for as long as the camera
 * keeps turning — and it is the failure that looks most like the effect working.
 */
test('a reprojection that leaves the frame falls back to this frame', () => {
  expect(TEMPORAL_RESOLVE_FRAG).toContain('wasUv.x < 0.0 || wasUv.x > 1.0');
  expect(TEMPORAL_RESOLVE_FRAG).toContain('wasUv.y < 0.0 || wasUv.y > 1.0');
});

/**
 * **The neighbourhood is nine taps and not five.** A cross lets a history through along a thin
 * diagonal edge, which is the geometry this effect exists for.
 */
test('the neighbourhood includes its diagonals', () => {
  expect(TEMPORAL_RESOLVE_FRAG).toContain('for (int y = -1; y <= 1; y++)');
  expect(TEMPORAL_RESOLVE_FRAG).toContain('for (int x = -1; x <= 1; x++)');
});
