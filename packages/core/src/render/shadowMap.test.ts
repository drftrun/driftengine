import { expect, test } from 'vitest';

import { SHADOW_DEPTH_CLEAR } from './depthConvention.ts';
import { recordingGl } from './rendererHarness.ts';
import { ShadowMap } from './shadowMap.ts';

/**
 * **A layer no pass has drawn must read as the far plane, and only a clear can promise that.**
 *
 * WebGL zeroes a new texture, and a zero in a map compared with `LEQUAL` is an occluder at the
 * light itself. ANGLE on Vulkan hands the same texture back reading 1. So a scene that allocates a
 * layer and never opens it — a second depth layer it does not peel, the movers' layer in a world
 * with none — was sunlit under one ANGLE backend and had no sun at all under the other, which is
 * the one Chrome on Linux runs by default. Measured on one card: 0 and 255 for the same texel.
 */
test('A SHADOW MAP IS BORN AT THE FAR PLANE, whatever the driver made its texture', () => {
  const { gl, calls } = recordingGl();
  /* A reversed frame's clear value, which is what the context holds when the maps are built. */
  gl.clearDepth(0);
  calls.length = 0;
  new ShadowMap(gl, 64);

  const clear = calls.findIndex(
    (call) => call.name === 'clear' && ((call.args[0] as number) & gl.DEPTH_BUFFER_BIT) !== 0,
  );
  expect(clear, 'the map is cleared once when it is made').toBeGreaterThan(-1);
  const valueAtClear = calls
    .slice(0, clear)
    .filter((call) => call.name === 'clearDepth')
    .at(-1)?.args[0];
  expect(valueAtClear, 'to the value a shadow pass clears to').toBe(SHADOW_DEPTH_CLEAR);
  const framebufferAtClear = calls
    .slice(0, clear)
    .filter((call) => call.name === 'bindFramebuffer')
    .at(-1)?.args[1];
  expect(framebufferAtClear, "with the map's own framebuffer bound").not.toBeNull();

  expect(gl.getParameter(gl.DEPTH_CLEAR_VALUE), "and the frame's own value is put back").toBe(0);
});
