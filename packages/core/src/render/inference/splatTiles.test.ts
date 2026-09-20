import { describe, expect, it } from 'vitest';

import {
  countSplatTiles,
  fillSplatTiles,
  splatPixelBox,
  splatTileGrid,
  splatPairOffsets,
  splatTileOffsets,
  SPLAT_BIN_FLOATS,
  SPLAT_TILE,
} from './splatTiles.ts';

/**
 * **The lists a tiled rasteriser walks.** What has to hold is that nothing is missed and nothing is
 * reordered: a splat absent from a tile it covers is a hole in the picture, and a list out of the
 * order it was given composites the cloud back to front.
 *
 * The coverage claim itself — that these lists hold every splat the reference rasteriser actually
 * touches a pixel of — is made where the reference is, in `@driftengine/capture`. This holds the
 * arithmetic either side of it.
 */

const WIDTH = 64;
const HEIGHT = 48;

function bins(splats: readonly (readonly [number, number, number, number])[]): Float32Array {
  const out = new Float32Array(splats.length * SPLAT_BIN_FLOATS);
  splats.forEach(([x, y, radius, depth], at) => {
    out[at * SPLAT_BIN_FLOATS] = x;
    out[at * SPLAT_BIN_FLOATS + 1] = y;
    out[at * SPLAT_BIN_FLOATS + 2] = radius;
    out[at * SPLAT_BIN_FLOATS + 3] = depth;
  });
  return out;
}

function binned(splats: readonly (readonly [number, number, number, number])[]) {
  const { across, down } = splatTileGrid(WIDTH, HEIGHT);
  const table = bins(splats);
  const counts = new Uint32Array(across * down);
  const total = countSplatTiles(table, splats.length, WIDTH, HEIGHT, counts);
  const offsets = new Uint32Array(across * down);
  const summed = splatTileOffsets(counts, offsets);
  const lists = new Uint32Array(total);
  fillSplatTiles(
    table,
    splats.length,
    WIDTH,
    HEIGHT,
    offsets,
    new Uint32Array(across * down),
    lists,
  );
  return { across, down, counts, offsets, lists, total, summed };
}

/** The splats a tile holds, in the order the lists hold them. */
function listOf(result: ReturnType<typeof binned>, column: number, row: number): number[] {
  const tile = row * result.across + column;
  const from = result.offsets[tile] as number;
  return Array.from(result.lists.subarray(from, from + (result.counts[tile] as number)));
}

describe('a cloud cut into tiles', () => {
  it('GIVES EVERY TILE THE SPLATS THAT COVER IT, and no others', () => {
    /* A splat inside one tile, one straddling the seam between two, and one far off the frame. */
    const result = binned([
      [8, 8, 3, 1],
      [SPLAT_TILE, 8, 2, 2],
      [400, 8, 3, 3],
    ]);
    expect(result.across).toBe(4);
    expect(result.down).toBe(3);
    expect(listOf(result, 0, 0)).toEqual([0, 1]);
    expect(listOf(result, 1, 0)).toEqual([1]);
    /* Nothing else anywhere: the total is exactly those three entries. */
    expect(result.total).toBe(3);
    expect(result.summed).toBe(3);
  });

  it('keeps the order it was given, which is what makes a depth sort enough', () => {
    /* Three splats over one tile, handed over furthest first — the lists say so. */
    const result = binned([
      [8, 8, 4, 9],
      [8, 8, 4, 5],
      [8, 8, 4, 1],
    ]);
    expect(listOf(result, 0, 0)).toEqual([0, 1, 2]);
  });

  it('bounds a splat by the box the rasteriser loops over, clamped to the frame', () => {
    const box = new Int32Array(4);
    const table = bins([[2, 2, 5, 1]]);
    expect(splatPixelBox(table, 0, WIDTH, HEIGHT, box)).toBe(true);
    /* −3 to 7 across, clamped at zero, and `ceil` on the far side as the rasteriser has it. */
    expect(Array.from(box)).toEqual([0, 0, 7, 7]);

    /* A splat with no radius covers nothing, and one past the frame covers nothing. */
    expect(splatPixelBox(bins([[8, 8, 0, 1]]), 0, WIDTH, HEIGHT, box)).toBe(false);
    expect(splatPixelBox(bins([[-20, 8, 3, 1]]), 0, WIDTH, HEIGHT, box)).toBe(false);
    expect(splatPixelBox(bins([[8, 200, 3, 1]]), 0, WIDTH, HEIGHT, box)).toBe(false);
  });

  it('gives an empty tile a list of its own, at a real offset', () => {
    const result = binned([[40, 40, 3, 1]]);
    /* The splat is in one tile; every other tile is empty and still has an offset to index by. */
    expect(result.counts.filter((value) => value > 0).length).toBe(1);
    expect(result.offsets.length).toBe(result.counts.length);
    for (let tile = 1; tile < result.offsets.length; tile += 1) {
      const step = (result.offsets[tile] as number) - (result.offsets[tile - 1] as number);
      expect(step).toBe(result.counts[tile - 1] as number);
    }
  });

  it('GIVES EVERY (TILE, SPLAT) PAIR A SLOT OF ITS OWN, and a splat’s slots run together', () => {
    /*
     * Two splats, one over four tiles and one over one. What has to hold is that the slots a splat
     * owns are contiguous and nobody else's — that is what lets a backward pass reduce them in a
     * fixed order instead of adding into a float atomic nothing can make deterministic.
     */
    const { across, down } = splatTileGrid(WIDTH, HEIGHT);
    const table = bins([
      [SPLAT_TILE, SPLAT_TILE, 3, 1],
      [40, 40, 2, 2],
    ]);
    const counts = new Uint32Array(across * down);
    const tilesPerSplat = new Uint32Array(2);
    const total = countSplatTiles(table, 2, WIDTH, HEIGHT, counts, tilesPerSplat);
    /* Centred on a tile corner with a radius of three: four tiles. The other is inside one. */
    expect(Array.from(tilesPerSplat)).toEqual([4, 1]);
    expect(total).toBe(5);

    const offsets = new Uint32Array(across * down);
    splatTileOffsets(counts, offsets);
    const pairOffsets = new Uint32Array(2);
    expect(splatPairOffsets(tilesPerSplat, pairOffsets)).toBe(total);
    expect(Array.from(pairOffsets)).toEqual([0, 4]);

    const lists = new Uint32Array(total);
    const pairOf = new Uint32Array(total);
    fillSplatTiles(table, 2, WIDTH, HEIGHT, offsets, new Uint32Array(across * down), lists, {
      offsets: pairOffsets,
      pairOf,
    });
    /* Every slot used exactly once, and each splat's four and one land in its own run. */
    expect([...pairOf].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
    for (let slot = 0; slot < total; slot += 1) {
      const splat = lists[slot] as number;
      const from = pairOffsets[splat] as number;
      expect(pairOf[slot]).toBeGreaterThanOrEqual(from);
      expect(pairOf[slot]).toBeLessThan(from + (tilesPerSplat[splat] as number));
    }
  });

  it('clears its counts, so a buffer used twice does not grow', () => {
    const { across, down } = splatTileGrid(WIDTH, HEIGHT);
    const counts = new Uint32Array(across * down);
    const table = bins([[8, 8, 3, 1]]);
    const first = countSplatTiles(table, 1, WIDTH, HEIGHT, counts);
    const second = countSplatTiles(table, 1, WIDTH, HEIGHT, counts);
    expect(second).toBe(first);
    expect(counts[0]).toBe(1);
  });
});
