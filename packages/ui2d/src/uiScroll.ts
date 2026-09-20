/**
 * Moving a clipping node's contents underneath it.
 *
 * **Scrolling is an offset applied at placement, not a transform applied at draw.** `uiLayout.ts`
 * subtracts it from the content origin, so a scrolled child's rectangle simply is where it is —
 * and hit testing, focus and clipping keep working without any of them knowing that scrolling
 * exists. Applied at draw, each of those would need the inverse and one of them would eventually
 * get it wrong in one direction only.
 *
 * **A scroll that moves nothing says so.** Nested containers are the case: a wheel over an inner
 * list that has reached its end should scroll the outer one rather than stopping dead, and a
 * caller that cannot tell "consumed" from "already at the end" cannot implement that. The boolean
 * is the whole mechanism.
 */
import type { UiNode } from './uiNode.ts';
import { uiRectHolds } from './uiNode.ts';

/**
 * How far this node's contents extend past its own box, along each axis.
 *
 * Read from the span `layoutUiTree` measured, which is relative to the content origin and so does
 * not change as the node scrolls. **Deriving it from placed rectangles plus the live scroll value
 * is wrong**, and wrong in the one situation it is asked about: after a caller has moved the
 * scroll, the rectangles still reflect the previous value and the two no longer agree.
 */
export function scrollExtent(node: UiNode): { x: number; y: number } {
  const contentW = Math.max(0, node.rect.w - node.paddingLeft - node.paddingRight);
  const contentH = Math.max(0, node.rect.h - node.paddingTop - node.paddingBottom);
  return {
    x: Math.max(0, node.contentSpanX - contentW),
    y: Math.max(0, node.contentSpanY - contentH),
  };
}

export function clampScroll(node: UiNode): void {
  const extent = scrollExtent(node);
  node.scrollX = Math.min(Math.max(0, node.scrollX), extent.x);
  node.scrollY = Math.min(Math.max(0, node.scrollY), extent.y);
}

/** Scroll, clamped. Returns whether anything actually moved — see the header for why. */
export function scrollBy(node: UiNode, dx: number, dy: number): boolean {
  const beforeX = node.scrollX;
  const beforeY = node.scrollY;
  node.scrollX += dx;
  node.scrollY += dy;
  clampScroll(node);
  return node.scrollX !== beforeX || node.scrollY !== beforeY;
}

/* Reused across calls: this runs per wheel event and the chain is its only allocation. */
const CHAIN: UiNode[] = [];

/**
 * Give a wheel to the innermost container under the pointer that can use it, then outwards.
 *
 * Innermost first is the order a person expects and the opposite of the order the tree makes
 * convenient, so the chain is collected on the way down and walked back up. Returns the node that
 * consumed it, or null when nothing did — which is a caller's signal to let the page have it.
 */
export function routeScrollWheel(
  root: UiNode,
  x: number,
  y: number,
  dx: number,
  dy: number,
): UiNode | null {
  let depth = 0;
  let walk: UiNode | null = root;
  while (walk !== null) {
    CHAIN[depth] = walk;
    depth += 1;
    let next: UiNode | null = null;
    for (let i = walk.children.length - 1; i >= 0; i -= 1) {
      const child = walk.children[i] as UiNode;
      if (!child.hidden && uiRectHolds(child, x, y)) {
        next = child;
        break;
      }
    }
    walk = next;
  }

  for (let i = depth - 1; i >= 0; i -= 1) {
    const node = CHAIN[i] as UiNode;
    if (!node.clip) continue;
    if (scrollBy(node, dx, dy)) return node;
  }
  return null;
}
