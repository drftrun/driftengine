/**
 * Instance culls on the device: a batch's instances tested against a view and compacted into an
 * indirect draw, many batches in one compute submit.
 *
 * **Queued during the frame, dispatched in one submit from `flushRings`.** Every submit that can carry
 * a culled draw — the frame, a mirror, a probe face — calls `flushRings` first, so the dispatch that
 * fills a slot is always on the queue ahead of the pass that draws from it. The parameters and the
 * zeroed instance count are written with `queue.writeBuffer` when the job is queued, which the queue
 * orders ahead of both submits.
 *
 * **A slot is one (batch, view) pair in one frame.** A batch drawn from the camera, a mirror and a
 * probe face needs three sets of survivors, so a batch holds up to `MAX_CULL_SLOTS`, taken in order
 * each frame; past that the renderer draws every instance, which is right and merely slower. Each
 * slot owns its buffers and a bind group built once, so queueing allocates nothing.
 */
import { INSTANCE_STRIDE } from '../../instances.ts';
import { INSTANCE_CULL_WGSL, INSTANCE_CULL_WORKGROUP } from './shaders/instanceCull.wgsl.ts';
import { shaderModule } from './shaderModules.ts';

/** Views a batch can be culled for in one frame. See the header. */
export const MAX_CULL_SLOTS = 4;

/** Jobs one frame may queue before the rest draw uncut. A ring size, not an opinion. */
const MAX_JOBS = 4096;

/** Bytes of `Params`: six planes, the mesh's sphere, and the instance count padded to 16. */
const PARAMS_BYTES = 6 * 16 + 16 + 16;

const USAGE = {
  VERTEX: 0x0020,
  UNIFORM: 0x0040,
  STORAGE: 0x0080,
  INDIRECT: 0x0100,
  COPY_DST: 0x0008,
} as const;

/** One set of survivors: the compacted instances, the indirect record, and what the cull reads. */
export interface CullSlot {
  readonly instances: GPUBuffer;
  readonly args: GPUBuffer;
  readonly params: GPUBuffer;
  readonly group: GPUBindGroup;
  /** How many instances the last queued job tested, which sizes its dispatch. */
  count: number;
}

export class InstanceCullPass {
  private readonly pipeline: GPUComputePipeline;
  private readonly layout: GPUBindGroupLayout;
  private readonly jobs: (CullSlot | null)[] = new Array<CullSlot | null>(MAX_JOBS).fill(null);
  private queued = 0;
  private readonly paramsStaging = new ArrayBuffer(PARAMS_BYTES);
  private readonly paramFloats = new Float32Array(this.paramsStaging);
  private readonly paramWords = new Uint32Array(this.paramsStaging);
  private readonly argsStaging = new Uint32Array(5);

  constructor(private readonly device: GPUDevice) {
    this.layout = device.createBindGroupLayout({
      label: 'instances.cull',
      entries: [
        { binding: 0, visibility: 0x4, buffer: { type: 'uniform' } },
        { binding: 1, visibility: 0x4, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: 0x4, buffer: { type: 'storage' } },
        { binding: 3, visibility: 0x4, buffer: { type: 'storage' } },
      ],
    });
    this.pipeline = device.createComputePipeline({
      label: 'instances.cull',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      compute: {
        module: shaderModule(device, { label: 'instances.cull', code: INSTANCE_CULL_WGSL }),
        entryPoint: 'main',
      },
    });
  }

  /** A slot reading `source`, a batch's full instance buffer of `capacity` instances. */
  createSlot(source: GPUBuffer, capacity: number, label: string): CullSlot {
    const size = Math.max(1, capacity) * INSTANCE_STRIDE;
    const instances = this.device.createBuffer({
      label: `${label}.kept`,
      size,
      usage: USAGE.VERTEX | USAGE.STORAGE,
    });
    const args = this.device.createBuffer({
      label: `${label}.args`,
      size: 20,
      usage: USAGE.INDIRECT | USAGE.STORAGE | USAGE.COPY_DST,
    });
    const params = this.device.createBuffer({
      label: `${label}.params`,
      size: PARAMS_BYTES,
      usage: USAGE.UNIFORM | USAGE.COPY_DST,
    });
    const group = this.device.createBindGroup({
      label: `${label}.cull`,
      layout: this.layout,
      entries: [
        { binding: 0, resource: { buffer: params } },
        { binding: 1, resource: { buffer: source, size } },
        { binding: 2, resource: { buffer: instances } },
        { binding: 3, resource: { buffer: args } },
      ],
    });
    return { instances, args, params, group, count: 0 };
  }

  /**
   * Queue a cull of `count` instances against six `planes`, the mesh's local sphere being
   * (centre, radius). Returns false when the frame's job ring is full, and the caller draws uncut.
   */
  queue(
    slot: CullSlot,
    planes: Float32Array,
    centre: ArrayLike<number>,
    radius: number,
    count: number,
    indexCount: number,
  ): boolean {
    if (this.queued >= MAX_JOBS) return false;
    const floats = this.paramFloats;
    for (let i = 0; i < 24; i++) floats[i] = planes[i] as number;
    floats[24] = centre[0] ?? 0;
    floats[25] = centre[1] ?? 0;
    floats[26] = centre[2] ?? 0;
    floats[27] = radius;
    this.paramWords[28] = count;
    this.device.queue.writeBuffer(slot.params, 0, this.paramsStaging);
    const args = this.argsStaging;
    args[0] = indexCount;
    args[1] = 0;
    args[2] = 0;
    args[3] = 0;
    args[4] = 0;
    this.device.queue.writeBuffer(slot.args, 0, args);
    slot.count = count;
    this.jobs[this.queued++] = slot;
    return true;
  }

  /** Dispatch everything queued, in one compute pass and one submit. Nothing queued is nothing done. */
  flush(): void {
    if (this.queued === 0) return;
    const encoder = this.device.createCommandEncoder({ label: 'instances.cull' });
    const pass = encoder.beginComputePass({ label: 'instances.cull' });
    pass.setPipeline(this.pipeline);
    for (let i = 0; i < this.queued; i++) {
      const slot = this.jobs[i];
      if (slot === null || slot === undefined) continue;
      pass.setBindGroup(0, slot.group);
      pass.dispatchWorkgroups(Math.ceil(slot.count / INSTANCE_CULL_WORKGROUP));
      this.jobs[i] = null;
    }
    pass.end();
    this.device.queue.submit([encoder.finish()]);
    this.queued = 0;
  }
}

/** Every buffer a slot owns, destroyed with its batch. */
export function destroySlot(slot: CullSlot): void {
  slot.instances.destroy();
  slot.args.destroy();
  slot.params.destroy();
}
