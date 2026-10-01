/**
 * Blocks: the ground between the roads, each cell inset by half the width of every road around
 * it, cut by the diagonal avenue where it crosses, and some given over to open ground.
 *
 * **Open ground is drawn per block from its district's rows**: in table order, a kind whose
 * minimum the block's short side meets is taken with that kind's chance. Blocks are visited in a
 * shuffled order under a city-wide cap, `openGroundShare` of all block area, so the cap bites
 * evenly rather than on whichever sectors come last. Only whole rectangles are open ground; a
 * piece the diagonal cut stays a building plot.
 *
 * What gives: the reference's host draws with a generator this reader never sees, so which blocks
 * are parks is ours; how many, and how big, is its tables'.
 */
import type { Cell, Grid } from './grid.ts';
import { area, bounds, clip, isRect, rect } from './plane.ts';
import type { Bounds, Vec2 } from './plane.ts';
import type { RoadNetwork } from './roads.ts';
import type { CityTables, GroundKind } from './tables.ts';

export interface Block {
  readonly id: number;
  readonly district: string;
  readonly cell: Cell;
  readonly outline: readonly Vec2[];
  readonly bounds: Bounds;
  /** Still the whole inset rectangle: the diagonal did not cut it. */
  readonly rect: boolean;
  /** `building` until a stage claims it: a landmark, or an open-ground kind. */
  kind: string;
  ground: GroundKind | null;
}

/** A piece the diagonal leaves smaller than this is paving, not a block. */
const SMALLEST_PIECE = 60;

/** The pieces of `outline` either side of the band `width` wide along a–b. */
function cutByBand(outline: readonly Vec2[], a: Vec2, b: Vec2, width: number): Vec2[][] {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const length = Math.hypot(dx, dz);
  /* The band's two edges, as half-planes on the unit normal. */
  const nx = -dz / length;
  const nz = dx / length;
  const c = nx * a[0] + nz * a[1];
  return [clip(outline, nx, nz, c + width / 2), clip(outline, -nx, -nz, -(c - width / 2))].filter(
    (piece) => piece.length >= 3 && Math.abs(area(piece)) >= SMALLEST_PIECE,
  );
}

export function buildBlocks(grid: Grid, roads: RoadNetwork): Block[] {
  const [a, b] = roads.diagonal.points;
  const blocks: Block[] = [];
  for (const cell of grid.cells) {
    const half = (vertical: boolean, at: number, from: number, to: number): number =>
      roads.width(vertical, at, from, to) / 2;
    const x0 = cell.x0 + half(true, cell.x0, cell.z0, cell.z1);
    const x1 = cell.x1 - half(true, cell.x1, cell.z0, cell.z1);
    const z0 = cell.z0 + half(false, cell.z0, cell.x0, cell.x1);
    const z1 = cell.z1 - half(false, cell.z1, cell.x0, cell.x1);
    if (x1 <= x0 || z1 <= z0) continue;
    let pieces: Vec2[][] = [rect(x0, z0, x1, z1)];
    if (a !== undefined && b !== undefined) {
      const from: Vec2 = [a[0], a[2]];
      const to: Vec2 = [b[0], b[2]];
      const cut = cutByBand(pieces[0] as Vec2[], from, to, roads.diagonal.cls.width);
      const crossed = cut.length !== 1 || !isRect(cut[0] as Vec2[]);
      /* Only where the band actually runs past this block: its ends are at avenue junctions. */
      const lo = Math.min(from[0], to[0]);
      const hi = Math.max(from[0], to[0]);
      if (crossed && x1 > lo && x0 < hi) pieces = cut;
    }
    for (const outline of pieces) {
      blocks.push({
        id: blocks.length,
        district: cell.district,
        cell,
        outline,
        bounds: bounds(outline),
        rect: isRect(outline),
        kind: 'building',
        ground: null,
      });
    }
  }
  return blocks;
}

/** Gives open ground to blocks by their districts' chances, under the city-wide share. */
export function assignGround(
  blocks: readonly Block[],
  tables: CityTables,
  random: () => number,
): void {
  const total = blocks.reduce((sum, block) => sum + Math.abs(area(block.outline)), 0);
  const cap = tables.value('openGroundShare') * total;
  const order = blocks.map((block) => block.id);
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j] as number, order[i] as number];
  }
  let open = 0;
  for (const id of order) {
    const block = blocks[id] as Block;
    if (block.kind !== 'building' || !block.rect) continue;
    const side = Math.min(block.bounds.x1 - block.bounds.x0, block.bounds.z1 - block.bounds.z0);
    const blockArea = Math.abs(area(block.outline));
    for (const kind of tables.grounds) {
      if (kind.district !== block.district || side < kind.minSize) continue;
      if (random() >= kind.chance) continue;
      if (open + blockArea > cap) break;
      block.kind = kind.kind;
      block.ground = kind;
      open += blockArea;
      break;
    }
  }
}
