/**
 * Which block the player is pointing at, and where a new one would go.
 *
 * Amanatides and Woo grid traversal: step to whichever axis boundary is nearest and repeat, so
 * the walk visits every cell the ray actually passes through. A stepper that advanced by a fixed
 * distance instead would tunnel through the corner between two blocks, and the bug reads as
 * "sometimes the block under the crosshair does not break".
 *
 * The cell *before* the hit comes back too, because that is where a placed block goes. Returning
 * a face normal instead would leave every caller doing the same addition.
 */
import { Block, blockDef } from './blocks';
import type { BlockSource } from './world';

export interface RayHit {
  /** The solid block the ray struck. */
  bx: number;
  by: number;
  bz: number;
  /** The empty cell just before it, which is where a placed block lands. */
  px: number;
  py: number;
  pz: number;
}

/**
 * Whether a block stops the ray.
 *
 * Fluids do not: you reach through water to the bed below it, or an ocean could never be dug
 * and every click into one would break a single block of water.
 */
function selectable(id: number): boolean {
  if (id === Block.AIR) return false;
  const def = blockDef(id);
  return def !== undefined && !def.fluid;
}

export function raycastVoxel(
  blocks: BlockSource,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDist: number,
): RayHit | null {
  let x = Math.floor(ox);
  let y = Math.floor(oy);
  let z = Math.floor(oz);

  const stepX = dx > 0 ? 1 : -1;
  const stepY = dy > 0 ? 1 : -1;
  const stepZ = dz > 0 ? 1 : -1;

  /* How far along the ray one whole cell is, per axis. Infinite where the ray does not move on
     that axis at all, which is what keeps it out of the comparison below. */
  const invX = dx !== 0 ? 1 / Math.abs(dx) : Number.POSITIVE_INFINITY;
  const invY = dy !== 0 ? 1 / Math.abs(dy) : Number.POSITIVE_INFINITY;
  const invZ = dz !== 0 ? 1 / Math.abs(dz) : Number.POSITIVE_INFINITY;

  /* Distance to the first cell boundary on each axis. */
  let tMaxX = dx !== 0 ? (dx > 0 ? x + 1 - ox : ox - x) * invX : Number.POSITIVE_INFINITY;
  let tMaxY = dy !== 0 ? (dy > 0 ? y + 1 - oy : oy - y) * invY : Number.POSITIVE_INFINITY;
  let tMaxZ = dz !== 0 ? (dz > 0 ? z + 1 - oz : oz - z) * invZ : Number.POSITIVE_INFINITY;

  let px = x;
  let py = y;
  let pz = z;
  let t = 0;

  while (t <= maxDist) {
    if (selectable(blocks.getBlock(x, y, z))) return { bx: x, by: y, bz: z, px, py, pz };
    px = x;
    py = y;
    pz = z;
    if (tMaxX < tMaxY && tMaxX < tMaxZ) {
      x += stepX;
      t = tMaxX;
      tMaxX += invX;
    } else if (tMaxY < tMaxZ) {
      y += stepY;
      t = tMaxY;
      tMaxY += invY;
    } else {
      z += stepZ;
      t = tMaxZ;
      tMaxZ += invZ;
    }
  }
  return null;
}
