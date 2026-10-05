import { describe, expect, it, vi } from 'vitest';

import { SkinPaletteRing } from './skinPaletteRing.ts';

function fakeDevice() {
  const writes: number[] = [];
  return {
    writes,
    device: {
      createTexture: vi.fn(() => ({ destroy: vi.fn(), createView: vi.fn(() => ({})) })),
      queue: {
        writeTexture: vi.fn((_t: unknown, data: Float32Array) => {
          writes.push(data[0] as number);
        }),
      },
    } as unknown as GPUDevice,
  };
}

/** One joint's palette, its first float naming it. */
function palette(name: number): Float32Array {
  const p = new Float32Array(16);
  p[0] = name;
  p[5] = 1;
  p[10] = 1;
  p[15] = 1;
  return p;
}

describe('SkinPaletteRing', () => {
  /*
   * A rig is drawn in the main pass, a reflection and three shadow layers, and each pass sets its
   * palette again. Each used to take a slot of its own, so a crowd filled the ring at a fifth of
   * the characters it could hold.
   */
  it('A PALETTE SET AGAIN IN ONE FRAME KEEPS ITS SLOT AND IS UPLOADED ONCE', () => {
    const { device, writes } = fakeDevice();
    const ring = new SkinPaletteRing(8);
    const rig = palette(3);
    const first = ring.take(device, rig);
    expect(ring.take(device, rig)).toBe(first);
    expect(ring.take(device, rig)).toBe(first);
    expect(ring.count).toBe(1);
    expect(writes).toEqual([3]);
  });

  /*
   * One scratch array posed with every rig in turn is the case identity alone gets wrong: the
   * second rig would take the first one's slot, and stand in its pose.
   */
  it('one array holding different rigs in turn takes a slot per rig', () => {
    const { device, writes } = fakeDevice();
    const ring = new SkinPaletteRing(8);
    const scratch = palette(1);
    const a = ring.take(device, scratch);
    scratch[0] = 2;
    const b = ring.take(device, scratch);
    expect(b).not.toBe(a);
    expect(writes).toEqual([1, 2]);
  });

  it('a slot given back by a rewind is not handed out for what it held', () => {
    const { device, writes } = fakeDevice();
    const ring = new SkinPaletteRing(8);
    const kept = palette(1);
    ring.take(device, kept);
    const mark = ring.mark();
    const baked = palette(2);
    expect(ring.take(device, baked)).toBe(1);
    ring.rewind(mark);
    const other = palette(3);
    expect(ring.take(device, other)).toBe(1);
    /* The baked palette's old slot now holds another rig, so it is written again. */
    expect(ring.take(device, baked)).toBe(2);
    expect(writes).toEqual([1, 2, 3, 2]);
  });

  it('a new frame uploads again', () => {
    const { device, writes } = fakeDevice();
    const ring = new SkinPaletteRing(8);
    const rig = palette(4);
    ring.take(device, rig);
    ring.reset();
    expect(ring.take(device, rig)).toBe(0);
    expect(writes).toEqual([4, 4]);
  });

  /* The cap was 128 and refused a crowd; it is the frame's draw budget now. */
  it('holds as many distinct palettes as its capacity, then declines and says so once', () => {
    const { device } = fakeDevice();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ring = new SkinPaletteRing(200);
    for (let i = 0; i < 200; i++) expect(ring.take(device, palette(i))).toBe(i);
    expect(ring.take(device, palette(999))).toBeNull();
    expect(ring.take(device, palette(998))).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
