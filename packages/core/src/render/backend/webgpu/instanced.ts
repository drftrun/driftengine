import { INSTANCE_FLOATS, INSTANCE_STRIDE, packInstances } from '../../instances.ts';
import type { MeshInstances } from '../../instances.ts';
import type { GpuMesh } from './buffers.ts';

/** VERTEX | COPY_DST, spelled the way every other pass here spells it. */
const USAGE_VERTEX = 0x0020 | 0x0008;

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

  constructor(device: GPUDevice, mesh: GpuMesh, capacity: number, label: string) {
    this.mesh = mesh;
    this.capacity = capacity;
    this.staging = new Float32Array(capacity * INSTANCE_FLOATS);
    this.buffer = device.createBuffer({
      /*
       * Labelled, and it is not decoration: a WebGPU validation failure arrives at `submit`
       * naming the resource it was about, and an unlabelled buffer names nothing.
       */
      label,
      size: capacity * INSTANCE_STRIDE,
      usage: USAGE_VERTEX,
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
  }

  dispose(): void {
    this.previousBuffer?.destroy();
    this.buffer.destroy();
  }
}
