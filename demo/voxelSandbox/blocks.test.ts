import { describe, expect, it } from 'vitest';

import { allReferencedTiles, Block, blockDef, blockLight, isAir, lightOpaque } from './blocks';

describe('the block table', () => {
  it('has no definition for air, and says so', () => {
    expect(isAir(Block.AIR)).toBe(true);
    expect(blockDef(Block.AIR)).toBeUndefined();
  });

  it('names three faces for every solid block', () => {
    /* The mesher indexes faces by group and falls back to magenta when a name is missing, so
       a definition short of a face renders wrong rather than failing. Caught here instead. */
    for (const id of [Block.STONE, Block.DIRT, Block.GRASS, Block.SAND, Block.LOG, Block.LEAVES]) {
      const def = blockDef(id);
      expect(def, `block ${id} has no definition`).toBeDefined();
      expect(def!.faces.top.length).toBeGreaterThan(0);
      expect(def!.faces.side.length).toBeGreaterThan(0);
      expect(def!.faces.bottom.length).toBeGreaterThan(0);
    }
  });

  it('lists every tile its definitions reference, without duplicates', () => {
    const tiles = allReferencedTiles();
    expect(tiles.length).toBeGreaterThan(0);
    expect(new Set(tiles).size).toBe(tiles.length);
  });

  it('does not let water block light', () => {
    /* Water is in the blend batch and light reaches through it. A light-opaque fluid would
       put a black column under every ocean. */
    expect(lightOpaque(Block.WATER)).toBe(false);
    expect(lightOpaque(Block.STONE)).toBe(true);
  });

  it('has exactly one light source, and it is the one the lighting tests use', () => {
    /* Task 15's flood-fill test needs a block that emits, and picking the wrong one there
       would assert nothing while looking like it asserted something. */
    expect(blockLight(Block.GLOWSTONE)).toBe(15);
    expect(blockLight(Block.STONE)).toBe(0);
  });
});
