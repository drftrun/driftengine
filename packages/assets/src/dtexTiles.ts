/**
 * A `DTEX` chunk's tile table as the grid residency asks about.
 *
 * **Two constructors of one grid, and this is the one a streaming consumer uses.**
 * `latentTileGrid` cuts a grid from a latent it has in memory, which is what a baker has;
 * a consumer loading a file has the table instead, and the table is the point — it says where each
 * tile's bytes are and what the tile *is*, so `tilesForView` can name the tiles a camera needs and
 * a loader can fetch exactly those.
 *
 * **The hash is the file's**, over the tile's stored bytes, which is the number the file, the
 * fetch and the cache all have to agree on. `latentTileGrid`'s hashes are over *decoded* texels and
 * are a different number for the same tile — a baker's key rather than a file's. A consumer that
 * mixed them would fetch every tile it already had.
 *
 * **One level, because a `DTEX` carries one.** The chunk holds a single latent grid, so this hands
 * back a single level; a mip chain in the container is a further format step and not an omission
 * here.
 *
 * This lives in `@driftengine/assets` because it is the one package that sees both the container
 * and the texture runtime — `drft` has no dependencies by rule, and `texture` does not know what a
 * chunk is.
 */
import type { DtexMaterial } from '@driftengine/drft';
import type { MaterialTileGrid } from '@driftengine/texture';

/** The grid a chunk's table describes, or `null` where the material is one image and not streamed. */
export function tileGridFromDtex(material: DtexMaterial): MaterialTileGrid | null {
  const tiles = material.tileOffset.length;
  if (tiles === 0 || material.tileSize === 0) return null;

  const hashes = new Array<string>(tiles);
  for (let at = 0; at < tiles; at += 1) {
    const high = (material.tileHash[at * 2] as number) >>> 0;
    const low = (material.tileHash[at * 2 + 1] as number) >>> 0;
    hashes[at] = high.toString(16).padStart(8, '0') + low.toString(16).padStart(8, '0');
  }
  return {
    width: material.latentWidth,
    height: material.latentHeight,
    tileSize: material.tileSize,
    addressMode: material.addressMode,
    levels: [hashes],
  };
}

/**
 * The bytes of one tile, by where it is rather than by its number.
 *
 * The table is in the grid's order — across a row, then down — so this is an index and a
 * subarray. It is here rather than left to a caller because the order is a format rule, and a
 * caller working it out again is a second place for it to be wrong.
 */
export function dtexTileBytes(material: DtexMaterial, tx: number, ty: number): Uint8Array | null {
  if (material.tileSize === 0) return null;
  const across = Math.ceil(material.latentWidth / material.tileSize);
  const down = Math.ceil(material.latentHeight / material.tileSize);
  if (tx < 0 || ty < 0 || tx >= across || ty >= down) return null;
  const at = ty * across + tx;
  const from = material.tileOffset[at] as number;
  return material.latent.subarray(from, from + (material.tileLength[at] as number));
}
