import { expect, test } from 'vitest';
import { layerOrder } from './uiLayer.ts';
import { addUiChild, createUiNode } from './uiNode.ts';
import type { UiNode } from './uiNode.ts';

function names(out: UiNode[], count: number): string[] {
  return out.slice(0, count).map((n) => n.name);
}

test('nodes on one layer keep tree order', () => {
  const root = createUiNode({ name: 'root' });
  addUiChild(root, createUiNode({ name: 'a' }));
  addUiChild(root, createUiNode({ name: 'b' }));
  const out: UiNode[] = [];
  expect(names(out, layerOrder(root, out))).toEqual(['root', 'a', 'b']);
});

test('a higher layer draws after everything below it, however deeply nested', () => {
  const root = createUiNode({ name: 'root' });
  const panel = addUiChild(root, createUiNode({ name: 'panel' }));
  addUiChild(panel, createUiNode({ name: 'popup', layer: 10 }));
  addUiChild(root, createUiNode({ name: 'sibling' }));
  const out: UiNode[] = [];
  const order = names(out, layerOrder(root, out));
  expect(order.indexOf('popup')).toBeGreaterThan(order.indexOf('sibling'));
});

test('a layer is inherited, so a popup s own children ride with it', () => {
  const root = createUiNode({ name: 'root' });
  const popup = addUiChild(root, createUiNode({ name: 'popup', layer: 10 }));
  addUiChild(popup, createUiNode({ name: 'label' }));
  addUiChild(root, createUiNode({ name: 'sibling' }));
  const out: UiNode[] = [];
  const order = names(out, layerOrder(root, out));
  expect(order.indexOf('label')).toBeGreaterThan(order.indexOf('sibling'));
});

test('ordering is stable, so two nodes on one layer never swap between frames', () => {
  const root = createUiNode({ name: 'root' });
  addUiChild(root, createUiNode({ name: 'a', layer: 5 }));
  addUiChild(root, createUiNode({ name: 'b', layer: 5 }));
  const first: UiNode[] = [];
  const second: UiNode[] = [];
  const a = names(first, layerOrder(root, first));
  const b = names(second, layerOrder(root, second));
  expect(a).toEqual(b);
});

test('a hidden subtree contributes nothing at any layer', () => {
  const root = createUiNode({ name: 'root' });
  const hidden = addUiChild(root, createUiNode({ name: 'hidden', hidden: true }));
  addUiChild(hidden, createUiNode({ name: 'child', layer: 99 }));
  const out: UiNode[] = [];
  expect(layerOrder(root, out)).toBe(1);
});
