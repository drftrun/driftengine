import { describe, expect, it } from 'vitest';

import { solidBox } from '@driftengine/core';
import type { MeshData } from '@driftengine/drft';

import { occluderBox, welded } from './occluders.ts';

const round = (xs: ArrayLike<number>): number[] =>
  Array.from(xs, (x) => Math.round(x * 1000) / 1000 + 0);

describe("a region's occluders and collision", () => {
  it('AN OCCLUDER STANDS INSIDE WHAT IT STANDS FOR, SQUARE TO THE AXES WHICHEVER WAY THAT IS TURNED', () => {
    /* 10 m along its x and 8 along its z, at (5, 7), from 4 m up to 30. */
    expect(round(occluderBox(5, 7, 0, 10, 8, 4, 30) ?? [])).toEqual([0, 4, 3, 10, 30, 11]);
    /* Turned a quarter, its 10 m runs along the world's z. */
    expect(round(occluderBox(5, 7, Math.PI / 2, 10, 8, 4, 30) ?? [])).toEqual([1, 4, 2, 9, 30, 12]);
    /* Turned an eighth, the largest square whose corners stay inside: half its lesser half-side
       over cos 45° + sin 45°, 4 / √2 = 2.828 either way. */
    expect(round(occluderBox(5, 7, Math.PI / 4, 10, 8, 4, 30) ?? [])).toEqual([
      2.172, 4, 4.172, 7.828, 30, 9.828,
    ]);
    /* Nothing narrower or lower than the coarse level's error. */
    expect(occluderBox(5, 7, 0, 3, 8, 4, 30)).toBeNull();
    expect(occluderBox(5, 7, 0, 10, 8, 4, 7)).toBeNull();
  });

  it('COLLISION IS WHAT IT IS MADE OF, WELDED: A BOX IS EIGHT CORNERS AND TWELVE TRIANGLES', () => {
    const box = (x: number): MeshData => {
      const s = solidBox(1, 1, 1);
      const positions = new Float32Array(s.positions);
      for (let i = 0; i < positions.length; i += 3) positions[i] = (positions[i] as number) + x;
      return {
        positions,
        normals: s.normals,
        colors: new Float32Array(positions.length),
        emissive: new Float32Array(positions.length / 3),
        indices: s.indices,
      };
    };
    const one = welded([box(0)]);
    expect([one.positions.length / 3, one.indices.length / 3]).toEqual([8, 12]);
    /* Two sharing a face share its four corners: twelve, and both boxes' triangles. */
    const two = welded([box(0), box(1)]);
    expect([two.positions.length / 3, two.indices.length / 3]).toEqual([12, 24]);
    /* A sliver with two corners 0.2 mm apart welds flat and goes: its third corner and the one
       the other two became stay, and no triangle. */
    const sliver: MeshData = {
      positions: new Float32Array([0, 0, 0, 0.0002, 0, 0, 0, 0, 1]),
      normals: new Float32Array(9),
      colors: new Float32Array(9),
      emissive: new Float32Array(3),
      indices: new Uint32Array([0, 1, 2]),
    };
    const three = welded([box(0), box(1), sliver]);
    expect([three.positions.length / 3, three.indices.length / 3]).toEqual([14, 24]);
    /* Every index names a corner, and each triangle three different ones. */
    for (let t = 0; t < two.indices.length; t += 3) {
      const [a, b, c] = [two.indices[t], two.indices[t + 1], two.indices[t + 2]] as number[];
      expect(new Set([a, b, c]).size).toBe(3);
      expect(Math.max(a as number, b as number, c as number)).toBeLessThan(12);
    }
  });
});
