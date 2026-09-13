import { describe, expect, it } from 'vitest';

import { TranslucentQueue } from './translucentQueue.ts';

/** A stand-in for a mesh handle: the queue only ever holds and hands back the reference. */
const MESH_A = { name: 'a' } as unknown as never;
const MESH_B = { name: 'b' } as unknown as never;

function identity(): Float32Array {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

describe('recording a translucent draw', () => {
  /*
   * **The matrix has to be copied, and this is the test that says so.**
   *
   * Every caller in this repository builds its model matrix into a scratch it reuses — `rings.ts`
   * writes `model(scratch, x, y)` in a loop and submits the same `Float32Array` a thousand times.
   * A queue that kept the reference would replay a thousand draws all wearing the *last*
   * transform, which on screen is every pane stacked in one place: a plausible picture, and
   * exactly the kind that gets blamed on the blending rather than on the queue.
   */
  it('survives the caller reusing the matrix it was handed', () => {
    const queue = new TranslucentQueue();
    const scratch = identity();

    scratch[12] = 1;
    queue.record(MESH_A, scratch, 0.5, {});
    scratch[12] = 2;
    queue.record(MESH_A, scratch, 0.5, {});
    scratch[12] = 999;

    const seen: number[] = [];
    queue.replay((draw) => seen.push(draw.model[12] ?? 0));
    expect(seen).toEqual([1, 2]);
  });

  /*
   * **And the tint, for the same reason.** `TranslucentMeshOptions` is an object literal at most
   * call sites, but a caller drawing many panes will hoist it and mutate the tint per draw.
   */
  it('survives the caller reusing the options object', () => {
    const queue = new TranslucentQueue();
    const options: { tint?: [number, number, number]; lit?: boolean } = {
      tint: [1, 0, 0],
      lit: false,
    };
    queue.record(MESH_A, identity(), 1, options);
    options.tint = [0, 1, 0];
    options.lit = true;
    queue.record(MESH_A, identity(), 1, options);

    const tints: (readonly number[] | null)[] = [];
    const lit: boolean[] = [];
    queue.replay((draw) => {
      tints.push(draw.tint === null ? null : [...draw.tint]);
      lit.push(draw.lit);
    });
    expect(tints).toEqual([
      [1, 0, 0],
      [0, 1, 0],
    ]);
    expect(lit).toEqual([false, true]);
  });

  it('carries the options a draw did not set as their defaults', () => {
    const queue = new TranslucentQueue();
    queue.record(MESH_A, identity(), 0.25, {});
    queue.replay((draw) => {
      expect(draw.lit).toBe(true);
      expect(draw.fog).toBe(true);
      expect(draw.toneMapped).toBe(true);
      expect(draw.depthWrite).toBe(true);
      expect(draw.depthLayer).toBe(0);
      expect(draw.tint).toBe(null);
      expect(draw.opacity).toBeCloseTo(0.25, 12);
    });
  });

  it('hands the meshes back in the order they were recorded', () => {
    const queue = new TranslucentQueue();
    queue.record(MESH_A, identity(), 1, {});
    queue.record(MESH_B, identity(), 1, {});
    const order: unknown[] = [];
    queue.replay((draw) => order.push(draw.mesh));
    expect(order).toEqual([MESH_A, MESH_B]);
  });

  /*
   * **Replayed twice, identically**, which is the whole reason this exists: the accumulation and
   * the revealage are two passes over the same geometry, and a queue that could only be walked
   * once would give the second pass a different set from the first.
   */
  it('replays the same draws every time it is walked', () => {
    const queue = new TranslucentQueue();
    queue.record(MESH_A, identity(), 0.5, {});
    queue.record(MESH_B, identity(), 0.75, {});
    const first: number[] = [];
    const second: number[] = [];
    queue.replay((d) => first.push(d.opacity));
    queue.replay((d) => second.push(d.opacity));
    expect(first).toEqual([0.5, 0.75]);
    expect(second).toEqual(first);
  });
});

describe('reusing the queue between frames', () => {
  it('is empty after a reset', () => {
    const queue = new TranslucentQueue();
    queue.record(MESH_A, identity(), 1, {});
    queue.reset();
    let walked = 0;
    queue.replay(() => walked++);
    expect(walked).toBe(0);
    expect(queue.length).toBe(0);
  });

  /*
   * **Records are pooled and never released**, because `AGENTS.md` forbids allocating in the frame
   * loop and a translucent set is submitted every frame. A reset returns the count to zero and
   * keeps the storage, so a steady scene allocates on its first frame and never again.
   */
  it('keeps its storage across a reset, so a steady scene allocates once', () => {
    const queue = new TranslucentQueue();
    for (let i = 0; i < 12; i++) queue.record(MESH_A, identity(), 1, {});
    const pooled = queue.capacity;
    queue.reset();
    for (let i = 0; i < 12; i++) queue.record(MESH_A, identity(), 1, {});
    expect(queue.capacity).toBe(pooled);
    expect(queue.length).toBe(12);
  });

  it('grows past its initial capacity without losing a draw', () => {
    const queue = new TranslucentQueue();
    const many = 200;
    for (let i = 0; i < many; i++) {
      const model = identity();
      model[12] = i;
      queue.record(MESH_A, model, 1, {});
    }
    const seen: number[] = [];
    queue.replay((d) => seen.push(d.model[12] ?? -1));
    expect(seen.length).toBe(many);
    expect(seen[0]).toBe(0);
    expect(seen[many - 1]).toBe(many - 1);
  });
});

describe('the refraction options', () => {
  /*
   * **A dropped field here is a pane that refracts under sorted blending and stands clear under
   * order-independent transparency**, which reads as a bug in the transparency mode rather than as a
   * queue that lost something. OIT replays this set twice, so anything the shader needs has to
   * survive the round trip.
   */
  it('the queue carries the refraction options into the replay', () => {
    const queue = new TranslucentQueue();
    queue.record(MESH_A, identity(), 0.5, {
      refraction: 0.02,
      refractTint: [0.2, 0.9, 0.3] as unknown as never,
      thicknessM: 0.4,
    });

    const seen: { refraction: number; tint: number[]; thicknessM: number }[] = [];
    queue.replay((draw) => {
      seen.push({
        refraction: draw.refraction,
        tint: Array.from(draw.refractTint ?? []),
        thicknessM: draw.thicknessM,
      });
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.refraction).toBeCloseTo(0.02);
    expect(seen[0]?.thicknessM).toBeCloseTo(0.4);
    /* Float32 rounding on the way into the store, so compare with tolerance: the contract is that
       the value arrives, not the last bit of its mantissa. */
    expect(seen[0]?.tint?.[0]).toBeCloseTo(0.2);
    expect(seen[0]?.tint?.[1]).toBeCloseTo(0.9);
    expect(seen[0]?.tint?.[2]).toBeCloseTo(0.3);
  });

  /*
   * Copied and not referenced, which is the whole correctness of this file: a caller reusing one
   * array for every draw would otherwise have every pane in the frame wear the last one's colour.
   */
  it('the refraction tint is copied, not held by reference', () => {
    const queue = new TranslucentQueue();
    const caller = new Float32Array([1, 0, 0]);
    queue.record(MESH_A, identity(), 0.5, {
      refraction: 0.01,
      refractTint: caller as unknown as never,
    });
    caller[0] = 0.5;

    let held: number[] = [];
    queue.replay((draw) => {
      held = Array.from(draw.refractTint ?? []);
    });
    expect(held[0]).toBe(1);
  });

  /* A draw that says nothing about refraction refracts not at all, which is every existing call. */
  it('a draw that names no refraction records none', () => {
    const queue = new TranslucentQueue();
    queue.record(MESH_A, identity(), 0.5, {});
    queue.replay((draw) => {
      expect(draw.refraction).toBe(0);
      expect(draw.refractTint).toBeNull();
      expect(draw.thicknessM).toBe(0);
    });
  });
});
