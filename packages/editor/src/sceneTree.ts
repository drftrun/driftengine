/**
 * A flattened, collapsible, named view of a `SceneNode` hierarchy.
 *
 * **A view and not a second scene graph.** The hierarchy belongs to `@driftengine/core`; this holds
 * what an editor needs on top of it — which rows are showing, which is selected, and what each one
 * is called — and nothing that a game running without an editor should carry.
 *
 * **The names live here, and that is the one real decision in this file.** `SceneNode` has none. A
 * string on every node would be paid by every game, in every serialised scene and every allocation
 * of a node, to serve an editor most of them never open. A map here is paid by whoever builds a
 * tree.
 */
import type { SceneNode } from '@driftengine/core';

/** One line of the flattened tree. Reused between rebuilds; copy what you keep. */
export interface TreeRow {
  node: SceneNode;
  /** How deep, with the root at zero. What a panel indents by. */
  depth: number;
  /** Whether this node has children at all, which is what draws a twisty. */
  hasChildren: boolean;
  /** Whether its children are showing. Meaningless when `hasChildren` is false. */
  expanded: boolean;
  name: string;
}

/** What a node with no name of its own is called. */
const UNNAMED = 'node';

export class SceneTree {
  /** What is selected, or null. Assigning is fine; nothing here caches it. */
  selected: SceneNode | null = null;

  private readonly names = new Map<SceneNode, string>();
  private readonly collapsed = new Set<SceneNode>();
  /**
   * Rows, reused.
   *
   * `rowCount` is how many of them are live, so a rebuild that produces fewer rows than the last
   * one does not allocate and does not have to clear the tail. `rows` slices to the live ones.
   */
  private readonly pool: TreeRow[] = [];
  private rowCount = 0;
  private readonly live: TreeRow[] = [];

  /** The rows the last `rebuild` produced, in the order they draw. */
  get rows(): readonly TreeRow[] {
    return this.live;
  }

  /** What a node is called. Nodes are `node` until something names them. */
  name(node: SceneNode): string {
    return this.names.get(node) ?? UNNAMED;
  }

  setName(node: SceneNode, name: string): void {
    this.names.set(node, name);
  }

  /** Whether a node's children are showing. Everything starts expanded. */
  expanded(node: SceneNode): boolean {
    return !this.collapsed.has(node);
  }

  setExpanded(node: SceneNode, expanded: boolean): void {
    if (expanded) this.collapsed.delete(node);
    else this.collapsed.add(node);
  }

  toggle(node: SceneNode): void {
    this.setExpanded(node, !this.expanded(node));
  }

  /**
   * Walk the hierarchy into rows, honouring collapse.
   *
   * A collapsed node contributes its own row and nothing beneath it, which is what collapsing is;
   * its children keep whatever expansion state they had, so expanding a branch again shows what was
   * showing before rather than a flattened one.
   *
   * Cheap enough to call every frame, and it allocates nothing once the deepest tree it has seen
   * has been seen.
   */
  rebuild(root: SceneNode): void {
    this.rowCount = 0;
    this.visit(root, 0);
    this.live.length = 0;
    for (let at = 0; at < this.rowCount; at++) this.live.push(this.pool[at] as TreeRow);
  }

  /** Where a node sits in the last rebuild's rows, or `-1`. */
  rowOf(node: SceneNode): number {
    for (let at = 0; at < this.live.length; at++) {
      if ((this.live[at] as TreeRow).node === node) return at;
    }
    return -1;
  }

  /**
   * Move a node under a new parent. `false` where the hierarchy refuses.
   *
   * **The refusal is `SceneNode`'s and is not re-implemented here**, which was checked rather than
   * assumed: `attachChild` already rejects a node as its own child and any ancestor as its own
   * descendant. What this adds is answering rather than throwing, because the caller is a drag in a
   * frame and an exception there takes down the frame somebody is dragging in.
   */
  reparent(child: SceneNode, parent: SceneNode): boolean {
    try {
      parent.attachChild(child);
      return true;
    } catch {
      return false;
    }
  }

  /** Forget a node's name and expansion, for a node that has left the tree. */
  forget(node: SceneNode): void {
    this.names.delete(node);
    this.collapsed.delete(node);
    if (this.selected === node) this.selected = null;
  }

  private visit(node: SceneNode, depth: number): void {
    const row = this.rowAt(this.rowCount);
    this.rowCount += 1;
    row.node = node;
    row.depth = depth;
    row.hasChildren = node.children.length > 0;
    row.expanded = this.expanded(node);
    row.name = this.name(node);
    if (!row.expanded) return;
    for (const child of node.children) this.visit(child, depth + 1);
  }

  private rowAt(index: number): TreeRow {
    const existing = this.pool[index];
    if (existing !== undefined) return existing;
    const made: TreeRow = {
      node: undefined as unknown as SceneNode,
      depth: 0,
      hasChildren: false,
      expanded: true,
      name: UNNAMED,
    };
    this.pool.push(made);
    return made;
  }
}
