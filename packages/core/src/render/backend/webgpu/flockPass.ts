import { DEPTH_COMPARE } from '../../depthConvention.ts';
import {
  FLOCK_BINDINGS,
  FLOCK_FRAG_WGSL,
  FLOCK_VERT_WGSL,
} from '../../shaders/generated/flock.wgsl.ts';
import { buildFlockGeometry } from '../../flockGeometry.ts';
import type { UniformFields } from './scatterPass.ts';
import { DEPTH_FORMAT } from './flatPass.ts';
import type { PipelineCache } from './pipelineCache.ts';
import { shaderModule } from './shaderModules.ts';

/**
 * The flock pass: ambient sky life, two triangles a bird, every path in the vertex shader.
 *
 * **The one effect in this backend that is neither blended nor additive.** A bird is opaque and
 * writes depth like any other surface, which is what lets one pass in front of another. Nothing
 * is culled: they are flat cards seen from both sides as they bank.
 */

export const FLOCK_VERT_FIELDS: UniformFields = FLOCK_BINDINGS.FLOCK_VERT.fields;
export const FLOCK_VERT_SIZE = FLOCK_BINDINGS.FLOCK_VERT.uniformSize;
export const FLOCK_FRAG_FIELDS: UniformFields = FLOCK_BINDINGS.FLOCK_FRAG.fields;
export const FLOCK_FRAG_SIZE = FLOCK_BINDINGS.FLOCK_FRAG.uniformSize;

const VERT_BINDING = FLOCK_BINDINGS.FLOCK_VERT.uniforms;
const FRAG_BINDING = FLOCK_BINDINGS.FLOCK_FRAG.uniforms;

const VISIBILITY_VERTEX = 0x1;
const VISIBILITY_FRAGMENT = 0x2;
const USAGE_VERTEX = 0x0020 | 0x0008;

/** A flock on the device, behind the surface's opaque handle. */
export interface GpuFlock {
  readonly corners: GPUBuffer;
  readonly wings: GPUBuffer;
  readonly indices: GPUBuffer;
  readonly vertexCount: number;
  dispose(): void;
}

export function createGpuFlock(device: GPUDevice, count: number): GpuFlock {
  const geometry = buildFlockGeometry(count);
  const upload = (data: Float32Array, label: string): GPUBuffer => {
    const buffer = device.createBuffer({
      label,
      size: Math.max(4, data.byteLength),
      usage: USAGE_VERTEX,
    });
    device.queue.writeBuffer(buffer, 0, data);
    return buffer;
  };
  const corners = upload(geometry.corners, 'flock.corners');
  const wings = upload(geometry.wings, 'flock.wings');
  const indices = upload(geometry.indices, 'flock.indices');

  return {
    corners,
    wings,
    indices,
    vertexCount: geometry.vertexCount,
    dispose(): void {
      corners.destroy();
      wings.destroy();
      indices.destroy();
    },
  };
}

/** `aCorner`, `aWing`, `aIndex` — one buffer each, as `FlockRenderer` holds them. */
export function flockVertexLayouts(): GPUVertexBufferLayout[] {
  return [
    {
      arrayStride: 8,
      attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' as GPUVertexFormat }],
    },
    {
      arrayStride: 4,
      attributes: [{ shaderLocation: 1, offset: 0, format: 'float32' as GPUVertexFormat }],
    },
    {
      arrayStride: 4,
      attributes: [{ shaderLocation: 2, offset: 0, format: 'float32' as GPUVertexFormat }],
    },
  ];
}

export function createFlockBindGroupLayout(device: GPUDevice): GPUBindGroupLayout {
  return device.createBindGroupLayout({
    label: 'flock.layout',
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
        buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: FLOCK_VERT_SIZE },
      },
      {
        binding: FRAG_BINDING,
        visibility: VISIBILITY_FRAGMENT,
        buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: FLOCK_FRAG_SIZE },
      },
    ],
  });
}

export function createFlockBindGroup(
  device: GPUDevice,
  layout: GPUBindGroupLayout,
  vertices: GPUBuffer,
  fragments: GPUBuffer,
): GPUBindGroup {
  return device.createBindGroup({
    label: 'flock.bindGroup',
    layout,
    entries: [
      { binding: VERT_BINDING, resource: { buffer: vertices, size: FLOCK_VERT_SIZE } },
      { binding: FRAG_BINDING, resource: { buffer: fragments, size: FLOCK_FRAG_SIZE } },
    ],
  });
}

/**
 * The pipeline.
 *
 * `less` and depth written, matching the flat pass: a bird is geometry in the world rather than
 * an effect over it, and a flock that did not write depth would show every bird through every
 * other one.
 */
export function flockPipeline(
  cache: PipelineCache,
  device: GPUDevice,
  layout: GPUBindGroupLayout,
): GPURenderPipeline {
  return cache.get('flock', () => ({
    label: 'flock',
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    vertex: {
      module: shaderModule(device, { label: 'flock.vert', code: FLOCK_VERT_WGSL }),
      entryPoint: 'main',
      buffers: flockVertexLayouts(),
    },
    fragment: {
      module: shaderModule(device, { label: 'flock.frag', code: FLOCK_FRAG_WGSL }),
      entryPoint: 'main',
      targets: [{ format: cache.format }],
    },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    multisample: { count: cache.sampleCount },
    depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: DEPTH_COMPARE },
  }));
}
