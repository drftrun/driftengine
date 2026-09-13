import { FULLSCREEN_VERT_WGSL } from '../../shaders/generated/fullscreen.wgsl.ts';
import { RUSH_BINDINGS, RUSH_FRAG_WGSL } from '../../shaders/generated/rush.wgsl.ts';
import {
  BLOOM_BINDINGS,
  BLOOM_DOWNSAMPLE_FRAG_WGSL,
  BLOOM_PREFILTER_FRAG_WGSL,
  BLOOM_UPSAMPLE_FRAG_WGSL,
} from '../../shaders/generated/bloom.wgsl.ts';
import {
  AMBIENTOCCLUSION_BINDINGS as AO_BINDINGS,
  AO_BLUR_FRAG_WGSL,
  AO_FRAG_WGSL,
} from '../../shaders/generated/ambientOcclusion.wgsl.ts';
import {
  TEMPORALRESOLVE_BINDINGS as TAA_BINDINGS,
  TEMPORAL_RESOLVE_FRAG_WGSL,
} from '../../shaders/generated/temporalResolve.wgsl.ts';
import {
  OITRESOLVE_BINDINGS as OIT_BINDINGS,
  OIT_RESOLVE_FRAG_WGSL,
} from '../../shaders/generated/oitResolve.wgsl.ts';
import {
  DECALPROJECT_BINDINGS as DECAL_BINDINGS,
  DECAL_PROJECT_FRAG_WGSL,
} from '../../shaders/generated/decalProject.wgsl.ts';
import {
  SSRTRACE_BINDINGS as SSR_BINDINGS,
  SSR_TRACE_FRAG_WGSL,
} from '../../shaders/generated/ssrTrace.wgsl.ts';
import {
  SSRRESOLVE_BINDINGS as SSR_RESOLVE_BINDINGS,
  SSR_RESOLVE_FRAG_WGSL,
} from '../../shaders/generated/ssrResolve.wgsl.ts';
import {
  GLOBALMEDIUM_BINDINGS as MEDIUM_BINDINGS,
  MEDIUM_FRAG_WGSL,
  MEDIUM_UPSAMPLE_FRAG_WGSL,
} from '../../shaders/generated/globalMedium.wgsl.ts';
import type { UniformFields } from './scatterPass.ts';
import type { PipelineCache } from './pipelineCache.ts';
import { shaderModule } from './shaderModules.ts';

/**
 * The composite: everything that happens to the frame after the world is drawn.
 *
 * **The scene lands off-screen and one pass puts it on the canvas.** That pass is `rush.ts`, and
 * it is one shader rather than four because every one of these effects reads the same resolved
 * image: the speed blur, the camera motion blur, the occlusion it multiplies in, the bloom it
 * adds and the tone curve it ends on. `sceneTarget.ts` makes the same argument on the other
 * backend, and both are why `bindMeshPass` grades in the mesh pass *only* when there is no
 * composite to grade in.
 *
 * **What differs here is depth.** WebGL2 resolves a multisampled depth buffer with
 * `blitFramebuffer` and reads it back; WebGPU has no multisample depth resolve at all. So a
 * frame that wants occlusion or motion blur gets a resolve of its own, written below, which
 * reads sample zero through `texture_depth_multisampled_2d` and writes it to a single-sample
 * float target the generated shaders can sample as an ordinary texture.
 */

export const RUSH_FRAG_FIELDS: UniformFields = RUSH_BINDINGS.RUSH_FRAG.fields;
export const RUSH_FRAG_SIZE = RUSH_BINDINGS.RUSH_FRAG.uniformSize;
const RUSH_UNIFORMS = RUSH_BINDINGS.RUSH_FRAG.uniforms;
const RUSH_TEXTURES = RUSH_BINDINGS.RUSH_FRAG.textures;

export const AO_FRAG_FIELDS: UniformFields = AO_BINDINGS.AO_FRAG.fields;
export const AO_FRAG_SIZE = AO_BINDINGS.AO_FRAG.uniformSize;
export const AO_BLUR_FIELDS: UniformFields = AO_BINDINGS.AO_BLUR_FRAG.fields;
export const AO_BLUR_SIZE = AO_BINDINGS.AO_BLUR_FRAG.uniformSize;

export const MEDIUM_FRAG_FIELDS: UniformFields = MEDIUM_BINDINGS.MEDIUM_FRAG.fields;
export const MEDIUM_FRAG_SIZE = MEDIUM_BINDINGS.MEDIUM_FRAG.uniformSize;
export const MEDIUM_UPSAMPLE_FIELDS: UniformFields = MEDIUM_BINDINGS.MEDIUM_UPSAMPLE_FRAG.fields;
export const MEDIUM_UPSAMPLE_SIZE = MEDIUM_BINDINGS.MEDIUM_UPSAMPLE_FRAG.uniformSize;

