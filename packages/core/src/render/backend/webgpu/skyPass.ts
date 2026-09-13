import { DEPTH_COMPARE_EQUAL } from '../../depthConvention.ts';
import { SKY_BINDINGS, SKY_FRAG_WGSL, SKY_VERT_WGSL } from '../../shaders/generated/sky.wgsl.ts';
import { DEPTH_FORMAT } from './flatPass.ts';
import type { PipelineCache } from './pipelineCache.ts';
import { shaderModule } from './shaderModules.ts';

/**
 * The sky: one triangle covering the screen, with the world reconstructed per fragment.
 *
 * **No vertex buffers at all.** The vertex shader builds its three corners from
 * `gl_VertexIndex` — `gl_VertexID` in the GLSL, which the transform renames — so there is
 * nothing to upload and nothing to bind. That makes this the simplest pass in the engine to
 * port and a good second one after `flat`.
 */

export const SKY_FIELDS = SKY_BINDINGS.SKY_FRAG.fields;
export const SKY_UNIFORM_SIZE = SKY_BINDINGS.SKY_FRAG.uniformSize;

const SKY_BINDING = SKY_BINDINGS.SKY_FRAG.uniforms;
const VISIBILITY_FRAGMENT = 0x2;

export function createSkyBindGroupLayout(device: GPUDevice): GPUBindGroupLayout {
  return device.createBindGroupLayout({
    label: 'sky.bindGroupLayout',
    entries: [
      {
        binding: SKY_BINDING,
        visibility: VISIBILITY_FRAGMENT,
        buffer: { type: 'uniform', minBindingSize: SKY_UNIFORM_SIZE },
      },
    ],
  });
}

export function createSkyBindGroup(
  device: GPUDevice,
  layout: GPUBindGroupLayout,
  uniforms: GPUBuffer,
): GPUBindGroup {
  return device.createBindGroup({
    label: 'sky.bindGroup',
    layout,
    entries: [{ binding: SKY_BINDING, resource: { buffer: uniforms, size: SKY_UNIFORM_SIZE } }],
  });
}

/**
 * The sky pipeline.
 *
 * **Depth is tested but not written**, which is what `gl.depthMask(false)` does on the
 * WebGL2 path. The sky sits at the far plane, so writing its depth would push every later
 * pass behind it; not testing at all would paint it over geometry already drawn.
 */
export function skyPipeline(
  cache: PipelineCache,
  device: GPUDevice,
  layout: GPUBindGroupLayout,
): GPURenderPipeline {
  return cache.get('sky', () => ({
    label: 'sky',
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    vertex: {
      module: shaderModule(device, { label: 'sky.vert', code: SKY_VERT_WGSL }),
      entryPoint: 'main',
      buffers: [],
    },
    fragment: {
      module: shaderModule(device, { label: 'sky.frag', code: SKY_FRAG_WGSL }),
      entryPoint: 'main',
      targets: [{ format: cache.format }],
    },
    primitive: { topology: 'triangle-list' },
    multisample: { count: cache.sampleCount },
    depthStencil: {
      format: DEPTH_FORMAT,
      depthWriteEnabled: false,
      /*
       * `less-equal` rather than `less`: the triangle is emitted at exactly the far plane,
       * and a cleared depth buffer holds exactly that value, so `less` would reject every
       * fragment and the sky would never appear.
       */
      depthCompare: DEPTH_COMPARE_EQUAL,
    },
  }));
}
