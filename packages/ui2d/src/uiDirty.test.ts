import { expect, test } from 'vitest';
import { createDirtyTracker, diffTree, dirtyBounds, markDirty } from './uiDirty.ts';
import { layoutUiTree } from './uiLayout.ts';
import { addUiChild, createUiNode } from './uiNode.ts';

test('an untouched tree reports nothing to redraw on the second frame', () => {
  const root = createUiNode({ width: 100, height: 100 });
  addUiChild(root, createUiNode({ width: 20, height: 20 }));
  layoutUiTree(root, 0, 0, 100, 100);
  const tracker = createDirtyTracker(64);
  expect(diffTree(tracker, root)).toBe(true);
  expect(diffTree(tracker, root)).toBe(false);
});

test('a node that moved reports a redraw', () => {
  const root = createUiNode({ width: 100, height: 100 });
  const child = addUiChild(root, createUiNode({ width: 20, height: 20 }));
  layoutUiTree(root, 0, 0, 100, 100);
  const tracker = createDirtyTracker(64);
  diffTree(tracker, root);
  child.rect.x += 5;
  expect(diffTree(tracker, root)).toBe(true);
});

test('the dirty bounds cover both where a node was and where it went', () => {
  const tracker = createDirtyTracker(64);
  markDirty(tracker, { x: 0, y: 0, w: 10, h: 10 });
  markDirty(tracker, { x: 50, y: 50, w: 10, h: 10 });
  const out = { x: 0, y: 0, w: 0, h: 0 };
  expect(dirtyBounds(tracker, out)).toBe(true);
  expect(out).toEqual({ x: 0, y: 0, w: 60, h: 60 });
});

test('a hover change is a redraw, because it changes pixels', () => {
  const root = createUiNode({ width: 100, height: 100, interactive: true });
  layoutUiTree(root, 0, 0, 100, 100);
  const tracker = createDirtyTracker(64);
  diffTree(tracker, root);
  root.hovered = true;
  expect(diffTree(tracker, root)).toBe(true);
});

test('a node becoming hidden is a redraw of where it used to be', () => {
  const root = createUiNode({ width: 100, height: 100 });
  const child = addUiChild(root, createUiNode({ width: 20, height: 20 }));
  layoutUiTree(root, 0, 0, 100, 100);
  const tracker = createDirtyTracker(64);
  diffTree(tracker, root);
  child.hidden = true;
  expect(diffTree(tracker, root)).toBe(true);
  const out = { x: 0, y: 0, w: 0, h: 0 };
  dirtyBounds(tracker, out);
  expect(out.w).toBeGreaterThan(0);
});

test('a node removed from the tree still repaints where it was', () => {
  const root = createUiNode({ width: 100, height: 100 });
  const child = addUiChild(root, createUiNode({ width: 20, height: 20 }));
  layoutUiTree(root, 0, 0, 100, 100);
  const tracker = createDirtyTracker(64);
  diffTree(tracker, root);
  root.children.pop();
  child.parent = null;
  expect(diffTree(tracker, root)).toBe(true);
});

test('text changing is a redraw', () => {
  const root = createUiNode({ width: 100, height: 100, text: 'a' });
  layoutUiTree(root, 0, 0, 100, 100);
  const tracker = createDirtyTracker(64);
  diffTree(tracker, root);
  root.text = 'ab';
  expect(diffTree(tracker, root)).toBe(true);
});
