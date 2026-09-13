/*! DriftEngine | Copyright 2026 Drift Technologies | Apache-2.0 | https://github.com/drftrun/driftengine */
/**
 * `@driftengine/ui2d` — the 2D layer.
 *
 * A quad is the whole of 2D, so this package is one batch and one pass over it: sprites, the
 * sheets they are cut from, the tilemaps that place thousands of them, and the interface tree that
 * lays a screen out. It draws through `registerPass` rather than through a verb on the renderer,
 * which is what lets it be a package at all — see `pass.ts` in core, which names this package as
 * one of the three that mechanism exists for.
 */

export { createAffine2D, screenToNdc, worldToNdc } from './camera2d.ts';
export type { Affine2D, Camera2D } from './camera2d.ts';

export {
  SPRITE_FLOATS,
  createSpriteBatch,
  drawSprite,
  resetSpriteBatch,
  spriteRun,
} from './spriteBatch.ts';
export type { SpriteBatch, SpritePlacement, SpriteRun, UvRect } from './spriteBatch.ts';

export { DEFAULT_SPRITE_CAPACITY, DEFAULT_SPRITE_SLOTS, createSpritePass } from './spritePass.ts';
export type { SpritePass, SpritePassOptions } from './spritePass.ts';

export { DEFAULT_SPRITE_TEXTURE_OPTIONS } from './spriteTexture.ts';
export type { SpriteImage, SpriteTextureOptions } from './spriteTexture.ts';

export {
  createSpriteFrame,
  frameOf,
  gridSheet,
  namedSheet,
  sheetFrame,
  sheetFrameHeight,
  sheetFrameWidth,
} from './spriteSheet.ts';
export type { SheetEntry, SpriteFrame, SpriteSheet } from './spriteSheet.ts';

export { TILE_EMPTY, createTilemap, drawTilemap, setTile, tileAt } from './tilemap.ts';
export type { Tilemap, ViewRect } from './tilemap.ts';

export { addUiChild, createUiNode, removeUiChild, uiNodeNamed, uiRectHolds } from './uiNode.ts';
export type { UiAlign, UiJustify, UiNode, UiNodeOptions, UiRect, UiSize } from './uiNode.ts';

export { layoutUiTree } from './uiLayout.ts';

export { drawUiTree } from './uiDraw.ts';
export type { UiContentSink } from './uiDraw.ts';

export { uiFocusNext, uiFocusOrder, uiFocusPrevious, uiHitTest } from './uiFocus.ts';

export { createUiInput, resetUiInput, routeUiKey, routeUiPointer, setUiFocus } from './uiInput.ts';
export type { UiInput } from './uiInput.ts';
