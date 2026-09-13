/**
 * The world's fixed dimensions, and the two index functions everything else agrees on.
 *
 * Dependency-free so worldgen and the chunk store can both import it without a cycle.
 */

export const CHUNK_SX = 16;
export const CHUNK_SZ = 16;
export const WORLD_H = 96;

/** Sea level. Water fills up to, but not including, this Y. */
export const SEA_LEVEL = 30;

/** Flat index into a chunk's block array. */
export function blockIndex(x: number, y: number, z: number): number {
  return (y * CHUNK_SZ + z) * CHUNK_SX + x;
}

export function chunkKey(cx: number, cz: number): string {
  return `${cx},${cz}`;
}
