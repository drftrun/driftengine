import { buildDtex, readDtex, type DtexMaterial } from '@driftengine/drft';
import { hashTile } from '@driftengine/texture';
import { expect, test } from 'vitest';

import { cutLatentTiles } from './bake/dtexChunk.ts';
import { dtexTileBytes, tileGridFromDtex } from './dtexTiles.ts';

/**
 * **A material in a file can be streamed tile by tile.**
 *
 * What that needs is not one thing: the table has to be the grid so a tile can be found by where it
 * is, the payload has to hold each tile's bytes together so a fetch is a range, and the hash has to
 * be the one the cache is keyed by. The test that matters is the round trip through the container,
 * because the table is only useful to somebody who has the file rather than the latent.
 */

/** An 8 by 8 latent of two components, cut into four tiles, as a chunk and back. */
function tiled(): DtexMaterial {
  const latent = Uint8Array.from({ length: 8 * 8 * 2 }, (_, at) => (at * 37) & 0xff);
  const cut = cutLatentTiles(latent, 8, 8, 2, 4);
  const material: DtexMaterial = {
    latentWidth: 8,
    latentHeight: 8,
    latentComponents: 2,
    channels: Uint32Array.from([(1 << 4) | 0]),
    nodes: Uint32Array.from([0, 0, 0, 0]),
    resultRegister: 0,
    addressMode: 0,
    networkInputs: 2,
    networkOutputs: 2,
    hidden: new Uint32Array(0),
    weights: Float32Array.from([0.5, 0.25]),
    tileOffset: cut.offset,
    tileLength: cut.length,
    tileHash: cut.hash,
    tileSize: 4,
    latent: cut.payload,
  };
  const bytes = buildDtex({ material: 0, texture: material });
  return readDtex(bytes.buffer as ArrayBuffer, 0, bytes.length).texture;
}

test('A FILE’S TILE TABLE IS THE GRID RESIDENCY ASKS ABOUT', () => {
  const material = tiled();
  const grid = tileGridFromDtex(material);
  expect(grid).not.toBeNull();
  if (grid === null) return;

  expect(grid.width).toBe(8);
  expect(grid.height).toBe(8);
  expect(grid.tileSize).toBe(4);
  expect(grid.levels.length).toBe(1);
  expect(grid.levels[0]?.length).toBe(4);

  /*
   * **The hash is the file's own, over the bytes a fetch would return.** That is the whole of what
   * makes a tile that arrived for one material already resident for another: the file, the range
   * request and the cache key are one number.
   */
  const first = dtexTileBytes(material, 0, 0);
  expect(first).not.toBeNull();
  expect(grid.levels[0]?.[0]).toBe(hashTile(first as Uint8Array));

  /* And a tile is found by where it is: the second row's first tile, not the second entry. */
  const below = dtexTileBytes(material, 0, 1);
  expect(below).not.toBeNull();
  expect(grid.levels[0]?.[2]).toBe(hashTile(below as Uint8Array));
  expect(dtexTileBytes(material, 2, 0)).toBeNull();
});

test('a material that is one image has no grid rather than a grid of one', () => {
  /*
   * **`null`, not a grid with a single tile in it.** They are different facts — *this material
   * streams* and *this material is one image* — and a consumer that could not tell them apart
   * would ask a residency cache for a tile the file never described.
   */
  const material = tiled();
  expect(tileGridFromDtex({ ...material, tileSize: 0 })).toBeNull();
  expect(tileGridFromDtex({ ...material, tileOffset: new Uint32Array(0), tileSize: 4 })).toBeNull();
});