export const BLOOM_PREFILTER_FIELDS: UniformFields = BLOOM_BINDINGS.BLOOM_PREFILTER_FRAG.fields;
/**
 * The other two stages' blocks, read by name like every other block here.
 *
 * **Named rather than assumed to be the prefilter's**, because they are not: the downsample has
 * a texel and no threshold, and the upsample has neither — it has a radius. All three happen to
 * be sixteen bytes, which is exactly the coincidence that would let a wrong offset go unnoticed.
 * `postField` throws on a name a block does not have, and that is the point of asking.
 */
export const BLOOM_DOWNSAMPLE_FIELDS: UniformFields = BLOOM_BINDINGS.BLOOM_DOWNSAMPLE_FRAG.fields;
export const BLOOM_UPSAMPLE_FIELDS: UniformFields = BLOOM_BINDINGS.BLOOM_UPSAMPLE_FRAG.fields;
/** The widest of the three, so one slot shape holds any stage's block. */
export const BLOOM_STAGE_SIZE = Math.max(
  BLOOM_BINDINGS.BLOOM_PREFILTER_FRAG.uniformSize,
  BLOOM_BINDINGS.BLOOM_DOWNSAMPLE_FRAG.uniformSize,
  BLOOM_BINDINGS.BLOOM_UPSAMPLE_FRAG.uniformSize,
);

const VISIBILITY_FRAGMENT = 0x2;

/**
 * What the scene is drawn into when the composite exists.
 *
 * `rgba16float` where the profile asks for an HDR scene, because that is the whole point of one:
 * a bright pixel keeps its range until the tone curve, instead of being clipped at 1 by the mesh
 * pass and then tone-mapped from a value that has already lost the information. `renderer.ts`
 * calls the same option `hdrScene` and `keepsRange` for the same reason — a bloom threshold in
 * scene units means nothing against a clamped buffer.
 */
export function sceneColorFormat(hdr: boolean): GPUTextureFormat {
  return hdr ? 'rgba16float' : 'rgba8unorm';
}

/** A single-sample depth the generated shaders can sample. See the module comment. */
export const RESOLVED_DEPTH_FORMAT: GPUTextureFormat = 'r32float';

/**
 * Sample zero of a multisampled depth buffer, written to a colour target.
 *
 * **Because WebGPU cannot resolve depth.** `blitFramebuffer` does it on the other backend and
 * this has no equivalent, so the choice is between this and switching occlusion off at any
 * sample count above one. Sample zero rather than an average, deliberately: occlusion and
 * reprojection both want *a* surface's depth, and the mean of four samples across a silhouette
 * is a depth where no surface is — which reads as a halo along every edge.
 */
const DEPTH_RESOLVE_WGSL = `
@group(0) @binding(0) var source: texture_depth_multisampled_2d;

@vertex
fn vertexMain(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
  let x = f32((index << 1u) & 2u);
  let y = f32(index & 2u);
  return vec4<f32>(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
}

@fragment
fn fragmentMain(@builtin(position) position: vec4<f32>) -> @location(0) f32 {
  return textureLoad(source, vec2<i32>(position.xy), 0);
}
`;

/** The same, for a frame drawn at one sample: a plain copy so the composite has one input shape. */
const DEPTH_COPY_WGSL = `
@group(0) @binding(0) var source: texture_depth_2d;

@vertex
fn vertexMain(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
  let x = f32((index << 1u) & 2u);
  let y = f32(index & 2u);
  return vec4<f32>(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
}

@fragment
fn fragmentMain(@builtin(position) position: vec4<f32>) -> @location(0) f32 {
  return textureLoad(source, vec2<i32>(position.xy), 0);
}
`;

export function createDepthResolveLayout(
  device: GPUDevice,
  multisampled: boolean,
): GPUBindGroupLayout {
  return device.createBindGroupLayout({
    label: 'post.depthResolveLayout',
    entries: [
      {
        binding: 0,
        visibility: VISIBILITY_FRAGMENT,
        texture: { sampleType: 'depth', multisampled },
      },
    ],
  });
}

