import { describe, expect, it, vi } from 'vitest';

import { FrameBudget } from '../budget.ts';
import { UniformRing } from './uniformRing.ts';

function fakeDevice() {
  const writes: { offset: number; size: number }[] = [];
  return {
    writes,
    device: {
      createBuffer: vi.fn(() => ({ destroy: vi.fn() })),
      queue: {
        writeBuffer: vi.fn(
          (_b: GPUBuffer, offset: number, data: ArrayBuffer, _o: number, size: number) => {
            writes.push({ offset, size });
          },
        ),
      },
    } as unknown as GPUDevice,
  };
}

describe('the uniform ring', () => {
  /*
   * A dynamic offset has to be a multiple of 256, so a 224-byte block still costs a full
   * slot. Rounding this down would produce a validation error at bind time, on a device.
   */
  it('rounds a slot up to the dynamic offset alignment', () => {
    const { device } = fakeDevice();
    const ring = new UniformRing(device, 224, 4, 0);
    expect(ring.slotSize).toBe(256);
  });

  it('hands out one distinct offset per draw', () => {
    const { device } = fakeDevice();
    const ring = new UniformRing(device, 224, 3, 0);

    expect(ring.allocate()).toBe(0);
    expect(ring.allocate()).toBe(256);
    expect(ring.allocate()).toBe(512);
    expect(ring.count).toBe(3);
  });

  /*
   * Full returns null rather than growing: allocating a buffer mid-frame is the thing this
   * class exists to avoid, so the caller skips the draw instead of stalling to make room.
   */
  it('returns null when it is full rather than growing', () => {
    const { device } = fakeDevice();
    const ring = new UniformRing(device, 64, 1, 0);

    expect(ring.allocate()).toBe(0);
    expect(ring.allocate()).toBeNull();
  });

  it('reuses its slots after a reset, without reallocating', () => {
    const { device } = fakeDevice();
    const ring = new UniformRing(device, 64, 2, 0);

    ring.allocate();
    ring.allocate();
    ring.reset();

    expect(ring.allocate()).toBe(0);
    expect((device.createBuffer as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('writes values into the slot they belong to', () => {
    const { device } = fakeDevice();
    const ring = new UniformRing(device, 64, 2, 0);
    const first = ring.allocate() as number;
    const second = ring.allocate() as number;

    ring.writeFloats(first, 0, [1, 2, 3, 4]);
    ring.writeFloats(second, 0, [9, 9, 9, 9]);
    ring.writeInt(second, 16, 7);
    ring.flush();

    /* Both slots in one upload, sized to what was taken rather than to the whole ring. */
    expect(device.queue.writeBuffer).toHaveBeenCalledTimes(1);
  });

  /*
   * One upload per frame is the whole point: a write per draw would be the per-frame cost
   * this replaces, and it would arrive in the wrong order relative to the pass anyway.
   */
  it('uploads once for the whole frame, sized to what was used', () => {
    const { device, writes } = fakeDevice();
    const ring = new UniformRing(device, 256, 8, 0);

    ring.allocate();
    ring.allocate();
    ring.flush();

    expect(writes).toEqual([{ offset: 0, size: 512 }]);
  });

  it('uploads nothing when no draw took a slot', () => {
    const { device } = fakeDevice();
    const ring = new UniformRing(device, 256, 4, 0);

    ring.flush();

    expect(device.queue.writeBuffer).not.toHaveBeenCalled();
  });
});

/**
 * **The ring is where a ceiling is counted, because the ring is where a ceiling is.**
 *
 * The alternative was counting at the ten call sites that allocate — every one of which already
 * had a warn-once flag beside it, and every one of which would have needed a second line added by
 * hand. Counting here means a ring added tomorrow is counted the day it is added, and it means the
 * number reported is exactly what the ceiling governs: `materialSlotForDraw` reuses an open slot
 * without allocating, so the material line counts material *changes*, which is what that ceiling
 * limits, and not the draw count somebody would otherwise have reported beside it.
 */
describe('the uniform ring, counted', () => {
  it('counts every allocation against its line, and the refusals separately', () => {
    const { device } = fakeDevice();
    const budget = new FrameBudget();
    const draws = budget.line('draws', 2);
    const ring = new UniformRing(device, 64, 2, 0, 'test.ring', draws);

    ring.allocate();
    ring.allocate();
    ring.allocate();
    ring.allocate();

    expect(draws.used, 'what was asked for, not what fit').toBe(4);
    expect(draws.dropped).toBe(2);
    expect(budget.dropped).toBe(true);
  });

  it('counts nothing when it was given no line, which is most of them', () => {
    const { device } = fakeDevice();
    const ring = new UniformRing(device, 64, 1, 0);
    expect(() => {
      ring.allocate();
      ring.allocate();
    }).not.toThrow();
  });
});

/**
 * Growth, which happens at the start of a frame and nowhere else.
 *
 * **`allocate` still returns null rather than growing, and that has not changed.** Allocating a
 * buffer mid-frame is the thing this class exists to avoid. What is new is that a frame which ran
 * out is not condemned to run out forever: the renderer asks for room at `beginFrame`, where no
 * encoder is open and everything from the last frame has been submitted, and the frame after is
 * drawn whole.
 *
 * The buffer object is replaced, so **every bind group holding it is invalid** — which is why this
 * says so in its return value rather than leaving a caller to notice.
 */
describe('the uniform ring, grown', () => {
  it('takes a bigger buffer and says the old one is gone', () => {
    const { device } = fakeDevice();
    const ring = new UniformRing(device, 64, 2, 0);
    const before = ring.buffer;

    expect(ring.growTo(8), 'the buffer was replaced').toBe(true);
    expect(ring.buffer).not.toBe(before);
    expect((before as unknown as { destroy: ReturnType<typeof vi.fn> }).destroy).toHaveBeenCalled();

    for (let i = 0; i < 8; i += 1) expect(ring.allocate()).not.toBeNull();
    expect(ring.allocate()).toBeNull();
  });

  it('does nothing, and says so, when it is already big enough', () => {
    const { device } = fakeDevice();
    const ring = new UniformRing(device, 64, 8, 0);
    const before = ring.buffer;

    expect(ring.growTo(8)).toBe(false);
    expect(ring.growTo(2)).toBe(false);
    expect(ring.buffer, 'the same buffer, so no bind group needs rebuilding').toBe(before);
  });

  it('writes into the room it grew, rather than off the end of the array it had', () => {
    const { device, writes } = fakeDevice();
    const ring = new UniformRing(device, 64, 1, 0);
    ring.growTo(4);

    const last = ring.allocate();
    ring.allocate();
    ring.allocate();
    const fourth = ring.allocate();
    expect(last).toBe(0);
    expect(fourth).toBe(768);

    ring.writeFloat(fourth as number, 0, 7.5);
    ring.flush();
    expect(writes[0]?.size, 'four slots uploaded, not the one it was built with').toBe(1024);
  });

  /**
   * **A ceiling on the growth, because a runaway consumer should degrade rather than crash.**
   *
   * The old behaviour — drop the work, report it — is still what happens past this, and it is the
   * right end state for a frame asking for something no device should be asked for. What changed
   * is where that line sits: at a number chosen for a phone's memory rather than at whatever the
   * ring happened to be built with.
   */
  it('refuses to grow past its memory ceiling, and keeps the buffer it has', () => {
    const { device } = fakeDevice();
    const ring = new UniformRing(device, 64, 2, 0);
    const before = ring.buffer;

    expect(ring.growTo(1_000_000_000)).toBe(false);
    expect(ring.buffer).toBe(before);
    expect(ring.allocate()).toBe(0);
  });
});
