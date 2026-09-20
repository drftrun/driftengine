import { describe, expect, it } from 'vitest';
import { createSelection, isSelected, selectOnly } from '@driftengine/tools';
import {
  collapseTree,
  createTree,
  expandTree,
  layoutTree,
  rebuildTree,
  toggleTreeRow,
  treeRowAt,
  visibleIndexOf,
} from './tree.ts';
import type { TreeItem } from './tree.ts';

/** A parent with `kids` children each, as the fully expanded list a caller hands in. */
function family(parents: number, kids: number): TreeItem[] {
  const items: TreeItem[] = [];
  let id = 0;
  for (let p = 0; p < parents; p += 1) {
    items.push({ id: id++, depth: 0, hasChildren: kids > 0, label: `parent ${p}` });
    for (let k = 0; k < kids; k += 1) {
      items.push({ id: id++, depth: 1, hasChildren: false, label: `child ${p}.${k}` });
    }
  }
  return items;
}

describe('a tree', () => {
  it('shows everything when nothing is collapsed', () => {
    const tree = createTree({ rowHeight: 20 });
    rebuildTree(tree, family(3, 2));
    expect(tree.visible.length).toBe(9);
  });

  it('hides a collapsed branch and shows the branch itself', () => {
    const tree = createTree({ rowHeight: 20 });
    const items = family(3, 2);
    rebuildTree(tree, items);

    toggleTreeRow(tree, 0);
    rebuildTree(tree, items);
    expect(tree.visible.length, 'two children went away, the parent stayed').toBe(7);
    expect(tree.visible[0]?.id).toBe(0);
    expect(tree.visible[1]?.id, 'the next parent follows immediately').toBe(3);
  });

  /** A branch collapsed inside a collapsed branch stays collapsed when the outer one opens. */
  it('remembers what was collapsed underneath', () => {
    const items: TreeItem[] = [
      { id: 0, depth: 0, hasChildren: true, label: 'a' },
      { id: 1, depth: 1, hasChildren: true, label: 'b' },
      { id: 2, depth: 2, hasChildren: false, label: 'c' },
      { id: 3, depth: 1, hasChildren: false, label: 'd' },
    ];
    const tree = createTree({ rowHeight: 20 });

    collapseTree(tree, 1);
    collapseTree(tree, 0);
    rebuildTree(tree, items);
    expect(tree.visible.map((row) => row.id)).toEqual([0]);

    expandTree(tree, 0);
    rebuildTree(tree, items);
    expect(
      tree.visible.map((row) => row.id),
      'b is still shut',
    ).toEqual([0, 1, 3]);
  });

  /**
   * **The defect that makes a scene tree collapse itself every time an entity is added.** Keyed by
   * row index, adding one entity above a collapsed branch shifts every index below it, and the
   * collapse lands on whatever moved into that slot. Keyed by identifier it cannot.
   */
  it('keeps its expansion state across a rebuild that renumbers everything', () => {
    const tree = createTree({ rowHeight: 20 });
    const before = family(2, 2);
    rebuildTree(tree, before);
    collapseTree(tree, 3);
    rebuildTree(tree, before);
    expect(tree.visible.map((row) => row.id)).toEqual([0, 1, 2, 3]);

    /* A new entity arrives at the top, so every row this tree knew about has moved down one. */
    const after: TreeItem[] = [{ id: 99, depth: 0, hasChildren: false, label: 'new' }, ...before];
    rebuildTree(tree, after);
    expect(
      tree.visible.map((row) => row.id),
      'still 3 that is shut, not whatever took its place',
    ).toEqual([99, 0, 1, 2, 3]);
  });

  /** Expanding rearranges the rows. It must not touch what is selected. */
  it('changes the visible set and not the selection', () => {
    const tree = createTree({ rowHeight: 20 });
    const items = family(2, 2);
    collapseTree(tree, 0);
    rebuildTree(tree, items);

    /* Ids run 0(parent) 1 2(children) 3(parent) 4 5, so collapsing 0 leaves 0, 3, 4, 5. */
    const selection = createSelection();
    selectOnly(selection, 5);
    expect(visibleIndexOf(tree, 5)).toBe(3);

    expandTree(tree, 0);
    rebuildTree(tree, items);

    expect(visibleIndexOf(tree, 5), 'the row moved').toBe(5);
    expect(isSelected(selection, 5), 'and the selection did not').toBe(true);
    expect(selection.entities).toEqual([5]);
  });

  it('is not hit-testable inside a collapsed subtree', () => {
    const tree = createTree({ rowHeight: 20 });
    const items = family(2, 2);
    rebuildTree(tree, items);
    expect(treeRowAt(tree, 25)?.id, 'the first child is the second row').toBe(1);

    collapseTree(tree, 0);
    rebuildTree(tree, items);
    expect(treeRowAt(tree, 25)?.id, 'that row is the next parent now').toBe(3);
    for (let y = 0; y < 20 * tree.visible.length; y += 1) {
      expect(treeRowAt(tree, y)?.id, 'nothing anywhere reaches a hidden row').not.toBe(1);
    }
  });

  it('reports nothing above the first row or below the last', () => {
    const tree = createTree({ rowHeight: 20 });
    rebuildTree(tree, family(1, 1));
    expect(treeRowAt(tree, -1)).toBe(null);
    expect(treeRowAt(tree, 40)).toBe(null);
  });
});

