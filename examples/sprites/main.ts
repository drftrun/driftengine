/**
 * A garden drawn as sprites: a tilemap, a gardener walking it, and flowers to pick.
 *
 * Everything is one sprite pass over one sheet, painted at load: the tilemap draws only the cells in
 * view, and the gardener is a frame of the same sheet drawn after it, so the order of the draws is
 * the order of the layers. `garden.drs` walks the gardener, keeps it out of the pond, picks the
 * flowers it steps on by rewriting their tiles, and draws both. The switches zoom the camera,
 * change how the sheet is filtered, and repaint it at dusk, all on the running page.
 */
import { ActionMap, InputSource, srgbColor } from '@driftengine/core';
import {
  createAffine2D,
  createSpritePass,
  createTilemap,
  frameOf,
  namedSheet,
  setTile,
  worldToNdc,
} from '@driftengine/ui2d';
import type { SpriteBatch, SpriteSheet, Tilemap } from '@driftengine/ui2d';
import { patchModule } from 'driftscript';
import { createReadout } from '../common/readout';
import { exported, hostScript } from '../common/script';
import { controls, flag, openStage } from '../common/stage';
import * as gardenScript from './garden.drs';
import { DAY, DUSK, ENTRIES, SHEET_HEIGHT, SHEET_WIDTH, paintSheet } from './sheet';

const stage = await openStage({});
const { renderer, canvas } = stage;

// #region pass
/* One pass of sprites, drawn wherever in the frame it is asked for, over one sheet. A sheet of
   pixel art is filtered nearest, so its texels stay square at any zoom. */
const pass = createSpritePass({ capacity: 4096, slots: 1, label: 'garden' });
/** The ground behind the tiles at each hour, picked by eye and so stated through `srgbColor`. */
const DUSK_CLEAR = srgbColor(0.08, 0.1, 0.14);
const DAY_CLEAR = srgbColor(0.3, 0.45, 0.25);
const handle = renderer.registerPass(pass);
const painted = new OffscreenCanvas(SHEET_WIDTH, SHEET_HEIGHT);
let palette = flag('light', 'day') === 'dusk' ? DUSK : DAY;
let filter: 'nearest' | 'linear' = flag('filter', 'nearest') === 'linear' ? 'linear' : 'nearest';
function upload(): void {
  pass.setTexture(0, paintSheet(painted, palette), { filter });
}
upload();
const sheet = namedSheet(0, SHEET_WIDTH, SHEET_HEIGHT, ENTRIES);
// #endregion

// #region map
/* The garden, a tile a world unit: grass and clover, a path, a pond, a fenced patch of soil, some
   stones, and flowers scattered over the grass. Row 0 is the bottom, because the world's y is up. */
const COLUMNS = 48;
const ROWS = 36;
const map = createTilemap(COLUMNS, ROWS, 1, 1);
const tileOf = (name: string): number => frameOf(sheet, name);
let seed = 7;
const random = (): number => {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return seed / 0x100000000;
};
for (let row = 0; row < ROWS; row += 1) {
  for (let column = 0; column < COLUMNS; column += 1) {
    const pond = ((column - 34) / 7) ** 2 + ((row - 24) / 5) ** 2 < 1;
    const patch = column >= 8 && column <= 17 && row >= 6 && row <= 13;
    const edge = patch && (column === 8 || column === 17 || row === 6 || row === 13);
    const path = Math.abs(row - (17 + Math.sin(column / 5) * 3)) < 1;
    let name = random() < 0.2 ? 'clover' : 'grass';
    if (path) name = 'path';
    if (pond) name = 'water';
    if (patch) name = edge && !(row === 13 && column === 12) ? 'fence' : 'soil';
    if (name === 'grass' && random() < 0.05) name = 'flower';
    if (name === 'grass' && random() < 0.015) name = 'stone';
    setTile(map, column, row, tileOf(name));
  }
}
const flowers = (): number => {
  let count = 0;
  for (const tile of map.tiles) if (tile === tileOf('flower')) count += 1;
  return count;
};
const planted = flowers();
// #endregion

