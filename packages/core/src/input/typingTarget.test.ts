import { expect, test } from 'vitest';
import { isTypingTarget } from './typingTarget.ts';

const el = (tagName: string, contentEditable = false): EventTarget =>
  ({ tagName, isContentEditable: contentEditable }) as unknown as EventTarget;

test('a text field is typing, and the canvas is not', () => {
  /*
   * The whole bug in one assertion. A game asks for `Space`, `KeyE` and the arrows
   * to be prevented — reasonably, since Space scrolls the page — and that made a bug
   * report impossible to write: no spaces, no `e`, no moving the caret.
   */
  expect(isTypingTarget(el('TEXTAREA'))).toBe(true);
  expect(isTypingTarget(el('INPUT'))).toBe(true);
  expect(isTypingTarget(el('SELECT'))).toBe(true);
  expect(isTypingTarget(el('CANVAS'))).toBe(false);
  expect(isTypingTarget(el('BODY'))).toBe(false);
});

test('a contenteditable is typing whatever tag it is', () => {
  expect(isTypingTarget(el('DIV', true))).toBe(true);
  expect(isTypingTarget(el('DIV', false))).toBe(false);
});

test('no target is not typing', () => {
  // A synthetic event, or one whose target has already been detached. The game is the
  // safe default: refusing input on a null target would drop real keystrokes.
  expect(isTypingTarget(null)).toBe(false);
});

test('an object that is not an element does not throw', () => {
  // `window` and `document` are event targets and have no `tagName`.
  expect(isTypingTarget({} as EventTarget)).toBe(false);
});
