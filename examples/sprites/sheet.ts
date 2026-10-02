/**
 * The garden's sprite sheet, painted pixel by pixel so the example loads no image.
 *
 * Sixteen cells of sixteen texels: eight tiles in the top row, and the gardener in the bottom one,
 * two steps for each way it can face. A palette paints it, so the same sheet comes out by day or at
 * dusk without a second picture.
 */
import type { SheetEntry } from '@driftengine/ui2d';

export const CELL = 16;
export const SHEET_WIDTH = CELL * 8;
export const SHEET_HEIGHT = CELL * 2;

const TILES = ['grass', 'clover', 'path', 'water', 'flower', 'fence', 'stone', 'soil'];
const STEPS = ['down0', 'down1', 'up0', 'up1', 'left0', 'left1', 'right0', 'right1'];

/** Every cell by name, where it is on the sheet. */
export const ENTRIES: readonly SheetEntry[] = [
  ...TILES.map((name, at) => ({ name, x: at * CELL, y: 0, w: CELL, h: CELL })),
  ...STEPS.map((name, at) => ({ name, x: at * CELL, y: CELL, w: CELL, h: CELL })),
];

export type Palette = Record<
  | 'grass'
  | 'grassDark'
  | 'path'
  | 'water'
  | 'waterLight'
  | 'petal'
  | 'wood'
  | 'stone'
  | 'soil'
  | 'skin'
  | 'shirt'
  | 'hat',
  string
>;

export const DAY: Palette = {
  grass: '#5c9a3c',
  grassDark: '#4a8530',
  path: '#c8a56a',
  water: '#3a78c4',
  waterLight: '#7fb2ea',
  petal: '#f2d24b',
  wood: '#8a5a32',
  stone: '#8d8f94',
  soil: '#6b4a2e',
  skin: '#f0c49a',
  shirt: '#c8463c',
  hat: '#e9d27a',
};

export const DUSK: Palette = {
  grass: '#2f5a3a',
  grassDark: '#264b31',
  path: '#7c6a55',
  water: '#22406e',
  waterLight: '#4c6fa3',
  petal: '#e8a24b',
  wood: '#5a3c2a',
  stone: '#5c5e6a',
  soil: '#3e2c22',
  skin: '#c79a80',
  shirt: '#8e3a3e',
  hat: '#b49c66',
};

/** Paint the sheet into a canvas, with a palette. */
export function paintSheet(canvas: OffscreenCanvas, palette: Palette): OffscreenCanvas {
  const g = canvas.getContext('2d');
  if (g === null) throw new Error('no 2d context for the sprite sheet');
  g.clearRect(0, 0, SHEET_WIDTH, SHEET_HEIGHT);
  const px = (cell: number, row: number, x: number, y: number, w: number, h: number, c: string) => {
    g.fillStyle = c;
    g.fillRect(cell * CELL + x, row * CELL + y, w, h);
  };
  /* Tiles, top row. Grass with a scatter of darker blades. */
  for (const cell of [0, 1, 4]) {
    px(cell, 0, 0, 0, CELL, CELL, palette.grass);
    for (const [x, y] of [
      [2, 3],
      [9, 2],
      [13, 7],
      [5, 10],
      [11, 13],
      [1, 12],
    ] as const) {
      px(cell, 0, x, y, 1, 2, palette.grassDark);
    }
  }
  /* Clover: three small leaves. */
  for (const [x, y] of [
    [6, 6],
    [8, 6],
    [7, 8],
  ] as const) {
    px(1, 0, x, y, 2, 2, palette.grassDark);
  }
  px(2, 0, 0, 0, CELL, CELL, palette.path);
  px(2, 0, 3, 4, 2, 1, palette.soil);
  px(2, 0, 10, 11, 2, 1, palette.soil);
  px(3, 0, 0, 0, CELL, CELL, palette.water);
  px(3, 0, 2, 4, 5, 1, palette.waterLight);
  px(3, 0, 9, 10, 5, 1, palette.waterLight);
  /* A flower on grass: a stem and four petals round a centre. */
  px(4, 0, 7, 8, 2, 5, palette.grassDark);
  px(4, 0, 5, 4, 6, 4, palette.petal);
  px(4, 0, 7, 3, 2, 6, palette.petal);
  px(4, 0, 7, 5, 2, 2, palette.wood);
  /* A fence: two posts and two rails, on grass. */
  px(5, 0, 0, 0, CELL, CELL, palette.grass);
  px(5, 0, 2, 2, 3, 13, palette.wood);
  px(5, 0, 11, 2, 3, 13, palette.wood);
  px(5, 0, 0, 5, CELL, 2, palette.wood);
  px(5, 0, 0, 10, CELL, 2, palette.wood);
  px(6, 0, 0, 0, CELL, CELL, palette.grass);
  px(6, 0, 3, 4, 10, 9, palette.stone);
  px(6, 0, 4, 3, 7, 2, palette.stone);
  px(7, 0, 0, 0, CELL, CELL, palette.soil);
  px(7, 0, 0, 4, CELL, 1, palette.wood);
  px(7, 0, 0, 11, CELL, 1, palette.wood);

  /* The gardener, bottom row: a hat, a face, a shirt and two legs, which swap on the second step.
     Facing down shows both eyes, up shows none, and a side shows one eye on that side. */
  for (let facing = 0; facing < 4; facing += 1) {
    for (let step = 0; step < 2; step += 1) {
      const cell = facing * 2 + step;
      px(cell, 1, 4, 1, 8, 3, palette.hat);
      px(cell, 1, 3, 3, 10, 1, palette.hat);
      px(cell, 1, 5, 4, 6, 4, palette.skin);
      if (facing === 0) {
        px(cell, 1, 6, 5, 1, 1, '#222');
        px(cell, 1, 9, 5, 1, 1, '#222');
      } else if (facing === 2) {
        px(cell, 1, 5, 5, 1, 1, '#222');
      } else if (facing === 3) {
        px(cell, 1, 10, 5, 1, 1, '#222');
      }
      px(cell, 1, 4, 8, 8, 5, palette.shirt);
      const lift = step === 0 ? 0 : 1;
      px(cell, 1, 5, 13, 2, 3 - lift, palette.wood);
      px(cell, 1, 9, 13 + lift, 2, 3 - lift, palette.wood);
    }
  }
  return canvas;
}
