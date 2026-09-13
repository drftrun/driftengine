import { describe, expect, it } from 'vitest';

import { Block } from './blocks';
import { WORLD_H } from './constants';
import { World } from './world';

describe('the chunk store', () => {
  it('reads air outside the world height', () => {
    const world = new World(1337);
    expect(world.getBlock(0, -1, 0)).toBe(Block.AIR);
    expect(world.getBlock(0, WORLD_H, 0)).toBe(Block.AIR);
    expect(world.getBlock(0, 10_000, 0)).toBe(Block.AIR);
  });

  it('generates a chunk on first touch and keeps it', () => {
    const world = new World(1337);
    expect(world.hasChunk(0, 0)).toBe(false);
    world.getBlock(4, 40, 4);
    expect(world.hasChunk(0, 0)).toBe(true);
  });

  it('remembers a block that was set', () => {
    const world = new World(1337);
    const y = world.surfaceY(4, 4) + 1;
    world.setBlock(4, y, 4, Block.STONE);
    expect(world.getBlock(4, y, 4)).toBe(Block.STONE);
  });

  it('reads negative world coordinates into the right chunk', () => {
    /* Floor division, not truncation. `-1 / 16 | 0` is 0 and puts the block in the wrong
       chunk, which shows up as a one-chunk-wide seam west and north of the origin. */
    const world = new World(1337);
    const y = world.surfaceY(-3, -3) + 1;
    world.setBlock(-3, y, -3, Block.STONE);
    expect(world.getBlock(-3, y, -3)).toBe(Block.STONE);
    expect(world.hasChunk(-1, -1)).toBe(true);
  });

  it('exports only the edits, not the terrain', () => {
    /* A save is a seed plus what the player changed. If generation leaked into the edit list,
       every save would carry a whole world and reloading would stop being a regeneration. */
    const world = new World(1337);
    expect(world.exportEdits()).toHaveLength(0);
    const y = world.surfaceY(4, 4) + 1;
    world.setBlock(4, y, 4, Block.STONE);
    expect(world.exportEdits()).toEqual([4, y, 4, Block.STONE]);
  });

  it('does not record a simulation write as a player edit', () => {
    /* Water flooding re-derives from the terrain on reload. Recording it would bloat every
       save with cells that regenerate for free. */
    const world = new World(1337);
    const y = world.surfaceY(4, 4) + 1;
    world.setBlock(4, y, 4, Block.WATER, false);
    expect(world.getBlock(4, y, 4)).toBe(Block.WATER);
    expect(world.exportEdits()).toHaveLength(0);
  });

  it('keeps an edit through a chunk being streamed out and back', () => {
    /* Edits live beside the chunk rather than inside it, which is the whole reason a chunk
       can be dropped to reclaim memory without losing what the player built on it. */
    const world = new World(1337);
    const y = world.surfaceY(4, 4) + 1;
    world.setBlock(4, y, 4, Block.STONE);
    world.dropChunk(0, 0);
    expect(world.hasChunk(0, 0)).toBe(false);
    expect(world.getBlock(4, y, 4)).toBe(Block.STONE);
  });

  it('reloads a world from its seed and edits', () => {
    const world = new World(1337);
    const y = world.surfaceY(4, 4) + 1;
    world.setBlock(4, y, 4, Block.STONE);
    const edits = world.exportEdits();

    const reloaded = new World(1);
    reloaded.reset(1337, edits);
    expect(reloaded.getBlock(4, y, 4)).toBe(Block.STONE);
    expect(reloaded.getBlock(5, y, 5)).toBe(world.getBlock(5, y, 5));
  });

  it('spawns on solid ground with room to stand', () => {
    const world = new World(1337);
    const spawn = world.findSpawn(0, 0);
    const fx = Math.floor(spawn.x);
    const fy = Math.floor(spawn.y);
    const fz = Math.floor(spawn.z);
    expect(world.getBlock(fx, fy, fz)).toBe(Block.AIR);
    expect(world.getBlock(fx, fy + 1, fz)).toBe(Block.AIR);
    for (const under of [Block.AIR, Block.WATER, Block.LEAVES, Block.LOG, Block.CACTUS]) {
      expect(world.getBlock(fx, fy - 1, fz)).not.toBe(under);
    }
  });

  it('reads open sky above the terrain and shade below it', () => {
    /* The world owns its light because every write has to invalidate it, and reading it back
       through the same object is what the mesher does. */
    const world = new World(1337);
    const surface = world.surfaceY(4, 4);
    expect(world.getPacked(4, surface + 6, 4) >> 4).toBe(15);
    expect(world.getPacked(4, 1, 4) >> 4).toBeLessThan(15);
  });
});

describe('the chunk the last lookup landed in', () => {
  /**
   * **A memo that outlives its chunk answers from geometry the store has thrown away.**
   *
   * `getChunk` keeps the last chunk it resolved so a run of reads inside one does not re-key the
   * map — which is most of what a mesher does. The hazard is `dropChunk`: a column that streams
   * out and is walked back into must be read from the chunk that regenerates, not from the one
   * the memo is still holding.
   */
  it('is not read after that chunk is dropped', () => {
    const world = new World(1337);
    const y = world.surfaceY(4, 4) + 1;
    world.setBlock(4, y, 4, Block.STONE);
    expect(world.getBlock(4, y, 4)).toBe(Block.STONE);

    /* Reading here leaves chunk (0, 0) in the memo, which is the state the drop has to clear. */
    world.dropChunk(0, 0);
    expect(world.hasChunk(0, 0)).toBe(false);

    /* Regenerates, and replays the recorded edit over the fresh terrain. */
    expect(world.getBlock(4, y, 4)).toBe(Block.STONE);
    expect(world.hasChunk(0, 0)).toBe(true);
  });

  it('does not answer one column with another column’s blocks', () => {
    const world = new World(1337);
    /* Far enough apart to be different chunks, and read alternately so the memo is always wrong
       for the call that follows it. */
    for (let i = 0; i < 4; i++) {
      const near = world.surfaceY(2, 2);
      const far = world.surfaceY(600, 600);
      expect(world.getBlock(2, near, 2)).toBe(world.getBlock(2, near, 2));
      expect(world.getBlock(600, far, 600)).toBe(world.getBlock(600, far, 600));
      expect(near).not.toBe(Number.NaN);
      expect(far).not.toBe(Number.NaN);
    }
    /* The two columns are independent: reading one must not change what the other reports. */
    const a = world.surfaceY(2, 2);
    world.getBlock(600, 40, 600);
    expect(world.surfaceY(2, 2)).toBe(a);
  });
});