export function depthResolvePipeline(
  cache: PipelineCache,
  device: GPUDevice,
  layout: GPUBindGroupLayout,
  multisampled: boolean,
): GPURenderPipeline {
  return cache.get(`post.depthResolve:${multisampled}`, () => {
    const module = shaderModule(device, {
      label: 'post.depthResolve',
      code: multisampled ? DEPTH_RESOLVE_WGSL : DEPTH_COPY_WGSL,
    });
    return {
      label: `post.depthResolve:${multisampled}`,
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: { module, entryPoint: 'vertexMain' },
      fragment: {
        module,
        entryPoint: 'fragmentMain',
        targets: [{ format: RESOLVED_DEPTH_FORMAT }],
      },
      primitive: { topology: 'triangle-list' as const },
    };
  });
}

/**
 * One texture, one sampler, one uniform block: the shape every stage of this chain has.
 *
 * The bloom stages and the occlusion blur all read a source and a size, so they share a layout
 * builder rather than three copies of the same six lines.
 */
export function createPostStageLayout(
  device: GPUDevice,
  uniformBinding: number,
  uniformSize: number,
  textures: readonly {
    binding: { texture: number; sampler: number };
    filterable?: boolean;
    /**
     * `'2d'` unless said otherwise, because every post input but one is a screen-sized target.
     *
     * The exception is the colour grade's lookup table, which is a cube of display values and
     * declares `texture_3d<f32>` in the generated WGSL. A layout that left this at `'2d'` is
     * rejected at bind-group creation rather than at draw — which is the *good* case, and is
     * only good because it is stated: a dimension is a property of the texture and never of the
     * pass reading it, which is the lesson `filterable` above records twice already.
     */
    dimension?: GPUTextureViewDimension;
  }[],
): GPUBindGroupLayout {
  const entries: GPUBindGroupLayoutEntry[] = [
    {
      binding: uniformBinding,
      visibility: VISIBILITY_FRAGMENT,
      buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: uniformSize },
    },
  ];
  for (const { binding, filterable = true, dimension = '2d' } of textures) {
    /*
     * **The resolved depth is `r32float`, which is `UnfilterableFloat` and nothing else.**
     *
     * The colour inputs are ordinary render targets and filter fine; this one does not, and
     * declaring it alongside them is rejected in the words this backend has now heard three
     * times: *"None of the supported sample types (UnfilterableFloat) of [Texture
     * "post.resolvedDepth"] match the expected sample types (Float)"*. `depthPass.ts` learned
     * it on a shadow map and `flatPass.ts` on the environment cube; the lesson is that a
     * texture's filterability is a property of its format and never of the pass using it.
     *
     * `r16float` would filter, and would throw away the depth precision occlusion and
     * reprojection are built on. So the format stays and the declaration bends.
     */
    entries.push({
      binding: binding.texture,
      visibility: VISIBILITY_FRAGMENT,
      texture: filterable
        ? { viewDimension: dimension }
        : { sampleType: 'unfilterable-float', viewDimension: dimension },
    });
    entries.push({
      binding: binding.sampler,
      visibility: VISIBILITY_FRAGMENT,
      sampler: { type: filterable ? 'filtering' : 'non-filtering' },
    });
  }
  return device.createBindGroupLayout({ label: 'post.stageLayout', entries });
}

/**
 * Additive, for the way back up the bloom pyramid.
 *
 * Each level is added *into* the one above it rather than replacing it, so level 0 ends up
 * holding every octave at once — which is what makes the falloff the sum of the octaves rather
 * than one kernel's. `bloomPass.ts` reaches the same place with `blendFunc(ONE, ONE)` and a
 * `loadOp` of `load` is the other half of it here: a cleared attachment would discard the
 * level the downsample just wrote and add the octave to nothing.
 */
/**
 * What composites the order-independent buffers over the finished scene.
 *
 * Against a fragment carrying the average colour and the revealage, this computes
 * `average * (1 - reveal) + scene * reveal` — which is the resolve. Doing it in the blend rather
 * than by sampling means the pass never reads the target it writes.
 */
export const OIT_COMPOSITE_BLEND: GPUBlendState = {
  color: { srcFactor: 'one-minus-src-alpha', dstFactor: 'src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one-minus-src-alpha', dstFactor: 'src-alpha', operation: 'add' },
};

/**
 * What a drawn decal does to the pixel under it: `dst * src`.
 *
 * White is the identity, so a fragment the projector missed changes nothing and the shader needs
 * no branch and no discard. It multiplies the *lit* pixel, which is the whole reason a mark placed
 * this late still takes the receiver's lighting — `decalProject.ts` argues that where it is
 * written, and `decalPass.ts` sets the same pair on the other backend.
 */
