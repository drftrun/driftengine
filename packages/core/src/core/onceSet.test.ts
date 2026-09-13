import { expect, test } from 'vitest';
import { OnceSet } from './onceSet.ts';
import { MemoryStore } from './storage.ts';

test('a claim succeeds once and survives a reload', () => {
  const store = new MemoryStore();
  const first = new OnceSet('test.once', store);
  expect(first.claim('jump')).toBe(true);
  expect(first.claim('jump')).toBe(false);

  // A separate instance over the same store is what the next page load is.
  expect(new OnceSet('test.once', store).claim('jump')).toBe(false);
  expect(new OnceSet('test.once', store).claim('slide')).toBe(true);
});

test('clearing brings every prompt back', () => {
  // "Show me the tutorial again" is a real settings entry, and it has to reach
  // flags that were written many versions ago.
  const store = new MemoryStore();
  const set = new OnceSet('test.once', store);
  set.claim('jump');
  set.clear();
  expect(set.claim('jump')).toBe(true);
});
