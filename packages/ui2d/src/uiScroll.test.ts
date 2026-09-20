import { expect, test } from 'vitest';
import { layoutUiTree } from './uiLayout.ts';
import { addUiChild, createUiNode } from './uiNode.ts';
import { clampScroll, routeScrollWheel, scrollBy, scrollExtent } from './uiScroll.ts';

function list(rows: number) {
  const view = createUiNode({ width: 100, height: 100, clip: true, direction: 'column' });
  for (let i = 0; i < rows; i += 1) addUiChild(view, createUiNode({ width: 'grow', height: 20 }));
  layoutUiTree(view, 0, 0, 100, 100);
  return view;
}

test('content shorter than the view has no extent to scroll', () => {
  expect(scrollExtent(list(2)).y).toBe(0);
});

test('content taller than the view can be scrolled by the difference', () => {
  expect(scrollExtent(list(10)).y).toBe(100);
});

test('scrolling past the end clamps instead of running away', () => {
  const view = list(10);
  scrollBy(view, 0, 500);
  expect(view.scrollY).toBe(100);
});

test('scrolling above the start clamps to zero', () => {
  const view = list(10);
  scrollBy(view, 0, -50);
  clampScroll(view);
  expect(view.scrollY).toBe(0);
});

test('a scroll that moves nothing reports so, so the caller can pass it on', () => {
  expect(scrollBy(list(2), 0, 10)).toBe(false);
});

test('a scroll that moves something reports so', () => {
  expect(scrollBy(list(10), 0, 10)).toBe(true);
});

test('a wheel over a container that cannot scroll passes to the one that can', () => {
  const outer = createUiNode({ width: 100, height: 100, clip: true, direction: 'column' });
  const inner = addUiChild(
    outer,
    createUiNode({ width: 'grow', height: 40, clip: true, direction: 'column' }),
  );
  addUiChild(inner, createUiNode({ width: 'grow', height: 20 }));
  for (let i = 0; i < 10; i += 1) addUiChild(outer, createUiNode({ width: 'grow', height: 20 }));
  layoutUiTree(outer, 0, 0, 100, 100);
  expect(routeScrollWheel(outer, 10, 10, 0, 10)).toBe(outer);
});

test('a wheel nothing can use reports nothing rather than claiming it', () => {
  const view = list(2);
  expect(routeScrollWheel(view, 10, 10, 0, 10)).toBe(null);
});
