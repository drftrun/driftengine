/**
 * Draw order when tree order is not enough.
 *
 * A dropdown is owned by the control that opens it and must cover the panel that control sits in;
 * a drag preview is owned by the thing being dragged and must cover everything. Tree order cannot
 * express either, because ownership and covering point in opposite directions.
 *
 * **A layer is inherited.** A popup's own children have to ride with it, or a menu draws above the
 * panel and its labels draw below it — which is the first bug any other arrangement produces.
 *
 * **A stable sort, and the stability is a requirement rather than a nicety.** Two nodes on one
 * layer that swap between frames produce a flicker nobody can reproduce on demand. Sorting the
 * traversal indices rather than the nodes makes the tiebreaker the traversal order by
 * construction, so it cannot be lost to whatever the sort implementation guarantees.
 */
import type { UiNode } from './uiNode.ts';

/* Reused across calls: this runs per frame and these are its only allocations. */
const FLAT: UiNode[] = [];
const LAYERS: number[] = [];
const ORDER: number[] = [];

function gather(node: UiNode, inherited: number, at: number): number {
  if (node.hidden) return at;
  const layer = node.layer === 0 ? inherited : node.layer;
  FLAT[at] = node;
  LAYERS[at] = layer;
  let next = at + 1;
  for (const child of node.children) next = gather(child, layer, next);
  return next;
}

/** Fill `out` with the tree in draw order and return how many entries were written. */
export function layerOrder(root: UiNode, out: UiNode[]): number {
  const count = gather(root, 0, 0);

  ORDER.length = 0;
  for (let i = 0; i < count; i += 1) ORDER.push(i);
  ORDER.sort((a, b) => {
    const byLayer = (LAYERS[a] ?? 0) - (LAYERS[b] ?? 0);
    return byLayer !== 0 ? byLayer : a - b;
  });

  for (let i = 0; i < count; i += 1) out[i] = FLAT[ORDER[i] ?? 0] as UiNode;
  out.length = count;
  return count;
}
