import { expect, test, vi } from 'vitest';

import { DEPTH_CLEAR, REVERSED_DEPTH } from '../../depthConvention.ts';
import { insetPipeline } from './insetPass.ts';

/**
 * The depth the inset's clearing quad writes, which decides whether anything can be drawn in it.
 *
 * **This file exists because the quad wrote the near plane and nothing could say so.** The quad
 * stands in for `gl.clear(DEPTH_BUFFER_BIT)`, which WebGPU cannot confine to a rectangle, and it
 * is drawn with `depthCompare: 'always'` and depth writes on — so whatever z it carries is
 * stamped across the whole inset. It carried `1.0`, under a comment calling that the far plane.
 * That is true of a conventional buffer and this engine reverses depth, where 1.0 is the *near*
 * plane and the compare is `greater`: every mesh drawn between `beginInset` and `endInset` then
 * fails the test against it, and the box comes out holding its clear colour and nothing else.
 *
 * It is exactly the mistake `glslFarDepth` was written for after the sky made it — a full-screen
 * triangle at `z = w`, correct conventionally and the near plane once reversed. The sky painted
 * over the world, which is loud; an inset paints over nothing, which is a black box on a menu and
 * reads as a missing draw.
 *
 * **Nothing could catch it below this line.** Both backends compile, link and record without a
 * word, and the only difference is which pixels survive a depth test — so the engine's own suite
 * saw a correct pipeline and a capture on WebGL2, where the clear is a real `gl.clear`, was
 * perfect. It was reported from a game as two black boxes on two screens.
 */
function capturedWgsl(): string {
  const codes: string[] = [];
  const device = {
    createShaderModule: vi.fn((descriptor: GPUShaderModuleDescriptor) => {
      codes.push(descriptor.code);
      return {} as GPUShaderModule;
    }),
    createPipelineLayout: vi.fn(() => ({}) as GPUPipelineLayout),
  } as unknown as GPUDevice;
  /* The cache builds the descriptor through the factory and hands it straight back. */
  const cache = {
    format: 'bgra8unorm' as GPUTextureFormat,
    sampleCount: 1,
    get: (_key: string, build: () => GPURenderPipelineDescriptor) => build(),
  } as unknown as Parameters<typeof insetPipeline>[0];

  insetPipeline(cache, device, {} as GPUBindGroupLayout, true);
  const code = codes[0];
  if (code === undefined) throw new Error('the inset pipeline compiled no shader');
  return code;
}

/** The z the vertex stage returns, read out of the source it actually compiles. */
function quadDepth(wgsl: string): number {
  const written = /return\s+vec4<f32>\(\s*ndc\s*,\s*([0-9.]+)\s*,\s*1\.0\s*\)/.exec(wgsl);
  if (written === null) throw new Error(`no clip position found in:\n${wgsl}`);
  return Number(written[1]);
}

test('the inset clear quad writes the far plane, so the inset can be drawn into', () => {
  /*
   * Against the convention rather than against a literal. A test pinning `0.0` would be a second
   * statement of the same choice, green on the day somebody flips `REVERSED_DEPTH` and the quad
   * does not follow — which is the only way this can come back.
   */
  expect(quadDepth(capturedWgsl())).toBe(DEPTH_CLEAR);
});

test('and that is the opposite end from the one a conventional buffer clears to', () => {
  /*
   * The premise the test above rests on, asserted so it cannot rot into a tautology: while depth
   * is reversed, the far plane is *not* the 1.0 that a shader written for a conventional buffer
   * would carry. If this ever fails, the engine has stopped reversing depth and the assertion
   * above has stopped being about anything.
   */
  expect(REVERSED_DEPTH).toBe(true);
  expect(DEPTH_CLEAR).not.toBe(1);
});