/**
 * What a global medium does to the pixel under it: `dst * transmittance + inscatter`.
 *
 * **The transfer equation for one segment, written as a blend state.** The march puts scattered
 * light in `rgb` and how much of the frame survives the journey in `a`, so `(one, src-alpha)` is
 * exactly the integral — and the composite therefore never samples the colour it is modifying,
 * which is the read both backends are entitled to call undefined.
 *
 * Alpha is `(zero, one)`: the frame's own alpha is not the medium's to spend. The scene target
 * carries it to the canvas, and a medium that wrote there would make a foggy frame translucent.
 */
export const MEDIUM_TRANSMIT_BLEND: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'src-alpha', operation: 'add' },
  alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
};

export const DECAL_MULTIPLY_BLEND: GPUBlendState = {
  color: { srcFactor: 'zero', dstFactor: 'src', operation: 'add' },
  alpha: { srcFactor: 'zero', dstFactor: 'src', operation: 'add' },
};

/**
 * `over`, against colour a pass has already multiplied by its own coverage.
 *
 * What the screen-space reflection writes and what composites it: the trace multiplies what it
 * found by how much of it lands, so two reflective surfaces overlapping layer the way two blended
 * surfaces do rather than the way two independent guesses do — and the resolve then never has to
 * sample the colour it is compositing onto.
 */
export const PREMULTIPLIED_OVER_BLEND: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};

export const ADDITIVE_BLEND: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
};

/** A fullscreen pass over one or more inputs, writing to one colour target. */
export function postPipeline(
  cache: PipelineCache,
  device: GPUDevice,
  layout: GPUBindGroupLayout,
  key: string,
  fragment: string,
  format: GPUTextureFormat,
  blend?: GPUBlendState,
): GPURenderPipeline {
  return cache.get(key, () => ({
    label: key,
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    vertex: {
      module: shaderModule(device, { label: 'post.vert', code: FULLSCREEN_VERT_WGSL }),
      entryPoint: 'main',
    },
    fragment: {
      module: shaderModule(device, { label: key, code: fragment }),
      entryPoint: 'main',
      targets: [blend === undefined ? { format } : { format, blend }],
    },
    /*
     * No depth at all, which is what makes this different from every other pipeline here: the
     * composite writes over a finished frame and has nothing to sort against. `sceneTarget.ts`
     * disables the test, the write and culling by hand for the same draw.
     */
    primitive: { topology: 'triangle-list' as const, cullMode: 'none' as const },
  }));
}

/**
 * The temporal resolve's block and its three inputs.
 *
 * Named like the occlusion's beside it, and for the same reason `BLOOM_DOWNSAMPLE_FIELDS` is: a
 * block read by assumption rather than by name is a uniform written to the wrong offset, which
 * draws a plausible picture.
 */
export const TAA_FRAG_FIELDS: UniformFields = TAA_BINDINGS.TEMPORAL_RESOLVE_FRAG.fields;
export const TAA_FRAG_SIZE = TAA_BINDINGS.TEMPORAL_RESOLVE_FRAG.uniformSize;
export const TAA_UNIFORMS = TAA_BINDINGS.TEMPORAL_RESOLVE_FRAG.uniforms;
export const TAA_TEXTURES = TAA_BINDINGS.TEMPORAL_RESOLVE_FRAG.textures;

/**
 * The order-independent resolve's inputs. It has no uniform block of its own — the whole pass is
 * two texture fetches and a divide — so only the textures are named here.
 */
export const OIT_TEXTURES = OIT_BINDINGS.OIT_RESOLVE_FRAG.textures;

/**
 * A drawn decal's block and the one texture it reads.
 *
 * One block per mark and a frame may draw many, so the buffer holds an aligned slot each and the
 * pass binds by dynamic offset — the arrangement the bloom chain already uses, and for the same
 * reason: `queue.writeBuffer` does not interleave with recorded commands, so one block rewritten
 * between two passes gives both passes the last write.
 */
export const DECAL_FRAG_FIELDS: UniformFields = DECAL_BINDINGS.DECAL_PROJECT_FRAG.fields;
export const DECAL_FRAG_SIZE = DECAL_BINDINGS.DECAL_PROJECT_FRAG.uniformSize;
export const DECAL_UNIFORMS = DECAL_BINDINGS.DECAL_PROJECT_FRAG.uniforms;
export const DECAL_TEXTURES = DECAL_BINDINGS.DECAL_PROJECT_FRAG.textures;

/**
 * The reflection trace's block and its two inputs, and the resolve's one.
 *
 * One block per surface and a frame may draw several, so the buffer holds an aligned slot each and
 * the pass binds by dynamic offset — the arrangement the bloom chain and the decals already use,
 * and for the reason `bloomStaging` states: `queue.writeBuffer` does not interleave with recorded
 * commands, so one block rewritten between two passes gives both passes the last write.
 */
