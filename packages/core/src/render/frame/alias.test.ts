import { expect, test } from 'vitest';
import { createAliasPlan, offsetOf, planAliases } from './alias.ts';
import { createDeps, recordDeps } from './deps.ts';
import { computeLifetimes, createLifetimes } from './lifetime.ts';
import { createVirtualTable, declareVirtual } from './virtual.ts';

test('two resources whose lifetimes do not overlap share one offset', () => {
  const table = createVirtualTable(4);
  const a = declareVirtual(table, { kind: 'buffer', bytes: 256 });
  const b = declareVirtual(table, { kind: 'buffer', bytes: 256 });

  const deps = createDeps(8, 32);
  recordDeps(deps, [], [a]);
  recordDeps(deps, [a], []);
  recordDeps(deps, [], [b]);
  recordDeps(deps, [b], []);

  const lifetimes = createLifetimes(4);
  computeLifetimes(deps, 4, lifetimes);
  const plan = createAliasPlan(4);
  const total = planAliases(table, lifetimes, plan);

  expect(offsetOf(plan, a)).toBe(offsetOf(plan, b));
  expect(total).toBe(256);
});

test('two resources alive at the same time never share an offset', () => {
  const table = createVirtualTable(4);
  const a = declareVirtual(table, { kind: 'buffer', bytes: 256 });
  const b = declareVirtual(table, { kind: 'buffer', bytes: 256 });

  const deps = createDeps(8, 32);
  recordDeps(deps, [], [a]);
  recordDeps(deps, [], [b]);
  recordDeps(deps, [a, b], []);

  const lifetimes = createLifetimes(4);
  computeLifetimes(deps, 3, lifetimes);
  const plan = createAliasPlan(4);
  const total = planAliases(table, lifetimes, plan);

  expect(offsetOf(plan, a)).not.toBe(offsetOf(plan, b));
  expect(total).toBe(512);
});

test('a smaller resource reusing a larger slot does not grow the arena', () => {
  const table = createVirtualTable(4);
  const big = declareVirtual(table, { kind: 'buffer', bytes: 1024 });
  const small = declareVirtual(table, { kind: 'buffer', bytes: 64 });

  const deps = createDeps(8, 32);
  recordDeps(deps, [], [big]);
  recordDeps(deps, [big], []);
  recordDeps(deps, [], [small]);
  recordDeps(deps, [small], []);

  const lifetimes = createLifetimes(4);
  computeLifetimes(deps, 4, lifetimes);
  const plan = createAliasPlan(4);
  expect(planAliases(table, lifetimes, plan)).toBe(1024);
});

test('an identifier nothing writes is given no offset at all', () => {
  const table = createVirtualTable(4);
  const unused = declareVirtual(table, { kind: 'buffer', bytes: 32 });
  const lifetimes = createLifetimes(4);
  const deps = createDeps(4, 16);
  computeLifetimes(deps, 0, lifetimes);
  const plan = createAliasPlan(4);
  expect(planAliases(table, lifetimes, plan)).toBe(0);
  expect(offsetOf(plan, unused)).toBe(-1);
});
