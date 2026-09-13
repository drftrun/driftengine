import { SceneNode } from '@driftengine/core';
import { expect, test } from 'vitest';
import { SceneTree } from './sceneTree.ts';

/** A root with two children, the first of which has one of its own. */
function hierarchy(): { root: SceneNode; a: SceneNode; b: SceneNode; leaf: SceneNode } {
  const root = new SceneNode();
  const a = new SceneNode();
  const b = new SceneNode();
  const leaf = new SceneNode();
  root.attachChild(a);
  root.attachChild(b);
  a.attachChild(leaf);
  return { root, a, b, leaf };
}

test('a rebuild flattens the hierarchy depth first', () => {
  const { root, a, b, leaf } = hierarchy();
  const tree = new SceneTree();
  tree.rebuild(root);
  expect(tree.rows.map((row) => row.node)).toEqual([root, a, leaf, b]);
  expect(tree.rows.map((row) => row.depth)).toEqual([0, 1, 2, 1]);
});

test('a row knows whether it has children', () => {
  const { root, leaf } = hierarchy();
  const tree = new SceneTree();
  tree.rebuild(root);
  expect(tree.rows[0]!.hasChildren).toBe(true);
  expect(tree.rows.find((row) => row.node === leaf)!.hasChildren).toBe(false);
});

test('collapsing a node removes its subtree and nothing else', () => {
  const { root, a, b } = hierarchy();
  const tree = new SceneTree();
  tree.setExpanded(a, false);
  tree.rebuild(root);
  expect(tree.rows.map((row) => row.node)).toEqual([root, a, b]);
});

/* The control for the assertion above: a leaf has no subtree to remove. */
test('collapsing a leaf changes nothing', () => {
  const { root, leaf } = hierarchy();
  const tree = new SceneTree();
  tree.rebuild(root);
  const before = tree.rows.length;
  tree.setExpanded(leaf, false);
  tree.rebuild(root);
  expect(tree.rows.length).toBe(before);
});

/*
 * Expanding restores what was showing rather than a flattened branch: a child collapsed inside a
 * collapsed parent stays collapsed when the parent opens.
 */
test('expanding a branch restores the state its children had', () => {
  const { root, a, leaf } = hierarchy();
  const leafChild = new SceneNode();
  leaf.attachChild(leafChild);
  const tree = new SceneTree();
  tree.setExpanded(leaf, false);
  tree.setExpanded(a, false);
  tree.rebuild(root);
  expect(tree.rows.length).toBe(3);
  tree.setExpanded(a, true);
  tree.rebuild(root);
  expect(tree.rows.map((row) => row.node)).toEqual([root, a, leaf, tree.rows[3]!.node]);
  expect(tree.rows.length).toBe(4);
});

test('toggle flips what expanded reports', () => {
  const { root, a } = hierarchy();
  const tree = new SceneTree();
  expect(tree.expanded(a)).toBe(true);
  tree.toggle(a);
  expect(tree.expanded(a)).toBe(false);
  tree.toggle(a);
  expect(tree.expanded(a)).toBe(true);
  tree.rebuild(root);
  expect(tree.rows.length).toBe(4);
});

test('a node is called node until something names it', () => {
  const { root, a } = hierarchy();
  const tree = new SceneTree();
  expect(tree.name(a)).toBe('node');
  tree.setName(a, 'lamp');
  tree.rebuild(root);
  expect(tree.rows[1]!.name).toBe('lamp');
});

test('rowOf finds a node in the last rebuild and answers -1 for one that is not showing', () => {
  const { root, a, leaf } = hierarchy();
  const tree = new SceneTree();
  tree.setExpanded(a, false);
  tree.rebuild(root);
  expect(tree.rowOf(a)).toBe(1);
  expect(tree.rowOf(leaf)).toBe(-1);
});

/*
 * The refusal is `SceneNode.attachChild`'s and is not re-implemented here, which was checked rather
 * than assumed. What this adds is answering instead of throwing, because the caller is a drag inside
 * a frame.
 */
test('reparenting under a descendant is refused rather than thrown', () => {
  const { root, a, leaf } = hierarchy();
  const tree = new SceneTree();
  expect(tree.reparent(a, leaf)).toBe(false);
  expect(a.parent).toBe(root);
});

test('reparenting a node under itself is refused too', () => {
  const { a } = hierarchy();
  const tree = new SceneTree();
  expect(tree.reparent(a, a)).toBe(false);
});

test('an ordinary reparent moves the node and the rows follow', () => {
  const { root, a, b, leaf } = hierarchy();
  const tree = new SceneTree();
  expect(tree.reparent(leaf, b)).toBe(true);
  expect(leaf.parent).toBe(b);
  tree.rebuild(root);
  expect(tree.rows.map((row) => row.node)).toEqual([root, a, b, leaf]);
});

test('forgetting a node drops its name, its collapse and its selection', () => {
  const { root, a } = hierarchy();
  const tree = new SceneTree();
  tree.setName(a, 'lamp');
  tree.setExpanded(a, false);
  tree.selected = a;
  tree.forget(a);
  expect(tree.name(a)).toBe('node');
  expect(tree.expanded(a)).toBe(true);
  expect(tree.selected).toBe(null);
  tree.rebuild(root);
  expect(tree.rows.length).toBe(4);
});

/* Rows are reused, so a rebuild that shrinks must not leave the old tail showing. */
test('a rebuild that produces fewer rows shows only the ones it produced', () => {
  const { root, a } = hierarchy();
  const tree = new SceneTree();
  tree.rebuild(root);
  expect(tree.rows.length).toBe(4);
  tree.setExpanded(root, false);
  tree.rebuild(root);
  expect(tree.rows.length).toBe(1);
  expect(tree.rows[0]!.node).toBe(root);
  tree.setExpanded(root, true);
  tree.rebuild(root);
  expect(tree.rows.length).toBe(4);
  expect(tree.rows[1]!.node).toBe(a);
});

/* A rebuild after warmup must allocate no rows, which is what makes it safe every frame. */
test('rebuilding twice reuses the same row objects', () => {
  const { root } = hierarchy();
  const tree = new SceneTree();
  tree.rebuild(root);
  const first = tree.rows[0];
  tree.rebuild(root);
  expect(tree.rows[0]).toBe(first);
});
