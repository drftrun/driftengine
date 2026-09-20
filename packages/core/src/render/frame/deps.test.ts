import { expect, test } from 'vitest';
import { createDeps, depsNodeCount, readsOf, recordDeps, resetDeps, writesOf } from './deps.ts';

test('a recorded node hands back its reads and writes unchanged', () => {
  const deps = createDeps(4, 16);
  const node = recordDeps(deps, [3, 7], [1]);
  expect(node).toBe(0);
  expect(Array.from(readsOf(deps, node))).toEqual([3, 7]);
  expect(Array.from(writesOf(deps, node))).toEqual([1]);
});

test('a node with no reads hands back an empty view rather than null', () => {
  const deps = createDeps(4, 16);
  const node = recordDeps(deps, [], [2]);
  expect(readsOf(deps, node).length).toBe(0);
  expect(Array.from(writesOf(deps, node))).toEqual([2]);
});

test('two nodes keep their own spans and do not bleed into each other', () => {
  const deps = createDeps(4, 16);
  const first = recordDeps(deps, [1], [2]);
  const second = recordDeps(deps, [2], [3, 4]);
  expect(Array.from(readsOf(deps, first))).toEqual([1]);
  expect(Array.from(writesOf(deps, second))).toEqual([3, 4]);
  expect(depsNodeCount(deps)).toBe(2);
});

test('a reset empties the record without reallocating the edge store', () => {
  const deps = createDeps(4, 16);
  recordDeps(deps, [1, 2, 3], [4]);
  const store = deps.edges;
  resetDeps(deps);
  expect(depsNodeCount(deps)).toBe(0);
  expect(deps.edges).toBe(store);
});

test('recording past the edge capacity grows the store and preserves earlier spans', () => {
  const deps = createDeps(2, 2);
  const first = recordDeps(deps, [9], [8]);
  const second = recordDeps(deps, [7, 6], [5]);
  expect(Array.from(readsOf(deps, first))).toEqual([9]);
  expect(Array.from(writesOf(deps, first))).toEqual([8]);
  expect(Array.from(readsOf(deps, second))).toEqual([7, 6]);
});
