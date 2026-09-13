import { describe, expect, it } from 'vitest';

import { Block } from './blocks';
import { raycastVoxel } from './raycast';
import type { BlockSource } from './world';

class Grid implements BlockSource {
  private readonly cells = new Map<string, Block>();

  put(x: number, y: number, z: number, id: Block): this {
    this.cells.set(`${x},${y},${z}`, id);
    return this;
  }

  getBlock(x: number, y: number, z: number): Block {
    return this.cells.get(`${x},${y},${z}`) ?? Block.AIR;
  }
}

describe('a ray through the voxel grid', () => {
  it('hits the first solid block along its direction', () => {
    const hit = raycastVoxel(new Grid().put(0, 0, 5, Block.STONE), 0.5, 0.5, 0.5, 0, 0, 1, 10);
    expect(hit).not.toBeNull();
    expect([hit!.bx, hit!.by, hit!.bz]).toEqual([0, 0, 5]);
  });

  it('reports the empty cell in front of the face it entered', () => {
    /* Placement goes here. A wrong cell puts the new block inside the one just clicked, or a
       block further away than the one you aimed at. */
    const hit = raycastVoxel(new Grid().put(0, 0, 5, Block.STONE), 0.5, 0.5, 0.5, 0, 0, 1, 10);
    expect([hit!.px, hit!.py, hit!.pz]).toEqual([0, 0, 4]);
  });

  it('stops at the nearer of two blocks', () => {
    const grid = new Grid().put(0, 0, 3, Block.STONE).put(0, 0, 6, Block.STONE);
    expect(raycastVoxel(grid, 0.5, 0.5, 0.5, 0, 0, 1, 10)!.bz).toBe(3);
  });

  it('reaches through water to the bed below it', () => {
    /* Selecting a fluid would mean you could never dig a seabed, and every click into an ocean
       would break one block of water and stop. */
    const grid = new Grid().put(0, 0, 3, Block.WATER).put(0, 0, 5, Block.STONE);
    expect(raycastVoxel(grid, 0.5, 0.5, 0.5, 0, 0, 1, 10)!.bz).toBe(5);
  });

  it('walks a diagonal without skipping a cell', () => {
    /* The failure mode of a naive stepper: a ray between two axes tunnels through the corner
       of a block instead of hitting it. */
    const grid = new Grid().put(3, 0, 3, Block.STONE);
    const d = 1 / Math.SQRT2;
    expect(raycastVoxel(grid, 0.5, 0.5, 0.5, d, 0, d, 12)).not.toBeNull();
  });

  it('gives up at maxDist rather than walking the world', () => {
    expect(raycastVoxel(new Grid(), 0.5, 0.5, 0.5, 0, 1, 0, 4)).toBeNull();
  });
});
