import { expect, test } from 'vitest';

import { LIVE_POINT_SHADOW_MAPS, POINT_SHADOW_POOL } from './lightBudget.ts';
import { OCTAHEDRAL_EDGE, PointShadowArray } from './pointShadowArray.ts';
import { recordingGl } from './rendererHarness.ts';

/*
 * The array is sized from the world's own light count and not from the maximum, and that is not
 * bookkeeping. `lightBudget.ts` records the opposite choice as "the single most expensive mistake
 * the renderer has made": one cubemap per light, forever, 265 MB of it unreadable by construction,
 * and an integrated part running at 3 fps maximised and perfectly in a small window. `texStorage3D`
 * is immutable, so allocating the maximum here would be that mistake in a new shape.
 */
test('the array is sized from the light count, not from the pool maximum', () => {
  const { gl, calls } = recordingGl();
  const array = new PointShadowArray(gl, 512, 3);
  const storage = calls.find((c) => c.name === 'texStorage3D');
  expect(storage, 'the array is allocated with texStorage3D').toBeDefined();
  /* texStorage3D(target, levels, internalformat, width, height, depth) */
  expect(storage?.args[3], 'the octahedral edge').toBe(OCTAHEDRAL_EDGE);
  expect(storage?.args[5], 'three lights plus the live maps').toBe(3 + LIVE_POINT_SHADOW_MAPS);
  expect(array.layers).toBe(3 + LIVE_POINT_SHADOW_MAPS);
  array.dispose(gl);
});

test('the array never allocates more layers than the pool can hand out', () => {
  const { gl } = recordingGl();
  const array = new PointShadowArray(gl, 512, 10_000);
  expect(array.layers).toBe(POINT_SHADOW_POOL + LIVE_POINT_SHADOW_MAPS);
  array.dispose(gl);
});

/*
 * The rule the whole design turns on, measured on a probe before it was written: WebGL2's
 * rendering-feedback-loop check is per texture object rather than per image, so a draw that
 * samples the array while any layer of it is attached is INVALID_OPERATION — even on a layer it
 * does not write. The resolve reads a separate scratch texture for exactly that reason, and this
 * is what keeps it that way.
 */
test('resolving a face attaches that layer and samples the scratch, never the array', () => {
  const { gl, calls } = recordingGl();
  const array = new PointShadowArray(gl, 512, 2);
  calls.length = 0;
  array.resolveFace(gl, 1, 4, 20, 0.25);

  const attach = calls.find((c) => c.name === 'framebufferTextureLayer');
  expect(attach, 'the layer is attached with framebufferTextureLayer').toBeDefined();
  /* framebufferTextureLayer(target, attachment, texture, level, layer) */
  expect(attach?.args[4], "the light's own layer").toBe(1);

  const bound = calls.filter((c) => c.name === 'bindTexture').map((c) => c.args[0]);
  expect(bound, 'the scratch is a plain 2D texture').toContain(gl.TEXTURE_2D);
  expect(bound, 'the array is never bound while a layer of it is attached').not.toContain(
    gl.TEXTURE_2D_ARRAY,
  );
  array.dispose(gl);
});

/*
 * `checkFramebufferStatus` is a synchronous query: the driver drains what it has queued before it
 * can answer. `pointShadowMap.ts` records what asking it per face cost — 95.6% of a 69 ms frame,
 * measured on a character moving into a fresh cluster of lamps, which is what made the bake budget
 * look useless. Every layer shares one texture, one size and one format, so one answer covers all
 * of them.
 */
test('framebuffer completeness is asked at construction and never in a resolve', () => {
  const { gl, calls } = recordingGl();
  const array = new PointShadowArray(gl, 512, 2);
  expect(calls.filter((c) => c.name === 'checkFramebufferStatus').length).toBeGreaterThan(0);
  calls.length = 0;
  for (let face = 0; face < 6; face++) array.resolveFace(gl, 0, face, 20, 0.25);
  expect(calls.filter((c) => c.name === 'checkFramebufferStatus')).toEqual([]);
  array.dispose(gl);
});

