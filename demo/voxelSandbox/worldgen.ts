/**
 * The terrain a seed produces, and nothing else.
 *
 * Pure and deterministic in `(seed, cx, cz)`, which is what makes two things true at once: the
 * save format can be a seed plus a handful of edits, and two neighbouring chunks generated at
 * different times still agree about the ground they share. Every height, biome, cave and tree is
 * read from **world** coordinates rather than chunk-local ones — a generator that read the local
 * x would look correct until two chunks met.
 *
 * Trees are stamped from a margin of columns outside the chunk, so a trunk rooted next door still
 * spills its canopy in across the border.
 */
import { Block } from './blocks';
import { blockIndex, CHUNK_SX, CHUNK_SZ, SEA_LEVEL, WORLD_H } from './constants';
import { fbm2, rand3, valueNoise3 } from './noise';

/** Leaf canopy radius, in blocks, and therefore how far outside the chunk to scan for trunks. */
const TREE_MARGIN = 2;

/**
 * The Y of the topmost solid ground in a world column.
 *
 * Three octave sets at falling scales: continents, hills, then detail. The continent term is
 * centred slightly below sea level so basins flood into oceans and lakes while landmasses still
 * stand well clear of the water.
 */
function heightAt(seed: number, wx: number, wz: number): number {
  const continent = fbm2(seed, wx / 220, wz / 220, 4);
  const hills = fbm2(seed + 7, wx / 70, wz / 70, 4);
  const detail = fbm2(seed + 19, wx / 24, wz / 24, 3);
  let h = SEA_LEVEL + (continent - 0.46) * 70 + (hills - 0.5) * 18 + (detail - 0.5) * 7;
  /* Flatten what is already low, so beaches and lake floors read as flat rather than as noise
     that happens to be underwater. */
  if (h < SEA_LEVEL) h = SEA_LEVEL - (SEA_LEVEL - h) * 0.7;
  return Math.max(2, Math.min(WORLD_H - 12, Math.floor(h)));
}

const enum Biome {
  OCEAN,
  BEACH,
  DESERT,
  PLAINS,
  FOREST,
  SNOW,
}

/** Climate, at a much lower frequency than the terrain and independent of its height. */
function temperature(seed: number, wx: number, wz: number): number {
  return fbm2(seed + 1300, wx / 360, wz / 360, 3);
}

function moisture(seed: number, wx: number, wz: number): number {
  return fbm2(seed + 2600, wx / 300, wz / 300, 3);
}

function biomeAt(seed: number, wx: number, wz: number, h: number): Biome {
  if (h <= SEA_LEVEL - 1) return Biome.OCEAN;
  if (h <= SEA_LEVEL + 1) return Biome.BEACH;
  /* High ground is snow-capped regardless of climate, which is the one place height overrules
     temperature rather than being independent of it. */
  if (h >= SEA_LEVEL + 38) return Biome.SNOW;
  const t = temperature(seed, wx, wz);
  const m = moisture(seed, wx, wz);
  if (t < 0.28) return Biome.SNOW;
  if (t > 0.55 && m < 0.42) return Biome.DESERT;
  if (m > 0.55) return Biome.FOREST;
  return Biome.PLAINS;
}

function surfaceBlock(biome: Biome): Block {
  switch (biome) {
    case Biome.SNOW:
      return Block.SNOW;
    case Biome.DESERT:
    case Biome.BEACH:
    case Biome.OCEAN:
      return Block.SAND;
    default:
      return Block.GRASS;
  }
}

/** Whether a cave has eaten this cell. Bounded in Y so caves never reach the floor or the sky. */
function carveCave(seed: number, wx: number, y: number, wz: number): boolean {
  if (y < 5 || y > SEA_LEVEL + 8) return false;
  return valueNoise3(seed + 101, wx / 18, y / 14, wz / 18) > 0.78;
}

/** What a stone cell turns out to be. Rarer ores sit deeper. */
function oreAt(seed: number, wx: number, y: number, wz: number): Block {
  const r = rand3(seed + 55, wx, y, wz);
  if (y < 14 && r > 0.992) return Block.DIAMOND_ORE;
  if (y < 22 && r > 0.99) return Block.GOLD_ORE;
  if (r > 0.978) return Block.IRON_ORE;
  if (r > 0.955) return Block.COAL_ORE;
  return Block.STONE;
}

/** Write a block if it lands inside this chunk, and silently drop it if it does not. */
function set(data: Uint8Array, x: number, y: number, z: number, id: Block): void {
  if (x < 0 || x >= CHUNK_SX || z < 0 || z >= CHUNK_SZ || y < 0 || y >= WORLD_H) return;
  data[blockIndex(x, y, z)] = id;
}

