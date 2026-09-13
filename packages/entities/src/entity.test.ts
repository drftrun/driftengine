import { describe, expect, it } from 'vitest';
import {
  ENTITY_GENERATION_CEILING,
  ENTITY_INDEX_CEILING,
  EntityAllocator,
  entityGeneration,
  entityIndex,
  packEntity,
} from './entity.ts';

describe('an entity handle', () => {
  it('round-trips an index and a generation, including at the top of both ranges', () => {
    for (const [index, generation] of [
      [0, 0],
      [1, 1],
      [12345, 678],
      [ENTITY_INDEX_CEILING - 1, 0],
      [0, 2 ** 27 - 1],
      [ENTITY_INDEX_CEILING - 1, 2 ** 27 - 1],
    ] as const) {
      const handle = packEntity(index, generation);
      expect(entityIndex(handle), `index of (${index}, ${generation})`).toBe(index);
      expect(entityGeneration(handle), `generation of (${index}, ${generation})`).toBe(generation);
    }
  });

  it('spends the whole 53-bit budget exactly, and the top handle is the last safe integer', () => {
    /*
     * 26 + 27 = 53, which is what a double holds exactly — so the largest handle is
     * `Number.MAX_SAFE_INTEGER` itself and there is **no headroom at all**. That is deliberate and
     * is worth asserting rather than discovering: a third field in a handle, or one more bit of
     * either, stops the arithmetic being exact and the failure is a handle that compares equal to a
     * different one.
     *
     * A packed `Uint32` would leave headroom and would wrap a slot's generation after 256 reuses,
     * silently handing back a handle identical to one that was destroyed. Between headroom nobody
     * has a use for and a wrap that is a correctness hole, this takes the wrap away.
     */
    const top = packEntity(ENTITY_INDEX_CEILING - 1, ENTITY_GENERATION_CEILING - 1);
    expect(Number.isSafeInteger(top)).toBe(true);
    expect(top).toBe(Number.MAX_SAFE_INTEGER);
    expect(entityIndex(top)).toBe(ENTITY_INDEX_CEILING - 1);
    expect(entityGeneration(top)).toBe(ENTITY_GENERATION_CEILING - 1);
  });
});

describe('the allocator', () => {
  it('hands out live entities and knows they are alive', () => {
    const allocator = new EntityAllocator();
    const a = allocator.create();
    const b = allocator.create();

    expect(a).not.toBe(b);
    expect(allocator.alive(a)).toBe(true);
    expect(allocator.alive(b)).toBe(true);
    expect(allocator.liveCount).toBe(2);
  });

  it('stops answering for a destroyed entity', () => {
    const allocator = new EntityAllocator();
    const a = allocator.create();

    expect(allocator.destroy(a)).toBe(true);
    expect(allocator.alive(a)).toBe(false);
    expect(allocator.liveCount).toBe(0);
    /* And destroying it twice is `false` rather than a second decrement. */
    expect(allocator.destroy(a)).toBe(false);
    expect(allocator.liveCount).toBe(0);
  });

  it('reuses the slot but never the handle, which is the whole point', () => {
    /*
     * Without a generation, the entity that takes a freed index makes every old reference to that
     * index silently valid — pointing at a different thing, of a different kind, with no error
     * anywhere.
     */
    const allocator = new EntityAllocator();
    const first = allocator.create();
    allocator.destroy(first);
    const second = allocator.create();

    expect(entityIndex(second)).toBe(entityIndex(first));
    expect(second).not.toBe(first);
    expect(allocator.alive(second)).toBe(true);
    expect(allocator.alive(first)).toBe(false);
  });

  it('reuses freed slots first-in-first-out, which spreads generation wear across the pool', () => {
    /*
     * A stack hands the same slot straight back, so one spawn-and-destroy pair in a loop burns that
     * slot's whole generation range while every other slot sits unused. A queue is what turns the
     * ceiling into a number about the pool rather than about one slot.
     */
    const allocator = new EntityAllocator();
    const a = allocator.create();
    const b = allocator.create();
    allocator.destroy(a);
    allocator.destroy(b);

    expect(entityIndex(allocator.create())).toBe(entityIndex(a));
    expect(entityIndex(allocator.create())).toBe(entityIndex(b));
  });

  it('refuses past the index ceiling rather than wrapping into a live handle', () => {
    const allocator = new EntityAllocator();
    /* Reaching the real ceiling would allocate 67 million slots, so the allocator takes one. */
    const small = new EntityAllocator({ ceiling: 3 });
    small.create();
    small.create();
    small.create();

    expect(() => small.create()).toThrow(/ceiling/);
    expect(allocator.liveCount).toBe(0);
  });

  it('says no to a handle from beyond its own range, rather than reading past its arrays', () => {
    const allocator = new EntityAllocator();
    allocator.create();

    expect(allocator.alive(packEntity(9999, 0))).toBe(false);
    expect(allocator.alive(packEntity(0, 41))).toBe(false);
  });

  it('keeps counting up the generation across many reuses of one slot', () => {
    const allocator = new EntityAllocator({ ceiling: 1 });
    let previous = allocator.create();
    for (let i = 0; i < 1000; i += 1) {
      allocator.destroy(previous);
      const next = allocator.create();
      expect(entityGeneration(next), `reuse ${i}`).toBe(entityGeneration(previous) + 1);
      expect(allocator.alive(previous), `reuse ${i}`).toBe(false);
      previous = next;
    }
  });
});
