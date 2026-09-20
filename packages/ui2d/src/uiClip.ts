/**
 * How far a node may draw, given the clipping ancestors above it.
 *
 * **A rectangle rather than a stack of them.** Successive clips intersect, and the intersection of
 * any number of rectangles is one rectangle, so the whole history above a node collapses into four
 * numbers. That is what makes this cheap enough to compute per node per frame rather than
 * maintained as state that can go stale.
 *
 * **An empty result is reported, not encoded.** A node clipped entirely away would otherwise
 * produce a negative width, which every consumer would then have to remember to check; instead
 * `clipRectFor` returns false and the caller skips the subtree. The rectangle it leaves behind is
 * degenerate but never negative, because a negative size reaching a scissor call is a validation
 * error on one backend and a silent full-screen draw on the other.
 *
 * **A clipping node does not clip itself.** It bounds its descendants; cutting it to its own
 * rectangle is a no-op in the ordinary case and wrong in the case where a caller has given it a
 * border that draws outside its content box.
 */
import type { UiNode, UiRect } from './uiNode.ts';

/** Write the overlap of two rectangles into `out`. Never negative; see the header. */
export function intersectClip(out: UiRect, parent: UiRect, child: UiRect): void {
  const left = Math.max(parent.x, child.x);
  const top = Math.max(parent.y, child.y);
  const right = Math.min(parent.x + parent.w, child.x + child.w);
  const bottom = Math.min(parent.y + parent.h, child.y + child.h);
  out.x = left;
  out.y = top;
  out.w = Math.max(0, right - left);
  out.h = Math.max(0, bottom - top);
}

/* Reused across calls: this runs per node per frame and the chain is its only allocation. */
const CHAIN: UiNode[] = [];

/**
 * The rectangle `node` may draw into, cut by every clipping ancestor between it and `root`.
 *
 * Returns false when nothing of it survives, which is the caller's signal to skip the subtree
 * rather than issue a draw that covers no pixels.
 */
export function clipRectFor(root: UiNode, node: UiNode, out: UiRect): boolean {
  out.x = node.rect.x;
  out.y = node.rect.y;
  out.w = node.rect.w;
  out.h = node.rect.h;

  /*
   * Collected on the way up and applied on the way down, because the intersection has to run
   * outermost-first: an inner clip can only narrow an outer one, so the wrong order happens to be
   * right for nested rectangles and is wrong for offset ones.
   */
  let depth = 0;
  let walk: UiNode | null = node.parent;
  while (walk !== null) {
    CHAIN[depth] = walk;
    depth += 1;
    if (walk === root) break;
    walk = walk.parent;
  }

  for (let i = depth - 1; i >= 0; i -= 1) {
    const ancestor = CHAIN[i] as UiNode;
    if (!ancestor.clip) continue;
    intersectClip(out, ancestor.rect, out);
  }

  return out.w > 0 && out.h > 0;
}
