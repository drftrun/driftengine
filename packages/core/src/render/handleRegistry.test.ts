import { describe, expect, it } from 'vitest';

import { createHandleRegistry, definitionAt, registerIn, unregisterIn } from './handleRegistry.ts';

/**
 * The handle arithmetic, tested apart from anything a handle names.
 *
 * `pass.test.ts` covers the same rules through the pass surface. These exist because a second
 * registry now shares this code, and a generation rule that is only exercised through one of its
 * callers is a rule the other caller inherits untested.
 */
describe('a generational handle registry', () => {
  it('carries a definition of any type, not only a pass', () => {
    const registry = createHandleRegistry<{ name: string }>();
    const handle = registerIn(registry, { name: 'binner' });
    expect(definitionAt(registry, handle)?.name).toBe('binner');
  });

  it('answers nothing for a handle whose slot has been taken by somebody else', () => {
    const registry = createHandleRegistry<{ name: string }>();
    const first = registerIn(registry, { name: 'first' });
    unregisterIn(registry, first);
    const second = registerIn(registry, { name: 'second' });
    /*
     * The slot is reused and the generation is not: the stale handle must not name the newcomer.
     * A package torn down and still dispatching is a use-after-free, and this is what stops it
     * being a silent one.
     */
    expect(second & 0xfff).toBe(first & 0xfff);
    expect(definitionAt(registry, first)).toBeUndefined();
    expect(definitionAt(registry, second)?.name).toBe('second');
  });

  it('frees a slot once however many times it is released', () => {
    const registry = createHandleRegistry<{ name: string }>();
    const handle = registerIn(registry, { name: 'once' });
    expect(unregisterIn(registry, handle)?.name).toBe('once');
    expect(unregisterIn(registry, handle)).toBeUndefined();
    /* Pushed onto `free` twice is one slot handed to two different definitions. */
    expect(registry.free).toHaveLength(1);
  });

  it('never issues zero, so an uninitialised field names nothing', () => {
    const registry = createHandleRegistry<{ name: string }>();
    expect(registerIn(registry, { name: 'first' })).toBeGreaterThan(0);
    expect(definitionAt(registry, 0)).toBeUndefined();
  });
});
