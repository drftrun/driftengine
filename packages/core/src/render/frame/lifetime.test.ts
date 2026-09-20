import { expect, test } from 'vitest';
import { createDeps, recordDeps } from './deps.ts';
import { computeLifetimes, createLifetimes, firstWrite, lastRead } from './lifetime.ts';

test('a resource written then read lives from the write to the read', () => {
  const deps = createDeps(4, 16);
  recordDeps(deps, [], [0]);
  recordDeps(deps, [0], [1]);
  recordDeps(deps, [1], [2]);
  const out = createLifetimes(4);
  computeLifetimes(deps, 3, out);
  expect(firstWrite(out, 0)).toBe(0);
  expect(lastRead(out, 0)).toBe(1);
});

test('the last read is the last one, not the first', () => {
  const deps = createDeps(8, 32);
  recordDeps(deps, [], [0]);
  recordDeps(deps, [0], [1]);
  recordDeps(deps, [0], [2]);
  const out = createLifetimes(4);
  computeLifetimes(deps, 3, out);
  expect(lastRead(out, 0)).toBe(2);
});

test('a resource written and never read still occupies the node that writes it', () => {
  const deps = createDeps(4, 16);
  recordDeps(deps, [], [0]);
  const out = createLifetimes(4);
  computeLifetimes(deps, 1, out);
  expect(firstWrite(out, 0)).toBe(0);
  expect(lastRead(out, 0)).toBe(0);
});

test('an identifier nothing writes reports no first write', () => {
  const deps = createDeps(4, 16);
  recordDeps(deps, [3], [0]);
  const out = createLifetimes(4);
  computeLifetimes(deps, 1, out);
  expect(firstWrite(out, 3)).toBe(-1);
});
