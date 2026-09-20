import { expect, test } from 'vitest';
import {
  createTextModel,
  deleteBackward,
  deleteForward,
  insertText,
  moveCaret,
  moveToLineEdge,
  selectAll,
  selectedText,
  selectionRange,
} from './textModel.ts';

test('typing into an empty model puts the caret after what was typed', () => {
  const m = createTextModel();
  insertText(m, 'hello');
  expect(m.text).toBe('hello');
  expect(m.caret).toBe(5);
});

test('typing over a selection replaces it', () => {
  const m = createTextModel('hello world');
  m.anchor = 0;
  m.caret = 5;
  insertText(m, 'goodbye');
  expect(m.text).toBe('goodbye world');
  expect(m.caret).toBe(7);
});

test('a selection made right to left deletes the same characters as one left to right', () => {
  const forward = createTextModel('abcdef');
  forward.anchor = 1;
  forward.caret = 4;
  deleteBackward(forward);

  const backward = createTextModel('abcdef');
  backward.anchor = 4;
  backward.caret = 1;
  deleteBackward(backward);

  expect(forward.text).toBe(backward.text);
  expect(forward.caret).toBe(backward.caret);
});

test('backspace with no selection removes the character before the caret', () => {
  const m = createTextModel('abc');
  m.caret = 2;
  m.anchor = 2;
  deleteBackward(m);
  expect(m.text).toBe('ac');
  expect(m.caret).toBe(1);
});

test('backspace at the start does nothing rather than going negative', () => {
  const m = createTextModel('abc');
  m.caret = 0;
  m.anchor = 0;
  deleteBackward(m);
  expect(m.text).toBe('abc');
  expect(m.caret).toBe(0);
});

test('delete at the end does nothing', () => {
  const m = createTextModel('abc');
  deleteForward(m);
  expect(m.text).toBe('abc');
});

test('a caret never lands inside a surrogate pair', () => {
  const m = createTextModel('a\u{1F600}b');
  m.caret = 1;
  m.anchor = 1;
  moveCaret(m, 1, false);
  expect(m.caret).toBe(3);
  moveCaret(m, -1, false);
  expect(m.caret).toBe(1);
});

test('backspace removes a whole astral character, not half of one', () => {
  const m = createTextModel('a\u{1F600}');
  deleteBackward(m);
  expect(m.text).toBe('a');
});

test('delete forward removes a whole astral character too', () => {
  const m = createTextModel('\u{1F600}b');
  m.caret = 0;
  m.anchor = 0;
  deleteForward(m);
  expect(m.text).toBe('b');
});

test('moving without selecting collapses the selection', () => {
  const m = createTextModel('abcdef');
  m.anchor = 1;
  m.caret = 4;
  moveCaret(m, 1, false);
  expect(selectionRange(m)).toEqual({ from: m.caret, to: m.caret });
});

test('moving with select keeps the anchor where it was', () => {
  const m = createTextModel('abcdef');
  m.anchor = 1;
  m.caret = 1;
  moveCaret(m, 2, true);
  expect(m.anchor).toBe(1);
  expect(selectedText(m)).toBe('bc');
});

test('selecting everything selects everything, whatever the caret was doing', () => {
  const m = createTextModel('abc');
  m.caret = 1;
  m.anchor = 1;
  selectAll(m);
  expect(selectedText(m)).toBe('abc');
});

test('home and end move within the line, not the whole field', () => {
  const m = createTextModel('one\ntwo\nthree');
  m.caret = 5;
  m.anchor = 5;
  moveToLineEdge(m, false, false);
  expect(m.caret).toBe(4);
  moveToLineEdge(m, true, false);
  expect(m.caret).toBe(7);
});
