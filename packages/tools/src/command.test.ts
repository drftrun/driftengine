import { expect, test } from 'vitest';
import { createUndoStack } from './command.ts';
import type { Command } from './command.ts';

function counter() {
  const state = { value: 0 };
  const add = (n: number): Command => ({
    label: `add ${n}`,
    apply: () => {
      state.value += n;
    },
    revert: () => {
      state.value -= n;
    },
  });
  return { state, add };
}

test('pushing applies, and undoing reverts', () => {
  const { state, add } = counter();
  const stack = createUndoStack(16);
  stack.push(add(5));
  expect(state.value).toBe(5);
  stack.undo();
  expect(state.value).toBe(0);
});

test('redo reapplies what undo reverted', () => {
  const { state, add } = counter();
  const stack = createUndoStack(16);
  stack.push(add(5));
  stack.undo();
  stack.redo();
  expect(state.value).toBe(5);
});

test('a new command after an undo discards the redo branch', () => {
  const { state, add } = counter();
  const stack = createUndoStack(16);
  stack.push(add(5));
  stack.undo();
  stack.push(add(3));
  expect(stack.canRedo()).toBe(false);
  expect(state.value).toBe(3);
});

test('undoing an empty stack reports failure rather than throwing', () => {
  expect(createUndoStack(16).undo()).toBe(false);
});

test('redoing with nothing to redo reports failure', () => {
  expect(createUndoStack(16).redo()).toBe(false);
});

test('the limit forgets the oldest entry and never reverts it on the way out', () => {
  const { state, add } = counter();
  const stack = createUndoStack(2);
  stack.push(add(1));
  stack.push(add(2));
  stack.push(add(4));
  expect(state.value).toBe(7);
  stack.undo();
  stack.undo();
  expect(stack.undo()).toBe(false);
  /* The first change stays: it was forgotten, not undone. */
  expect(state.value).toBe(1);
});

test('a mergeable command absorbs the next, so a drag is one undo and not sixty', () => {
  const state = { value: 0 };
  let from = 0;
  const drag = (to: number): Command => ({
    label: 'drag',
    apply() {
      state.value = to;
    },
    revert() {
      state.value = from;
    },
    merge() {
      /* The stack has already applied it. Absorbing only means this entry's revert covers both. */
      return true;
    },
  });
  const stack = createUndoStack(16);
  from = 0;
  stack.push(drag(1));
  stack.push(drag(2));
  stack.push(drag(3));
  expect(state.value).toBe(3);
  stack.undo();
  expect(state.value).toBe(0);
  expect(stack.canUndo()).toBe(false);
});

test('an absorbed command is not applied twice', () => {
  let applies = 0;
  const make = (): Command => ({
    label: 'x',
    apply() {
      applies += 1;
    },
    revert() {},
    merge() {
      return true;
    },
  });
  const stack = createUndoStack(16);
  stack.push(make());
  stack.push(make());
  expect(applies).toBe(2);
});

test('a command that refuses to merge becomes its own entry', () => {
  const { state, add } = counter();
  const stack = createUndoStack(16);
  const first: Command = { ...add(1), merge: () => false };
  stack.push(first);
  stack.push(add(2));
  expect(state.value).toBe(3);
  stack.undo();
  expect(state.value).toBe(1);
});

test('the labels name what would be undone and redone', () => {
  const { add } = counter();
  const stack = createUndoStack(16);
  stack.push(add(5));
  expect(stack.undoLabel()).toBe('add 5');
  expect(stack.redoLabel()).toBe(null);
  stack.undo();
  expect(stack.redoLabel()).toBe('add 5');
});

test('clearing forgets everything without reverting it', () => {
  const { state, add } = counter();
  const stack = createUndoStack(16);
  stack.push(add(5));
  stack.clear();
  expect(stack.canUndo()).toBe(false);
  expect(state.value).toBe(5);
});
