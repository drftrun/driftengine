import { expect, test } from 'vitest';
import {
  addToSelection,
  clearSelection,
  createSelection,
  isSelected,
  primarySelection,
  selectOnly,
  selectRange,
  selectedEntities,
  toggleSelection,
} from './selection.ts';

test('selecting one replaces the selection', () => {
  const s = createSelection();
  addToSelection(s, 1);
  selectOnly(s, 2);
  expect(Array.from(selectedEntities(s))).toEqual([2]);
});

test('adding extends it', () => {
  const s = createSelection();
  addToSelection(s, 1);
  addToSelection(s, 2);
  expect(Array.from(selectedEntities(s))).toEqual([1, 2]);
});

test('adding the same entity twice does not duplicate it', () => {
  const s = createSelection();
  addToSelection(s, 1);
  addToSelection(s, 1);
  expect(selectedEntities(s).length).toBe(1);
});

test('toggling removes an already-selected entity', () => {
  const s = createSelection();
  addToSelection(s, 1);
  toggleSelection(s, 1);
  expect(isSelected(s, 1)).toBe(false);
});

test('a range takes everything between, inclusive, in either direction', () => {
  const order = [10, 20, 30, 40, 50];
  const forward = createSelection();
  selectRange(forward, 20, 40, order);
  const backward = createSelection();
  selectRange(backward, 40, 20, order);
  expect(Array.from(selectedEntities(forward))).toEqual([20, 30, 40]);
  expect(Array.from(selectedEntities(backward))).toEqual([20, 30, 40]);
});

test('a range over an entity not in the order does nothing rather than guessing', () => {
  const s = createSelection();
  addToSelection(s, 7);
  selectRange(s, 1, 99, [10, 20]);
  expect(Array.from(selectedEntities(s))).toEqual([7]);
});

test('the primary selection is the most recently added', () => {
  const s = createSelection();
  addToSelection(s, 1);
  addToSelection(s, 2);
  expect(primarySelection(s)).toBe(2);
});

test('an empty selection has no primary rather than entity zero', () => {
  expect(primarySelection(createSelection())).toBe(null);
});

test('the order is stable, so a multi-entity gizmo does not change pivot between frames', () => {
  const s = createSelection();
  addToSelection(s, 5);
  addToSelection(s, 3);
  addToSelection(s, 9);
  const first = Array.from(selectedEntities(s));
  expect(Array.from(selectedEntities(s))).toEqual(first);
  expect(primarySelection(s)).toBe(9);
});

test('clearing empties it', () => {
  const s = createSelection();
  addToSelection(s, 1);
  clearSelection(s);
  expect(selectedEntities(s).length).toBe(0);
});
