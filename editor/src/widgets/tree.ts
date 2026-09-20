/**
 * A virtualised, expandable tree.
 *
 * **Expansion is keyed by identifier and never by row index**, which is the whole point of this
 * file. Keyed by index, adding one entity above a collapsed branch shifts every index below it and
 * the collapse lands on whatever moved into that slot — so a scene tree appears to collapse itself
 * every time anything is added, which is the single most common defect in an editor's outliner.
 * The identifier is the caller's; nothing here invents one.
 *
 * **Collapsed is the stored state and expanded is the default.** A tree that stored the expanded
 * set would show a brand new branch closed, and a scene that has just loaded would be one row.
 *
 * **Building rows costs a screenful rather than a tree.** `rebuildTree` walks the caller's list
 * once to work out what is showing, which is unavoidable and cheap; `layoutTree` then builds nodes
 * only for the rows `visibleRange` says are on screen, and reuses them as the list scrolls. Ten
 * thousand rows and ten build the same number of nodes.
 */
import { createUiNode, visibleRange } from '@driftengine/ui2d';
import type { RowWindow, UiNode } from '@driftengine/ui2d';

/** One row of the caller's fully expanded model. The tree does the hiding. */
export interface TreeItem {
  /** Stable across rebuilds. What expansion is remembered by. */
  readonly id: number;
  /** Zero at the root. What the row indents by, and what collapsing is judged against. */
  readonly depth: number;
  readonly hasChildren: boolean;
  readonly label: string;
}

export interface TreeOptions {
  readonly rowHeight?: number;
  /** Rows built beyond each edge of the view, so a scroll does not show a gap before it fills. */
  readonly overscan?: number;
  readonly indent?: number;
  readonly name?: string;
}

export interface Tree {
  /** The scrolling container. Its children are the rows currently on screen. */
  readonly node: UiNode;
  rowHeight: number;
  overscan: number;
  indent: number;
  scrollY: number;
  /** Identifiers whose children are hidden. Absent means showing. */
  readonly collapsed: Set<number>;
  /** What the last `rebuildTree` decided is showing, in draw order. */
  readonly visible: TreeItem[];
  /** Which slice of `visible` the last `layoutTree` built nodes for. */
  window: RowWindow;
}

export function createTree(options: TreeOptions = {}): Tree {
  return {
    node: createUiNode({
      direction: 'column',
      width: 'grow',
      height: 'grow',
      clip: true,
      name: options.name ?? '',
    }),
    rowHeight: options.rowHeight ?? 20,
    overscan: options.overscan ?? 2,
    indent: options.indent ?? 12,
    scrollY: 0,
    collapsed: new Set<number>(),
    visible: [],
    window: { first: 0, count: 0 },
  };
}

export function isTreeExpanded(tree: Tree, id: number): boolean {
  return !tree.collapsed.has(id);
}

export function expandTree(tree: Tree, id: number): void {
  tree.collapsed.delete(id);
}

export function collapseTree(tree: Tree, id: number): void {
  tree.collapsed.add(id);
}

export function toggleTreeRow(tree: Tree, id: number): void {
  if (tree.collapsed.has(id)) tree.collapsed.delete(id);
  else tree.collapsed.add(id);
}

/**
 * Work out which of the caller's rows are showing.
 *
 * **A collapsed row contributes itself and nothing beneath it**, where "beneath" is every following
 * row of greater depth. That is one pass and no tree structure: the depth column already holds the
 * hierarchy, so skipping a subtree is skipping forward until the depth comes back.
 *
 * A collapsed row's descendants keep their own state while they are hidden, so opening a branch
 * again shows what was showing before rather than a flattened one.
 */
export function rebuildTree(tree: Tree, items: readonly TreeItem[]): void {
  tree.visible.length = 0;
  for (let at = 0; at < items.length; at += 1) {
    const item = items[at] as TreeItem;
    tree.visible.push(item);
    if (!item.hasChildren || !tree.collapsed.has(item.id)) continue;
    /* Skip the subtree: everything following that is deeper than this row. */
    while (at + 1 < items.length && (items[at + 1] as TreeItem).depth > item.depth) at += 1;
  }
}

/** Where a row sits in the visible list, or -1 when it is hidden or absent. */
export function visibleIndexOf(tree: Tree, id: number): number {
  for (let at = 0; at < tree.visible.length; at += 1) {
    if ((tree.visible[at] as TreeItem).id === id) return at;
  }
  return -1;
}

/**
 * The row at a position in the tree's own content space, or null.
 *
 * Content space rather than screen space, so this is scroll-independent arithmetic: the caller
 * subtracts the container's origin and adds `scrollY`, exactly as it would for any other scrolled
 * content. **A hidden row is not in `visible`, so it cannot be hit** — the containment the test
 * asks for falls out of the same list the drawing uses rather than being a second rule.
 */
export function treeRowAt(tree: Tree, y: number): TreeItem | null {
  if (y < 0 || tree.rowHeight <= 0) return null;
  const at = Math.floor(y / tree.rowHeight);
  return at < tree.visible.length ? (tree.visible[at] as TreeItem) : null;
}

/**
 * Build nodes for the rows on screen and nothing else.
 *
 * The node pool is the container's own children, grown to the widest window seen and then reused:
 * scrolling a ten-thousand-row list rewrites twenty-four nodes rather than allocating any.
 */
export function layoutTree(tree: Tree, viewHeight: number): RowWindow {
  const window = visibleRange(
    tree.scrollY,
    viewHeight,
    tree.rowHeight,
    tree.visible.length,
    tree.overscan,
  );
  tree.window = window;

  const rows = tree.node.children;
  while (rows.length < window.count) {
    const row = createUiNode({ width: 'grow', height: tree.rowHeight, interactive: true });
    row.parent = tree.node;
    rows.push(row);
  }
  rows.length = window.count;

  for (let at = 0; at < window.count; at += 1) {
    const item = tree.visible[window.first + at] as TreeItem;
    const row = rows[at] as UiNode;
    row.text = item.label;
    row.name = String(item.id);
    row.height = tree.rowHeight;
    row.paddingLeft = item.depth * tree.indent;
  }
  return window;
}
