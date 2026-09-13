import {
  DEPTH_BINDINGS,
  DEPTH_FRAG_WGSL,
  DEPTH_INSTANCED_VERT_WGSL,
  DEPTH_SKINNED_VERT_WGSL,
  DEPTH_VERT_WGSL,
} from '../../shaders/generated/depth.wgsl.ts';
import { vertexBufferLayouts } from './buffers.ts';
import type { PipelineCache } from './pipelineCache.ts';
import { shaderModule } from './shaderModules.ts';

/**
 * The shadow pass: the world drawn from the light, into a depth map.
 *
 * **A pass of its own, before the frame.** `beginShadowPass` is called by a scene *before*
 * `beginFrame`, so this owns its own encoder and its own render pass rather than sharing the
 * frame's. That ordering is the scene's and is not this backend's to change.
 */

export const DEPTH_VERT_FIELDS = DEPTH_BINDINGS.DEPTH_VERT.fields;
export const DEPTH_VERT_SIZE = DEPTH_BINDINGS.DEPTH_VERT.uniformSize;
export const DEPTH_FRAG_SIZE = DEPTH_BINDINGS.DEPTH_FRAG.uniformSize;
/** Re-exported so the scatter depth pass can pair with the same fragment stage. */
export { DEPTH_FRAG_WGSL };
export const DEPTH_FRAG_BINDING = DEPTH_BINDINGS.DEPTH_FRAG.uniforms;
export const DEPTH_PREVIOUS_BINDING = DEPTH_BINDINGS.DEPTH_FRAG.textures.uPreviousShadowMap;

const VERT_BINDING = DEPTH_BINDINGS.DEPTH_VERT.uniforms;
const FRAG_BINDING = DEPTH_BINDINGS.DEPTH_FRAG.uniforms;
const PREVIOUS = DEPTH_BINDINGS.DEPTH_FRAG.textures.uPreviousShadowMap;
/** Where the skinned vertex stage reads the joint palette. Generated, not chosen here. */
export const DEPTH_PALETTE_BINDING = DEPTH_BINDINGS.DEPTH_SKINNED_VERT.textures.uJointPalette;

const VISIBILITY_VERTEX = 0x1;
const VISIBILITY_FRAGMENT = 0x2;

/**
 * The format the shadow map is stored in.
 *
 * `depth32float` rather than the frame's `depth24plus`, because this one is *sampled* as
 * well as written and a comparison against a quantised depth is where shadow acne comes
 * from. It is also the format `shadowMap.ts` asks WebGL2 for, so the two backends compare
 * the same numbers.
 */
export const SHADOW_FORMAT: GPUTextureFormat = 'depth32float';

export function createDepthBindGroupLayout(
  device: GPUDevice,
  /**
   * Whether this layout carries the joint palette.
   *
   * A **separate layout** rather than the palette added to the one layout with a stand-in bound
   * when nothing is skinned, which is the shape `flatLayoutFor` already uses. What it buys is that
   * the rigid path is untouched: no extra binding, no one-pixel texture to keep alive, and a
   * frame that skins nothing pays nothing at all.
   */
  skinned = false,
): GPUBindGroupLayout {
  return device.createBindGroupLayout({
    label: skinned ? 'depth.layout.skinned' : 'depth.layout',
    entries: [
      /* The texture and no sampler: the shader reads the palette with `textureLoad`, an integer
         coordinate with nothing to filter, which is what `flatPass.ts` binds for the same
         palette. naga declares a sampler for it and nothing ever reads one. */
      ...(skinned
        ? [
            {
              binding: DEPTH_PALETTE_BINDING.texture,
              visibility: VISIBILITY_VERTEX,
              texture: { sampleType: 'unfilterable-float' as GPUTextureSampleType },
            },
          ]
        : []),
      {
        binding: VERT_BINDING,
        visibility: VISIBILITY_VERTEX,
        buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: DEPTH_VERT_SIZE },
      },
      {
        binding: FRAG_BINDING,
        visibility: VISIBILITY_FRAGMENT,
        buffer: { type: 'uniform', minBindingSize: DEPTH_FRAG_SIZE },
      },
      /*
       * **`unfilterable-float`, because the peel binds `SHADOW_FORMAT` here.**
       *
       * The defaults are `sampleType: 'float'` and `type: 'filtering'`, and a `depth32float`
       * view satisfies neither. The device rejects the pair in as many words — *"None of the
       * supported sample types (UnfilterableFloat|Depth) of [Texture "shadow.static"] match
       * the expected sample types (Float)"* — and it rejects it by returning an **invalid
       * bind group rather than throwing**. A peel pass built on one records nothing, so the
       * peel map keeps the undefined contents it was created with and the frame still
       * presents. Three ports of the peel were measured and reverted against that silence.
       *
       * The one-pixel `rgba8unorm` stand-in every non-peel frame binds here satisfies this
       * too — measured, both ways — and the sampler beside it is all-`nearest` already, which
       * is what `non-filtering` requires. `flatPass.ts` reaches the same declaration from the
       * name, and `uPreviousShadowMap` is one of the names it would match.
       */
      {
        binding: PREVIOUS.texture,
        visibility: VISIBILITY_FRAGMENT,
        texture: { sampleType: 'unfilterable-float' },
      },
      {
        binding: PREVIOUS.sampler,
        visibility: VISIBILITY_FRAGMENT,
        sampler: { type: 'non-filtering' },
      },
    ],
  });
}

