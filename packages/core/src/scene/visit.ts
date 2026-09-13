import { sphereInFrustum } from '../math/frustum.ts';
import type { Frustum } from '../math/frustum.ts';
import type { SceneNode } from './node.ts';

/**
 * What a traversal discarded, and what it handed over.
 *
 * **The pruned count is a measurement rather than a curiosity.** A hierarchy that prunes nothing
 * is a linear scan with extra steps, and the only way to know which one a given world produces is
 * to count. A caller printing this beside its frame time is what turns "the partition helps" from
 * a belief into a number.
 */
export interface VisitResult {
  /** Nodes with geometry handed to the visitor. */
  visited: number;
  /** Subtrees rejected whole, each standing for every node beneath it. */
  pruned: number;
  /** Nodes reached and tested, which is what `pruned` saved a multiple of. */
  tested: number;
}

/**
 * Walk a hierarchy, skipping any subtree the frustum rejects.
 *
 * **This is the spatial partition, and there is no second structure.** A node's world bounds
 * enclose every descendant's, so rejecting a parent rejects everything under it — which is what a
 * bounding-volume hierarchy is. The caller builds it by describing its world, and the pruning is
 * free. `IMPROVEMENTS.md` recorded a trigger for building a BVH; this retires it rather than
 * meeting it.
 *
 * **It does not draw.** `visit` is handed a node and the caller decides what verb that is worth,
 * in whatever order it likes. The render graph work established that draw order carries meaning,
 * and a traversal that issued draws would be deciding it.
 *
 * **A node with no geometry is not visited, but its children are.** A group is scaffolding, and
 * handing one to a visitor gives a caller something with nothing to draw.
 *
 * Allocates nothing: `out` is the caller's, and the visitor is called rather than collected.
 */
export function visitVisible(
  root: SceneNode,
  frustum: Frustum,
  visit: (node: SceneNode) => void,
  out: VisitResult,
): VisitResult {
  out.visited = 0;
  out.pruned = 0;
  out.tested = 0;
  walk(root, frustum, visit, out);
  return out;
}

function walk(
  node: SceneNode,
  frustum: Frustum,
  visit: (node: SceneNode) => void,
  out: VisitResult,
): void {
  out.tested += 1;
  const bounds = node.worldBounds;
  if (
    !sphereInFrustum(
      frustum,
      bounds.centre[0] ?? 0,
      bounds.centre[1] ?? 0,
      bounds.centre[2] ?? 0,
      bounds.radius,
    )
  ) {
    out.pruned += 1;
    return;
  }
  if (node.hasGeometry) {
    out.visited += 1;
    visit(node);
  }
  for (const child of node.children) walk(child, frustum, visit, out);
}

export function createVisitResult(): VisitResult {
  return { visited: 0, pruned: 0, tested: 0 };
}
