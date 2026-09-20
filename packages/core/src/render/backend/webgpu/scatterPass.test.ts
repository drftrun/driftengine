import { expect, test, vi } from 'vitest';

import { DEPTH_COMPARE } from '../../depthConvention.ts';
import { SHADOW_FORMAT } from './depthPass.ts';
import { scatterDepthPipeline } from './scatterPass.ts';
import type { PipelineCache } from './pipelineCache.ts';

/**
 * A device that hands back the descriptor it was given, so the pipeline can be read.
 *
 * The cache is bypassed rather than mocked: `get` is asked to build and the built descriptor is
 * what the test reads, which is the same object `createRenderPipeline` would receive.
 */
function recordingCache(): { cache: PipelineCache; built: GPURenderPipelineDescriptor[] } {
  const built: GPURenderPipelineDescriptor[] = [];
  const cache = {
    get: (_key: string, build: () => GPURenderPipelineDescriptor) => {
      const descriptor = build();
      built.push(descriptor);
      return descriptor as unknown as GPURenderPipeline;
    },
  };
  return { cache: cache as unknown as PipelineCache, built };
}

function device(): GPUDevice {
  return {
    createPipelineLayout: vi.fn(() => ({})),
    createShaderModule: vi.fn(() => ({})),
  } as unknown as GPUDevice;
}

test('THE SCATTER SHADOW PIPELINE COMPARES `less`, because the shadow map is not reversed', () => {
  /*
   * **It compared `DEPTH_COMPARE` — the *scene's* convention — against a map cleared to one.**
   * `depthConvention.ts` reverses the scene's depth and leaves shadows alone in as many words:
   * the cascades are orthographic, where depth is already linear and a float buffer gains
   * nothing. So `SHADOW_DEPTH_CLEAR` is 1 and `beginShadowPass` clears to 1, and a fragment at
   * depth 0.3 tested with `greater` fails `0.3 > 1`. **Nothing was ever written**: a scatter
   * batch cast no shadow at all on WebGPU, silently, with no GL error and a perfectly ordinary
   * frame.
   *
   * `depthPass.ts` has said `depthCompare: 'less'` for the mesh path all along, which is why
   * meshes cast and scatter did not — and why it took a scene whose only caster is a scatter
   * batch to show it. `demo/windField.ts` is that scene: turning directional shadows off there
   * changed 2,628 pixels on WebGL2 and **0** on WebGPU, and removing the canopy caster on WebGL2
   * left a frame pixel-identical to the shadows-off one, which is what named the caster.
   */
  const { cache, built } = recordingCache();
  scatterDepthPipeline(cache, device(), {} as GPUBindGroupLayout, SHADOW_FORMAT, 'frag');
  expect(built[0]?.depthStencil?.depthCompare).toBe('less');
});

test('and it is not the frame’s compare, which is the one it used to take', () => {
  /* Named rather than implied: the two are opposite whenever `REVERSED_DEPTH` holds, which is
     the only configuration this engine ships, so a test that asserted `less` alone would pass
     just as well on a build where the distinction had stopped mattering. */
  expect(DEPTH_COMPARE).toBe('greater');
});
