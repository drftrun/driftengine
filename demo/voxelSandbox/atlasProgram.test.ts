import { expect, test } from 'vitest';

import { ADDRESS_MODE, createDecodeRegisters, decodeCpu, srgbToLinear } from '@driftengine/texture';
import type { LatentImage } from '@driftengine/texture';

import { atlasProgram, type AtlasProgram } from './atlasProgram';

/**
 * Sixteen rather than the sandbox's 128, because the layout does not depend on it and a 2048 square
 * converted to floats for the reference decoder is two seconds a test. The seam test then reaches
 * one texel a tile at level four rather than seven.
 */
const TILE = 16;

/** The sRGB bytes tile `i` is filled with: distinct per tile, opaque, and no channel at an end. */
function tileColour(i: number): [number, number, number, number] {
  return [40 + 20 * i, 200 - 10 * i, 90, 255];
}

/** An atlas of `cols` by `rows` tiles, laid out as `buildBlockAtlas` lays them. */
function tiles(cols: number, rows: number): Uint8Array {
  const width = cols * TILE;
  const pixels = new Uint8Array(width * rows * TILE * 4);
  for (let y = 0; y < rows * TILE; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const colour = tileColour(Math.floor(y / TILE) * cols + Math.floor(x / TILE));
      pixels.set(colour, (y * width + x) * 4);
    }
  }
  return pixels;
}

/**
 * The program's block as the reference decoder reads it: bytes over 255, which is what an
 * `rgba8unorm` layer hands the device's sampler.
 */
function asLatent(block: {
  width: number;
  height: number;
  levels: readonly Uint8Array[];
}): LatentImage {
  const floats = (bytes: Uint8Array) => Float32Array.from(bytes, (byte) => byte / 255);
  return {
    data: floats(block.levels[0] as Uint8Array),
    width: block.width,
    height: block.height,
    channels: 4,
    mips: block.levels.slice(1).map((level, k) => ({
      data: floats(level),
      width: Math.max(1, block.width >> (k + 1)),
      height: Math.max(1, block.height >> (k + 1)),
    })),
  };
}

/** Converted once a program: a 2048 square is sixty-four megabytes of floats. */
const LATENTS = new WeakMap<AtlasProgram, LatentImage>();

/** What the program answers at an atlas coordinate `buildBlockAtlas`'s UV table would hold. */
function decodedAt(built: AtlasProgram, u: number, v: number, lod = 0): Float32Array {
  const block = built.program.blocks?.[0];
  if (block === undefined) throw new Error('no block');
  let latent = LATENTS.get(built);
  if (latent === undefined) {
    latent = asLatent(block);
    LATENTS.set(built, latent);
  }
  const [ru, rv] = built.remap(u, v);
  const out = new Float32Array(4);
  decodeCpu(
    built.program.graph,
    { latents: [], blocks: [latent], networks: [] },
    ru,
    rv,
    0,
    out,
    createDecodeRegisters(),
    lod,
  );
  return out;
}

test('EACH TILE GETS A CELL TWICE ITS SIZE, AND THE ATLAS A POWER-OF-TWO SQUARE', () => {
  /*
   * The device's texture array takes one square size for every layer, and a power-of-two cell is
   * what keeps a box-filtered chain from ever averaging two tiles together. Five by three tiles of
   * sixteen are five by three cells of 32, which is 160 by 96 and a square of 256 — and the
   * sandbox's twenty-seven tiles of 128, six by five, are a square of 2048.
   */
  const built = atlasProgram(tiles(5, 3), 5 * TILE, 3 * TILE, TILE);
  const block = built.program.blocks?.[0];
  expect(block?.width).toBe(256);
  expect(block?.height).toBe(256);
});

test('EVERY MIP LEVEL IS PRESENT, down to one texel', () => {
  /*
   * A chunk forty metres away reads a coarser level, and `decodeTables.ts` refuses a layer whose
   * chain stops short. The forward path's atlas has no chain at all and aliases; this one cannot.
   */
  const built = atlasProgram(tiles(2, 2), 2 * TILE, 2 * TILE, TILE);
  const levels = built.program.blocks?.[0]?.levels ?? [];
  expect(levels.length).toBe(7);
  expect(levels[6]?.length).toBe(4);
});