/** A tree rooted at world `(bx, baseY, bz)`, clipped to whatever part of it falls in this chunk. */
function stampTree(
  seed: number,
  data: Uint8Array,
  cx: number,
  cz: number,
  bx: number,
  baseY: number,
  bz: number,
): void {
  const trunkH = 4 + Math.floor(rand3(seed + 3, bx, 0, bz) * 3);
  const topY = baseY + trunkH;

  for (let dy = -2; dy <= 1; dy++) {
    const ly = topY + dy;
    const radius = dy >= 1 ? 1 : 2;
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        /* Trim the corners of the widest layers, so the canopy reads round rather than square. */
        if (dx * dx + dz * dz > radius * radius + 1) continue;
        const lx = bx + dx - cx * CHUNK_SX;
        const lz = bz + dz - cz * CHUNK_SZ;
        if (lx < 0 || lx >= CHUNK_SX || lz < 0 || lz >= CHUNK_SZ) continue;
        if (ly < 0 || ly >= WORLD_H) continue;
        const idx = blockIndex(lx, ly, lz);
        if (data[idx] === Block.AIR) data[idx] = Block.LEAVES;
      }
    }
  }

  /* After the canopy, so the trunk wins where they overlap. */
  for (let i = 0; i < trunkH; i++) {
    set(data, bx - cx * CHUNK_SX, baseY + i, bz - cz * CHUNK_SZ, Block.LOG);
  }
}

function stampCactus(
  seed: number,
  data: Uint8Array,
  cx: number,
  cz: number,
  bx: number,
  baseY: number,
  bz: number,
): void {
  const tall = 1 + Math.floor(rand3(seed + 9, bx, 1, bz) * 3);
  for (let i = 0; i < tall; i++) {
    set(data, bx - cx * CHUNK_SX, baseY + i, bz - cz * CHUNK_SZ, Block.CACTUS);
  }
}

export function generateChunk(seed: number, cx: number, cz: number, data: Uint8Array): void {
  data.fill(Block.AIR);
  const baseX = cx * CHUNK_SX;
  const baseZ = cz * CHUNK_SZ;

  for (let x = 0; x < CHUNK_SX; x++) {
    for (let z = 0; z < CHUNK_SZ; z++) {
      const wx = baseX + x;
      const wz = baseZ + z;
      const h = heightAt(seed, wx, wz);
      const surf = surfaceBlock(biomeAt(seed, wx, wz, h));

      for (let y = 0; y <= h; y++) {
        /* The floor is written before the cave test, so no cave can open a hole a player
           falls through. */
        if (y === 0) {
          data[blockIndex(x, y, z)] = Block.BEDROCK;
          continue;
        }
        if (carveCave(seed, wx, y, wz)) continue;
        let id: Block;
        if (y === h) {
          id = surf;
        } else if (y >= h - 3) {
          id = surf === Block.SAND ? Block.SAND : Block.DIRT;
        } else {
          id = oreAt(seed, wx, y, wz);
        }
        data[blockIndex(x, y, z)] = id;
      }

      /*
       * Water fills an ocean column from sea level straight down until it meets something
       * solid, which floods the seafloor *and* any cave mouth open beneath it — so there is
       * never an air pocket hanging directly under the sea.
       *
       * A land column takes none. A cave sealed under a solid roof stays air, and only floods
       * later if the player digs into it; that is the runtime water sim's job, not this one's.
       */
      if (h < SEA_LEVEL) {
        for (let y = SEA_LEVEL - 1; y >= 1; y--) {
          if (data[blockIndex(x, y, z)] !== Block.AIR) break;
          data[blockIndex(x, y, z)] = Block.WATER;
        }
      }
    }
  }

  /* Scanned with a margin so a trunk rooted in the next chunk still drops its leaves in here. */
  for (let x = -TREE_MARGIN; x < CHUNK_SX + TREE_MARGIN; x++) {
    for (let z = -TREE_MARGIN; z < CHUNK_SZ + TREE_MARGIN; z++) {
      const wx = baseX + x;
      const wz = baseZ + z;
      const h = heightAt(seed, wx, wz);
      if (h < SEA_LEVEL + 1) continue;
      /* Skip a column whose surface a cave ate: a trunk rooted on ground that is not there
         would hang over the cave mouth. `carveCave` is pure in world coordinates, so asking it
         here stays seam-safe without needing the neighbour's data. */
      if (carveCave(seed, wx, h, wz)) continue;

      const biome = biomeAt(seed, wx, wz, h);
      const r = rand3(seed + 777, wx, 5, wz);
      if (biome === Biome.FOREST && r > 0.985) {
        stampTree(seed, data, cx, cz, wx, h + 1, wz);
      } else if (biome === Biome.PLAINS && r > 0.995) {
        stampTree(seed, data, cx, cz, wx, h + 1, wz);
      } else if (biome === Biome.SNOW && r > 0.994) {
        stampTree(seed, data, cx, cz, wx, h + 1, wz);
      } else if (biome === Biome.DESERT && rand3(seed + 888, wx, 7, wz) > 0.99) {
        stampCactus(seed, data, cx, cz, wx, h + 1, wz);
      }
    }
  }
}
