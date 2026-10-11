/**
 * A point skin on WebGPU: its points, joints and normals in storage buffers made once, and a pose
 * recorded as one compute dispatch into the dynamic mesh's own position and normal buffers. What a
 * point skin is, and why it poses into a mesh rather than in a vertex stage, is `pointSkin.ts`.
 *
 * **Each skin owns its joints buffer**, so two skins posed in one frame read their own: a write to
 * one buffer between two dispatches would hand both the last, the per-draw rule `AGENTS.md` keeps
 * for every resource a later write in the frame overwrites. A skin posed twice in a frame draws its
 * last pose everywhere, as a mesh rewritten twice with `updateMesh` does.
 */
import { reachOf, type PointSkinData, type PointSkinReach } from '../../pointSkin.ts';
import type { GpuMesh } from './buffers.ts';
import { POINT_SKIN_WGSL, POINT_SKIN_WORKGROUP } from './shaders/pointSkin.wgsl.ts';

const STORAGE = 0x0080;
const UNIFORM = 0x0040;
const COPY_DST = 0x0008;

/** The pipeline every skin on a device poses with, made at the first skin. */
export function createPointSkinPipeline(device: GPUDevice): GPUComputePipeline {
  return device.createComputePipeline({
    label: 'pointSkin.pose',
    layout: 'auto',
    compute: {
      module: device.createShaderModule({ label: 'pointSkin.pose', code: POINT_SKIN_WGSL }),
      entryPoint: 'posePoints',
    },
  });
}

export class GpuPointSkin {
  readonly mesh: GpuMesh;
  readonly reach: PointSkinReach;
  private readonly count: number;
  private readonly pipeline: GPUComputePipeline;
  private readonly joints: GPUBuffer;
  private readonly buffers: readonly GPUBuffer[];
  private readonly group: GPUBindGroup;

  constructor(device: GPUDevice, pipeline: GPUComputePipeline, mesh: GpuMesh, data: PointSkinData) {
    this.mesh = mesh;
    this.pipeline = pipeline;
    this.reach = reachOf(data);
    const count = data.weights.length / 4;
    this.count = count;

    /* Each influence a vec4: its point, and its weight in w. */
    const points = new Float32Array(count * 16);
    for (let i = 0; i < count * 4; i++) {
      points.set(data.points.subarray(i * 3, i * 3 + 3), i * 4);
      points[i * 4 + 3] = data.weights[i] as number;
    }
    const named = Uint32Array.from(data.joints);
    const normals = new Float32Array(count * 4);
    for (let v = 0; v < count; v++) normals.set(data.normals.subarray(v * 3, v * 3 + 3), v * 4);
    const params = new Uint32Array([count, 0, 0, 0]);

    const made = (
      label: string,
      contents: Float32Array | Uint32Array,
      usage: number,
    ): GPUBuffer => {
      const buffer = device.createBuffer({
        label,
        size: Math.max(16, contents.byteLength),
        usage: usage | COPY_DST,
      });
      device.queue.writeBuffer(buffer, 0, contents);
      return buffer;
    };
    this.joints = device.createBuffer({
      label: 'pointSkin.joints',
      size: Math.max(1, this.reach.joints) * 64,
      usage: STORAGE | COPY_DST,
    });
    const buffers = [
      made('pointSkin.params', params, UNIFORM),
      made('pointSkin.points', points, STORAGE),
      made('pointSkin.named', named, STORAGE),
      made('pointSkin.normals', normals, STORAGE),
    ];
    this.buffers = buffers;
    const [positionsOut, normalsOut] = mesh.vertexBuffers as [GPUBuffer, GPUBuffer];
    this.group = device.createBindGroup({
      label: 'pointSkin.pose',
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: buffers[0] as GPUBuffer } },
        { binding: 1, resource: { buffer: this.joints } },
        { binding: 2, resource: { buffer: buffers[1] as GPUBuffer } },
        { binding: 3, resource: { buffer: buffers[2] as GPUBuffer } },
        { binding: 4, resource: { buffer: buffers[3] as GPUBuffer } },
        { binding: 5, resource: { buffer: positionsOut } },
        { binding: 6, resource: { buffer: normalsOut } },
      ],
    });
  }

  /** Write the pose's joints and record the dispatch that poses every vertex into `encoder`. */
  pose(device: GPUDevice, encoder: GPUCommandEncoder, matrices: Float32Array): void {
    if (this.reach.joints > 0) {
      device.queue.writeBuffer(this.joints, 0, matrices, 0, this.reach.joints * 16);
    }
    const pass = encoder.beginComputePass({ label: 'pointSkin.pose' });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.group);
    pass.dispatchWorkgroups(Math.ceil(this.count / POINT_SKIN_WORKGROUP));
    pass.end();
  }

  dispose(): void {
    this.joints.destroy();
    for (const buffer of this.buffers) buffer.destroy();
  }
}
