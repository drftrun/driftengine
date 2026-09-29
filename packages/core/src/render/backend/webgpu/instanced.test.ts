import { describe, expect, it } from 'vitest';
import { createMeshInstances } from '../../instances.ts';
import type { GpuMesh } from './buffers.ts';
import { GpuInstancedBatch } from './instanced.ts';

/** A device whose buffers are byte arrays and whose queue copies at the call, as a real one does. */
function fakeDevice(): { device: GPUDevice; memory: Map<object, Uint8Array> } {
  const memory = new Map<object, Uint8Array>();
  const device = {
    createBuffer(descriptor: GPUBufferDescriptor): GPUBuffer {
      const buffer = { destroy(): void {}, size: descriptor.size };
      memory.set(buffer, new Uint8Array(descriptor.size));
      return buffer as unknown as GPUBuffer;
    },
    queue: {
      writeBuffer(buffer: object, offset: number, data: Float32Array, from = 0, count?: number) {
        const bytes = memory.get(buffer) as Uint8Array;
        const floats = count ?? data.length - from;
        bytes.set(new Uint8Array(data.buffer, data.byteOffset + from * 4, floats * 4), offset);
      },
    },
  };
  return { device: device as unknown as GPUDevice, memory };
}

function placedAt(xs: readonly number[]) {
  const data = createMeshInstances(2);
  data.count = xs.length;
  xs.forEach((x, i) => {
    data.models.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1], i * 16);
  });
  return data;
}

describe('an instanced batch', () => {
  /*
   * A reconstruction needs where each slot was last frame. Before packing the new placement the
   * batch writes the one still in its staging array — the last upload — into the buffer it is
   * handed, and says how many slots that held. Twenty floats a slot; the x of a slot's matrix is
   * its thirteenth.
   */
  it('HANDS OVER LAST FRAME’S SLOTS BEFORE IT PACKS THIS FRAME’S', () => {
    const { device, memory } = fakeDevice();
    const batch = new GpuInstancedBatch(device, {} as GpuMesh, 2, 'test');
    const previous = device.createBuffer({ size: 160, usage: 0 });

    batch.upload(device.queue, placedAt([1, 2]), null);
    batch.upload(device.queue, placedAt([5]), previous);

    const was = new Float32Array((memory.get(previous) as Uint8Array).buffer);
    const now = new Float32Array((memory.get(batch.buffer) as Uint8Array).buffer);
    expect([was[12], was[32]]).toEqual([1, 2]);
    expect(now[12]).toBe(5);
    expect(batch.previousCount).toBe(2);
    expect(batch.liveCount).toBe(1);
  });
});
