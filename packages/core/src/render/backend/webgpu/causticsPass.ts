import { DEPTH_COMPARE } from '../../depthConvention.ts';
import {
  CAUSTICS_BINDINGS,
  CAUSTICS_FRAG_WGSL,
  CAUSTICS_VERT_WGSL,
} from '../../shaders/generated/caustics.wgsl.ts';
import type { UniformFields } from './scatterPass.ts';
import { DEPTH_FORMAT } from './flatPass.ts';
import type { PipelineCache } from './pipelineCache.ts';
import { shaderModule } from './shaderModules.ts';

/**
 * The caustics pass: a surface lit by nearby water.
 *
 * `causticsRenderer.ts` carries the argument for the feature and for its limits, including why
 * the ambient term is not decoration and why either side of the water works. The geometry comes
 * from `buildSheets`, which both backends call, so this owns three buffers and a pipeline.
 */

export const CAUSTICS_VERT_FIELDS: UniformFields = CAUSTICS_BINDINGS.CAUSTICS_VERT.fields;
export const CAUSTICS_VERT_SIZE = CAUSTICS_BINDINGS.CAUSTICS_VERT.uniformSize;
export const CAUSTICS_FRAG_FIELDS: UniformFields = CAUSTICS_BINDINGS.CAUSTICS_FRAG.fields;
export const CAUSTICS_FRAG_SIZE = CAUSTICS_BINDINGS.CAUSTICS_FRAG.uniformSize;

const VERT_BINDING = CAUSTICS_BINDINGS.CAUSTICS_VERT.uniforms;
const FRAG_BINDING = CAUSTICS_BINDINGS.CAUSTICS_FRAG.uniforms;

const VISIBILITY_VERTEX = 0x1;
const VISIBILITY_FRAGMENT = 0x2;
const USAGE_VERTEX = 0x0020 | 0x0008; // VERTEX | COPY_DST

/** A lit surface on the device, behind the API's opaque handle. */
export interface GpuCaustics {
  readonly vertexBuffers: readonly GPUBuffer[];
  readonly vertexCount: number;
  dispose(): void;
}

export function createGpuCaustics(
  device: GPUDevice,
  positions: Float32Array,
  locals: Float32Array,
  params: Float32Array,
  vertexCount: number,
): GpuCaustics {
  const upload = (data: Float32Array, label: string): GPUBuffer => {
    const buffer = device.createBuffer({
      label,
      size: Math.max(4, data.byteLength),
      usage: USAGE_VERTEX,
    });
    device.queue.writeBuffer(buffer, 0, data);
    return buffer;
  };
  const buffers = [
    upload(positions, 'caustics.rest'),
    upload(locals, 'caustics.local'),
    upload(params, 'caustics.params'),
  ];
  return {
    vertexBuffers: buffers,
    vertexCount,
    dispose(): void {
      for (const buffer of buffers) buffer.destroy();
    },
  };
}

/** `aRest`, `aLocal`, `aParams` — three arrays on both sides, so three buffers. */
export function causticsVertexLayouts(): GPUVertexBufferLayout[] {
  return [
    {
      arrayStride: 12,
      attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' as GPUVertexFormat }],
    },
    {
      arrayStride: 8,
      attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x2' as GPUVertexFormat }],
    },
    {
      arrayStride: 8,
      attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x2' as GPUVertexFormat }],
    },
  ];
}

export function createCausticsBindGroupLayout(device: GPUDevice): GPUBindGroupLayout {
  return device.createBindGroupLayout({
    label: 'caustics.layout',
    entries: [
      /*
       * **Addressed by a dynamic offset, so a frame can draw more than one batch.**
       *
       * With one buffer rewritten between draws, every batch reads whatever was written last:
       * `queue.write*` calls are ordered on the queue timeline and the encoder is submitted after
       * every one of them. The picture is each batch wearing the last one's colour, width, time
       * and placement. That is the hazard `UniformRing` exists for, recorded in `AGENTS.md` on
       * 2026-08-27, and this pass was one of four still carrying it — invisible for as long as
       * nothing drew two, which is exactly how water kept it for eight releases.
       *
       * WebGL2 needs none of this: it sets uniforms and draws in one stream.
       */
      {
        binding: VERT_BINDING,
        visibility: VISIBILITY_VERTEX,
        buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: CAUSTICS_VERT_SIZE },
      },
      {
        binding: FRAG_BINDING,
        visibility: VISIBILITY_FRAGMENT,
        buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: CAUSTICS_FRAG_SIZE },
      },
    ],
  });
}

export function createCausticsBindGroup(
  device: GPUDevice,
  layout: GPUBindGroupLayout,
  vertices: GPUBuffer,
  fragments: GPUBuffer,
): GPUBindGroup {
  return device.createBindGroup({
    label: 'caustics.bindGroup',
    layout,
    entries: [
      { binding: VERT_BINDING, resource: { buffer: vertices, size: CAUSTICS_VERT_SIZE } },
      { binding: FRAG_BINDING, resource: { buffer: fragments, size: CAUSTICS_FRAG_SIZE } },
    ],
  });
}

/**
 * The pipeline.
 *
 * **Added, not blended over**, because this is light arriving at a surface rather than the
 * surface: `gl.blendFunc(ONE, ONE)` on the other backend. Nothing culled, because a sheet is
 * seen from either side — a pool floor from above and a soffit from below.
 *
 * **Depth tested and depth not written**, and the test is the part that matters:
 * `causticsRenderer.ts` records that the sheet sits a couple of centimetres under the surface it
 * lights, so geometry in front of it — a character, a lamp, a parapet — still occludes the light.
 */
export function causticsPipeline(
  cache: PipelineCache,
  device: GPUDevice,
  layout: GPUBindGroupLayout,
): GPURenderPipeline {
  return cache.get('caustics', () => ({
    label: 'caustics',
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    vertex: {
      module: shaderModule(device, { label: 'caustics.vert', code: CAUSTICS_VERT_WGSL }),
      entryPoint: 'main',
      buffers: causticsVertexLayouts(),
    },
    fragment: {
      module: shaderModule(device, { label: 'caustics.frag', code: CAUSTICS_FRAG_WGSL }),
      entryPoint: 'main',
      targets: [
        {
          format: cache.format,
          blend: {
            color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
          },
        },
      ],
    },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    multisample: { count: cache.sampleCount },
    depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: DEPTH_COMPARE },
  }));
}