export function createDepthBindGroup(
  device: GPUDevice,
  layout: GPUBindGroupLayout,
  perDraw: GPUBuffer,
  perPass: GPUBuffer,
  previous: GPUTextureView,
  sampler: GPUSampler,
  /** The joint palette, for a layout built with `skinned`. Omit for the rigid layout. */
  palette: GPUTextureView | null = null,
): GPUBindGroup {
  return device.createBindGroup({
    label: palette === null ? 'depth.bindGroup' : 'depth.bindGroup.skinned',
    layout,
    entries: [
      { binding: VERT_BINDING, resource: { buffer: perDraw, size: DEPTH_VERT_SIZE } },
      { binding: FRAG_BINDING, resource: { buffer: perPass, size: DEPTH_FRAG_SIZE } },
      { binding: PREVIOUS.texture, resource: previous },
      { binding: PREVIOUS.sampler, resource: sampler },
      ...(palette !== null ? [{ binding: DEPTH_PALETTE_BINDING.texture, resource: palette }] : []),
    ],
  });
}

/**
 * The depth pipeline.
 *
 * **No colour target at all.** The pass writes depth and nothing else, which is what makes
 * it cheap; a colour attachment here would be a buffer written and never read.
 *
 * The vertex layout is the mesh's own, because the depth shader takes position from
 * location 0 and the pipeline still has to describe every attribute the module declares.
 */
