import { DEPTH_COMPARE } from '../../depthConvention.ts';
import {
  WINDSTREAKS_BINDINGS,
  WIND_STREAK_FRAG_WGSL,
  WIND_STREAK_VERT_WGSL,
} from '../../shaders/generated/windStreaks.wgsl.ts';
import { buildWindStreakLattice } from '../../windStreakDraw.ts';
import type { UniformFields } from './scatterPass.ts';
import { DEPTH_FORMAT } from './flatPass.ts';
import type { PipelineCache } from './pipelineCache.ts';
import { shaderModule } from './shaderModules.ts';

/**
 * The wind-streak pass: a lattice of debris that follows the camera and wraps.
 *
 * **Nothing here is per frame except ten uniforms.** The whole effect lives in the vertex
 * shader — a particle's place comes from its index and the clock, and the box it sits in wraps
 * around the camera — so there is no spawning, no pooling and no upload once the lattice is
 * built.
 *
 * Blended over what is behind it rather than added, because dust in air occludes: this is the
 * one effect in this backend that is neither opaque nor additive.
 */

export const WIND_STREAK_VERT_FIELDS: UniformFields = WINDSTREAKS_BINDINGS.WIND_STREAK_VERT.fields;
export const WIND_STREAK_VERT_SIZE = WINDSTREAKS_BINDINGS.WIND_STREAK_VERT.uniformSize;
export const WIND_STREAK_FRAG_FIELDS: UniformFields = WINDSTREAKS_BINDINGS.WIND_STREAK_FRAG.fields;
export const WIND_STREAK_FRAG_SIZE = WINDSTREAKS_BINDINGS.WIND_STREAK_FRAG.uniformSize;

const VERT_BINDING = WINDSTREAKS_BINDINGS.WIND_STREAK_VERT.uniforms;
const FRAG_BINDING = WINDSTREAKS_BINDINGS.WIND_STREAK_FRAG.uniforms;

const VISIBILITY_VERTEX = 0x1;
const VISIBILITY_FRAGMENT = 0x2;
const USAGE_VERTEX = 0x0020 | 0x0008;

/** A lattice on the device, behind the surface's opaque handle. */
export interface GpuWindStreaks {
  readonly corners: GPUBuffer;
  readonly indices: GPUBuffer;
  readonly vertexCount: number;
  readonly cellSize: number;
  readonly count: number;
  readonly onsetSpeed: number;
  readonly fullSpeed: number;
  dispose(): void;
}

export function createGpuWindStreaks(
  device: GPUDevice,
  count: number,
  cellSize: number,
  onsetSpeed: number,
  fullSpeed: number,
): GpuWindStreaks {
  const lattice = buildWindStreakLattice(count);
  const upload = (data: Float32Array, label: string): GPUBuffer => {
    const buffer = device.createBuffer({
      label,
      size: Math.max(4, data.byteLength),
      usage: USAGE_VERTEX,
    });
    device.queue.writeBuffer(buffer, 0, data);
    return buffer;
  };
  const corners = upload(lattice.corners, 'windStreaks.corners');
  const indices = upload(lattice.indices, 'windStreaks.indices');

  return {
    corners,
    indices,
    vertexCount: lattice.vertexCount,
    cellSize,
    count,
    onsetSpeed,
    fullSpeed,
    dispose(): void {
      corners.destroy();
      indices.destroy();
    },
  };
}

/**
 * `aCorner` and `aIndex`, one buffer each, matching what `WindStreakRenderer` binds.
 *
 * Not interleaved, because they are two separate arrays on both sides and two of eight slots is
 * nothing. The flat pass interleaves only because ten attributes will not fit.
 */
export function windStreakVertexLayouts(): GPUVertexBufferLayout[] {
  return [
    {
      arrayStride: 8,
      attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' as GPUVertexFormat }],
    },
    {
      arrayStride: 4,
      attributes: [{ shaderLocation: 1, offset: 0, format: 'float32' as GPUVertexFormat }],
    },
  ];
}

export function createWindStreakBindGroupLayout(device: GPUDevice): GPUBindGroupLayout {
  return device.createBindGroupLayout({
    label: 'windStreaks.layout',
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
        buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: WIND_STREAK_VERT_SIZE },
      },
      {
        binding: FRAG_BINDING,
        visibility: VISIBILITY_FRAGMENT,
        buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: WIND_STREAK_FRAG_SIZE },
      },
    ],
  });
}

export function createWindStreakBindGroup(
  device: GPUDevice,
  layout: GPUBindGroupLayout,
  vertices: GPUBuffer,
  fragments: GPUBuffer,
): GPUBindGroup {
  return device.createBindGroup({
    label: 'windStreaks.bindGroup',
    layout,
    entries: [
      { binding: VERT_BINDING, resource: { buffer: vertices, size: WIND_STREAK_VERT_SIZE } },
      { binding: FRAG_BINDING, resource: { buffer: fragments, size: WIND_STREAK_FRAG_SIZE } },
    ],
  });
}

/**
 * The pipeline.
 *
 * **Alpha over, depth tested, depth not written, nothing culled.** A streak is a two-sided
 * card carried past the camera at any angle, so culling it would drop half of them for no
 * saving; writing depth would let a translucent smear occlude whatever is drawn after it.
 */
export function windStreakPipeline(
  cache: PipelineCache,
  device: GPUDevice,
  layout: GPUBindGroupLayout,
): GPURenderPipeline {
  return cache.get('windStreaks', () => ({
    label: 'windStreaks',
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    vertex: {
      module: shaderModule(device, {
        label: 'windStreaks.vert',
        code: WIND_STREAK_VERT_WGSL,
      }),
      entryPoint: 'main',
      buffers: windStreakVertexLayouts(),
    },
    fragment: {
      module: shaderModule(device, {
        label: 'windStreaks.frag',
        code: WIND_STREAK_FRAG_WGSL,
      }),
      entryPoint: 'main',
      targets: [
        {
          format: cache.format,
          blend: {
            color: {
              srcFactor: 'src-alpha',
              dstFactor: 'one-minus-src-alpha',
              operation: 'add',
            },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        },
      ],
    },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    multisample: { count: cache.sampleCount },
    depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: DEPTH_COMPARE },
  }));
}