/*
 * The resolve is a copy and not a render. The layer already holds whatever the previous bake of
 * this light left in it, so a fragment that lost a depth comparison would leave half of one image
 * and half of another — a shadow baked around two different places at once, which is exactly the
 * failure `PointShadowImage.planBake` exists to prevent one level up.
 */
test('a resolve writes unconditionally and hands the depth function back', () => {
  const { gl, calls } = recordingGl();
  const array = new PointShadowArray(gl, 512, 2);
  calls.length = 0;
  array.resolveFace(gl, 0, 0, 20, 0.25);
  const depthFuncs = calls.filter((c) => c.name === 'depthFunc').map((c) => c.args[0]);
  expect(depthFuncs[0], 'the copy cannot lose a comparison').toBe(gl.ALWAYS);
  /*
   * **Whatever the frame was testing with, not a named compare.** This asserted `LESS`, which was
   * the frame's compare when it was written and stopped being it the moment the engine could draw
   * reversed — at which point one point-shadow copy left the rest of the frame testing the wrong
   * way and a scene with point shadows lost most of its pixels. The claim is that it hands back
   * what it took, so that is what is checked.
   */
  const read = calls.filter((c) => c.name === 'getParameter');
  expect(read.length, 'it reads the compare before changing it').toBeGreaterThan(0);
  expect(depthFuncs.at(-1), 'and the frame gets its own back').toBe(
    (gl as unknown as { getParameter(p: unknown): unknown }).getParameter(read[0]?.args[0]),
  );
  expect(
    calls.filter((c) => c.name === 'depthMask').map((c) => c.args[0]),
    'writing depth is the entire point of the pass',
  ).toContain(true);
  array.dispose(gl);
});

/*
 * The bug the WebGL2 capture caught and no unit test did.
 *
 * A resolve leaves the scratch bound for sampling; the next face makes it the render target.
 * That is a rendering feedback loop, and WebGL2 answers a draw in one with INVALID_OPERATION and
 * no pixels — not the resolve's own draw, but the *casters*, because `depth.ts` declares
 * `uPreviousShadowMap` on that unit and an active sampler is enough whether the branch reads it
 * or not. Twenty-five warnings in `night-court` and forty in `day-clock`; `gilded-chamber` was
 * silent because it had nothing stale to bake, which is what made it look like a scene bug.
 *
 * Confirmed as a unit collision rather than guessed: moving the resolve's sampler to an unused
 * unit removed every warning on its own.
 */
test('a face pass does not leave the scratch bound for sampling while it is the target', () => {
  const { gl, calls } = recordingGl();
  const array = new PointShadowArray(gl, 512, 2);

  calls.length = 0;
  array.resolveFace(gl, 0, 0, 20, 0.25);
  const scratch = calls
    .filter((c) => c.name === 'bindTexture' && c.args[0] === gl.TEXTURE_2D)
    .at(-1)?.args[1];
  expect(scratch, 'the resolve binds the scratch to sample it').toBeDefined();

  calls.length = 0;
  array.beginFace(gl);
  const target = calls.findIndex((c) => c.name === 'bindFramebuffer');
  expect(target, 'beginFace binds the scratch framebuffer').toBeGreaterThanOrEqual(0);
  const replaced = calls
    .slice(0, target)
    .some((c) => c.name === 'bindTexture' && c.args[0] === gl.TEXTURE_2D && c.args[1] !== scratch);
  expect(replaced, 'and clears the scratch off its unit first').toBe(true);
  const nulled = calls.some((c) => c.name === 'bindTexture' && c.args[1] === null);
  expect(nulled, 'with a complete texture rather than null — see emptyTexture.ts').toBe(false);

  array.dispose(gl);
});
