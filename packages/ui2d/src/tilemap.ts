/** A grid of sheet frames, drawn as sprites, culled to what the view can see. */

import { drawSprite } from './spriteBatch.ts';
import type { SpriteBatch } from './spriteBatch.ts';
import { createSpriteFrame, sheetFrame } from './spriteSheet.ts';
import type { SpriteSheet } from './spriteSheet.ts';

/** A cell holding nothing. Negative, so it can never be a frame index. */
export const TILE_EMPTY = -1;

export interface Tilemap {
  readonly columns: number;
  readonly rows: number;
  /** One frame index per cell, row-major. `TILE_EMPTY` for a cell with nothing in it. */
  readonly tiles: Int32Array;
  /** How big a cell is, in whatever units the batch's affine maps from. */
  readonly tileWidth: number;
  readonly tileHeight: number;
  /**
   * Where cell (0, 0)'s corner sits.
   *
   * Mutable, because scrolling a map is moving it and the alternative is rebuilding one.
   */
  x: number;
  y: number;
}

/** What the view can see, in the same units the map is placed in. */
export interface ViewRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export function createTilemap(
  columns: number,
  rows: number,
  tileWidth: number,
  tileHeight: number,
): Tilemap {
  const tiles = new Int32Array(columns * rows);
  tiles.fill(TILE_EMPTY);
  return { columns, rows, tiles, tileWidth, tileHeight, x: 0, y: 0 };
}

/** The frame in a cell, or `TILE_EMPTY` — including for a cell outside the map. */
export function tileAt(map: Tilemap, column: number, row: number): number {
  if (column < 0 || column >= map.columns || row < 0 || row >= map.rows) return TILE_EMPTY;
  return map.tiles[row * map.columns + column] as number;
}

/** Put a frame in a cell. A cell outside the map is ignored rather than wrapping into another row. */
export function setTile(map: Tilemap, column: number, row: number, tile: number): void {
  if (column < 0 || column >= map.columns || row < 0 || row >= map.rows) return;
  map.tiles[row * map.columns + column] = tile;
}

/*
 * One frame rectangle, refilled per tile. Module scope because `drawTilemap` is a per-frame hot
 * path and this is the only object in it.
 */
const FRAME = createSpriteFrame();

/**
 * Draw the tiles the view can see. Returns how many that was.
 *
 * **The cost is the view rather than the map**, which is the whole reason this is a function and
 * not a loop the caller writes: the visible span is arithmetic on four numbers, so a map of a
 * million cells costs the few hundred on screen. A walk over every cell testing each against the
 * view would draw exactly the same picture and be unusable at the size a tilemap exists for.
 *
 * **Which way the rows run is the affine's business, not this function's.** A cell's corner is
 * `y + row * tileHeight`, so in screen space — where y counts down — row 0 is the top row, and in a
 * 2D world — where y counts up — it is the bottom. That is the same rule `SpritePlacement` states
 * about its own corner, and having one rule rather than a flag is what keeps the two agreeing.
 */
export function drawTilemap(
  batch: SpriteBatch,
  map: Tilemap,
  sheet: SpriteSheet,
  view: ViewRect,
  tint: ArrayLike<number> | null,
): number {
  const firstColumn = Math.max(0, Math.floor((view.x - map.x) / map.tileWidth));
  const firstRow = Math.max(0, Math.floor((view.y - map.y) / map.tileHeight));
  /* Exclusive, and `ceil` rather than `floor + 1` so a view ending exactly on a boundary stops. */
  const lastColumn = Math.min(map.columns, Math.ceil((view.x + view.w - map.x) / map.tileWidth));
  const lastRow = Math.min(map.rows, Math.ceil((view.y + view.h - map.y) / map.tileHeight));

  PLACEMENT.w = map.tileWidth;
  PLACEMENT.h = map.tileHeight;
  let drawn = 0;
  for (let row = firstRow; row < lastRow; row += 1) {
    const rowBase = row * map.columns;
    const y = map.y + row * map.tileHeight;
    for (let column = firstColumn; column < lastColumn; column += 1) {
      const tile = map.tiles[rowBase + column] as number;
      if (tile === TILE_EMPTY) continue;
      sheetFrame(sheet, tile, FRAME);
      PLACEMENT.x = map.x + column * map.tileWidth;
      PLACEMENT.y = y;
      drawSprite(batch, sheet.texture, PLACEMENT, FRAME, tint);
      drawn += 1;
    }
  }
  return drawn;
}

/*
 * The placement handed to `drawSprite`, refilled per tile. Its size never changes within a call, so
 * `drawTilemap` sets it once; the two coordinates move per cell.
 */
const PLACEMENT = { x: 0, y: 0, w: 0, h: 0 };
