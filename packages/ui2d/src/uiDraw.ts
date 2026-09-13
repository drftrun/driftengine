/** Turn a laid-out interface tree into quads, parents first so children land on top. */

import { drawSprite } from './spriteBatch.ts';
import type { SpriteBatch, SpritePlacement } from './spriteBatch.ts';
import type { UiNode } from './uiNode.ts';

/**
 * Where a caller draws what a quad cannot be.
 *
 * Text is the whole of it today. This package draws textured quads and core already draws two kinds
 * of text — `drawText` from the pixel font and `drawSdfText` from an atlas — so the honest seam is
 * that the tree says *where* a label goes and the caller says *how* it is drawn. Wrapping either
 * here would mean this package importing the renderer's verb surface to re-export it.
 *
 * Called with the node's resolved rect already filled in, in the order the node is drawn, so a
 * label lands over its own background and under whatever is drawn after it.
 */
export interface UiContentSink {
  content(node: UiNode): void;
}

/* One placement, refilled per node. This is a per-frame path and it is the only object in it. */
const PLACEMENT: SpritePlacement & { x: number; y: number; w: number; h: number } = {
  x: 0,
  y: 0,
  w: 0,
  h: 0,
};

/**
 * Draw a tree. Returns how many quads it came to.
 *
 * **Parents before children, siblings in order**, which is the same rule the batch already has:
 * there is no depth here, so what is drawn later is what is on top. A node draws its background
 * first and its image second, so an icon lands on its own plate.
 *
 * Allocates nothing. `layoutUiTree` must have run over this root, or every rect is whatever it was
 * left at.
 */
export function drawUiTree(
  batch: SpriteBatch,
  root: UiNode,
  white: number,
  sink: UiContentSink | null,
): number {
  if (root.hidden) return 0;
  let drawn = 0;
  PLACEMENT.x = root.rect.x;
  PLACEMENT.y = root.rect.y;
  PLACEMENT.w = root.rect.w;
  PLACEMENT.h = root.rect.h;
  if (root.background !== null) {
    drawSprite(batch, white, PLACEMENT, null, root.background);
    drawn += 1;
  }
  if (root.texture >= 0) {
    drawSprite(batch, root.texture, PLACEMENT, root.frame, root.tint);
    drawn += 1;
  }
  if (sink !== null && root.text !== '') sink.content(root);
  for (const child of root.children) drawn += drawUiTree(batch, child, white, sink);
  return drawn;
}