export function depthPipeline(
  cache: PipelineCache,
  device: GPUDevice,
  layout: GPUBindGroupLayout,
  key: string,
  present: Readonly<Record<string, boolean>>,
  /**
   * **`none` for a cubemap face, and the directional pass's own comment says why not here.**
   *
   * That comment argues against culling front faces to cure acne, and it is about the
   * *directional* map, which is rendered from far away over a whole world. A point light's
   * cube is rendered from inside a room, and `pointShadowMap.ts` disables culling outright for
   * a reason that is not about acne at all: rendering back faces only stores the far side of
   * every caster, and for a character's limbs the near and far sides are centimetres apart, so
   * the caster effectively vanishes from the map. Two passes, two answers, one parameter.
   */
  cullMode: GPUCullMode = 'back',
  /** Whether this pipeline's vertex stage reads a joint palette. See `DEPTH_SKINNED_VERT`. */
  skinned = false,
  /**
   * Whether placement arrives per instance. See `DEPTH_INSTANCED_VERT`.
   *
   * Excludes `skinned`, and the layout is why rather than the shader: an instanced pipeline
   * reclaims the two attribute locations the joint indices and weights occupy.
   */
  instanced = false,
): GPURenderPipeline {
  return cache.get(key, () => ({
    label: key,
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    vertex: {
      module: shaderModule(
        device,
        instanced
          ? { label: 'depth.instanced.vert', code: DEPTH_INSTANCED_VERT_WGSL }
          : skinned
            ? { label: 'depth.skinned.vert', code: DEPTH_SKINNED_VERT_WGSL }
            : { label: 'depth.vert', code: DEPTH_VERT_WGSL },
      ),
      entryPoint: 'main',
      buffers: vertexBufferLayouts(present, instanced),
    },
    fragment: {
      module: shaderModule(device, { label: 'depth.frag', code: DEPTH_FRAG_WGSL }),
      entryPoint: 'main',
      targets: [],
    },
    /*
     * **Back faces culled, matching the frame.** Culling front faces instead is the textbook
     * answer to shadow acne, and it is the wrong answer here: `renderer.ts` keeps the
     * frame's own back-face culling through the directional pass and handles acne with
     * receiver-plane compensation instead, so a depth map built from the far side of every
     * surface disagrees with what the shader expects to compare against.
     *
     * The symptom was unmistakable and worth recording: the whole scene came out uniformly
     * in shadow — paving, pillars and all — because every fragment compared itself against a
     * depth recorded behind it.
     *
     * **`frontFace: 'cw'`, and it is this pass's projection that asks for it rather than a
     * preference.** Facing is decided in framebuffer coordinates, whose Y points down while
     * clip space's points up, so a triangle wound counter-clockwise in clip space reaches the
     * rasteriser clockwise. Every presented pass is projected through `CLIP_CORRECTION`, which
     * negates Y and turns that back over, so the default `ccw` is right for all of them. This
     * map is sampled rather than presented, so `SHADOW_CLIP_CORRECTION` leaves Y alone — and
     * the default then culls precisely the faces this pass exists to record.
     *
     * That shipped and was invisible for a fortnight, because it takes geometry the light can
     * see through to show: on a world of a vault over an arcade, the vault was missing from the
     * map, so the arcade under it was lit here and in shadow on WebGL2. Read back texel for
     * texel against that backend, 2,000,709 texels of 2,095,575 differed by more than 0.2 m and
     * 805,117 by more than 2 m, this map holding surfaces 8.4 m further from the light on
     * average; declaring the winding takes those to 6,972 and 0.
     *
     * **What would make it wrong** is giving this pass the Y flip after all — the winding has to
     * move back with it, and neither half is inert on its own.
     * `webgpu/renderer.test.ts` asserts the pair against the matrix rather than against the
     * literal for that reason.
     */
    primitive: { topology: 'triangle-list', cullMode, frontFace: 'cw' },
    /*
     * **The raster offset the other backend has always had, and this one never did.**
     *
     * `shadowMap.ts` sets `gl.polygonOffset(1.1, 4)` for its directional pass and calls it
     * load-bearing in its own comment: *"a small slope-aware raster offset separates the stored
     * caster from its receiver"*. This pipeline declared a format, a write and a compare, and
     * nothing else — so every WebGPU shadow was compared against a depth with no separation at
     * all.
     *
     * **It was measured as minor and it was not.** Adding it moved 2,178 pixels when it was first
     * tried, which read as a small thing worth taking on its own terms. What that measurement
     * could not see is that the pass was, at the time, storing the *far* side of every caster
     * because its winding was inverted — and a caster's own thickness is an enormous accidental
     * bias. Correcting the winding removed the masking, and what it exposed is what a shadow pass
     * with no offset does: acne on ground in shadow, and self-shadowing near geometry that reads
     * as a shadow with nothing casting it.
     *
     * **`depthBias` is not the same quantity on the two backends and that is stated rather than
     * hidden.** WebGL2's `units` are multiples of the smallest resolvable difference of a
     * `DEPTH_COMPONENT24` map; WebGPU applies the constant against a `depth32float`, where the
     * specification scales it by the exponent of the primitive's maximum depth. The slope term is
     * the same quantity in both. So these are the other backend's numbers as a starting point and
     * the constant is the half to distrust — which is why `shadows.html` exists.
     *
     * **What would make it wrong** is over-biasing, which detaches a shadow from its caster: the
     * failure `shadowMap.ts` names as the reason it culls back faces rather than front. Too small
     * shows as acne, too large as a floating shadow, and only one of them looks like a bug.
     */
    depthStencil: {
      format: SHADOW_FORMAT,
      depthWriteEnabled: true,
      depthCompare: 'less',
      depthBias: 4,
      depthBiasSlopeScale: 1.1,
    },
  }));
}