describe('a tree of ten thousand rows', () => {
  const HUGE = 10_000;

  function huge(): TreeItem[] {
    const items: TreeItem[] = [];
    for (let i = 0; i < HUGE; i += 1) {
      items.push({ id: i, depth: 0, hasChildren: false, label: `row ${i}` });
    }
    return items;
  }

  /** The claim is that it costs a screenful, and the count of built nodes is what says so. */
  it('builds a screenful of nodes and not a tree of them', () => {
    const tree = createTree({ rowHeight: 20, overscan: 2 });
    rebuildTree(tree, huge());
    layoutTree(tree, 400);

    expect(tree.visible.length).toBe(HUGE);
    /*
     * Twenty rows fill 400 pixels and two more are built past the bottom edge. There is no
     * overscan above, because there is nothing above row zero to overscan into — `visibleRange`
     * applies the margin before clamping, which is what keeps a caller from indexing rows that do
     * not exist.
     */
    expect(tree.window.count).toBe(22);
    expect(tree.node.children.length).toBe(22);
  });

  it('costs the same at the bottom of the list as at the top', () => {
    const tree = createTree({ rowHeight: 20, overscan: 2 });
    rebuildTree(tree, huge());
    layoutTree(tree, 400);
    const atTop = tree.node.children.length;

    tree.scrollY = 20 * (HUGE - 20);
    layoutTree(tree, 400);
    expect(tree.window.first).toBe(HUGE - 22);
    expect(tree.node.children.length, 'the same screenful, further down').toBe(atTop);
    expect(tree.node.children[0]?.text).toBe(`row ${HUGE - 22}`);
  });

  /** In the middle there is something to overscan into at both ends, and the window is widest. */
  it('overscans both ways once it is away from the ends', () => {
    const tree = createTree({ rowHeight: 20, overscan: 2 });
    rebuildTree(tree, huge());
    tree.scrollY = 5_000;
    layoutTree(tree, 400);
    expect(tree.window.first).toBe(248);
    expect(tree.window.count).toBe(24);
  });

  /** The node pool is reused, so scrolling a long list does not allocate a long list of nodes. */
  it('reuses its row nodes as it scrolls', () => {
    const tree = createTree({ rowHeight: 20, overscan: 2 });
    rebuildTree(tree, huge());
    layoutTree(tree, 400);
    const first = tree.node.children[0];

    tree.scrollY = 2000;
    layoutTree(tree, 400);
    expect(tree.node.children[0], 'the same node, carrying a different row').toBe(first);
    expect(first?.text).toBe('row 98');
  });

  it('shrinks the screenful when the list is shorter than the view', () => {
    const tree = createTree({ rowHeight: 20, overscan: 2 });
    rebuildTree(tree, family(1, 2));
    layoutTree(tree, 400);
    expect(tree.node.children.length).toBe(3);
  });
});
