import { expect, test } from 'vitest';

import { createPassRegistry, passAt, registerIn, unregisterIn } from './pass.ts';
import type { PassDefinition } from './pass.ts';

const stub = (label: string): PassDefinition => ({ label, draw: () => {} });

test('a registered pass comes back by its handle', () => {
  const registry = createPassRegistry();
  const handle = registerIn(registry, stub('splats'));
  expect(passAt(registry, handle)?.label).toBe('splats');
});

test('two passes registered together are told apart', () => {
  const registry = createPassRegistry();
  const first = registerIn(registry, stub('a'));
  const second = registerIn(registry, stub('b'));
  expect(second).not.toBe(first);
  expect(passAt(registry, first)?.label).toBe('a');
  expect(passAt(registry, second)?.label).toBe('b');
});

/**
 * The reason a handle carries a generation rather than being an index.
 *
 * A slot reused after `unregisterPass` would answer to the old handle, so a package that was
 * torn down goes on drawing — which reads as a leak and is a use-after-free. The generation
 * makes the stale handle answer nothing instead.
 */
test('an unregistered handle answers nothing rather than the next tenant', () => {
  const registry = createPassRegistry();
  const handle = registerIn(registry, stub('a'));
  unregisterIn(registry, handle);
  const reused = registerIn(registry, stub('b'));

  expect(passAt(registry, handle), 'the stale handle must not draw somebody else').toBeUndefined();
  expect(passAt(registry, reused)?.label, 'and the slot is genuinely reused').toBe('b');
});

test('unregistering twice is not an error and frees the slot once', () => {
  const registry = createPassRegistry();
  const handle = registerIn(registry, stub('a'));
  unregisterIn(registry, handle);
  unregisterIn(registry, handle);
  expect(registry.free.length, 'a slot freed twice would be handed out twice').toBe(1);
});

test('a handle from nowhere answers nothing', () => {
  const registry = createPassRegistry();
  expect(passAt(registry, 0)).toBeUndefined();
  expect(passAt(registry, -1)).toBeUndefined();
  expect(passAt(registry, 9_999)).toBeUndefined();
});
