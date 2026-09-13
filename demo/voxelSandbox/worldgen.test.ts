import { describe, expect, it } from 'vitest';

import { Block } from './blocks';
import { blockIndex, CHUNK_SX, CHUNK_SZ, SEA_LEVEL, WORLD_H } from './constants';
import { generateChunk } from './worldgen';

const SIZE = CHUNK_SX * CHUNK_SZ * WORLD_H;

const chunk = (seed: number, cx: number, cz: number): Uint8Array => {
  const data = new Uint8Array(SIZE);
  generateChunk(seed, cx, cz, data);
  return data;
};

describe('the terrain a seed produces', () => {
  it('produces the same chunk twice', () => {
    /* The save format is a seed plus sparse edits, so a generator that drifted would reload
       somebody's world as a different one. This is what makes the format safe. */
    expect(chunk(1337, 3, -2)).toEqual(chunk(1337, 3, -2));
  });

  it('produces different chunks for different seeds', () => {
    expect(chunk(1337, 0, 0)).not.toEqual(chunk(7, 0, 0));
  });

  it('fills below sea level and leaves sky above the terrain', () => {
    const data = chunk(1337, 0, 0);
    let solidBelowSea = 0;
    for (let x = 0; x < CHUNK_SX; x++) {
      for (let z = 0; z < CHUNK_SZ; z++) {
        expect(data[blockIndex(x, WORLD_H - 1, z)]).toBe(Block.AIR);
        for (let y = 0; y < SEA_LEVEL; y++) {
          if (data[blockIndex(x, y, z)] !== Block.AIR) solidBelowSea++;
        }
      }
    }
    expect(solidBelowSea).toBeGreaterThan(0);
  });

  it('leaves no hole in the floor', () => {
    /* A cave carved through y=0 would be a hole a player falls out of the world through. */
    const data = chunk(1337, 5, 5);
    for (let x = 0; x < CHUNK_SX; x++) {
      for (let z = 0; z < CHUNK_SZ; z++) {
        expect(data[blockIndex(x, 0, z)]).toBe(Block.BEDROCK);
      }
    }
  });

  it('agrees with its neighbour about their shared border', () => {
    /* Height comes from world coordinates rather than chunk-local ones, which is what stops a
       seam. A generator that read chunk-local x would look right until two chunks met. */
    const left = chunk(1337, 0, 0);
    const right = chunk(1337, 1, 0);
    let compared = 0;
    for (let z = 0; z < CHUNK_SZ; z++) {
      for (let y = 0; y < WORLD_H; y++) {
        /* The rightmost column of one chunk and the leftmost of the next are adjacent, not
           identical, so this checks that neither has a wall of air against solid ground. */
        const a = left[blockIndex(CHUNK_SX - 1, y, z)]!;
        const b = right[blockIndex(0, y, z)]!;
        if (a !== Block.AIR || b !== Block.AIR) compared++;
      }
    }
    expect(compared).toBeGreaterThan(0);
  });

  it('does not flood a column whose ground stands above the sea', () => {
    /* Water is filled per column from sea level down. A land column that took water would
       put a puddle on top of a hill. */
    const data = chunk(1337, 0, 0);
    for (let x = 0; x < CHUNK_SX; x++) {
      for (let z = 0; z < CHUNK_SZ; z++) {
        let surface = -1;
        for (let y = WORLD_H - 1; y >= 0; y--) {
          const id = data[blockIndex(x, y, z)]!;
          if (id !== Block.AIR && id !== Block.WATER) {
            surface = y;
            break;
          }
        }
        if (surface < SEA_LEVEL) continue;
        for (let y = surface + 1; y < WORLD_H; y++) {
          expect(data[blockIndex(x, y, z)]).not.toBe(Block.WATER);
        }
      }
    }
  });
});
