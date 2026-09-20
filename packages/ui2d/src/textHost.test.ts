import { expect, test } from 'vitest';
import { applyComposition, createNullTextHost } from './textHost.ts';
import { createTextModel } from './textModel.ts';

test('the null host focuses without throwing, so a headless build runs', () => {
  const host = createNullTextHost();
  expect(() => host.focusField(0, 0, 10, 10)).not.toThrow();
  expect(() => host.blurField()).not.toThrow();
});

test('the null clipboard is empty rather than absent', async () => {
  await expect(createNullTextHost().readClipboard()).resolves.toBe('');
});

test('an in-progress composition replaces the previous update, not the whole field', () => {
  const m = createTextModel('start ');
  applyComposition(m, { text: 'ni', done: false });
  applyComposition(m, { text: 'nihao', done: false });
  expect(m.text).toBe('start nihao');
});

test('a finished composition clears the range, so the next keystroke does not overwrite it', () => {
  const m = createTextModel('start ');
  applyComposition(m, { text: 'ni', done: false });
  applyComposition(m, { text: '你好', done: true });
  expect(m.text).toBe('start 你好');
  applyComposition(m, { text: 'x', done: false });
  expect(m.text).toBe('start 你好x');
});

test('a composition cancelled to nothing leaves the field as it was', () => {
  const m = createTextModel('start ');
  applyComposition(m, { text: 'ni', done: false });
  applyComposition(m, { text: '', done: true });
  expect(m.text).toBe('start ');
});

test('a composition over a selection replaces the selection once, not once per update', () => {
  const m = createTextModel('hello world');
  m.anchor = 0;
  m.caret = 5;
  applyComposition(m, { text: 'a', done: false });
  applyComposition(m, { text: 'ab', done: true });
  expect(m.text).toBe('ab world');
});
