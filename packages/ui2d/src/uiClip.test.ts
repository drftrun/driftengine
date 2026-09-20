import { expect, test } from 'vitest';
import { clipRectFor, intersectClip } from './uiClip.ts';
import { layoutUiTree } from './uiLayout.ts';
import { addUiChild, createUiNode } from './uiNode.ts';

test('a rectangle inside its clip keeps all of itself', () => {
  const out = { x: 0, y: 0, w: 0, h: 0 };
  intersectClip(out, { x: 0, y: 0, w: 100, h: 100 }, { x: 10, y: 10, w: 20, h: 20 });
  expect(out).toEqual({ x: 10, y: 10, w: 20, h: 20 });
});

test('a rectangle hanging over the edge is cut to the overlap', () => {
  const out = { x: 0, y: 0, w: 0, h: 0 };
  intersectClip(out, { x: 0, y: 0, w: 50, h: 50 }, { x: 40, y: 40, w: 30, h: 30 });
  expect(out).toEqual({ x: 40, y: 40, w: 10, h: 10 });
});

test('a rectangle entirely outside reports nothing to draw and never a negative size', () => {
  const out = { x: 0, y: 0, w: 0, h: 0 };
  intersectClip(out, { x: 0, y: 0, w: 50, h: 50 }, { x: 200, y: 200, w: 10, h: 10 });
  expect(out.w).toBe(0);
  expect(out.h).toBe(0);
});

test('a node entirely outside its clipping ancestor reports nothing to draw', () => {
  const root = createUiNode({ width: 100, height: 100, clip: true });
  const child = addUiChild(
    root,
    createUiNode({ width: 10, height: 10, absolute: true, x: 200, y: 200 }),
  );
  layoutUiTree(root, 0, 0, 100, 100);
  const out = { x: 0, y: 0, w: 0, h: 0 };
  expect(clipRectFor(root, child, out)).toBe(false);
  expect(out.w).toBeGreaterThanOrEqual(0);
  expect(out.h).toBeGreaterThanOrEqual(0);
});

test('clipping is inherited, so a grandchild is cut by the nearest clipping ancestor', () => {
  const root = createUiNode({ width: 100, height: 100, clip: true });
  const middle = addUiChild(root, createUiNode({ width: 'grow', height: 'grow' }));
  const leaf = addUiChild(
    middle,
    createUiNode({ width: 300, height: 10, absolute: true, x: 0, y: 0 }),
  );
  layoutUiTree(root, 0, 0, 100, 100);
  const out = { x: 0, y: 0, w: 0, h: 0 };
  expect(clipRectFor(root, leaf, out)).toBe(true);
  expect(out.w).toBe(100);
});

test('a node with no clipping ancestor is never cut', () => {
  const root = createUiNode({ width: 100, height: 100 });
  const child = addUiChild(
    root,
    createUiNode({ width: 300, height: 10, absolute: true, x: 0, y: 0 }),
  );
  layoutUiTree(root, 0, 0, 100, 100);
  const out = { x: 0, y: 0, w: 0, h: 0 };
  expect(clipRectFor(root, child, out)).toBe(true);
  expect(out.w).toBe(300);
});

test('a clipping node does not cut itself', () => {
  const root = createUiNode({ width: 100, height: 100, clip: true });
  layoutUiTree(root, 0, 0, 100, 100);
  const out = { x: 0, y: 0, w: 0, h: 0 };
  expect(clipRectFor(root, root, out)).toBe(true);
  expect(out.w).toBe(100);
});
