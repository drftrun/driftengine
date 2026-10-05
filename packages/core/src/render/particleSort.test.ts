import { describe, expect, it } from 'vitest';

import { createParticleSort, sortBackToFront } from './particleSort.ts';
import type { ParticleInstances } from './particlePool.ts';

/** `count` particles along +z at the given depths, each named by its seed. */
function particles(depths: number[]): ParticleInstances {
  const n = depths.length;
  const out: ParticleInstances = {
    positions: new Float32Array(n * 3),
    sizes: new Float32Array(n),
    spins: new Float32Array(n),
    colors: new Float32Array(n * 3),
    alphas: new Float32Array(n),
    ages: new Float32Array(n),
    seeds: new Float32Array(n),
    velocities: new Float32Array(n * 3),
    frames: new Float32Array(n),
    count: n,
    capacity: n,
  };
  depths.forEach((z, i) => {
    out.positions[i * 3 + 2] = z;
    out.seeds[i] = i;
    out.frames?.set([i * 10], i);
  });
  return out;
}

describe('sorting a blended batch', () => {
  /* An eye at the origin: the particle at 9 is drawn first and the one at 1 last. */
  it('PUTS THE FARTHEST FIRST, CARRYING EVERY STREAM WITH ITS PARTICLE', () => {
    const sort = createParticleSort(8);
    const sorted = sortBackToFront(particles([3, 9, 1, 5]), [0, 0, 0], sort);
    expect(sorted.count).toBe(4);
    expect(Array.from(sorted.seeds.subarray(0, 4))).toEqual([1, 3, 0, 2]);
    expect(Array.from(sorted.frames?.subarray(0, 4) ?? [])).toEqual([10, 30, 0, 20]);
    expect(sorted.positions[2]).toBe(9);
  });

  /* Two particles at one distance keep the order they came in, frame after frame. */
  it('keeps a tie in the order it arrived', () => {
    const sort = createParticleSort(8);
    const sorted = sortBackToFront(particles([4, 2, 4, 2, 4]), [0, 0, 0], sort);
    expect(Array.from(sorted.seeds.subarray(0, 5))).toEqual([0, 2, 4, 1, 3]);
  });

  it('sorts a count that is not a power of two, and no more than its capacity', () => {
    const depths = [7, 1, 6, 2, 5, 3, 4];
    const sort = createParticleSort(7);
    const sorted = sortBackToFront(particles(depths), [0, 0, 0], sort);
    expect(Array.from(sorted.positions.filter((_, i) => i % 3 === 2))).toEqual([
      7, 6, 5, 4, 3, 2, 1,
    ]);
    const small = createParticleSort(3);
    expect(sortBackToFront(particles(depths), [0, 0, 0], small).count).toBe(3);
  });
});
