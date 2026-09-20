import { expect, test } from 'vitest';
import {
  beginReadback,
  completeReadback,
  createReadbackRing,
  readbackPending,
  takeReadback,
} from './readback.ts';

test('nothing has arrived before anything was asked for', () => {
  const ring = createReadbackRing(3);
  expect(takeReadback(ring)).toBe(null);
});

test('a completed slot comes back exactly once', () => {
  const ring = createReadbackRing(3);
  const slot = beginReadback(ring);
  const data = new ArrayBuffer(8);
  completeReadback(ring, slot, data);
  expect(takeReadback(ring)).toBe(data);
  expect(takeReadback(ring)).toBe(null);
});

test('an outstanding request does not block a later one', () => {
  const ring = createReadbackRing(3);
  const first = beginReadback(ring);
  const second = beginReadback(ring);
  expect(second).not.toBe(first);
  expect(readbackPending(ring)).toBe(2);
});

test('a full ring refuses a new request rather than overwriting an outstanding one', () => {
  const ring = createReadbackRing(2);
  beginReadback(ring);
  beginReadback(ring);
  expect(beginReadback(ring)).toBe(-1);
});

test('completing the oldest frees a slot for the next request', () => {
  const ring = createReadbackRing(2);
  const first = beginReadback(ring);
  beginReadback(ring);
  completeReadback(ring, first, new ArrayBuffer(4));
  takeReadback(ring);
  expect(beginReadback(ring)).not.toBe(-1);
});
