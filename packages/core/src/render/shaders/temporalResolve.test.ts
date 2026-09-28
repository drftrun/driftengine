import { expect, test } from 'vitest';

import {
  FLICKER_BLEND,
  FLICKER_MEMORY,
  FLICKER_REPEAT,
  FLICKER_SURFACE,
  FLICKER_WIDTH,
  STILL_FROM,
  STILL_TO,
} from '../temporalAa.ts';
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
  const history = TEMPORAL_RESOLVE_FRAG.indexOf('historyCatmullRom(wasUv)');
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

/**
 * **The history is read through a Catmull-Rom filter.** A bilinear read of a picture that is itself
 * last frame's blend compounds a small blur every frame, and a still camera settled on a picture
 * visibly softer than one frame of it: stone read as out of focus beside the same frame with the
 * resolve off. Every tap at an explicit level, for the reason the first test here gives.
 */
test('THE HISTORY IS READ SHARP, through Catmull-Rom rather than one bilinear fetch', () => {
  expect(TEMPORAL_RESOLVE_FRAG).toContain('vec3 history = historyCatmullRom(wasUv);');
  expect(TEMPORAL_RESOLVE_FRAG).toContain('vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);');
  expect(TEMPORAL_RESOLVE_FRAG).not.toContain('textureLod(uHistory, wasUv');
});

/**
 * **Every exit writes the record as well as the picture.** An output a fragment does not write is
 * undefined, and the record read back next frame from an undefined texel is a pixel that widens by
 * whatever the driver left there — on a cut, a resize, or the edge of a turning camera.
 */
test('EVERY EXIT WRITES THE FLICKER RECORD, not only the one that resolves', () => {
  const pictures = TEMPORAL_RESOLVE_FRAG.split('fragColor = ').length - 1;
  const records = TEMPORAL_RESOLVE_FRAG.split('flickerOut = ').length - 1;
  const motions = TEMPORAL_RESOLVE_FRAG.split('flickerMotionOut = ').length - 1;
  expect(pictures).toBe(4);
  expect(records).toBe(pictures);
  expect(motions).toBe(pictures);
});

/**
 * **The anti-flicker is the one `temporalAa.ts` tests, constant for constant**, so the frame-by-frame
 * model there is a model of what runs. And the record is a half-float value where the scene is,
 * so it is read at the precision the depth is.
 */
test('the anti-flicker spells its twin’s constants and reads its record at highp', () => {
  expect(TEMPORAL_RESOLVE_FRAG).toContain(
    `const float FLICKER_MEMORY = ${FLICKER_MEMORY.toFixed(3)};`,
  );
  expect(TEMPORAL_RESOLVE_FRAG).toContain(
    `const float FLICKER_WIDTH = ${FLICKER_WIDTH.toFixed(1)};`,
  );
  expect(TEMPORAL_RESOLVE_FRAG).toContain(
    `const float FLICKER_REPEAT = ${FLICKER_REPEAT.toFixed(2)};`,
  );
  expect(TEMPORAL_RESOLVE_FRAG).toContain(
    `const float FLICKER_BLEND = ${FLICKER_BLEND.toFixed(2)};`,
  );
  expect(TEMPORAL_RESOLVE_FRAG).toContain(`const float STILL_FROM = ${STILL_FROM.toFixed(2)};`);
  expect(TEMPORAL_RESOLVE_FRAG).toContain(`const float STILL_TO = ${STILL_TO.toFixed(2)};`);
  expect(Number(FLICKER_MEMORY.toFixed(3))).toBe(FLICKER_MEMORY);
  for (const [name, value, digits] of [['FLICKER_SURFACE', FLICKER_SURFACE, 2]] as const) {
    expect(TEMPORAL_RESOLVE_FRAG).toContain(`const float ${name} = ${value.toFixed(digits)};`);
    expect(Number(value.toFixed(digits)), name).toBe(value);
  }
  expect(TEMPORAL_RESOLVE_FRAG).toContain('uniform highp sampler2D uFlicker;');
  expect(TEMPORAL_RESOLVE_FRAG).toContain('uniform highp sampler2D uFlickerMotion;');
  /*
   * **Fetched at the texel where the surface was, never filtered**: a filtered read at an edge
   * mixes two surfaces' records, and a record is only worth anything as one surface's.
   */
  expect(TEMPORAL_RESOLVE_FRAG).toContain('texelFetch(uFlicker, was, 0)');
  expect(TEMPORAL_RESOLVE_FRAG).not.toContain('textureLod(uFlicker');
  expect(TEMPORAL_RESOLVE_FRAG).not.toContain('textureLod(uFlickerMotion');
});
