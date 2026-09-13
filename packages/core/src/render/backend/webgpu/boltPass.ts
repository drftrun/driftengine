import { DEPTH_COMPARE } from '../../depthConvention.ts';
import {
  BOLT_BINDINGS,
  BOLT_FRAG_WGSL,
  BOLT_VERT_WGSL,
} from '../../shaders/generated/bolt.wgsl.ts';
import { buildSegmentQuads } from '../../segmentQuads.ts';
import type { UniformFields } from './scatterPass.ts';
import { DEPTH_FORMAT } from './flatPass.ts';
import type { PipelineCache } from './pipelineCache.ts';
import { shaderModule } from './shaderModules.ts';

/**
 * The bolt pass: a pool of electrical arcs, four vertices a segment.
 *
 * **The only pass here whose vertex buffers change every frame.** Plumes, scatter, water and the
 * flock upload once and animate in the shader; an arc's endpoints are the simulation's output
 * and arrive per frame, so three of the four streams are written on each draw. The staging
 * arrays are allocated with the batch, which is what keeps the frame loop allocation-free.
 */

export const BOLT_VERT_FIELDS: UniformFields = BOLT_BINDINGS.BOLT_VERT.fields;
export const BOLT_VERT_SIZE = BOLT_BINDINGS.BOLT_VERT.uniformSize;
export const BOLT_FRAG_FIELDS: UniformFields = BOLT_BINDINGS.BOLT_FRAG.fields;
export const BOLT_FRAG_SIZE = BOLT_BINDINGS.BOLT_FRAG.uniformSize;

const VERT_BINDING = BOLT_BINDINGS.BOLT_VERT.uniforms;
const FRAG_BINDING = BOLT_BINDINGS.BOLT_FRAG.uniforms;

const VISIBILITY_VERTEX = 0x1;
const VISIBILITY_FRAGMENT = 0x2;
const USAGE_VERTEX = 0x0020 | 0x0008;
const USAGE_INDEX = 0x0010 | 0x0008;

/** A batch of arcs on the device, behind the surface's opaque handle. */
export interface GpuBolts {
  readonly fromBuffer: GPUBuffer;
  readonly toBuffer: GPUBuffer;
  readonly corners: GPUBuffer;
  readonly arcBuffer: GPUBuffer;
  readonly indices: GPUBuffer;
  readonly capacity: number;
  /** Staging, expanded from the pool's per-segment arrays to per-vertex ones. */
  readonly from: Float32Array;
  readonly to: Float32Array;
  readonly arc: Float32Array;
  dispose(): void;
}

export function createGpuBolts(device: GPUDevice, capacity: number, label: string): GpuBolts {
  const verts = capacity * 4;
  const geometry = buildSegmentQuads(capacity);

  const dynamic = (floats: number, name: string): GPUBuffer =>
    device.createBuffer({
      label: `${label}.${name}`,
      size: Math.max(4, floats * 4),
      usage: USAGE_VERTEX,
    });

  const fromBuffer = dynamic(verts * 3, 'from');
  const toBuffer = dynamic(verts * 3, 'to');
  const arcBuffer = dynamic(verts * 4, 'arc');

  const corners = device.createBuffer({
    label: `${label}.corners`,
    size: Math.max(4, geometry.corners.byteLength),
    usage: USAGE_VERTEX,
  });
  device.queue.writeBuffer(corners, 0, geometry.corners);

  const indices = device.createBuffer({
    label: `${label}.indices`,
    size: Math.max(4, geometry.indices.byteLength),
    usage: USAGE_INDEX,
  });
  device.queue.writeBuffer(indices, 0, geometry.indices);

  return {
    fromBuffer,
    toBuffer,
    corners,
    arcBuffer,
    indices,
    capacity,
    from: new Float32Array(verts * 3),
    to: new Float32Array(verts * 3),
    arc: new Float32Array(verts * 4),
    dispose(): void {
      fromBuffer.destroy();
      toBuffer.destroy();
      corners.destroy();
      arcBuffer.destroy();
      indices.destroy();
    },
  };
}

/** `aFrom`, `aTo`, `aCorner`, `aArc` — one buffer each, at the locations `bolt.ts` declares. */
export function boltVertexLayouts(): GPUVertexBufferLayout[] {
  return [
    {
      arrayStride: 12,
      attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' as GPUVertexFormat }],
    },
    {
      arrayStride: 12,
      attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' as GPUVertexFormat }],
    },
    {
      arrayStride: 8,
      attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x2' as GPUVertexFormat }],
    },
    {
      arrayStride: 16,
      attributes: [{ shaderLocation: 3, offset: 0, format: 'float32x4' as GPUVertexFormat }],
    },
  ];
}

export function createBoltBindGroupLayout(device: GPUDevice): GPUBindGroupLayout {
  return device.createBindGroupLayout({
    label: 'bolt.layout',
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
        buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: BOLT_VERT_SIZE },
      },
      {
        binding: FRAG_BINDING,
        visibility: VISIBILITY_FRAGMENT,
        buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: BOLT_FRAG_SIZE },
      },
    ],
  });
}

export function createBoltBindGroup(
  device: GPUDevice,
  layout: GPUBindGroupLayout,
  vertices: GPUBuffer,
  fragments: GPUBuffer,
): GPUBindGroup {
  return device.createBindGroup({
    label: 'bolt.bindGroup',
    layout,
    entries: [
      { binding: VERT_BINDING, resource: { buffer: vertices, size: BOLT_VERT_SIZE } },
      { binding: FRAG_BINDING, resource: { buffer: fragments, size: BOLT_FRAG_SIZE } },
    ],
  });
}

/**
 * The pipeline.
 *
 * **Additive, depth tested, depth not written, nothing culled** — the same shape every emissive
 * effect here takes, and for the same reason `plumePass` gives: an arc adds light to what is
 * behind it, so a one-minus-alpha destination factor would make a bright filament darken the
 * wall behind it, and writing depth would let it occlude whatever is drawn next.
 */
export function boltPipeline(
  cache: PipelineCache,
  device: GPUDevice,
  layout: GPUBindGroupLayout,
): GPURenderPipeline {
  return cache.get('bolt', () => ({
    label: 'bolt',
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    vertex: {
      module: shaderModule(device, { label: 'bolt.vert', code: BOLT_VERT_WGSL }),
      entryPoint: 'main',
      buffers: boltVertexLayouts(),
    },
    fragment: {
      module: shaderModule(device, { label: 'bolt.frag', code: BOLT_FRAG_WGSL }),
      entryPoint: 'main',
      targets: [
        {
          format: cache.format,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add' },
            alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
          },
        },
      ],
    },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    multisample: { count: cache.sampleCount },
    depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: DEPTH_COMPARE },
  }));
}
