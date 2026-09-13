import { DEPTH_COMPARE } from '../../depthConvention.ts';
import {
  FILM_BINDINGS,
  FILM_FRAG_WGSL,
  FILM_VERT_WGSL,
} from '../../shaders/generated/film.wgsl.ts';
import { vertexBufferLayouts } from './buffers.ts';
import type { UniformFields } from './scatterPass.ts';
import { DEPTH_FORMAT } from './flatPass.ts';
import type { PipelineCache } from './pipelineCache.ts';
import { shaderModule } from './shaderModules.ts';

/**
 * The film pass: a thin wet layer — an oil slick, a puddle — lying over the world.
 *
 * Its own pass because it is its own material: view-dependent iridescence and a dissolving
 * edge, neither of which the flat shader can express. `renderer.ts` says the rest, including
 * why `sheen` is iridescence rather than wetness and where its usable range is.
 *
 * The geometry is an ordinary mesh, so the vertex layout is the flat pass's own — the shader
 * reads position, normal, colour and a coverage weight, and the pipeline still has to describe
 * every attribute the module declares.
 */

export const FILM_VERT_FIELDS: UniformFields = FILM_BINDINGS.FILM_VERT.fields;
export const FILM_VERT_SIZE = FILM_BINDINGS.FILM_VERT.uniformSize;
export const FILM_FRAG_FIELDS: UniformFields = FILM_BINDINGS.FILM_FRAG.fields;
export const FILM_FRAG_SIZE = FILM_BINDINGS.FILM_FRAG.uniformSize;

const VERT_BINDING = FILM_BINDINGS.FILM_VERT.uniforms;
const FRAG_BINDING = FILM_BINDINGS.FILM_FRAG.uniforms;
const REFLECTION = FILM_BINDINGS.FILM_FRAG.textures.uReflectionMap;

const VISIBILITY_VERTEX = 0x1;
const VISIBILITY_FRAGMENT = 0x2;

export function createFilmBindGroupLayout(device: GPUDevice): GPUBindGroupLayout {
  return device.createBindGroupLayout({
    label: 'film.layout',
    entries: [
      {
        binding: VERT_BINDING,
        visibility: VISIBILITY_VERTEX,
        buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: FILM_VERT_SIZE },
      },
      {
        binding: FRAG_BINDING,
        visibility: VISIBILITY_FRAGMENT,
        buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: FILM_FRAG_SIZE },
      },
      /*
       * The mirror is an ordinary colour target, so a filtering sampler is right here — unlike
       * every `...ShadowMap`, which is a depth format and cannot take one. `depthPass.ts` has
       * the message the device gives when the two are confused.
       */
      { binding: REFLECTION.texture, visibility: VISIBILITY_FRAGMENT, texture: {} },
      { binding: REFLECTION.sampler, visibility: VISIBILITY_FRAGMENT, sampler: {} },
    ],
  });
}

/** Bound once against both rings; a dynamic offset per film. See `createPanelBindGroup`. */
export function createFilmBindGroup(
  device: GPUDevice,
  layout: GPUBindGroupLayout,
  vertices: GPUBuffer,
  fragments: GPUBuffer,
  reflection: GPUTextureView,
  sampler: GPUSampler,
): GPUBindGroup {
  return device.createBindGroup({
    label: 'film.bindGroup',
    layout,
    entries: [
      { binding: VERT_BINDING, resource: { buffer: vertices, size: FILM_VERT_SIZE } },
      { binding: FRAG_BINDING, resource: { buffer: fragments, size: FILM_FRAG_SIZE } },
      { binding: REFLECTION.texture, resource: reflection },
      { binding: REFLECTION.sampler, resource: sampler },
    ],
  });
}

/**
 * The pipeline.
 *
 * **Alpha over, depth tested, depth not written.** A slick lies on the surface it was built
 * against instead of fighting it for the depth buffer, which is what `renderer.ts` says by
 * turning `depthMask` off around the draw. Writing depth would let a translucent patch occlude
 * whatever is drawn after it.
 */
export function filmPipeline(
  cache: PipelineCache,
  device: GPUDevice,
  layout: GPUBindGroupLayout,
  key: string,
  present: Readonly<Record<string, boolean>>,
): GPURenderPipeline {
  return cache.get(key, () => ({
    label: key,
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    vertex: {
      module: shaderModule(device, { label: 'film.vert', code: FILM_VERT_WGSL }),
      entryPoint: 'main',
      buffers: vertexBufferLayouts(present),
    },
    fragment: {
      module: shaderModule(device, { label: 'film.frag', code: FILM_FRAG_WGSL }),
      entryPoint: 'main',
      targets: [
        {
          format: cache.format,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        },
      ],
    },
    primitive: { topology: 'triangle-list', cullMode: 'back' },
    multisample: { count: cache.sampleCount },
    depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: DEPTH_COMPARE },
  }));
}
