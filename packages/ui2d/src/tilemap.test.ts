import { describe, expect, it } from 'vitest';

import { SPRITE_FLOATS, createSpriteBatch } from './spriteBatch.ts';
import { gridSheet } from './spriteSheet.ts';
import { TILE_EMPTY, createTilemap, drawTilemap, setTile, tileAt } from './tilemap.ts';
import type { Tilemap } from './tilemap.ts';

/** A four-frame sheet, cells of 16 texels, on slot 3. */
const SHEET = gridSheet(3, 32, 32, 16, 16);

function filled(columns: number, rows: number, tile = 0): Tilemap {
  const map = createTilemap(columns, rows, 10, 10);
  map.tiles.fill(tile);
  return map;
}

/** Where instance `i`'s (0, 0) corner landed. */
function origin(batch: ReturnType<typeof createSpriteBatch>, i: number): [number, number] {
  const at = i * SPRITE_FLOATS;
  return [batch.instances[at + 12] as number, batch.instances[at + 13] as number];
}

describe('a tilemap', () => {
  it('reads and writes a cell', () => {
    const map = createTilemap(4, 3, 10, 10);
    expect(tileAt(map, 2, 1)).toBe(TILE_EMPTY);
    setTile(map, 2, 1, 7);
    expect(tileAt(map, 2, 1)).toBe(7);
  });

  it('answers empty for a cell outside it rather than reading another row', () => {
    const map = filled(4, 3, 2);
    expect(tileAt(map, 4, 0)).toBe(TILE_EMPTY);
    expect(tileAt(map, -1, 0)).toBe(TILE_EMPTY);
    expect(tileAt(map, 0, 3)).toBe(TILE_EMPTY);
  });

  it('places a cell at its own corner, at the size it was built with', () => {
    const map = filled(4, 3);
    map.x = 100;
    map.y = 50;
    const batch = createSpriteBatch(64);
    drawTilemap(batch, map, SHEET, { x: -1000, y: -1000, w: 4000, h: 4000 }, null);
    // Cell (0, 0) first, then (1, 0): row-major, so x moves first.
    expect(origin(batch, 0)).toEqual([100, 50]);
    expect(origin(batch, 1)).toEqual([110, 50]);
    expect(origin(batch, 4)).toEqual([100, 60]);
  });

  it('draws every tile of one map on one texture, so it is one run', () => {
    const map = filled(8, 8);
    const batch = createSpriteBatch(256);
    drawTilemap(batch, map, SHEET, { x: -1000, y: -1000, w: 4000, h: 4000 }, null);
    expect(batch.count).toBe(64);
    expect(batch.runCount).toBe(1);
  });

  it('skips empty cells', () => {
    const map = filled(4, 4);
    setTile(map, 1, 1, TILE_EMPTY);
    setTile(map, 2, 3, TILE_EMPTY);
    const batch = createSpriteBatch(64);
    const drawn = drawTilemap(batch, map, SHEET, { x: -1000, y: -1000, w: 4000, h: 4000 }, null);
    expect(drawn).toBe(14);
    expect(batch.count).toBe(14);
  });
});

describe('culling', () => {
  /*
   * The claim this whole module turns on. A map of a million tiles must cost the view rather than
   * the map — a walk over every cell would pass every placement assertion above and be unusable at
   * the size a tilemap exists for.
   */
  it('costs the view rather than the map', () => {
    const map = filled(1000, 1000);
    const batch = createSpriteBatch(4096);
    const started = performance.now();
    const drawn = drawTilemap(batch, map, SHEET, { x: 0, y: 0, w: 50, h: 50 }, null);
    const spent = performance.now() - started;
    expect(drawn).toBe(25);
    // A walk over a million cells is not this fast on any machine this runs on.
    expect(spent).toBeLessThan(20);
  });

  it('includes the cells the view only partly covers', () => {
    const map = filled(10, 10);
    const batch = createSpriteBatch(256);
    // From the middle of cell 1 to the middle of cell 3, on both axes: cells 1, 2 and 3.
    const drawn = drawTilemap(batch, map, SHEET, { x: 15, y: 15, w: 20, h: 20 }, null);
    expect(drawn).toBe(9);
  });

  it('draws nothing for a view beside the map', () => {
    const map = filled(10, 10);
    const batch = createSpriteBatch(256);
    expect(drawTilemap(batch, map, SHEET, { x: 500, y: 0, w: 50, h: 50 }, null)).toBe(0);
    expect(drawTilemap(batch, map, SHEET, { x: -500, y: 0, w: 50, h: 50 }, null)).toBe(0);
    expect(batch.count).toBe(0);
  });

  it('clamps to the map rather than reading off the end of a row', () => {
    const map = filled(3, 3);
    const batch = createSpriteBatch(256);
    // A view far wider than the map: nine tiles, not the width of the view in tiles.
    expect(drawTilemap(batch, map, SHEET, { x: -1000, y: -1000, w: 4000, h: 4000 }, null)).toBe(9);
  });

  /*
   * The map is offset, and the cull has to be in the map's own space. A cull that forgot the offset
   * would pass every test above, where the map sits at the origin.
   */
  it("culls in the map's own place, not at the origin", () => {
    const map = filled(10, 10);
    map.x = 1000;
    map.y = 2000;
    const batch = createSpriteBatch(256);
    expect(drawTilemap(batch, map, SHEET, { x: 0, y: 0, w: 50, h: 50 }, null)).toBe(0);
    expect(drawTilemap(batch, map, SHEET, { x: 1000, y: 2000, w: 20, h: 20 }, null)).toBe(4);
  });
});
