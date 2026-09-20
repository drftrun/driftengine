import { expect, test } from 'vitest';
import { indirectSupport } from './api.ts';

/*
 * These assert a backend fact rather than the presence of a method, and the reason is worth
 * keeping beside them: a contributed pass already holds the `GPURenderPassEncoder` through
 * `PassContext`, and a compute definition already holds the `GPUComputePassEncoder` through
 * `ComputeContext`. Neither needs a verb on `RendererApi` to issue an indirect command. What a
 * GPU-driven pipeline needs from this surface is permission to try.
 */
test('WebGPU can be driven from buffers the GPU wrote', () => {
  expect(indirectSupport('webgpu')).toBe(true);
});

test('WebGL2 cannot, and reports so rather than pretending', () => {
  expect(indirectSupport('webgl2')).toBe(false);
});
