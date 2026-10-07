import { instancesBox } from '../../instanceCull.ts';
import { INSTANCE_FLOATS, INSTANCE_STRIDE, packInstances } from '../../instances.ts';
import { destroySlot } from './instanceCullPass.ts';
import type { CullSlot } from './instanceCullPass.ts';
import type { MeshInstances } from '../../instances.ts';
import type { GpuMesh } from './buffers.ts';
import { packInstanceClocks } from '../../boneAnimation.ts';
import { GpuInstanceClocks, type GpuBoneAnimation } from './boneAnimations.ts';

/** VERTEX | COPY_DST, spelled the way every other pass here spells it. */
const USAGE_VERTEX = 0x0020 | 0x0008;
/** A culling batch's source is read by the cull as storage too. */
const USAGE_STORAGE = 0x0080;

/**
 * One mesh's per-instance buffer on the device.
 *
 * **Attached to a mesh rather than owning one.** The geometry an instanced draw repeats is
 * usually the expensive kind — a loaded model rather than a blade of grass — so this holds a
 * reference to the mesh a consumer already uploaded and adds only the placement.
 *
 * The staging array is allocated here and rewritten in place, which is what keeps a frame that
 * re-uploads a moving batch allocation-free.
 */
export class GpuInstancedBatch {
  readonly buffer: GPUBuffer;
  readonly mesh: GpuMesh;
  readonly capacity: number;
  private readonly staging: Float32Array;

  /** Whether the camera draw culls this batch. See `InstancedOptions.cull`. */
  readonly cull: boolean;
  /** The world box around every live instance, fitted at upload. See `instancesBox`. */
  readonly box = new Float32Array([1, 1, 1, -1, -1, -1]);
  /** One set of survivors per view drawn this frame. See `InstanceCullPass`. */
  readonly slots: CullSlot[] = [];
  /** The frame the slots were last taken in, and how many were taken. */
  slotFrame = -1;
  slotsTaken = 0;

  /** The bone animation every instance plays, and its clocks; null for a batch that plays none. */
  readonly animation: GpuBoneAnimation | null;
  readonly clocks: GpuInstanceClocks | null;
  /**
   * An animated batch's own groups — its lit twins by the material group they were built beside, its
   * shadow groups by what they cut with — and the renderer's group epoch they were built in, after
   * which every one is dropped. See `WebGPURenderer.animatedGroup`.
   */
  readonly litGroups = new Map<GPUBindGroup, GPUBindGroup>();
  readonly depthGroups = new Map<unknown, GPUBindGroup>();
  readonly depthPeelGroups = new Map<unknown, GPUBindGroup>();
  groupEpoch = -1;

  constructor(
    device: GPUDevice,
    mesh: GpuMesh,
    capacity: number,
    label: string,
    cull = false,
    animation: GpuBoneAnimation | null = null,
  ) {
    this.mesh = mesh;
    this.capacity = capacity;
    /* An animated batch is culled whole and never by instance: see `submitInstanced`. */
    this.cull = cull;
    this.animation = animation;
    this.clocks =
      animation === null ? null : new GpuInstanceClocks(device, capacity, `${label}.clocks`);
    this.staging = new Float32Array(capacity * INSTANCE_FLOATS);
    this.buffer = device.createBuffer({
      /*
       * Labelled, and it is not decoration: a WebGPU validation failure arrives at `submit`
       * naming the resource it was about, and an unlabelled buffer names nothing.
       */
      label,
      size: Math.max(1, capacity) * INSTANCE_STRIDE,
      usage: USAGE_VERTEX | (cull ? USAGE_STORAGE : 0),
    });
  }

  /** Last frame's packed slots, for a reconstruction; made on first use by the renderer. */
  previousBuffer: GPUBuffer | null = null;
  /** How many slots the upload before the last one held, and how many the last one holds. */
  previousCount = 0;
  liveCount = 0;
  /** The frame of the last upload. See `changeFrames.ts`. */
  changed = -1;

  /**
   * Pack and push `data.count` instances, in one write.
   *
   * Only the live prefix, for the reason `uploadScatter` gives: the rest is not drawn and
   * uploading it would be per-frame waste with nothing reading it.
   *
   * **Given `previous`, the placement still in the staging array — the last upload, which is last
   * frame's — is written there first**, so a reconstruction can pair each slot with where it was.
   * `writeBuffer` copies at the call, so packing afterwards cannot reach that copy.
   */
  upload(queue: GPUQueue, data: MeshInstances, previous: GPUBuffer | null = null): void {
    if (this.cull) instancesBox(data, this.mesh.bounds, this.box);
    const count = Math.min(data.count, this.capacity);
    if (previous !== null) {
      if (this.liveCount > 0) {
        queue.writeBuffer(previous, 0, this.staging, 0, this.liveCount * INSTANCE_FLOATS);
      }
      this.previousCount = this.liveCount;
    }
    this.liveCount = count;
    if (count === 0) return;
    packInstances(data, this.staging);
    queue.writeBuffer(this.buffer, 0, this.staging, 0, count * INSTANCE_FLOATS);
    if (this.clocks !== null) {
      packInstanceClocks(data, this.clocks.staging);
      this.clocks.upload(queue, count);
    }
  }

  dispose(): void {
    this.previousBuffer?.destroy();
    this.buffer.destroy();
    this.clocks?.dispose();
    for (const slot of this.slots) destroySlot(slot);
  }
}
