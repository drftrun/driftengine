import { DEPTH_COMPARE } from '../../depthConvention.ts';
import {
  LINE_BINDINGS,
  LINE_FRAG_WGSL,
  LINE_VERT_WGSL,
} from '../../shaders/generated/line.wgsl.ts';
import { buildSegmentQuads } from '../../segmentQuads.ts';
import type { LineSegments } from '../../linePoints.ts';
import type { UniformFields } from './scatterPass.ts';
import { DEPTH_FORMAT } from './flatPass.ts';
import type { PipelineCache } from './pipelineCache.ts';
import { shaderModule } from './shaderModules.ts';

/**
 * The line pass: a polyline with a real width, four vertices a segment.
 *
 * **The plain sibling of `boltPass.ts`, sharing its quad and nothing after that.** Both turn a
 * segment into a camera-facing quad from `segmentQuads.ts`, because neither filament has a
 * thickness to see around; a bolt is additive light with no model transform and a line is a
 * fogged, alpha-blended thing in the world that moves with whatever it is attached to, hence
 * the extra `uModel` field `LINE_VERT` carries and `BOLT_VERT` does not.
 *
 * The per-frame streams are two positions, not bolt's five — no `along`/`fade`/`seed`/
 * `brightness` to carry, because a line has no envelope. `expandLineSegments` is written here
 * rather than folded into `expandBoltSegments` in `segmentQuads.ts`, for the reason
 * `lineBatch.ts` gives on the WebGL2 side: teaching that function a `LineSegments` shape too
 * would grow a union coupling two renderers that share only a quad.
 *
 * **Uniforms are a `UniformRing`, one slot a draw, not a single block like `boltPass.ts`'s.**
 * A bolt pool is drawn once a frame in every scene that has shipped so far, so a single block
 * happened to be safe there; a polyline is exactly the shape `uniformRing.ts`'s own comment
 * warns about — a waveform, several trails, a plotted curve, all in one frame — and
 * `queue.writeBuffer` does not interleave with recorded draw commands, so a single block
 * written more than once in a frame gives *every* draw that frame the last write. Found on
 * this page's own demo, which draws seven polylines a frame: every stroke rendered at the last
 * one's transform, colour and width, which on WebGPU alone put every shape at the last draw's
 * position and looked exactly like nothing had rendered rather than like a transform bug — see
 * `drawLines` in `webgpu/renderer.ts`.
 */

export const LINE_VERT_FIELDS: UniformFields = LINE_BINDINGS.LINE_VERT.fields;
export const LINE_VERT_SIZE = LINE_BINDINGS.LINE_VERT.uniformSize;
export const LINE_FRAG_FIELDS: UniformFields = LINE_BINDINGS.LINE_FRAG.fields;
export const LINE_FRAG_SIZE = LINE_BINDINGS.LINE_FRAG.uniformSize;

const VERT_BINDING = LINE_BINDINGS.LINE_VERT.uniforms;
const FRAG_BINDING = LINE_BINDINGS.LINE_FRAG.uniforms;

const VISIBILITY_VERTEX = 0x1;
const VISIBILITY_FRAGMENT = 0x2;
const USAGE_VERTEX = 0x0020 | 0x0008; // VERTEX | COPY_DST
const USAGE_INDEX = 0x0010 | 0x0008; // INDEX | COPY_DST

/** A polyline batch on the device, behind the surface's opaque handle. */
export interface GpuLines {
  readonly fromBuffer: GPUBuffer;
  readonly toBuffer: GPUBuffer;
  readonly corners: GPUBuffer;
  readonly indices: GPUBuffer;
  readonly capacity: number;
  /** Staging, expanded from the segment list's per-segment arrays to per-vertex ones. */
  readonly from: Float32Array;
  readonly to: Float32Array;
  dispose(): void;
}

export function createGpuLines(device: GPUDevice, capacity: number, label: string): GpuLines {
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
    indices,
    capacity,
    from: new Float32Array(verts * 3),
    to: new Float32Array(verts * 3),
    dispose(): void {
      fromBuffer.destroy();
      toBuffer.destroy();
      corners.destroy();
      indices.destroy();
    },
  };
}

/**
 * Expand this frame's segments to their four vertices each, into arrays the caller owns.
 *
 * Returns how many segments were written, which is the list's count clamped to the batch's
 * capacity — a caller that overruns loses its tail rather than its frame, the same rule
 * `expandBoltSegments` follows. Reads only `LineSegments.from`/`.to`, the same walk `lineBatch.ts`
 * writes inline in `upload()` on the WebGL2 side.
 */
