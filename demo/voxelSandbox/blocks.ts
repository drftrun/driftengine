/**
 * Every block this world has, and the properties that decide how each one is drawn and treated.
 *
 * Tile names are the Kenney Voxel Pack's own filenames, which is why `atlas.ts` can fetch
 * `<name>.png` without a translation table. The flags are deliberately independent — culling,
 * ambient occlusion, collision and render mode are four different questions, and a block like
 * glass answers them differently from a block like water.
 */
import type { Vec3 } from '../../packages/core/src/index';

export const enum Block {
  AIR = 0,
  STONE = 1,
  DIRT = 2,
  GRASS = 3,
  SAND = 4,
  SNOW = 5,
  WATER = 6,
  LOG = 7,
  LEAVES = 8,
  PLANKS = 9,
  GLASS = 10,
  BRICK = 11,
  COAL_ORE = 12,
  IRON_ORE = 13,
  GOLD_ORE = 14,
  DIAMOND_ORE = 15,
  GRAVEL = 16,
  ICE = 17,
  CACTUS = 18,
  BEDROCK = 19,
  WOOL_RED = 20,
  WOOL_GREEN = 21,
  WOOL_BLUE = 22,
  GLOWSTONE = 23,
}

export type RenderMode = 'opaque' | 'cutout' | 'blend';

export interface BlockDef {
  id: Block;
  name: string;
  /** Tile names for the three face groups. `side` covers all four lateral faces. */
  faces: { top: string; side: string; bottom: string };
  renderMode: RenderMode;
  /** Fully hides a touching neighbour's face, and is itself hidden by an opaque neighbour. */
  hidesNeighborFaces: boolean;
  /** Contributes to the ambient-occlusion darkening of adjacent geometry. */
  castsAO: boolean;
  /** Blocks player movement. */
  collidable: boolean;
  /** A liquid: translucent, non-collidable, and swum through rather than walked on. */
  fluid: boolean;
  /** Foliage that sways. */
  sway: boolean;
  /** Falls when nothing is underneath it. Sand and gravel. */
  falls: boolean;
  /** Light emitted, 0 to 15. Zero is not a light source. */
  light: number;
  /** Cannot be broken or replaced. The world's floor is made of it. */
  indestructible: boolean;
}

/**
 * One definition, with the defaults an ordinary opaque block wants.
 *
 * `all` sets every face at once, which is what most blocks need; `top`, `side` and `bottom`
 * override it individually for the few that are layered.
 */
function def(
  id: Block,
  name: string,
  faces: Partial<BlockDef['faces']> & { all?: string },
  opts: Partial<BlockDef> = {},
): BlockDef {
  const all = faces.all ?? 'stone';
  return {
    id,
    name,
    faces: { top: faces.top ?? all, side: faces.side ?? all, bottom: faces.bottom ?? all },
    renderMode: opts.renderMode ?? 'opaque',
    hidesNeighborFaces: opts.hidesNeighborFaces ?? true,
    castsAO: opts.castsAO ?? true,
    collidable: opts.collidable ?? true,
    fluid: opts.fluid ?? false,
    sway: opts.sway ?? false,
    falls: opts.falls ?? false,
    light: opts.light ?? 0,
    indestructible: opts.indestructible ?? false,
  };
}

const DEFS: Record<number, BlockDef> = {
  [Block.STONE]: def(Block.STONE, 'Stone', { all: 'stone' }),
  [Block.DIRT]: def(Block.DIRT, 'Dirt', { all: 'dirt' }),
  [Block.GRASS]: def(Block.GRASS, 'Grass', {
    top: 'grass_top',
    side: 'dirt_grass',
    bottom: 'dirt',
  }),
  [Block.SAND]: def(Block.SAND, 'Sand', { all: 'sand' }, { falls: true }),
  [Block.SNOW]: def(Block.SNOW, 'Snow', { top: 'snow', side: 'dirt_snow', bottom: 'dirt' }),
  [Block.WATER]: def(
    Block.WATER,
    'Water',
    { all: 'water' },
    {
      renderMode: 'blend',
      hidesNeighborFaces: false,
      castsAO: false,
      collidable: false,
      fluid: true,
    },
  ),
  [Block.LOG]: def(Block.LOG, 'Wood Log', {
    top: 'trunk_top',
    side: 'trunk_side',
    bottom: 'trunk_top',
  }),
  [Block.LEAVES]: def(
    Block.LEAVES,
    'Leaves',
    { all: 'leaves_transparent' },
    { renderMode: 'cutout', hidesNeighborFaces: false, castsAO: false, sway: true },
  ),
  [Block.PLANKS]: def(Block.PLANKS, 'Planks', { all: 'wood' }),
  [Block.GLASS]: def(
    Block.GLASS,
    'Glass',
    { all: 'glass' },
    { renderMode: 'blend', hidesNeighborFaces: false, castsAO: false },
  ),
  [Block.BRICK]: def(Block.BRICK, 'Brick', { all: 'brick_red' }),
  [Block.COAL_ORE]: def(Block.COAL_ORE, 'Coal Ore', { all: 'stone_coal' }),
  [Block.IRON_ORE]: def(Block.IRON_ORE, 'Iron Ore', { all: 'stone_iron' }),
  [Block.GOLD_ORE]: def(Block.GOLD_ORE, 'Gold Ore', { all: 'stone_gold' }),
  [Block.DIAMOND_ORE]: def(Block.DIAMOND_ORE, 'Diamond Ore', { all: 'stone_diamond' }),
  [Block.GRAVEL]: def(Block.GRAVEL, 'Gravel', { all: 'gravel_stone' }, { falls: true }),
  [Block.ICE]: def(
    Block.ICE,
    'Ice',
    { all: 'ice' },
    { renderMode: 'blend', hidesNeighborFaces: false, castsAO: false },
  ),
  [Block.CACTUS]: def(
    Block.CACTUS,
    'Cactus',
    { top: 'cactus_top', side: 'cactus_side', bottom: 'cactus_top' },
    { renderMode: 'cutout', hidesNeighborFaces: false },
  ),
  [Block.BEDROCK]: def(Block.BEDROCK, 'Bedrock', { all: 'greystone' }, { indestructible: true }),
  [Block.WOOL_RED]: def(Block.WOOL_RED, 'Red Wool', { all: 'cotton_red' }),
  [Block.WOOL_GREEN]: def(Block.WOOL_GREEN, 'Green Wool', { all: 'cotton_green' }),
  [Block.WOOL_BLUE]: def(Block.WOOL_BLUE, 'Blue Wool', { all: 'cotton_blue' }),
  [Block.GLOWSTONE]: def(Block.GLOWSTONE, 'Glowstone', { all: 'lava' }, { light: 15 }),
};

