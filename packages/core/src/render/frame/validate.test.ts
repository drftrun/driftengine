import { expect, test } from 'vitest';
import { createDeps, recordDeps } from './deps.ts';
import { validateGraph } from './validate.ts';

test('a well-formed graph validates', () => {
  const deps = createDeps(8, 32);
  recordDeps(deps, [], [0]);
  recordDeps(deps, [0], [1]);
  expect(validateGraph(deps, 2, [])).toBe(null);
});

test('reading a resource nothing wrote is refused, and the message names both', () => {
  const deps = createDeps(8, 32);
  recordDeps(deps, [7], [0]);
  const message = validateGraph(deps, 1, []);
  expect(message).toContain('node 0');
  expect(message).toContain('7');
});

test('an imported resource may be read without being written', () => {
  const deps = createDeps(8, 32);
  recordDeps(deps, [7], [0]);
  expect(validateGraph(deps, 1, [7])).toBe(null);
});

test('reading a resource written only later is refused', () => {
  const deps = createDeps(8, 32);
  recordDeps(deps, [1], [0]);
  recordDeps(deps, [], [1]);
  expect(validateGraph(deps, 2, [])).toContain('node 0');
});

test('a node may read what it writes, because that is a read-modify-write', () => {
  const deps = createDeps(8, 32);
  recordDeps(deps, [], [0]);
  recordDeps(deps, [0], [0]);
  expect(validateGraph(deps, 2, [])).toBe(null);
});
