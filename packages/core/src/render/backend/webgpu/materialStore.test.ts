import { describe, expect, it, vi } from 'vitest';

import { FrameBudget } from '../budget.ts';
import { MaterialStore } from './materialStore.ts';

function fakeDevice() {
  const writes: { offset: number; size: number; words: number[] }[] = [];
  return {
    writes,
    device: {
      createBuffer: vi.fn(() => ({ destroy: vi.fn() })),
      queue: {
        writeBuffer: vi.fn(
          (_b: GPUBuffer, offset: number, data: ArrayBuffer, from: number, size: number) => {
            writes.push({ offset, size, words: [...new Int32Array(data, from, size / 4)] });
          },
        ),
      },
    } as unknown as GPUDevice,
  };
}

/** A block of four words, all `value` but the last, which says which block it is. */
function block(value: number, tag = 0): Int32Array {
  return new Int32Array([value, value, value, tag]);
}

describe('the material store', () => {
  it('rounds a slot up to the dynamic offset alignment', () => {
    const { device } = fakeDevice();
    expect(new MaterialStore(device, 592, 4, 0).slotSize).toBe(768);
  });

  /*
   * The whole point: a material whose numbers did not change since the last frame is bound where
   * it already is, and nothing crosses to the device for it.
   */
  it('KEEPS A MATERIAL ACROSS FRAMES: THE SAME NUMBERS NEXT FRAME UPLOAD NOTHING', () => {
    const { device, writes } = fakeDevice();
    const store = new MaterialStore(device, 16, 4, 0);

    store.beginFrame();
    const first = store.place(block(7));
    store.flush();
    expect(writes).toHaveLength(1);

    store.beginFrame();
    expect(store.place(block(7))).toBe(first);
    store.flush();
    expect(writes, 'nothing uploaded for a material already held').toHaveLength(1);
  });

  it('gives the same numbers one slot and different numbers another, within a frame', () => {
    const { device } = fakeDevice();
    const store = new MaterialStore(device, 16, 4, 0);
    store.beginFrame();
    const a = store.place(block(1));
    const b = store.place(block(1, 1));
    expect(b).not.toBe(a);
    expect(store.place(block(1))).toBe(a);
    expect(store.place(block(1, 1))).toBe(b);
  });

  /* A slot a recorded draw reads cannot be rewritten before that draw is submitted. */
  it('never gives away a slot the frame has asked for, and refuses instead', () => {
    const { device } = fakeDevice();
    const budget = new FrameBudget();
    const line = budget.line('materials', 2);
    const store = new MaterialStore(device, 16, 2, 0, 'materials', line);
    store.beginFrame();
    expect(store.place(block(1))).not.toBeNull();
    expect(store.place(block(2))).not.toBeNull();
    expect(store.place(block(3))).toBeNull();
    expect(line.used).toBe(3);
    expect(line.dropped).toBe(1);
    /* And what it holds is still there for the frame's draws to share. */
    expect(store.place(block(1))).not.toBeNull();
  });

  /*
   * A material drawn every frame but late in this one must not be the one a new block displaces,
   * or a scene with a few changing materials rewrites its steady ones every frame as well.
   */
  it('DISPLACES A BLOCK NOBODY ASKED FOR LAST FRAME BEFORE ONE THAT WAS', () => {
    const { device, writes } = fakeDevice();
    const store = new MaterialStore(device, 16, 3, 0);
    store.beginFrame();
    const a = store.place(block(1));
    const b = store.place(block(2));
    store.place(block(3));
    store.flush();

    store.beginFrame();
    store.place(block(1));
    store.place(block(2));
    store.flush();

    store.beginFrame();
    store.place(block(4));
    /* The two drawn last frame are still where they were, so drawing them costs nothing. */
    expect(store.place(block(1))).toBe(a);
    expect(store.place(block(2))).toBe(b);
    writes.length = 0;
    store.flush();
    expect(writes.map((w) => w.words[0])).toEqual([4]);
  });

  it('uploads what was written in one write per run of neighbouring slots', () => {
    const { device, writes } = fakeDevice();
    const store = new MaterialStore(device, 16, 4, 0);
    store.beginFrame();
    store.place(block(1));
    store.place(block(2));
    store.place(block(3));
    store.flush();
    expect(writes).toHaveLength(1);
    expect(writes[0]?.offset).toBe(0);
    expect(writes[0]?.size).toBe(3 * store.slotSize);
  });

  /* A flush mid-frame, before a submit, sends what is new since the last one and nothing again. */
  it('sends nothing twice when a frame flushes more than once', () => {
    const { device, writes } = fakeDevice();
    const store = new MaterialStore(device, 16, 4, 0);
    store.beginFrame();
    store.place(block(1));
    store.flush();
    store.place(block(2));
    store.flush();
    store.flush();
    expect(writes.map((w) => w.words[0])).toEqual([1, 2]);
  });

  /*
   * A material's words are mostly floats, and the values a person types — 0.5, 1, 2 — have no low
   * mantissa bits, so blocks differing only in one must still spread over the buckets and still be
   * told apart within one: sixty-four of them in a store of sixty-four share buckets by chance.
   */
  it('TELLS BLOCKS SHARING A BUCKET APART', () => {
    const { device } = fakeDevice();
    const store = new MaterialStore(device, 16, 64, 0);
    store.beginFrame();
    const seen = new Set<number | null>();
    for (let tag = 0; tag < 64; tag++) {
      seen.add(store.place(new Int32Array(new Float32Array([1, 0.5, 1, 2 ** (tag - 32)]).buffer)));
    }
    expect(seen.size).toBe(64);
    expect(seen.has(null)).toBe(false);
  });

  /*
   * Two blocks with one hash, found by search: a hash narrows the candidates and only the words
   * decide, or two materials that collide would draw as whichever was placed first.
   */
  it('TELLS TWO BLOCKS WITH THE SAME HASH APART BY THEIR WORDS', () => {
    const { device } = fakeDevice();
    const store = new MaterialStore(device, 16, 4, 0);
    store.beginFrame();
    const a = store.place(new Int32Array([1, 1, 3753, 2]));
    const b = store.place(new Int32Array([1, 1, 1826, 37]));
    expect(b).not.toBe(a);
  });

  /* A grown buffer holds nothing, so every block is written to it again. */
  it('forgets what it held when it grows', () => {
    const { device, writes } = fakeDevice();
    const store = new MaterialStore(device, 16, 2, 0);
    store.beginFrame();
    store.place(block(1));
    store.flush();
    expect(store.growTo(8)).toBe(true);
    expect(store.slots).toBe(8);
    store.beginFrame();
    store.place(block(1));
    store.flush();
    expect(writes).toHaveLength(2);
  });

  it('stops growing at the ring ceiling, rather than allocating whatever it is asked for', () => {
    const { device } = fakeDevice();
    const store = new MaterialStore(device, 592, 4, 0);
    expect(store.growTo(1_000_000_000)).toBe(false);
    expect(store.slots).toBe(4);
  });

  /*
   * A list recorded once binds its materials by offset in a bundle, frame after frame, whether or
   * not anything else asks for them; a pinned slot is never what a new block displaces.
   */
  it('NEVER DISPLACES A PINNED BLOCK, HOWEVER LONG SINCE IT WAS ASKED FOR', () => {
    const { device } = fakeDevice();
    const store = new MaterialStore(device, 16, 2, 0);
    store.beginFrame();
    const kept = store.place(block(1)) as number;
    store.pin(kept);
    for (let frame = 0; frame < 4; frame++) {
      store.beginFrame();
      store.place(block(10 + frame));
    }
    store.beginFrame();
    expect(store.place(block(1)), 'still where it was pinned').toBe(kept);
    store.unpin(kept);
    store.beginFrame();
    store.beginFrame();
    store.place(block(20));
    store.place(block(21));
    expect(store.place(block(1)), 'and displaced once let go').not.toBe(kept);
  });

  /* Growth forgets every block, pinned ones too, and says so by a number a holder compares. */
  it('COUNTS EACH TIME IT FORGETS', () => {
    const { device } = fakeDevice();
    const store = new MaterialStore(device, 16, 2, 0);
    const before = store.epoch;
    store.growTo(4);
    expect(store.epoch).toBe(before + 1);
  });
});