export const SSR_FRAG_FIELDS: UniformFields = SSR_BINDINGS.SSR_TRACE_FRAG.fields;
export const SSR_FRAG_SIZE = SSR_BINDINGS.SSR_TRACE_FRAG.uniformSize;
export const SSR_UNIFORMS = SSR_BINDINGS.SSR_TRACE_FRAG.uniforms;
export const SSR_TEXTURES = SSR_BINDINGS.SSR_TRACE_FRAG.textures;
export const SSR_RESOLVE_TEXTURES = SSR_RESOLVE_BINDINGS.SSR_RESOLVE_FRAG.textures;

/**
 * The resolve's layout: one texture and no uniform block.
 *
 * `createPostStageLayout` cannot express this — it makes a block mandatory, every other stage in
 * the chain having one — and this pass has nothing to parameterise: it fetches a texel and hands it
 * to the blend state. A buffer allocated, bound and never read is worse than a second builder.
 */
export function createSsrResolveLayout(device: GPUDevice): GPUBindGroupLayout {
  const binding = SSR_RESOLVE_TEXTURES.uSsrReflection;
  return device.createBindGroupLayout({
    label: 'post.ssrResolveLayout',
    entries: [
      {
        binding: binding.texture,
        visibility: VISIBILITY_FRAGMENT,
        texture: { viewDimension: '2d' },
      },
      { binding: binding.sampler, visibility: VISIBILITY_FRAGMENT, sampler: { type: 'filtering' } },
    ],
  });
}

/**
 * The resolve's layout: two textures and no uniform block.
 *
 * **`createPostStageLayout` cannot express this**, because every other pass in the chain has a
 * block and it makes one mandatory. This pass has nothing to parameterise — it fetches the two
 * buffers, divides and hands the result to the blend state — so a layout with a uniform binding
 * nothing writes would be a buffer allocated, bound and never read.
 */
export function createOitResolveLayout(device: GPUDevice): GPUBindGroupLayout {
  const entries: GPUBindGroupLayoutEntry[] = [];
  for (const binding of [OIT_TEXTURES.uOitAccum, OIT_TEXTURES.uOitReveal]) {
    entries.push({
      binding: binding.texture,
      visibility: VISIBILITY_FRAGMENT,
      texture: { viewDimension: '2d' },
    });
    entries.push({
      binding: binding.sampler,
      visibility: VISIBILITY_FRAGMENT,
      sampler: { type: 'filtering' },
    });
  }
  return device.createBindGroupLayout({ label: 'post.oitResolveLayout', entries });
}

export { MEDIUM_FRAG_WGSL, MEDIUM_UPSAMPLE_FRAG_WGSL };
export const MEDIUM_UNIFORMS = MEDIUM_BINDINGS.MEDIUM_FRAG.uniforms;
export const MEDIUM_TEXTURES = MEDIUM_BINDINGS.MEDIUM_FRAG.textures;
export const MEDIUM_UPSAMPLE_UNIFORMS = MEDIUM_BINDINGS.MEDIUM_UPSAMPLE_FRAG.uniforms;
export const MEDIUM_UPSAMPLE_TEXTURES = MEDIUM_BINDINGS.MEDIUM_UPSAMPLE_FRAG.textures;

export {
  RUSH_FRAG_WGSL,
  AO_FRAG_WGSL,
  AO_BLUR_FRAG_WGSL,
  TEMPORAL_RESOLVE_FRAG_WGSL,
  OIT_RESOLVE_FRAG_WGSL,
  DECAL_PROJECT_FRAG_WGSL,
  SSR_TRACE_FRAG_WGSL,
  SSR_RESOLVE_FRAG_WGSL,
};
export { BLOOM_PREFILTER_FRAG_WGSL, BLOOM_DOWNSAMPLE_FRAG_WGSL, BLOOM_UPSAMPLE_FRAG_WGSL };
export { RUSH_UNIFORMS, RUSH_TEXTURES };
export const AO_UNIFORMS = AO_BINDINGS.AO_FRAG.uniforms;
export const AO_TEXTURES = AO_BINDINGS.AO_FRAG.textures;
export const AO_BLUR_UNIFORMS = AO_BINDINGS.AO_BLUR_FRAG.uniforms;
export const AO_BLUR_TEXTURES = AO_BINDINGS.AO_BLUR_FRAG.textures;
export const BLOOM_UNIFORMS = BLOOM_BINDINGS.BLOOM_PREFILTER_FRAG.uniforms;
export const BLOOM_TEXTURES = BLOOM_BINDINGS.BLOOM_PREFILTER_FRAG.textures;