export function expandLineSegments(
  data: LineSegments,
  capacity: number,
  from: Float32Array,
  to: Float32Array,
): number {
  const count = Math.min(data.count, capacity);
  for (let s = 0; s < count; s++) {
    const fx = data.from[s * 3] as number;
    const fy = data.from[s * 3 + 1] as number;
    const fz = data.from[s * 3 + 2] as number;
    const tx = data.to[s * 3] as number;
    const ty = data.to[s * 3 + 1] as number;
    const tz = data.to[s * 3 + 2] as number;
    for (let c = 0; c < 4; c++) {
      const v = s * 4 + c;
      from[v * 3] = fx;
      from[v * 3 + 1] = fy;
      from[v * 3 + 2] = fz;
      to[v * 3] = tx;
      to[v * 3 + 1] = ty;
      to[v * 3 + 2] = tz;
    }
  }
  return count;
}

/** `aFrom`, `aTo`, `aCorner` — one buffer each, at the locations `line.ts` declares. No fourth
 * dynamic attribute: unlike a bolt, a line carries no envelope. */
export function lineVertexLayouts(): GPUVertexBufferLayout[] {
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
  ];
}

/**
 * `hasDynamicOffset: true` on both bindings, which the ring needs for the reason this file's own
 * top comment gives.
 *
 * **This used to say "unlike `boltPass.ts`", and that stopped being true on 2026-09-02** when
 * bolts, caustics, the flock and the wind streaks all gained rings of their own. A comment naming
 * a neighbour's shortcoming is a comment that goes stale when the neighbour is fixed.
 */
export function createLineBindGroupLayout(device: GPUDevice): GPUBindGroupLayout {
  return device.createBindGroupLayout({
    label: 'line.layout',
    entries: [
      {
        binding: VERT_BINDING,
        visibility: VISIBILITY_VERTEX,
        buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: LINE_VERT_SIZE },
      },
      {
        binding: FRAG_BINDING,
        visibility: VISIBILITY_FRAGMENT,
        buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: LINE_FRAG_SIZE },
      },
    ],
  });
}

/** Bound once against the ring's two buffers; every draw supplies its own dynamic offset. */
export function createLineBindGroup(
  device: GPUDevice,
  layout: GPUBindGroupLayout,
  vertices: GPUBuffer,
  fragments: GPUBuffer,
): GPUBindGroup {
  return device.createBindGroup({
    label: 'line.bindGroup',
    layout,
    entries: [
      { binding: VERT_BINDING, resource: { buffer: vertices, size: LINE_VERT_SIZE } },
      { binding: FRAG_BINDING, resource: { buffer: fragments, size: LINE_FRAG_SIZE } },
    ],
  });
}

/**
 * The pipeline.
 *
 * **Alpha blended, depth tested, depth not written, nothing culled.** Alpha rather than
 * `boltPipeline`'s additive, matching `LineBatch.drawTo`'s WebGL2 state exactly: a line occludes
 * in colour but must not punch a hole in the depth buffer from its own soft antialiased edge,
 * the same discipline the SDF text pass follows. Nothing culled for the reason `lineBatch.ts`
 * gives: the quad billboards toward the view the same way a bolt's does, so its winding can flip
 * with the camera angle.
 */
export function linePipeline(
  cache: PipelineCache,
  device: GPUDevice,
  layout: GPUBindGroupLayout,
  /**
   * Whether this stroke is *light arriving* rather than a thing in the world.
   *
   * **A second pipeline rather than a second verb, and it does not make a line a bolt.** Blending
   * is pipeline state on this backend, so an additive stroke is a variant with its own cache key —
   * the same arrangement `depthWrite` already has for a translucent mesh. What it is not is a mode
   * flag turning `drawLines` into `drawBolts`: a bolt jitters along its own path because it is
   * lightning, which is a fact about geometry that nothing here touches.
   */
  additive = false,
): GPURenderPipeline {
  return cache.get(additive ? 'line:additive' : 'line', () => ({
    label: additive ? 'line.additive' : 'line',
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    vertex: {
      module: shaderModule(device, { label: 'line.vert', code: LINE_VERT_WGSL }),
      entryPoint: 'main',
      buffers: lineVertexLayouts(),
    },
    fragment: {
      module: shaderModule(device, { label: 'line.frag', code: LINE_FRAG_WGSL }),
      entryPoint: 'main',
      targets: [
        {
          format: cache.format,
          /* The additive arm is `boltPass`'s exactly, because it is the same statement about the
             same kind of thing: light adds to what is behind it and never covers it. */
          blend: additive
            ? {
                color: { srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add' },
                alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
              }
            : {
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