export function blockDef(id: number): BlockDef | undefined {
  return DEFS[id];
}

/** A representative average colour per block, used to tint break debris. */
const BLOCK_COLORS: Record<number, Vec3> = {
  [Block.STONE]: [0.5, 0.5, 0.5],
  [Block.DIRT]: [0.45, 0.32, 0.2],
  [Block.GRASS]: [0.35, 0.6, 0.25],
  [Block.SAND]: [0.85, 0.78, 0.5],
  [Block.SNOW]: [0.92, 0.95, 0.98],
  [Block.WATER]: [0.25, 0.45, 0.85],
  [Block.LOG]: [0.45, 0.33, 0.2],
  [Block.LEAVES]: [0.25, 0.5, 0.2],
  [Block.PLANKS]: [0.7, 0.55, 0.35],
  [Block.GLASS]: [0.7, 0.85, 0.9],
  [Block.BRICK]: [0.7, 0.3, 0.25],
  [Block.COAL_ORE]: [0.3, 0.3, 0.3],
  [Block.IRON_ORE]: [0.7, 0.6, 0.5],
  [Block.GOLD_ORE]: [0.85, 0.75, 0.35],
  [Block.DIAMOND_ORE]: [0.5, 0.8, 0.85],
  [Block.GRAVEL]: [0.5, 0.48, 0.46],
  [Block.ICE]: [0.7, 0.85, 0.95],
  [Block.CACTUS]: [0.3, 0.5, 0.25],
  [Block.BEDROCK]: [0.25, 0.25, 0.25],
  [Block.WOOL_RED]: [0.8, 0.2, 0.2],
  [Block.WOOL_GREEN]: [0.3, 0.7, 0.3],
  [Block.WOOL_BLUE]: [0.25, 0.4, 0.8],
  [Block.GLOWSTONE]: [1.0, 0.78, 0.4],
};

/** A block's representative colour, for tinting the debris it throws when broken. */
export function blockColor(id: number): Vec3 {
  return BLOCK_COLORS[id] ?? [0.6, 0.6, 0.6];
}

export function isAir(id: number): boolean {
  return id === Block.AIR;
}

/** Whether a block refuses to be broken or replaced. */
export function isIndestructible(id: number): boolean {
  return DEFS[id]?.indestructible === true;
}

/** Light emitted by a block, 0 to 15. Air and ordinary blocks emit none. */
export function blockLight(id: number): number {
  return DEFS[id]?.light ?? 0;
}

/**
 * Whether a block stops light entirely.
 *
 * Tied to `hidesNeighborFaces` rather than to a flag of its own, because the two questions have
 * the same answer: a block you cannot see past is a block light cannot get past. Water, glass,
 * leaves, ice and cactus all let it through.
 */
export function lightOpaque(id: number): boolean {
  return DEFS[id]?.hidesNeighborFaces === true;
}

/** Every tile name any block references, which is exactly what the atlas has to load. */
export function allReferencedTiles(): string[] {
  const set = new Set<string>();
  for (const key of Object.keys(DEFS)) {
    const d = DEFS[Number(key)];
    if (d === undefined) continue;
    set.add(d.faces.top);
    set.add(d.faces.side);
    set.add(d.faces.bottom);
  }
  return [...set];
}

/** The blocks the creative hotbar offers, in slot order. */
export const HOTBAR: readonly Block[] = [
  Block.GRASS,
  Block.DIRT,
  Block.STONE,
  Block.SAND,
  Block.LOG,
  Block.PLANKS,
  Block.LEAVES,
  Block.GLASS,
  Block.BRICK,
  Block.GLOWSTONE,
];
