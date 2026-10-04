/** Which node a point is on, and which node a keyboard should be talking to. */

import { uiRectHolds } from './uiNode.ts';
import type { UiNode } from './uiNode.ts';
import { layersPresent } from './uiLayer.ts';

/**
 * The interactive node under a point, or `null`.
 *
 * **Searched last-drawn first**, because the last thing drawn is the thing on top and a hit test
 * that disagreed with the picture would be a button that responds where it is not.
 *
 * **A node that is not `interactive` does not block what is behind it.** A panel is a backdrop, and
 * a backdrop that swallowed clicks would make every button under a plate dead — which is the
 * failure a caller cannot see and would spend an afternoon on. A caller that wants a modal to
 * swallow clicks marks the modal itself interactive, which says so.
 *
 * Allocates nothing.
 */
export function uiHitTest(root: UiNode, x: number, y: number): UiNode | null {
  /* The highest layer first, as it is drawn last: a raised popup takes the pointer over a later
     sibling it covers. See `drawUiTree`. */
  const count = layersPresent(root, HIT_LAYERS);
  for (let at = count - 1; at >= 0; at -= 1) {
    const hit = hitOn(root, x, y, 0, HIT_LAYERS[at] ?? 0);
    if (hit !== null) return hit;
  }
  return null;
}

/** The layers of the tree being pointed at, reused: a hit test runs per pointer event. */
const HIT_LAYERS: number[] = [];

function hitOn(node: UiNode, x: number, y: number, inherited: number, only: number): UiNode | null {
  if (node.hidden) return null;
  /* A clipping node bounds its descendants here as it does in the picture: a row scrolled out of a
     list is not under the pointer, whatever is drawn where it would have been. */
  if (node.clip && !uiRectHolds(node, x, y)) return null;
  const layer = node.layer === 0 ? inherited : node.layer;
  for (let i = node.children.length - 1; i >= 0; i -= 1) {
    const hit = hitOn(node.children[i] as UiNode, x, y, layer, only);
    if (hit !== null) return hit;
  }
  return layer === only && node.interactive && uiRectHolds(node, x, y) ? node : null;
}

/**
 * Every focusable node, in tree order, appended to `out`.
 *
 * Tree order rather than a declared tab index: the order a tree is built in is the order it reads
 * in, and a second ordering is a second thing to keep in step with the first. A caller that wants a
 * different order moves the node.
 *
 * `out` is cleared first and reused, so a caller may hold one array. This is not a per-frame path —
 * focus changes when a key is pressed.
 */
export function uiFocusOrder(root: UiNode, out: UiNode[]): UiNode[] {
  out.length = 0;
  gather(root, out);
  return out;
}

function gather(node: UiNode, out: UiNode[]): void {
  if (node.hidden) return;
  if (node.focusable) out.push(node);
  for (const child of node.children) gather(child, out);
}

/* One array, reused by the two step functions below. Neither is reentrant and neither needs to be. */
const ORDER: UiNode[] = [];

/**
 * The next focusable node after `current`, wrapping.
 *
 * `null` for `current` starts at the first, which is what a tree that has never been focused wants.
 * `null` comes back only when nothing at all is focusable.
 */
export function uiFocusNext(root: UiNode, current: UiNode | null): UiNode | null {
  return step(root, current, 1);
}

/** The focusable node before `current`, wrapping. */
export function uiFocusPrevious(root: UiNode, current: UiNode | null): UiNode | null {
  return step(root, current, -1);
}

function step(root: UiNode, current: UiNode | null, by: number): UiNode | null {
  uiFocusOrder(root, ORDER);
  if (ORDER.length === 0) return null;
  const at = current === null ? -1 : ORDER.indexOf(current);
  /*
   * A `current` that is not in the list — hidden since it was focused, or removed from the tree —
   * lands here as -1 and starts from the beginning going forward, or the end going back. Better
   * than refusing: a node that disappeared under the focus should not take the keyboard with it.
   */
  if (at < 0) return (by > 0 ? ORDER[0] : ORDER[ORDER.length - 1]) as UiNode;
  const next = (at + by + ORDER.length) % ORDER.length;
  return ORDER[next] as UiNode;
}