// #region script
const input = new InputSource(canvas, ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
const actions = new ActionMap(input, {
  move: {
    stick: 'left',
    up: ['KeyW', 'ArrowUp'],
    down: ['KeyS', 'ArrowDown'],
    left: ['KeyA', 'ArrowLeft'],
    right: ['KeyD', 'ArrowRight'],
  },
});
const script = hostScript(gardenScript);
interface Gardener {
  x: number;
  y: number;
  picked: number;
}
const gardener = exported<() => Gardener>(script, 'createGardener')();
type Walk = (
  gardener: Gardener,
  actions: ActionMap,
  map: Tilemap,
  sheet: SpriteSheet,
  dt: number,
) => void;
type Draw = (
  gardener: Gardener,
  batch: SpriteBatch,
  map: Tilemap,
  sheet: SpriteSheet,
  x: number,
  y: number,
  w: number,
  h: number,
) => void;
if (import.meta.hot) {
  import.meta.hot.accept('./garden.drs', (next) => {
    if (next !== undefined) {
      patchModule(script, next as Record<string, unknown>, { Gardener: [gardener] });
    }
  });
}
// #endregion

let zoom = flag('zoom', 'near') === 'far' ? 28 : 56;
controls([
  {
    key: 'zoom',
    label: 'zoom',
    value: zoom === 28 ? 'far' : 'near',
    options: ['near', 'far'].map((z) => ({ text: z, value: z })),
    change: (value) => {
      zoom = value === 'far' ? 28 : 56;
    },
  },
  {
    key: 'filter',
    label: 'filter',
    value: filter,
    options: ['nearest', 'linear'].map((f) => ({ text: f, value: f })),
    change: (value) => {
      filter = value === 'linear' ? 'linear' : 'nearest';
      upload();
    },
  },
  {
    key: 'light',
    label: 'light',
    value: palette === DUSK ? 'dusk' : 'day',
    options: ['day', 'dusk'].map((l) => ({ text: l, value: l })),
    change: (value) => {
      palette = value === 'dusk' ? DUSK : DAY;
      upload();
    },
  },
]);

const affine = createAffine2D();
const view = { x: 0, y: 0, zoom: 56, rotation: 0 };
const readout = createReadout(renderer, 2);
let time = 0;

stage.run({
  simulate(dt) {
    time += dt;
    exported<Walk>(script, 'walk')(gardener, actions, map, sheet, dt);
  },
  render() {
    // #region frame
    /* The camera follows the gardener, and the view it sees, in tiles, is what the tilemap draws. */
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const seenW = width / zoom;
    const seenH = height / zoom;
    /* Kept inside the garden, so its edge is never in view. */
    view.x = Math.min(Math.max(gardener.x, seenW / 2), COLUMNS - seenW / 2);
    view.y = Math.min(Math.max(gardener.y, seenH / 2), ROWS - seenH / 2);
    view.zoom = zoom;
    pass.reset();
    pass.setTransform(worldToNdc(view, width, height, affine));
    exported<Draw>(script, 'draw')(
      gardener,
      pass.batch,
      map,
      sheet,
      view.x - seenW / 2,
      view.y - seenH / 2,
      seenW,
      seenH,
    );
    renderer.beginFrame(palette === DUSK ? DUSK_CLEAR : DAY_CLEAR);
    renderer.drawPass(handle);
    // #endregion
    readout.set(
      0,
      `${gardener.picked} OF ${planted} FLOWERS PICKED  ${pass.batch.count} SPRITES THIS FRAME`,
    );
    readout.set(1, 'WASD, THE ARROWS OR A STICK TO WALK');
    readout.draw(time);
    renderer.endFrame();
  },
});
