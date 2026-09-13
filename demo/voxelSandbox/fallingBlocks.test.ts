import { describe, expect, it } from 'vitest';

import { Block } from './blocks';
import { WORLD_H } from './constants';
import { FallingBlocks } from './fallingBlocks';
import { World } from './world';

/** Everything `FallingBlocks` touches on the renderer, none of which these tests are about. */
const renderer = {
  createMesh: () => ({}),
  createScatter: () => ({}),
  disposeScatter: () => {},
  disposeMesh: () => {},
  setMaterial: () => {},
  drawMesh: () => {},
  drawScatter: () => {},
  updateScatter: () => {},
} as never;

/** A chunk renderer that records the remesh it was asked for and does nothing else. */
const chunks = { remeshEdit: () => {} } as never;

const atlas = {
  texture: null,
  rects: new Map(),
  fallback: { u0: 0, v0: 0, u1: 1, v1: 1 },
} as never;

/** A column of sand standing on stone, with the world around it already generated. */
function sandTower(world: World, x: number, z: number, height: number): number {
  const ground = world.surfaceY(x, z);
  /* Clear anything the generator left above the ground, so the tower is the only thing there. */
  for (let y = ground + 1; y < Math.min(WORLD_H, ground + height + 4); y++) {
    world.setBlock(x, y, z, Block.AIR, false);
  }
  for (let i = 0; i < height; i++) world.setBlock(x, ground + 1 + i, z, Block.SAND, false);
  return ground + 1;
}

describe('a column of sand', () => {
  /**
   * **Breaking the bottom of a stack drops the whole stack, not just one block.**
   *
   * `considerColumn` takes an unsupported block out of the grid and turns it into an entity.
   * Whatever was resting on that cell has just lost its support, and nothing was asking about
   * it — so breaking the base of a tower dropped exactly one block and left the rest standing in
   * the air, which is what a real session reported as "the cube on top is not falling".
   */
  it('leaves the grid all at once, so the whole column falls together', () => {
    const world = new World(1337);
    const [x, z] = [4, 4];
    const base = sandTower(world, x, z, 3);

    /* Break the block the tower stands on, exactly as `onBreak` is called in play. */
    world.setBlock(x, base - 1, z, Block.AIR, false);
    const falling = new FallingBlocks(renderer, world, chunks, atlas);
    falling.onBreak(x, base - 1, z);

    /*
     * Every cell of the tower is empty *now*, before a single step has run: each block became a
     * falling entity the moment the one under it did.
     *
     * `land()` already reconsiders the cell above whatever just settled, so the column does come
     * down eventually — one block per landing, each waiting for the one below to hit the ground.
     * That is the symptom reported from a real session as the cube on top not falling: it does
     * fall, several beats later, hanging unsupported in the meantime.
     */
    const stillStanding = [0, 1, 2]
      .map((i) => ({ y: base + i, id: world.getBlock(x, base + i, z) }))
      .filter((cell) => cell.id !== Block.AIR)
      .map((cell) => `y=${cell.y}`);

    expect(stillStanding, 'these cells are unsupported and still in the grid').toEqual([]);
  });
});
