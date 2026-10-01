import { describe, expect, it } from 'vitest';

import { solidBox } from '@driftengine/core';
import type { MeshData } from '@driftengine/drft';

import type { CopyOf } from './kit.ts';
import { PieceMeasures, rates } from './measure.ts';

const box = solidBox(1, 1, 1);
const unitBox: MeshData = {
  positions: box.positions,
  normals: box.normals,
  colors: new Float32Array(box.positions.length),
  emissive: new Float32Array(box.positions.length / 3),
  indices: box.indices,
};
/* One triangle of a square metre, lying level and facing up — open, so it faces one way — with
   edges off the axes, so both halves of each cross product count. */
const floor: MeshData = {
  positions: new Float32Array([0, 0, 0, 1, 0, 1, 1, 0, -1]),
  normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
  colors: new Float32Array(9),
  emissive: new Float32Array(3),
  indices: new Uint32Array([0, 1, 2]),
};
const copy = (columns: number[], piece = 0): CopyOf => ({
  piece,
  matrix: new Float32Array([...columns, 0, 0, 0]),
  uv: new Float32Array(8),
});
const round = (x: number): number => Math.round(x * 1000) / 1000 + 0;

describe('measuring a copy', () => {
  const measures = new PieceMeasures([unitBox, floor]);

  it('A COPY FACES SIDEWAYS AND UP BY ITS STRETCHED FACES, TURNED OR MIRRORED', () => {
    /* 10 × 30 × 10: four walls of 10 × 30, a top of 10 × 10; the bottom faces down. */
    const tall = measures.facing(copy([10, 0, 0, 0, 30, 0, 0, 0, 10]));
    expect([round(tall.side), round(tall.up)]).toEqual([1200, 100]);
    /* A quarter turn about y swaps which walls are which, and a mirror winds back: the same. */
    const turned = measures.facing(copy([0, 0, -10, 0, 30, 0, 10, 0, 0]));
    expect([round(turned.side), round(turned.up)]).toEqual([1200, 100]);
    const mirrored = measures.facing(copy([-10, 0, 0, 0, 30, 0, 0, 0, 10]));
    expect([round(mirrored.side), round(mirrored.up)]).toEqual([1200, 100]);
    /* Upside down, its top faces down and its bottom up. */
    const flipped = measures.facing(copy([10, 0, 0, 0, -30, 0, 0, 0, -10]));
    expect([round(flipped.side), round(flipped.up)]).toEqual([1200, 100]);
    /* A floor stretched 2 × 2 faces up with 4 m²; mirrored top to bottom it is a ceiling. */
    expect(measures.facing(copy([2, 0, 0, 0, 1, 0, 0, 0, 2], 1)).up).toBe(4);
    expect(measures.facing(copy([2, 0, 0, 0, -1, 0, 0, 0, 2], 1))).toEqual({ side: 0, up: 0 });
  });

  it("A COPY'S SIDES ARE ITS BOX IN THE WORLD, TURNED, LONGEST FIRST", () => {
    expect(measures.sides(copy([10, 0, 0, 0, 0.2, 0, 0, 0, 3])).map(round)).toEqual([10, 3, 0.2]);
    /* 4 × 1 × 4 turned 45° about y spans 4·cos 45° + 4·sin 45° = 4√2 along x and along z. */
    const c = Math.SQRT1_2;
    expect(measures.sides(copy([4 * c, 0, -4 * c, 0, 1, 0, 4 * c, 0, 4 * c])).map(round)).toEqual([
      5.657, 5.657, 1,
    ]);
    /* The floor stood on its edge, its x 50 m up, its z 2 m stretched to 6: its own y is flat, so
       the 10 there counts none. */
    expect(measures.sides(copy([0, 50, 0, 10, 0, 0, 0, 0, 3], 1)).map(round)).toEqual([50, 6, 0]);
  });
});

describe('texture density', () => {
  /* A wall 6 m wide and 3 m tall facing +z, its picture three times across and once up. */
  const wall: MeshData = {
    positions: new Float32Array([0, 0, 0, 6, 0, 0, 6, 3, 0, 0, 3, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    colors: new Float32Array(12),
    emissive: new Float32Array(4),
    uvs: new Float32Array([0, 0, 3, 0, 3, 1, 0, 1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };

  it('A WALL REPEATS ALONG AND UP AT ITS OWN RATES; A ROOF AT ONE', () => {
    const side = rates(wall, 'side');
    expect([round(side.ru), round(side.rv)]).toEqual([0.5, 0.333]);
    /* The same picture turned a quarter on the wall: now once along its 6 m and three times up. */
    const turned = { ...wall, uvs: new Float32Array([0, 0, 0, 1, 3, 1, 3, 0]) };
    const t = rates(turned, 'side');
    expect([round(t.ru), round(t.rv)]).toEqual([0.167, 1]);
    /* A roof 4 m square, its picture twice each way: half a repeat a metre. */
    const roof: MeshData = {
      ...wall,
      positions: new Float32Array([0, 5, 0, 0, 5, -4, 4, 5, -4, 4, 5, 0]),
      normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
      uvs: new Float32Array([0, 0, 0, 2, 2, 2, 2, 0]),
      indices: new Uint32Array([0, 3, 2, 0, 2, 1]),
    };
    const up = rates(roof, 'up');
    expect([round(up.ru), round(up.rv)]).toEqual([0.5, 0.5]);
    /* And a wall has no roof in it. */
    expect(rates(wall, 'up')).toEqual({ ru: 0, rv: 0 });
  });
});
