import type { SpriteBatch, SpriteSheet, Tilemap } from '@driftengine/ui2d';
import {
  createSpriteFrame,
  drawSprite,
  drawTilemap,
  frameOf,
  setTile,
  sheetFrame,
  tileAt,
} from '@driftengine/ui2d';
import type { CapabilityDefinition, Effect, OpaqueType } from 'driftscript';
import { defineCapability } from 'driftscript';

export const SPRITES_MODULE = 'drift/2d';

/**
 * `drift/2d` — quads with a picture on them, and the grids of them.
 *
 * ```drs
 * import { sprite, tilemap } from "drift/2d" as sprites
 *
 * fn hud(batch: SpriteBatch) {
 *     sprites.sprite(batch, 0, 10, 10, 32, 32)
 * }
 * ```
 *
 * **The `as` is not decoration and this module is why the language has it.** A capability is reached
 * through a namespace and the namespace was the last segment of the path, so a call here would have
 * been `2d.sprite(...)` — a number followed by an identifier, refused by the lexer before the
 * checker saw it. This binding was written on 2026-09-03, wired, found uncallable, and **withdrawn
 * rather than shipped**, because a capability nobody can spell is the silent no-op this repository
 * forbids wearing a feature's clothes. DriftScript 1.11.0 answered it at the import, and the
 * language's own changelog carries the five spellings that were tried and failed.
 *
 * So a script naming this module must name the namespace too, and `DS0139` says so at the import
 * with the line to write rather than leaving an author at `DS0003` inside their own call.
 *
 * ## The effects, and why this one needed nothing from the language
 *
 * Unlike `drift/terrain`, this module met no wall on effects. **A sprite is a thing that draws**,
 * and `scene.write` is exactly what the language reserves for that — its own comment says a
 * `SceneNode` "is what *draws*", and that writing one is a change to the view rather than to the
 * simulation. Everything here that puts a quad in a batch is declared that way, and it is outside
 * `DETERMINISTIC_EFFECTS` for the right reason: a `@deterministic` system decides where things
 * *are*, and something else draws them.
 *
 * **Reading a sheet or a tile is `scene.read`**, which is inside the boundary, so a deterministic
 * system may ask what frame a name is or what is in a cell. That asymmetry is the honest one:
 * looking at the view is a read of state the simulation already produced.
 *
 * **`setTile` is a write to the view and is outside**, which is worth being explicit about because
 * it reads as a limitation and is not one. A `Tilemap` here is *drawing* data — its cells are frame
 * indices into a sheet, and `tilemap.ts` says so in its first line. A game's collision grid is the
 * game's own array and is not this. A deterministic system that wants to dig a hole changes its own
 * grid and lets a drawing system follow.
 */
export const SPRITES_TYPES: readonly OpaqueType[] = [
  {
    module: SPRITES_MODULE,
    name: 'SpriteBatch',
    doc: 'One frame of quads, in the order they were put in. Reset it, fill it, draw it.',
  },
  {
    module: SPRITES_MODULE,
    name: 'SpriteSheet',
    doc: 'The rectangles of one texture that each hold a picture, addressed by index or by name.',
  },
  {
    module: SPRITES_MODULE,
    name: 'Tilemap',
    doc: 'A grid of sheet frames. Drawing one costs the view rather than the map.',
  },
];

const define = (
  name: string,
  params: readonly { name: string; type: string }[],
  returns: string,
  effects: readonly Effect[],
  doc: string,
): CapabilityDefinition =>
  defineCapability({
    module: SPRITES_MODULE,
    name,
    signature: `fn(${params.map((p) => `${p.name}: ${p.type}`).join(', ')}) -> ${returns}`,
    params: [...params],
    returns,
    effects: [...effects],
    /*
     * Every float here is `f32` and none is `float`. `float` is width-polymorphic and takes its
     * width from another `float`, so a capability returning one must take one — a rule Track L paid
     * for. Nothing here returns a float at all, and a batch stores its instances as `Float32Array`,
     * so `f32` is what the number actually is rather than a width chosen to satisfy a checker.
     */
    deterministic: !effects.includes('scene.write'),
    doc,
    implementation: `${SPRITES_MODULE}.${name}`,
  });

const AT = [
  { name: 'x', type: 'f32' },
  { name: 'y', type: 'f32' },
  { name: 'w', type: 'f32' },
  { name: 'h', type: 'f32' },
] as const;

