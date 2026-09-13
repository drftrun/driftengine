import { describe, expect, it } from 'vitest';

import { Block } from './blocks';
import type { ChunkRenderer } from './chunkRenderer';
import { SEA_LEVEL } from './constants';
import { WaterSim } from './waterSim';
import { World } from './world';

/* The sim only tells the renderer which chunks to rebuild, so a recorder stands in for one and
   keeps this test in the node environment. */
const recorder = (): ChunkRenderer & { touched: string[] } => {
  const touched: string[] = [];
  return {
    touched,
    remeshIfActive: (cx: number, cz: number) => touched.push(`${cx},${cz}`),
  } as unknown as ChunkRenderer & { touched: string[] };
};

/** A world with its spawn region loaded, so the sim's loaded-chunk guard lets work through. */
const loaded = (): World => {
  const world = new World(1337);
  for (let cz = -1; cz <= 1; cz++) for (let cx = -1; cx <= 1; cx++) world.getChunk(cx, cz);
  return world;
};

describe('water', () => {
  it('pours sideways into a hole opened below sea level', () => {
    /* Built rather than found: the spawn at seed 1337 is inland, and a test that hunted for a
       sea would be asserting about the terrain instead of about the flow. */
    const world = loaded();
    const y = SEA_LEVEL - 4;
    world.setBlock(4, y, 4, Block.WATER);
    world.setBlock(5, y, 4, Block.AIR);
    world.setBlock(5, y - 1, 4, Block.STONE);

    const water = new WaterSim(world, recorder());
    water.onBreak(5, y, 4);
    for (let i = 0; i < 20; i++) water.update(WATER_TICK);
    expect(world.getBlock(5, y, 4)).toBe(Block.WATER);
  });

  it('spreads one ring per step, not all at once', () => {
    /* The two-phase generation is what makes this true: a cell filled early in a step must not
       feed its sibling in the same step, or a flood arrives instantly instead of pouring. */
    const world = loaded();
    const y = SEA_LEVEL - 4;
    world.setBlock(4, y, 4, Block.WATER);
    for (let d = 1; d <= 4; d++) {
      world.setBlock(4 + d, y, 4, Block.AIR);
      world.setBlock(4 + d, y - 1, 4, Block.STONE);
    }

    const water = new WaterSim(world, recorder());
    water.onPlace(4, y, 4);
    water.update(WATER_TICK);
    expect(world.getBlock(5, y, 4)).toBe(Block.WATER);
    expect(world.getBlock(6, y, 4)).toBe(Block.AIR);
    water.update(WATER_TICK);
    expect(world.getBlock(6, y, 4)).toBe(Block.WATER);
  });

  it('does not spread sideways above sea level', () => {
    /* Sideways flow is a sub-sea rule. Without it, one broken block on a hilltop turns into a
       puddle spreading across the entire surface. */
    const world = loaded();
    const y = SEA_LEVEL + 6;
    world.setBlock(4, y, 4, Block.WATER);
    world.setBlock(5, y, 4, Block.AIR);
    /* Solid underneath, so it cannot simply fall away. */
    world.setBlock(5, y - 1, 4, Block.STONE);
    const water = new WaterSim(world, recorder());
    water.onPlace(4, y, 4);
    for (let i = 0; i < 20; i++) water.update(WATER_TICK);
    expect(world.getBlock(5, y, 4)).toBe(Block.AIR);
  });

  it('falls straight down at any height', () => {
    const world = loaded();
    const y = SEA_LEVEL + 8;
    world.setBlock(6, y, 6, Block.WATER);
    world.setBlock(6, y - 1, 6, Block.AIR);
    const water = new WaterSim(world, recorder());
    water.onPlace(6, y, 6);
    for (let i = 0; i < 20; i++) water.update(WATER_TICK);
    expect(world.getBlock(6, y - 1, 6)).toBe(Block.WATER);
  });

  it('stops doing work once it has settled', () => {
    const world = loaded();
    const chunks = recorder();
    const water = new WaterSim(world, chunks);
    water.settleChunk(0, 0);
    for (let i = 0; i < 40; i++) water.update(WATER_TICK);
    const settled = chunks.touched.length;
    for (let i = 0; i < 20; i++) water.update(WATER_TICK);
    expect(chunks.touched.length).toBe(settled);
  });

  it('does not record its own fills as player edits', () => {
    /* A flood re-derives from the terrain on reload. Recording it would put thousands of
       regenerable cells into every save. */
    const world = loaded();
    const before = world.exportEdits().length;
    const water = new WaterSim(world, recorder());
    water.settleChunk(0, 0);
    water.settleChunk(1, 0);
    expect(world.exportEdits().length).toBe(before);
  });

  it('never pulls in a chunk that is not loaded', () => {
    /* A long undersea cavern would otherwise stream and mutate chunks far past the render
       radius, one cell at a time. */
    const world = new World(1337);
    world.getChunk(0, 0);
    const water = new WaterSim(world, recorder());
    water.settleChunk(0, 0);
    for (let i = 0; i < 40; i++) water.update(WATER_TICK);
    expect(world.hasChunk(6, 6)).toBe(false);
  });
});

/** One flow step, so a test advances rings rather than wall-clock seconds. */
const WATER_TICK = 0.2;
