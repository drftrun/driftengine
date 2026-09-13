/**
 * The entity model on its own, with no engine at all.
 *
 * **This is what its independence is worth**, and it is measured rather than claimed: the package
 * imports no `@driftengine/*`, so a consumer who wants entities and no renderer pays for entities
 * and no renderer. `boundaries.test.mjs` asserts the import graph; this asserts the consequence,
 * which is the number.
 *
 * The one dependency is `driftscript`'s schema mechanism, and the size is how you can tell whether
 * tree-shaking reached only that or dragged the whole runtime in with it.
 */
import { EntityAllocator, entityIndex } from '@driftengine/entities';

export function reachable(): number {
  const allocator = new EntityAllocator();
  return entityIndex(allocator.create());
}
