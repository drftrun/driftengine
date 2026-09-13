import type { PipelineCache } from './pipelineCache.ts';
import { DEPTH_CLEAR } from '../../depthConvention.ts';
import { DEPTH_FORMAT } from './flatPass.ts';
import { shaderModule } from './shaderModules.ts';

/**
 * Clearing a *rectangle* of the frame, which WebGPU has no operation for.
 *
 * `beginInset` on WebGL2 is `gl.scissor` plus `gl.clear`, and the scissor confines the clear.
 * WebGPU clears at `loadOp`, which applies to the whole attachment and cannot be confined —
 * reopening the pass to clear would throw away the frame outside the inset, and clearing only
 * depth that way would silently un-occlude everything a scene draws *after* `endInset`.
 *
 * So the rect is drawn rather than cleared: one quad at the far plane, depth always written,
 * colour written or masked off depending on whether the caller asked for a colour. **Which end of
 * the buffer "the far plane" is comes from `depthConvention.ts`** and not from this file: depth is
 * reversed here, and a quad that names the conventional end clears the inset to the *near* plane
 * and makes it undrawable. See the note at the return.
 *
 * **Its own shader, and it is allowed to be.** This is not generated from GLSL and has no
 * WebGL2 counterpart to stay honest against — the counterpart is `gl.clear`. The mip blit in
 * `surfaceTexturePass.ts` is here for the same reason.
 */
const INSET_WGSL = `
struct Rect {
  color: vec4<f32>,
}
@group(0) @binding(0) var<uniform> rect: Rect;

@vertex
fn vertexMain(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
  /*
   * The whole of the current viewport, which is the inset, because \`beginInset\` has already
   * set it.
   *
   * **It used to place the quad from the rect's own CSS pixels and that is one transform too
   * many.** Clip space is relative to the viewport in force, not to the canvas, so a quad
   * describing "this box within the canvas" was mapped into the box a second time: it came out
   * small and pushed toward a corner, leaving most of the inset uncleared. What a caller then
   * saw was whatever had been in the frame there, or nothing at all where the frame was
   * transparent — reported from the game as a hole where a portrait should be. The content
   * inside the inset was always correct, which is what made it look like a missing draw rather
   * than a misplaced one.
   */
  var corner = array<vec2<f32>, 6>(
    vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0),
    vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 1.0), vec2<f32>(0.0, 1.0),
  );
  let ndc = corner[index] * 2.0 - vec2<f32>(1.0, 1.0);
  /*
   * **The far plane, interpolated from the convention rather than written down.**
   *
   * This said \`1.0\`, under a comment calling it "the far plane, which is what a depth clear
   * writes". That is true of a conventional depth buffer and this engine reverses depth, where
   * 1.0 is the *near* plane and the compare is \`greater\`. The quad is drawn with
   * \`depthCompare: 'always'\` and depth writes on, so it stamped the nearest possible value
   * across the whole inset and every mesh drawn between \`beginInset\` and \`endInset\` failed
   * the test against it: the box came out holding its clear colour and nothing else, on WebGPU
   * only, with nothing logged. Reported from a game as two empty boxes on two menu screens, both
   * of them the places it draws an inset.
   *
   * It is the mistake \`glslFarDepth\` exists because the sky made — a full-screen triangle at
   * \`z = w\`, the far plane conventionally and the near plane once reversed. \`DEPTH_CLEAR\` is
   * the same number by definition: what a depth attachment is cleared to, which is what a quad
   * standing in for a depth clear must write.
   */
  return vec4<f32>(ndc, ${DEPTH_CLEAR}.0, 1.0);
}

@fragment
fn fragmentMain() -> @location(0) vec4<f32> {
  return rect.color;
}
`;

/**
 * `color` (4), and nothing else.
 *
 * The rect's bounds and the canvas size were in here to place the quad and are not needed to
 * cover a viewport that is already the rect. Kept out rather than left unread: an unused uniform
 * is a field somebody later writes and expects to matter.
 */
export const INSET_UNIFORM_SIZE = 16;

export function createInsetBindGroupLayout(device: GPUDevice): GPUBindGroupLayout {
  return device.createBindGroupLayout({
    label: 'inset.layout',
    entries: [
      {
        binding: 0,
        visibility: 0x1 | 0x2,
        buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: INSET_UNIFORM_SIZE },
      },
    ],
  });
}

export function createInsetBindGroup(
  device: GPUDevice,
  layout: GPUBindGroupLayout,
  uniforms: GPUBuffer,
): GPUBindGroup {
  return device.createBindGroup({
    label: 'inset.bindGroup',
    layout,
    entries: [{ binding: 0, resource: { buffer: uniforms, size: INSET_UNIFORM_SIZE } }],
  });
}

/**
 * The clearing quad.
 *
 * `writeColor` off is the depth-only case — `beginInset(rect, null)`, where the frame behind
 * survives so what is drawn next sits over the scene rather than over a rectangle of flat
 * colour. `depthCompare: 'always'` because a clear does not ask permission.
 */
export function insetPipeline(
  cache: PipelineCache,
  device: GPUDevice,
  layout: GPUBindGroupLayout,
  writeColor: boolean,
): GPURenderPipeline {
  return cache.get(`inset|${writeColor ? 'color' : 'depth'}`, () => {
    const module = shaderModule(device, { label: 'inset', code: INSET_WGSL });
    return {
      label: `inset|${writeColor ? 'color' : 'depth'}`,
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: { module, entryPoint: 'vertexMain' },
      fragment: {
        module,
        entryPoint: 'fragmentMain',
        targets: [{ format: cache.format, writeMask: writeColor ? 0xf : 0 }],
      },
      primitive: { topology: 'triangle-list' as const, cullMode: 'none' as const },
      multisample: { count: cache.sampleCount },
      depthStencil: {
        format: DEPTH_FORMAT,
        depthWriteEnabled: true,
        depthCompare: 'always' as const,
      },
    };
  });
}
