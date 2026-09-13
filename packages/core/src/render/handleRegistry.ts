/**
 * A slot table addressed by generational handles.
 *
 * **The handle arithmetic, and nothing about what a handle names.** It came out of `pass.ts`
 * when a second registry wanted exactly this: two copies of a generation rule are two chances to
 * get the invalidation wrong, and the failure mode is a handle answering to whoever took its slot
 * next — a use-after-free that reads as a leak.
 *
 * The definition type is a parameter rather than a union of the two kinds it holds. A union would
 * oblige every caller to narrow a value it already knows the type of, and would make adding a
 * third kind an edit to this file rather than to the caller that wanted it.
 */

/** How many bits of a handle are the slot. 4,096 registered definitions is far past generous. */
const SLOT_BITS = 12;
const SLOT_MASK = (1 << SLOT_BITS) - 1;

export interface HandleRegistry<T> {
  definitions: (T | undefined)[];
  /** Bumped whenever a slot is released, which is what invalidates the handles that named it. */
  generations: number[];
  /** Slots released and not yet reused, so registration does not grow the array forever. */
  free: number[];
}

export function createHandleRegistry<T>(): HandleRegistry<T> {
  return { definitions: [], generations: [], free: [] };
}

/**
 * Take a slot and return the handle that names it.
 *
 * Handles start at 1: zero is a generation-0 slot-0 handle and would be indistinguishable from
 * the number a caller gets from an uninitialised field, so generations start at 1 instead.
 */
export function registerIn<T>(registry: HandleRegistry<T>, definition: T): number {
  const slot = registry.free.pop() ?? registry.definitions.length;
  registry.definitions[slot] = definition;
  registry.generations[slot] ??= 1;
  return ((registry.generations[slot] ?? 1) << SLOT_BITS) | slot;
}

/** The definition a handle names, or `undefined` if it names one that has been released. */
export function definitionAt<T>(registry: HandleRegistry<T>, handle: number): T | undefined {
  if (handle <= 0) return undefined;
  const slot = handle & SLOT_MASK;
  if (registry.generations[slot] !== handle >>> SLOT_BITS) return undefined;
  return registry.definitions[slot];
}

/**
 * Release a slot.
 *
 * Guarded on the handle still being live, so calling it twice frees the slot once — a slot
 * pushed onto `free` twice is a slot handed to two different definitions.
 */
export function unregisterIn<T>(registry: HandleRegistry<T>, handle: number): T | undefined {
  const definition = definitionAt(registry, handle);
  if (definition === undefined) return undefined;
  const slot = handle & SLOT_MASK;
  registry.definitions[slot] = undefined;
  registry.generations[slot] = (registry.generations[slot] ?? 1) + 1;
  registry.free.push(slot);
  return definition;
}

/**
 * Release every slot still held, handing each definition to the caller on the way out.
 *
 * **Teardown's half of `unregisterIn`, and it was missing.** Both renderers hold registries like
 * this one and neither emptied one when it was disposed, so a definition kept whatever `init`
 * built — a pipeline, a bind group, its buffers — for as long as the process lived. A private
 * field going out of scope is not a GPU object being destroyed. Written here rather than once per
 * backend for the reason this module exists at all: two copies of a lifetime rule are two chances
 * to get it wrong, and the one that is wrong is the one nobody reads.
 *
 * `release` is the caller's, because the device object a definition must be handed is the only
 * part of this that is per-backend — and on one of them there is a condition on handing it over
 * at all.
 *
 * Each slot is released *before* its definition is told, so a `release` that reaches back into
 * this registry finds a slot already gone rather than one it can free twice.
 */
export function drainRegistry<T>(
  registry: HandleRegistry<T>,
  release: (definition: T) => void,
): void {
  for (let slot = 0; slot < registry.definitions.length; slot += 1) {
    if (registry.definitions[slot] === undefined) continue;
    /* Rebuilt rather than remembered: the generation bump that invalidates the handles naming
       this slot is `unregisterIn`'s to make, and making it twice is how a slot is freed twice. */
    const handle = ((registry.generations[slot] ?? 1) << SLOT_BITS) | slot;
    const definition = unregisterIn(registry, handle);
    if (definition !== undefined) release(definition);
  }
}
