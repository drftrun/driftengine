import { describe, expect, test } from 'vitest';
import { ParticlePool } from './particlePool.ts';
import type { ParticlePoolOptions } from './particlePool.ts';

function options(over: Partial<ParticlePoolOptions> = {}): ParticlePoolOptions {
  return {
    capacity: 8,
    lifeSec: 1,
    sizeStart: 1,
    sizeEnd: 2,
    colorStart: [1, 1, 1],
    colorEnd: [0.2, 0.2, 0.2],
    gravity: 0,
    drag: 0,
    rise: 0,
    ...over,
  };
}

const DT = 1 / 60;

describe('ParticlePool', () => {
  test('a particle lives for its lifetime and then stops existing', () => {
    const pool = new ParticlePool(options({ lifeSec: 0.5 }));
    pool.emit(0, 0, 0, 0, 0, 0, 1);
    pool.update(DT);
    expect(pool.instances.count).toBe(1);
    for (let i = 0; i < 40; i++) pool.update(DT);
    expect(pool.instances.count).toBe(0);
    expect(pool.live).toBe(0);
  });

  test('the instance buffer is compacted, so the draw call is exactly the live count', () => {
    /*
     * The reason this is worth stating: a pool that leaves gaps has to either
     * draw its whole capacity every frame or carry a free list. Compacting on
     * update means a mostly-empty pool costs one loop and a tiny draw.
     */
    const pool = new ParticlePool(options({ lifeSec: 1 }));
    pool.emit(0, 0, 0, 0, 0, 0, 1, 1, 0.2);
    pool.emit(1, 0, 0, 0, 0, 0, 2, 1, 1);
    pool.emit(2, 0, 0, 0, 0, 0, 3, 1, 0.2);
    for (let i = 0; i < 20; i++) pool.update(DT);
    expect(pool.instances.count).toBe(1);
    // The survivor is at index 0, not wherever it was emitted.
    expect(pool.instances.positions[0]).toBeCloseTo(1, 5);
  });

  test('overrunning capacity drops the oldest rather than refusing to emit', () => {
    // Degrading invisibly beats degrading visibly at exactly the moment the
    // effect matters — a drift long enough to fill the pool is the one a player
    // most wants to see.
    const pool = new ParticlePool(options({ capacity: 4 }));
    for (let i = 0; i < 10; i++) pool.emit(i, 0, 0, 0, 0, 0, i);
    pool.update(DT);
    expect(pool.instances.count).toBe(4);
    // The four newest survive. Which slot each lands in is the ring's business
    // and not a property worth pinning — compaction walks slot order, not age.
    const survivors = [0, 1, 2, 3].map((i) => Math.round(pool.instances.positions[i * 3] ?? -1));
    expect(survivors.sort((a, b) => a - b)).toEqual([6, 7, 8, 9]);
  });

  test('gravity and drag act, and rise opposes gravity', () => {
    const falling = new ParticlePool(options({ gravity: 10 }));
    falling.emit(0, 0, 0, 0, 0, 0, 1);
    for (let i = 0; i < 30; i++) falling.update(DT);
    expect(falling.instances.positions[1]).toBeLessThan(-0.5);

    const floating = new ParticlePool(options({ gravity: 10, rise: 10 }));
    floating.emit(0, 0, 0, 0, 0, 0, 1);
    for (let i = 0; i < 30; i++) floating.update(DT);
    expect(floating.instances.positions[1]).toBeCloseTo(0, 5);

    const dragged = new ParticlePool(options({ drag: 20 }));
    dragged.emit(0, 0, 0, 10, 0, 0, 1);
    for (let i = 0; i < 30; i++) dragged.update(DT);
    const free = new ParticlePool(options());
    free.emit(0, 0, 0, 10, 0, 0, 1);
    for (let i = 0; i < 30; i++) free.update(DT);
    expect(dragged.instances.positions[0]).toBeLessThan((free.instances.positions[0] ?? 0) * 0.5);
  });

  test('particles fade out rather than vanishing', () => {
    // The tint carries the fade, because the instanced path has no per-instance
    // opacity. A particle that pops out of existence at full brightness is the
    // single most obvious way a particle system looks cheap.
    const pool = new ParticlePool(options({ lifeSec: 1 }));
    pool.emit(0, 0, 0, 0, 0, 0, 1);
    pool.update(DT);
    const born = pool.instances.tints[0] ?? 0;
    for (let i = 0; i < 50; i++) pool.update(DT);
    const dying = pool.instances.tints[0] ?? 0;
    expect(dying).toBeLessThan(born * 0.4);
    expect(dying).toBeGreaterThanOrEqual(0);
  });

  test('particles grow as they age', () => {
    const pool = new ParticlePool(options({ sizeStart: 0.2, sizeEnd: 1.5 }));
    pool.emit(0, 0, 0, 0, 0, 0, 1);
    pool.update(DT);
    const young = pool.instances.scaleAndYaw[0] ?? 0;
    for (let i = 0; i < 40; i++) pool.update(DT);
    expect(pool.instances.scaleAndYaw[0] ?? 0).toBeGreaterThan(young * 2);
  });

  test('neighbours do not share a rotation', () => {
    // Otherwise a plume reads as one object turning rather than as many puffs.
    const pool = new ParticlePool(options({ capacity: 6 }));
    for (let i = 0; i < 6; i++) pool.emit(0, 0, 0, 0, 0, 0, 7);
    pool.update(DT);
    const spins = new Set<number>();
    for (let i = 0; i < 6; i++)
      spins.add(Math.round((pool.instances.scaleAndYaw[i * 2 + 1] ?? 0) * 100));
    expect(spins.size).toBeGreaterThan(4);
  });

  test('the same seeds produce the same plume', () => {
    /*
     * Variation comes from a seed rather than from `Math.random`, so a caller
     * inside a deterministic system can pass a tick count. The same run has to
     * look the same twice — it is on its way to being a clip.
     */
    const run = (): number[] => {
      const pool = new ParticlePool(options({ capacity: 16, gravity: 4, drag: 2 }));
      for (let i = 0; i < 40; i++) {
        pool.emit(i * 0.1, 0, 0, 1, 2, 0, i);
        pool.update(DT);
      }
      return [...pool.instances.positions, ...pool.instances.scaleAndYaw];
    };
    expect(run()).toEqual(run());
  });

  test('clearing empties it', () => {
    const pool = new ParticlePool(options());
    pool.emit(0, 0, 0, 0, 0, 0, 1);
    pool.update(DT);
    pool.clear();
    pool.update(DT);
    expect(pool.instances.count).toBe(0);
  });

  test('a degenerate pool is refused at construction, not at draw time', () => {
    expect(() => new ParticlePool(options({ capacity: 0 }))).toThrow();
    expect(() => new ParticlePool(options({ capacity: 2.5 }))).toThrow();
    expect(() => new ParticlePool(options({ lifeSec: 0 }))).toThrow();
  });
});
