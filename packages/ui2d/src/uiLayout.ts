/** Two passes over an interface tree: measure what wants a size, then place what got one. */

import type { UiNode } from './uiNode.ts';

/**
 * Lay a tree out into `x`, `y`, `w`, `h`.
 *
 * **Two passes, bottom-up then top-down, and no third.** The measure pass answers what every node
 * comes to on its own; the place pass hands out the space that exists and distributes what is left
 * over. A `fit` size that depended on the space it was given would need a third pass and a rule for
 * when to stop, which is where a layout engine stops being explicable.
 *
 * **Allocates nothing.** Every number it produces is written into a `UiRect` the node already owns,
 * so a tree laid out every frame costs no garbage. That is the rule this whole module is shaped by,
 * and it is why the node is an object with fields rather than a description that gets resolved into
 * one.
 *
 * **The box is what is *available*, and the root resolves its own size against it** like any other
 * node: `grow` fills it, a number is that number, and `fit` — the default — comes to whatever its
 * contents do. So the same call lays out a full-screen HUD and a tooltip, and a caller does not
 * have to measure a menu itself before it can place one. Nothing is clamped to the box: a `fit`
 * root with more in it than fits reports the size it really is, because a silently truncated
 * layout is worse than one that visibly overflows.
 */
export function layoutUiTree(root: UiNode, x: number, y: number, w: number, h: number): void {
  measure(root);
  place(
    root,
    x,
    y,
    root.width === 'grow' ? w : root.measuredWidth,
    root.height === 'grow' ? h : root.measuredHeight,
  );
}

/**
 * What a node comes to on its own, written into `measuredWidth` and `measuredHeight`.
 *
 * A `grow` child measures as `fit` here, which is what lets a menu sized to its contents hold a row
 * that fills it: at measure time there is nothing to take a share of, so the honest answer is the
 * child's own natural size. The place pass is where `grow` means anything.
 */
function measure(node: UiNode): void {
  let along = 0;
  let across = 0;
  let counted = 0;
  const row = node.direction === 'row';
  for (const child of node.children) {
    if (child.hidden) continue;
    measure(child);
    if (child.absolute) continue;
    const childAlong = row ? child.measuredWidth : child.measuredHeight;
    const childAcross = row ? child.measuredHeight : child.measuredWidth;
    along += childAlong;
    if (childAcross > across) across = childAcross;
    counted += 1;
  }
  if (counted > 1) along += node.gap * (counted - 1);

  const padX = node.paddingLeft + node.paddingRight;
  const padY = node.paddingTop + node.paddingBottom;
  const contentAlong = counted === 0 ? (row ? node.contentWidth : node.contentHeight) : along;
  const contentAcross = counted === 0 ? (row ? node.contentHeight : node.contentWidth) : across;

  const fitWidth = (row ? contentAlong : contentAcross) + padX;
  const fitHeight = (row ? contentAcross : contentAlong) + padY;
  node.measuredWidth = typeof node.width === 'number' ? node.width : fitWidth;
  node.measuredHeight = typeof node.height === 'number' ? node.height : fitHeight;
}

