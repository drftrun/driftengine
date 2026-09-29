import { expect, test } from 'vitest';

import { SHADOW_DEPTH_CLEAR } from './depthConvention.ts';
import { recordingGl } from './rendererHarness.ts';
import {
  SUN_DYNAMIC_LAYER,
  SUN_PEELED_LAYER,
  SUN_STATIC_LAYER,
  SunShadowArray,
} from './shadowMap.ts';

/**
 * **A layer no pass has drawn must read as the far plane, and only a clear can promise that.**
 *
 * WebGL zeroes a new texture, and a zero in a map compared with `LEQUAL` is an occluder at the
 * light itself. ANGLE on Vulkan hands the same texture back reading 1. So a scene that allocates a
 * layer and never opens it — a second depth layer it does not peel, the movers' layer in a world
 * with none — was sunlit under one ANGLE backend and had no sun at all under the other, which is
 * the one Chrome on Linux runs by default. Measured on one card: 0 and 255 for the same texel.
 */
test('A SHADOW MAP IS BORN AT THE FAR PLANE, every layer of it, whatever the driver made', () => {
  const { gl, calls } = recordingGl();
  /* A reversed frame's clear value, which is what the context holds when the maps are built. */
  gl.clearDepth(0);
  calls.length = 0;
  new SunShadowArray(gl, 64, true);

  const layersCleared = new Set<number>();
  let attached = -1;
  let clearValue: unknown = null;
  for (const call of calls) {
    if (call.name === 'framebufferTextureLayer') attached = call.args[4] as number;
    if (call.name === 'clearDepth') clearValue = call.args[0];
    if (call.name === 'clear' && ((call.args[0] as number) & gl.DEPTH_BUFFER_BIT) !== 0) {
      expect(clearValue, 'to the value a shadow pass clears to').toBe(SHADOW_DEPTH_CLEAR);
      layersCleared.add(attached);
    }
  }
  expect([...layersCleared].sort()).toEqual([
    SUN_STATIC_LAYER,
    SUN_DYNAMIC_LAYER,
    SUN_PEELED_LAYER,
  ]);
  expect(gl.getParameter(gl.DEPTH_CLEAR_VALUE), "and the frame's own value is put back").toBe(0);
});

test('THE THREE MAPS ARE ONE TEXTURE, with the peel only where it is asked for', () => {
  const { gl, calls } = recordingGl();
  const peeled = new SunShadowArray(gl, 64, true);
  const storage = calls.filter((call) => call.name === 'texStorage3D');
  expect(storage).toHaveLength(1);
  expect(storage[0]?.args.slice(2)).toEqual([gl.DEPTH_COMPONENT24, 64, 64, 3]);
  expect(peeled.layers).toBe(3);
  expect(new SunShadowArray(gl, 64, false).layers, 'static and moving only').toBe(2);
});

/*
 * **The peel reads the static layer while it is drawn, so it cannot be drawn into the array.**
 * WebGL2 calls a texture both sampled and attached a feedback loop whatever layer each names, so
 * the peel renders into a scratch of its own and is copied into its layer when the pass ends.
 */
test('THE PEEL IS DRAWN ASIDE AND COPIED INTO ITS LAYER', () => {
  const { gl, calls } = recordingGl();
  const sun = new SunShadowArray(gl, 64, true);
  calls.length = 0;
  sun.begin(gl, 'static-peel');
  expect(
    calls.some((call) => call.name === 'framebufferTextureLayer'),
    'nothing of the array is attached while the peel draws',
  ).toBe(false);
  calls.length = 0;
  sun.end(gl);
  const layer = calls.filter((call) => call.name === 'framebufferTextureLayer').at(-1);
  expect(layer?.args[4], 'the copy lands in the peeled layer').toBe(SUN_PEELED_LAYER);
  const blit = calls.find((call) => call.name === 'blitFramebuffer');
  expect(blit?.args[8]).toBe(gl.DEPTH_BUFFER_BIT);
});
