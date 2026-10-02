/** Turn a laid-out interface tree into quads, parents first so children land on top. */

import { drawSprite } from './spriteBatch.ts';
import type { SpriteBatch, SpritePlacement } from './spriteBatch.ts';
import { createSpriteFrame } from './spriteSheet.ts';
import type { SpriteFrame } from './spriteSheet.ts';
import type { UiNode, UiRect } from './uiNode.ts';

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
  /**
   * `visible` is the part of the node its clipping ancestors leave on screen, which outside any clip
   * is the whole of it. Text has to be cut where the quads are, and only the caller drawing it can
   * cut it: a label in a row half scrolled out of a list is skipped, or drawn cut, here.
   */
  content(node: UiNode, visible: UiRect): void;
}

/* One placement, refilled per node. This is a per-frame path and these are the only objects in it. */
const PLACEMENT: SpritePlacement & { x: number; y: number; w: number; h: number } = {
  x: 0,
  y: 0,
  w: 0,
  h: 0,
};
/* The visible part of a node, handed to the sink, and the part of its frame that part shows. */
const VISIBLE: UiRect = { x: 0, y: 0, w: 0, h: 0 };
const CUT = createSpriteFrame();

/**
 * Draw a tree. Returns how many quads it came to.
 *
 * **Parents before children, siblings in order**, which is the same rule the batch already has:
 * there is no depth here, so what is drawn later is what is on top. A node draws its background
 * first and its image second, so an icon lands on its own plate.
 *
 * **A clipping node bounds what its descendants draw.** Each quad is cut to the rectangle every
 * clipping ancestor leaves, on the CPU, and an image's frame is cut in proportion, so a scrolled list
 * shows the rows inside it and nothing past its edges. Cut rather than scissored, because a scissor
 * is state a contributed pass would have to set and restore on both backends, and a cut is four
 * numbers per quad in the batch it already writes. Until 2026-10-02 `clip` was laid out, scrolled
 * and documented, and drawn by nothing: a list's rows drew wherever they had scrolled to. The tree is
 * in screen space, CSS pixels from the top-left, which is the space the cut assumes.
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
  return drawWithin(batch, root, white, sink, -Infinity, -Infinity, Infinity, Infinity);
}

function drawWithin(
  batch: SpriteBatch,
  node: UiNode,
  white: number,
  sink: UiContentSink | null,
  left: number,
  top: number,
  right: number,
  bottom: number,
): number {
  if (node.hidden) return 0;
  const rect = node.rect;
  const clipped = left !== -Infinity;
  const x0 = Math.max(rect.x, left);
  const y0 = Math.max(rect.y, top);
  const x1 = Math.min(rect.x + rect.w, right);
  const y1 = Math.min(rect.y + rect.h, bottom);
  let drawn = 0;
  /*
   * Inside a clip, a node cut away entirely draws nothing of its own. Outside one, nothing is cut and
   * a node is drawn as it always was, whatever its size. Its children are cut one by one either way,
   * since a child can lie outside its parent's box and still inside the clip.
   */
  if (!clipped || (x1 > x0 && y1 > y0)) {
    PLACEMENT.x = clipped ? x0 : rect.x;
    PLACEMENT.y = clipped ? y0 : rect.y;
    PLACEMENT.w = clipped ? x1 - x0 : rect.w;
    PLACEMENT.h = clipped ? y1 - y0 : rect.h;
    if (node.background !== null) {
      drawSprite(batch, white, PLACEMENT, null, node.background);
      drawn += 1;
    }
    if (node.texture >= 0) {
      const frame = clipped ? cutFrame(node, x0, y0, x1, y1) : node.frame;
      drawSprite(batch, node.texture, PLACEMENT, frame, node.tint);
      drawn += 1;
    }
    if (sink !== null && node.text !== '') {
      VISIBLE.x = PLACEMENT.x;
      VISIBLE.y = PLACEMENT.y;
      VISIBLE.w = PLACEMENT.w;
      VISIBLE.h = PLACEMENT.h;
      sink.content(node, VISIBLE);
    }
  }
  /* What a clipping node leaves its children: its own box, inside whatever it was left itself. */
  const keep = node.clip;
  const cl = keep ? Math.max(left, rect.x) : left;
  const ct = keep ? Math.max(top, rect.y) : top;
  const cr = keep ? Math.min(right, rect.x + rect.w) : right;
  const cb = keep ? Math.min(bottom, rect.y + rect.h) : bottom;
  for (const child of node.children) drawn += drawWithin(batch, child, white, sink, cl, ct, cr, cb);
  return drawn;
}

/** The part of a node's frame its visible box shows, or the whole frame when nothing was cut. */
function cutFrame(
  node: UiNode,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): SpriteFrame | null {
  const rect = node.rect;
  if (x0 === rect.x && y0 === rect.y && x1 === rect.x + rect.w && y1 === rect.y + rect.h) {
    return node.frame;
  }
  const u0 = node.frame?.u0 ?? 0;
  const v0 = node.frame?.v0 ?? 0;
  const u1 = node.frame?.u1 ?? 1;
  const v1 = node.frame?.v1 ?? 1;
  const perX = rect.w > 0 ? (u1 - u0) / rect.w : 0;
  const perY = rect.h > 0 ? (v1 - v0) / rect.h : 0;
  CUT.u0 = u0 + (x0 - rect.x) * perX;
  CUT.u1 = u0 + (x1 - rect.x) * perX;
  CUT.v0 = v0 + (y0 - rect.y) * perY;
  CUT.v1 = v0 + (y1 - rect.y) * perY;
  return CUT;
}
