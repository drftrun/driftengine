import { expect, test } from 'vitest';
import { layoutUiTree } from './uiLayout.ts';
import { addUiChild, createUiNode } from './uiNode.ts';
import {
  beginDrag,
  capturePointer,
  createPointerState,
  dropTarget,
  endDrag,
  pointerTarget,
  releasePointer,
} from './uiPointer.ts';

function tree() {
  const root = createUiNode({ width: 100, height: 100, direction: 'row' });
  const left = addUiChild(
    root,
    createUiNode({ width: 50, height: 100, interactive: true, name: 'left' }),
  );
  const right = addUiChild(
    root,
    createUiNode({ width: 50, height: 100, interactive: true, name: 'right' }),
  );
  layoutUiTree(root, 0, 0, 100, 100);
  return { root, left, right };
}

test('with nothing captured, the target is whatever is under the pointer', () => {
  const { root, right } = tree();
  expect(pointerTarget(createPointerState(), root, 75, 50)).toBe(right);
});

test('a captured node keeps the pointer even when it leaves, which is what a slider needs', () => {
  const { root, left } = tree();
  const state = createPointerState();
  capturePointer(state, left);
  expect(pointerTarget(state, root, 75, 50)).toBe(left);
  expect(pointerTarget(state, root, -500, -500)).toBe(left);
});

test('releasing gives the pointer back to the tree', () => {
  const { root, left, right } = tree();
  const state = createPointerState();
  capturePointer(state, left);
  releasePointer(state);
  expect(pointerTarget(state, root, 75, 50)).toBe(right);
});

test('a drag that ends over a node reports both ends and the payload', () => {
  const { root, left, right } = tree();
  const state = createPointerState();
  beginDrag(state, left, 'asset:42');
  pointerTarget(state, root, 75, 50);
  expect(dropTarget(state)).toBe(right);
  const result = endDrag(state);
  expect(result?.source).toBe(left);
  expect(result?.target).toBe(right);
  expect(result?.payload).toBe('asset:42');
});

test('a drag hovering its own source has no target', () => {
  const { root, left } = tree();
  const state = createPointerState();
  beginDrag(state, left, 'x');
  pointerTarget(state, root, 25, 50);
  expect(dropTarget(state)).toBe(null);
});

test('a drag that ends over nothing reports a null target rather than failing', () => {
  const { root, left } = tree();
  const state = createPointerState();
  beginDrag(state, left, 'asset:42');
  pointerTarget(state, root, -10, -10);
  expect(endDrag(state)?.target).toBe(null);
});

test('ending a drag that never began reports nothing', () => {
  expect(endDrag(createPointerState())).toBe(null);
});

test('a finished drag leaves no state behind', () => {
  const { root, left } = tree();
  const state = createPointerState();
  beginDrag(state, left, 'x');
  pointerTarget(state, root, 75, 50);
  endDrag(state);
  expect(dropTarget(state)).toBe(null);
  expect(state.dragPayload).toBe('');
});
