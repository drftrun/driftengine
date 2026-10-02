import { DEPTH_COMPARE } from '@driftengine/core';
import { describe, expect, it } from 'vitest';

import { packSplats } from './splatData.ts';
import { createGpuSplats } from './splatGpu.ts';

/**
 * The WebGPU pipeline's depth state, read off the descriptor it hands the device.
 *
 * A browser is what draws it, and no test here has one; what can be asserted without one is that
 * the pipeline asks for the frame's own compare. A `'less'` written as a literal survived a
 * reversal of the scene's depth on both backends, and the symptom, splats drawn only inside the
 * silhouette of the meshes standing in them, is nothing a CPU test of the sort or the packing sees.
 */
function recordingDevice(): { device: GPUDevice; pipelines: GPURenderPipelineDescriptor[] } {
  const pipelines: GPURenderPipelineDescriptor[] = [];
  const object = (): object => ({});
  const device = {
    createTexture: () => ({ createView: object }),
    createBuffer: object,
    createSampler: object,
    createBindGroupLayout: object,
    createBindGroup: object,
    createPipelineLayout: object,
    createShaderModule: object,
    createRenderPipeline: (descriptor: GPURenderPipelineDescriptor) => {
      pipelines.push(descriptor);
      return {};
    },
    queue: { writeTexture: () => undefined, writeBuffer: () => undefined },
  } as unknown as GPUDevice;
  return { device, pipelines };
}

describe('the WebGPU splat pipeline', () => {
  const splats = packSplats({
    count: 1,
    positions: new Float32Array(3),
    scales: new Float32Array([0.1, 0.1, 0.1]),
    rotations: new Float32Array([0, 0, 0, 1]),
    colors: new Float32Array([1, 1, 1]),
    opacities: new Float32Array([1]),
  });

  it("tests depth with the frame's own compare, and never writes it", () => {
    const { device, pipelines } = recordingDevice();
    createGpuSplats(device, 'rgba16float', 'depth32float', 4, splats, 'test');
    expect(pipelines).toHaveLength(1);
    expect(pipelines[0]?.depthStencil?.depthCompare).toBe(DEPTH_COMPARE);
    expect(pipelines[0]?.depthStencil?.depthWriteEnabled).toBe(false);
  });

  it('would have caught the literal it replaced, since the scene depth is reversed', () => {
    expect(DEPTH_COMPARE).not.toBe('less');
  });
});