export const SPRITES_CAPABILITIES: readonly CapabilityDefinition[] = [
  define(
    'sprite',
    [{ name: 'batch', type: 'SpriteBatch' }, { name: 'texture', type: 'i32' }, ...AT],
    'void',
    ['scene.write'],
    'Put one quad in the batch, covering the whole of a texture.',
  ),
  define(
    'tinted',
    [
      { name: 'batch', type: 'SpriteBatch' },
      { name: 'texture', type: 'i32' },
      ...AT,
      { name: 'r', type: 'f32' },
      { name: 'g', type: 'f32' },
      { name: 'b', type: 'f32' },
      { name: 'a', type: 'f32' },
    ],
    'void',
    ['scene.write'],
    'The same, multiplied by a colour. White is the identity, so a white texture draws exactly this colour — which is how a solid rectangle is drawn.',
  ),
  define(
    'frame',
    [
      { name: 'batch', type: 'SpriteBatch' },
      { name: 'sheet', type: 'SpriteSheet' },
      { name: 'frame', type: 'i32' },
      ...AT,
    ],
    'void',
    ['scene.write'],
    'Put one frame of a sheet in the batch. A frame the sheet does not have draws the whole sheet, which is unmistakable.',
  ),
  define(
    'named',
    [
      { name: 'sheet', type: 'SpriteSheet' },
      { name: 'name', type: 'String' },
    ],
    'i32',
    ['scene.read'],
    'The index a name has in a sheet, or -1. Ask once and keep the number: a name lookup is a hash and a frame is an array read.',
  ),
  define(
    'frames',
    [{ name: 'sheet', type: 'SpriteSheet' }],
    'i32',
    ['scene.read'],
    'How many frames the sheet was cut into.',
  ),
  define(
    'tilemap',
    [
      { name: 'batch', type: 'SpriteBatch' },
      { name: 'map', type: 'Tilemap' },
      { name: 'sheet', type: 'SpriteSheet' },
      ...AT,
    ],
    'i32',
    ['scene.write'],
    'Draw the tiles a view rectangle can see, and answer how many that was. The cost is the view rather than the map.',
  ),
  define(
    'tile',
    [
      { name: 'map', type: 'Tilemap' },
      { name: 'column', type: 'i32' },
      { name: 'row', type: 'i32' },
    ],
    'i32',
    ['scene.read'],
    'The frame in a cell, or -1 for an empty one — including for a cell outside the map, which answers empty rather than another row.',
  ),
  define(
    'setTile',
    [
      { name: 'map', type: 'Tilemap' },
      { name: 'column', type: 'i32' },
      { name: 'row', type: 'i32' },
      { name: 'tile', type: 'i32' },
    ],
    'void',
    ['scene.write'],
    'Put a frame in a cell. A cell outside the map is ignored rather than wrapping into another row.',
  ),
  define(
    'columns',
    [{ name: 'map', type: 'Tilemap' }],
    'i32',
    ['scene.read'],
    'How wide the map is, in cells.',
  ),
  define(
    'rows',
    [{ name: 'map', type: 'Tilemap' }],
    'i32',
    ['scene.read'],
    'How tall the map is, in cells.',
  ),
  define(
    'count',
    [{ name: 'batch', type: 'SpriteBatch' }],
    'i32',
    ['scene.read'],
    'How many quads are in the batch this frame.',
  ),
  /*
   * **A script can see the batch overflow, which is the whole reason this is exposed.** The batch
   * does not grow: past its capacity a draw is counted and dropped, and a caller with no way to
   * read that count finds out by noticing something missing from a corner of the screen.
   */
  define(
    'dropped',
    [{ name: 'batch', type: 'SpriteBatch' }],
    'i32',
    ['scene.read'],
    'How many quads did not fit this frame. Zero is the only good value; anything else is a batch that wants a bigger capacity.',
  ),
];

/**
 * **No services, and that is the shape rather than an omission.**
 *
 * Every capability takes the batch, sheet or map it acts on, so the module needs nothing from the
 * host to answer — they reach a script through `uses`, the way a `Terrain` and a `NavGraph` do. So
 * this is registered unconditionally, and a script that never receives a batch never calls it.
 */
export function spritesImplementation(): Record<string, unknown> {
  /* One frame rectangle for every `frame` call. These run per draw and may not allocate. */
  const scratch = createSpriteFrame();
  const place = { x: 0, y: 0, w: 0, h: 0 };
  const tint = new Float32Array(4);
  const view = { x: 0, y: 0, w: 0, h: 0 };

  const at = (x: number, y: number, w: number, h: number): typeof place => {
    place.x = x;
    place.y = y;
    place.w = w;
    place.h = h;
    return place;
  };

  return {
    sprite: (batch: SpriteBatch, texture: number, x: number, y: number, w: number, h: number) => {
      drawSprite(batch, texture, at(x, y, w, h), null, null);
    },
    tinted: (
      batch: SpriteBatch,
      texture: number,
      x: number,
      y: number,
      w: number,
      h: number,
      r: number,
      g: number,
      b: number,
      a: number,
    ) => {
      tint[0] = r;
      tint[1] = g;
      tint[2] = b;
      tint[3] = a;
      drawSprite(batch, texture, at(x, y, w, h), null, tint);
    },
    frame: (
      batch: SpriteBatch,
      sheet: SpriteSheet,
      frame: number,
      x: number,
      y: number,
      w: number,
      h: number,
    ) => {
      drawSprite(batch, sheet.texture, at(x, y, w, h), sheetFrame(sheet, frame, scratch), null);
    },
    named: (sheet: SpriteSheet, name: string) => frameOf(sheet, name),
    frames: (sheet: SpriteSheet) => sheet.count,
    tilemap: (
      batch: SpriteBatch,
      map: Tilemap,
      sheet: SpriteSheet,
      x: number,
      y: number,
      w: number,
      h: number,
    ) => {
      view.x = x;
      view.y = y;
      view.w = w;
      view.h = h;
      return drawTilemap(batch, map, sheet, view, null);
    },
    tile: (map: Tilemap, column: number, row: number) => tileAt(map, column, row),
    setTile: (map: Tilemap, column: number, row: number, tile: number) => {
      setTile(map, column, row, tile);
    },
    columns: (map: Tilemap) => map.columns,
    rows: (map: Tilemap) => map.rows,
    count: (batch: SpriteBatch) => batch.count,
    dropped: (batch: SpriteBatch) => batch.dropped,
  };
}