test('A GUTTER REPEATS ITS TILE’S EDGE, and past every cell the square is transparent', () => {
  const built = atlasProgram(tiles(3, 1), 3 * TILE, TILE, TILE);
  const level0 = built.program.blocks?.[0]?.levels[0] as Uint8Array;
  const edge = 128;
  const texel = (x: number, y: number) => [
    ...level0.subarray((y * edge + x) * 4, (y * edge + x) * 4 + 4),
  ];
  /* Tile 1's cell starts at 32 and its content at 40; the gutter to its left is its own colour. */
  expect(texel(32 + 2, 8 + 1)).toEqual(tileColour(1));
  expect(texel(32 + 8 + 3, 2)).toEqual(tileColour(1));
  /* Below the one row of cells, and right of the third: nothing. */
  expect(texel(10, 60)[3]).toBe(0);
  expect(texel(110, 10)[3]).toBe(0);
});

test('A TILE DECODES TO ITS OWN COLOUR, IN LINEAR LIGHT, through the remap', () => {
  /*
   * **The remap is the load-bearing line, and this is the test of it that is not about a picture.**
   * Tile 7 of a five-by-three atlas is the third across on the second row; its centre in the
   * atlas's own coordinates has to land on it in the cell layout.
   *
   * **In linear light, because the atlas is sRGB.** The forward path uploads it with
   * `colorSpace: 'srgb'` and the sampler decodes; a decode program reads bytes, so the program
   * carries the curve itself or every block is washed out.
   */
  const built = atlasProgram(tiles(5, 3), 5 * TILE, 3 * TILE, TILE);
  const out = decodedAt(
    built,
    (2 * TILE + TILE / 2) / (5 * TILE),
    (1 * TILE + TILE / 2) / (3 * TILE),
  );
  const expected = tileColour(7);
  for (let c = 0; c < 3; c += 1) {
    expect(out[c]).toBeCloseTo(srgbToLinear((expected[c] as number) / 255), 6);
  }
  expect(out[3]).toBeCloseTo(1, 6);
});

test('A TILE’S EDGE READ AT A COARSE LEVEL IS STILL ITS OWN COLOUR, which is the seam', () => {
  /*
   * **What a bare atlas cannot do and the sand showed.** `buildBlockAtlas` insets each tile's UVs
   * by half a texel, which is exactly enough at level 0 and not at all at any level coarser: a
   * texel there is two, four, sixteen of level 0's, and a bilinear sample at a tile's edge reads
   * its neighbour. On the port every block of sand wore a grass-green line along each edge. A
   * gutter of the tile's own edge, half a tile deep, holds it to itself down to one texel a tile.
   */
  const built = atlasProgram(tiles(5, 3), 5 * TILE, 3 * TILE, TILE);
  const half = 0.5;
  /* Tile 7's four inset corners, as the mesher writes them, at every level to one texel a tile. */
  const u0 = (2 * TILE + half) / (5 * TILE);
  const u1 = (3 * TILE - half) / (5 * TILE);
  const v0 = (1 * TILE + half) / (3 * TILE);
  const v1 = (2 * TILE - half) / (3 * TILE);
  const expected = tileColour(7)
    .slice(0, 3)
    .map((byte) => srgbToLinear(byte / 255));
  for (const lod of [0, 1, 2, 3, 4]) {
    for (const [u, v] of [
      [u0, v0],
      [u1, v0],
      [u0, v1],
      [u1, v1],
    ] as const) {
      const out = decodedAt(built, u, v, lod);
      for (let c = 0; c < 3; c += 1) {
        expect(out[c], `level ${lod} at ${u.toFixed(4)}, ${v.toFixed(4)}`).toBeCloseTo(
          expected[c] as number,
          2,
        );
      }
    }
  }
});

test('AND IT CLAMPS AT THE EDGE RATHER THAN WRAPPING, since the far edge is another tile', () => {
  /* A repeating image wraps; an atlas that wrapped would blend its last column into its first at
     every coarser level. */
  const built = atlasProgram(tiles(4, 4), 4 * TILE, 4 * TILE, TILE);
  expect(built.program.graph.addressMode).toBe(ADDRESS_MODE.CENTRE_CLAMP);
});
