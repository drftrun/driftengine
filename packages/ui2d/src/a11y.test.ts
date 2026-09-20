import { expect, test } from 'vitest';
import { a11yTree, createNullA11yHost } from './a11y.ts';
import type { A11yNode } from './a11y.ts';
import { layoutUiTree } from './uiLayout.ts';
import { addUiChild, createUiNode } from './uiNode.ts';

test('an interactive node with text appears as a labelled entry', () => {
  const root = createUiNode({ width: 100, height: 100 });
  addUiChild(
    root,
    createUiNode({ width: 50, height: 20, interactive: true, focusable: true, text: 'Save' }),
  );
  layoutUiTree(root, 0, 0, 100, 100);
  const out: A11yNode[] = [];
  const count = a11yTree(root, out);
  expect(out.slice(0, count).some((e) => e.label === 'Save' && e.role === 'button')).toBe(true);
});

test('a purely decorative node contributes nothing', () => {
  const root = createUiNode({ width: 100, height: 100 });
  addUiChild(root, createUiNode({ width: 50, height: 20 }));
  layoutUiTree(root, 0, 0, 100, 100);
  expect(a11yTree(root, [])).toBe(0);
});

test('a hidden subtree contributes nothing', () => {
  const root = createUiNode({ width: 100, height: 100 });
  const hidden = addUiChild(root, createUiNode({ hidden: true }));
  addUiChild(hidden, createUiNode({ interactive: true, text: 'Hidden' }));
  layoutUiTree(root, 0, 0, 100, 100);
  expect(a11yTree(root, [])).toBe(0);
});

test('an entry carries where it is, so a reader can point at it', () => {
  const root = createUiNode({ width: 100, height: 100 });
  addUiChild(root, createUiNode({ width: 40, height: 20, interactive: true, text: 'Go' }));
  layoutUiTree(root, 0, 0, 100, 100);
  const out: A11yNode[] = [];
  a11yTree(root, out);
  expect(out[0]?.w).toBe(40);
});

test('the null host accepts a tree and does nothing, so a headless build runs', () => {
  expect(() => createNullA11yHost().publish([], 0)).not.toThrow();
});
