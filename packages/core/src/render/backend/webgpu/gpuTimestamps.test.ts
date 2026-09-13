import { describe, expect, it, vi } from 'vitest';

import { GpuTimestamps } from './gpuTimestamps.ts';

/**
 * A device with no GPU behind it, whose readback lands when a test says so.
 *
 * `settle` is the whole point: a timer that resolved its own readback synchronously would be
 * the stall this class exists to avoid, so the tests have to drive the mapping by hand.
 */
function stubDevice(options: { feature?: boolean } = {}) {
  const querySet = { destroy: vi.fn() };
  /* Two timestamps per pass, in nanoseconds, as the driver would write them. */
  let stamps = new BigUint64Array(64);
  let releaseMap: (() => void) | null = null;
  const buffers: GPUBufferDescriptor[] = [];

  const readBuffer = {
    mapAsync: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseMap = resolve;
        }),
    ),
    getMappedRange: vi.fn(() => stamps.buffer),
    unmap: vi.fn(),
    destroy: vi.fn(),
  };

  const device = {
    features: new Set<string>(options.feature === false ? [] : ['timestamp-query']),
    createQuerySet: vi.fn(() => querySet),
    createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
      buffers.push(descriptor);
      /* The read buffer is the second one, and the only one a test ever reaches into. */
      return buffers.length === 2 ? readBuffer : { destroy: vi.fn() };
    }),
  } as unknown as GPUDevice;

  const encoder = {
    resolveQuerySet: vi.fn(),
    copyBufferToBuffer: vi.fn(),
  } as unknown as GPUCommandEncoder;

  return {
    device,
    encoder,
    querySet,
    buffers,
    /** Write one pass's begin/end pair, in milliseconds. */
    writePass(index: number, startMs: number, endMs: number) {
      stamps[index * 2] = BigInt(Math.round(startMs * 1e6));
      stamps[index * 2 + 1] = BigInt(Math.round(endMs * 1e6));
    },
    reset() {
      stamps = new BigUint64Array(64);
    },
    /** Let the pending `mapAsync` land, and give the microtask queue a turn. */
    async settle() {
      releaseMap?.();
      releaseMap = null;
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

/** Drive one measured frame: `sampleEvery` of 1 so every frame counts. */
function timerOn(stub: ReturnType<typeof stubDevice>) {
  return new GpuTimestamps(stub.device, true, 1);
}

describe('GpuTimestamps', () => {
  it('measures nothing unless a consumer asked, whatever the adapter offers', () => {
    /*
     * The default, and the reason it is the default: enabling this attaches a `timestampWrites`
     * block to every render pass in the frame, so an implementation that disagrees about any
     * part of it invalidates the command buffer and the frame draws nothing at all. A profiler
     * must not be able to blank the screen of somebody who never asked to measure.
     */
    const stub = stubDevice();
    const timer = new GpuTimestamps(stub.device);
    expect(timer.available).toBe(false);
    expect(timer.beginFrame()).toBe(false);
    expect(timer.writesFor(), 'nothing may be attached to a pass').toBeUndefined();
    expect(stub.device.createQuerySet).not.toHaveBeenCalled();
  });

  it('reports unavailable, and measures nothing, on a device without the feature', () => {
    const stub = stubDevice({ feature: false });
    const timer = timerOn(stub);

    expect(timer.available).toBe(false);
    expect(timer.beginFrame()).toBe(false);
    expect(timer.sampling).toBe(false);
    expect(timer.writesFor()).toBeUndefined();
    expect(timer.lastFrameMs()).toBeNull();
    expect(timer.poll()).toBeNull();
    expect(stub.device.createQuerySet).not.toHaveBeenCalled();
  });

  it('hands every pass its own consecutive query pair', () => {
    const stub = stubDevice();
    const timer = timerOn(stub);
    timer.beginFrame();

    const first = timer.writesFor();
    const second = timer.writesFor();

    expect(first?.beginningOfPassWriteIndex).toBe(0);
    expect(first?.endOfPassWriteIndex).toBe(1);
    expect(second?.beginningOfPassWriteIndex).toBe(2);
    expect(second?.endOfPassWriteIndex).toBe(3);
    expect(first?.querySet).toBe(second?.querySet);
  });

  it('hands out nothing at all on an unmeasured frame, so a skipped frame is free', () => {
    const stub = stubDevice();
    /* Every other frame, so the second one is skipped. */
    const timer = new GpuTimestamps(stub.device, true, 2);

    expect(timer.beginFrame()).toBe(true);
    expect(timer.writesFor()).toBeDefined();
    timer.endFrame();

    expect(timer.beginFrame()).toBe(false);
    expect(timer.writesFor()).toBeUndefined();
  });

  it('sums each pass into the slot that was open when it was recorded', async () => {
    const stub = stubDevice();
    const timer = timerOn(stub);
    timer.beginFrame();

    /* Three shadow layers, one mirror, then the frame — the real shape of a frame. */
    timer.begin('shadows');
    timer.writesFor();
    timer.writesFor();
    timer.writesFor();
    timer.end();
    timer.begin('reflection');
    timer.writesFor();
    timer.end();
    /* No bracket open: the composite belongs to `rest`, like everything after the scene. */
    timer.writesFor();

    stub.writePass(0, 0, 1.0);
    stub.writePass(1, 1.0, 2.5);
    stub.writePass(2, 2.5, 3.0);
    stub.writePass(3, 3.0, 5.0);
    stub.writePass(4, 5.0, 9.0);

    timer.resolve(stub.encoder);
    timer.endFrame();
    await stub.settle();

    const sample = timer.poll();
    expect(sample).not.toBeNull();
    expect(sample?.shadows).toBeCloseTo(3.0, 5);
    expect(sample?.reflection).toBeCloseTo(2.0, 5);
    expect(sample?.rest).toBeCloseTo(4.0, 5);
    expect(timer.lastFrameMs()).toBeCloseTo(9.0, 5);
  });

  it('never copies into the read buffer while a readback is still in flight', () => {
    const stub = stubDevice();
    const timer = timerOn(stub);

    timer.beginFrame();
    timer.writesFor();
    timer.resolve(stub.encoder);
    timer.endFrame();
    const afterFirst = (stub.encoder.copyBufferToBuffer as ReturnType<typeof vi.fn>).mock.calls
      .length;

    /* The map has not landed, so the next frame must decline to measure rather than
       queue a copy into a buffer the driver still owns. */
    expect(timer.beginFrame()).toBe(false);
    timer.resolve(stub.encoder);
    expect((stub.encoder.copyBufferToBuffer as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      afterFirst,
    );
  });

  it('treats a pair the driver never wrote as no measurement rather than as zero', async () => {
    const stub = stubDevice();
    const timer = timerOn(stub);
    timer.beginFrame();
    timer.begin('shadows');
    timer.writesFor();
    timer.end();
    timer.writesFor();

    /* The first pass wrote; the second is still the zeros the buffer started with. */
    stub.writePass(0, 2.0, 6.0);

    timer.resolve(stub.encoder);
    timer.endFrame();
    await stub.settle();

    const sample = timer.poll();
    expect(sample?.shadows).toBeCloseTo(4.0, 5);
    expect(sample?.rest).toBe(0);
  });

  it('stops handing out pairs once the query set is full', () => {
    const stub = stubDevice();
    const timer = timerOn(stub);
    timer.beginFrame();

    let handed = 0;
    for (let i = 0; i < 200; i++) if (timer.writesFor() !== undefined) handed++;

    expect(handed).toBeGreaterThan(0);
    const count = (stub.device.createQuerySet as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
      ?.count;
    expect(handed * 2).toBe(count);
  });
});