/** Put a node in a box, then put its children in what is left of it. */
function place(node: UiNode, x: number, y: number, w: number, h: number): void {
  node.rect.x = x;
  node.rect.y = y;
  node.rect.w = w;
  node.rect.h = h;

  const row = node.direction === 'row';
  /*
   * Scrolling is subtracted here, at placement, rather than applied as a transform at draw.
   * Applied at draw, hit testing would need the inverse and every consumer would eventually get
   * it wrong in one direction; applied here, a scrolled child's rectangle simply *is* where it is,
   * and hit testing, focus and clipping all keep working without knowing scrolling exists.
   */
  const contentX = x + node.paddingLeft - node.scrollX;
  const contentY = y + node.paddingTop - node.scrollY;
  const contentW = Math.max(0, w - node.paddingLeft - node.paddingRight);
  const contentH = Math.max(0, h - node.paddingTop - node.paddingBottom);
  const contentAlong = row ? contentW : contentH;
  const contentAcross = row ? contentH : contentW;

  /* What the flow children take before anything grows, and how many of them want to grow. */
  let taken = 0;
  let growers = 0;
  let counted = 0;
  for (const child of node.children) {
    if (child.hidden || child.absolute) continue;
    const asked = row ? child.width : child.height;
    if (asked === 'grow') growers += 1;
    else taken += row ? child.measuredWidth : child.measuredHeight;
    counted += 1;
  }
  const gaps = counted > 1 ? node.gap * (counted - 1) : 0;
  const spare = Math.max(0, contentAlong - taken - gaps);
  const share = growers > 0 ? spare / growers : 0;

  /*
   * `justify` spends what is left over, and there is nothing left over once something has grown —
   * which is why a growing child and a `center` on the same node are not a contradiction: the
   * growing child ate the leftover, so centring has nothing to move.
   */
  let cursor = 0;
  let between = 0;
  if (growers === 0) {
    if (node.justify === 'center') cursor = spare / 2;
    else if (node.justify === 'end') cursor = spare;
    else if (node.justify === 'between' && counted > 1) between = spare / (counted - 1);
  }

  for (const child of node.children) {
    if (child.hidden) continue;
    if (child.absolute) {
      placeAbsolute(child, contentX, contentY, contentW, contentH);
      continue;
    }
    const askedAlong = row ? child.width : child.height;
    const sizeAlong =
      askedAlong === 'grow' ? share : row ? child.measuredWidth : child.measuredHeight;
    const askedAcross = row ? child.height : child.width;
    const naturalAcross = row ? child.measuredHeight : child.measuredWidth;
    const sizeAcross =
      node.align === 'stretch' || askedAcross === 'grow' ? contentAcross : naturalAcross;
    let offAcross = 0;
    if (node.align === 'center') offAcross = (contentAcross - sizeAcross) / 2;
    else if (node.align === 'end') offAcross = contentAcross - sizeAcross;

    if (row) {
      place(child, contentX + cursor, contentY + offAcross, sizeAlong, sizeAcross);
    } else {
      place(child, contentX + offAcross, contentY + cursor, sizeAcross, sizeAlong);
    }
    cursor += sizeAlong + node.gap + between;
  }

  measureSpan(node, contentX, contentY);
}

/**
 * A child taken out of the flow: at its own offset inside the parent's content box.
 *
 * Inside the content box rather than the border box, so an absolute badge in a padded panel sits
 * where the panel's contents start — which is where a caller reading the padding expects it, and
 * the only reading under which `x: 0` means the same thing for an absolute child as for a flow one.
 */
/**
 * How far the placed children reach past the content origin.
 *
 * Measured after placement and relative to `contentX`/`contentY`, which the scroll has already
 * moved — so the offset cancels and the answer is the same whatever the node is scrolled to.
 * `uiScroll.ts` clamps against this and would be wrong clamping against anything derived from the
 * live scroll value.
 */
function measureSpan(node: UiNode, contentX: number, contentY: number): void {
  let spanX = 0;
  let spanY = 0;
  for (const child of node.children) {
    if (child.hidden) continue;
    spanX = Math.max(spanX, child.rect.x + child.rect.w - contentX);
    spanY = Math.max(spanY, child.rect.y + child.rect.h - contentY);
  }
  node.contentSpanX = spanX;
  node.contentSpanY = spanY;
}

function placeAbsolute(
  child: UiNode,
  contentX: number,
  contentY: number,
  contentW: number,
  contentH: number,
): void {
  const w = child.width === 'grow' ? contentW : child.measuredWidth;
  const h = child.height === 'grow' ? contentH : child.measuredHeight;
  place(child, contentX + child.x, contentY + child.y, w, h);
}
