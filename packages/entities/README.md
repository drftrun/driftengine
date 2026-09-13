# @driftengine/entities

Entities with generational identity, component storage, queries, systems with declared reads and
writes, prefabs and scene serialization.

**It imports no other engine package.** An entity model that knew what a `Transform` was would be an
entity model that knew it had a scene — and the argument for declared reads and writes is that a
declaration is about a component _id_ rather than about what the component means.

It also **declares no component types**. A consumer writes the ones its world needs, or takes them
from whichever package owns the subsystem.

```ts
import { EntityAllocator } from '@driftengine/entities';

const entities = new EntityAllocator();
const player = entities.create();
entities.destroy(player);
entities.alive(player); // false — and the entity that takes the slot is a different handle
```

## The handle

An entity is one number: a 26-bit index and a 27-bit generation, combined arithmetically. **The
generation is what stops a stale handle addressing a live entity** — an index freed and reused makes
every old reference silently valid, pointing at a different thing with no error anywhere.

The conventional packed `Uint32` splits 24 and 8, so a slot's 257th reuse hands back a handle
identical to its first. This split gives sixty-seven million entities and 134 million reuses of each
slot, and costs four bytes per stored entity because a handle lives in a `Float64Array`.

26 + 27 is the whole 53-bit budget, exactly. There is no headroom, deliberately, and a test asserts
the top handle so that is discovered here rather than in a wrong comparison.

## Systems declare what they touch

```ts
const schedule = buildSchedule([
  { name: 'hunger', writes: [Hunger], everyTicks: 60, run(view) { … } },
  { name: 'decay', reads: [Hunger], writes: [Health], after: ['hunger'], run(view) { … } },
]);
runSchedule(world, schedule, tick);
```

**The declaration is enforced.** A system that writes something it did not declare is refused
naming both — a schedule derived from a lie is worse than no schedule. `writes` implies `reads`.

Order is declaration order, adjusted only by `after`, which is topologically sorted with
declaration order as the tie-break. A cycle in `after` is refused naming the systems.

`everyTicks` strides the **fixed step** and is never a rate in seconds: a rate in wall-clock time
leaves the determinism contract on its first dropped frame.

**Destroying from inside a system is deferred** to after it returns. A removal swaps the last dense
entry into the hole, so removing mid-walk moves an entity the cursor has already passed into a
position it has already visited — and that entity is never seen, silently, and only whichever one
happened to be last. `create` and `add` are immediate, and a newly added entity may be visited in
the same pass.

## Prefabs and scenes

```ts
const guard = definePrefab('guard', [
  [Health, { current: 100 }],
  [Perception, { sightRange: 40 }],
]);
const spawned = instantiate(world, guard, { Perception: { sightRange: 60 } });

const scene = serializeWorld(world, [Health, Perception]);
const result = deserializeWorld(fresh, scene, [Health, Perception]);
```

**A prefab is a value with no link back to its instances.** A live link is what an editor wants,
and it costs every instance a record of which fields it has overridden; Track K can add that record
without changing what a prefab is.

**A scene addresses every value by a stable field id**, never a name and never a position. A field
inserted in the middle would renumber everything after it, and a save would then load the right
names with the wrong values — worse than failing, because it looks like it worked.

Loading across a change goes through `driftscript`'s migration, unchanged: a field added since
arrives with its default, one removed is dropped, and one whose **type** changed is refused naming
it. Nothing is written into the world until every entity has migrated, so a refusal on the fifth
does not leave four behind.

Entity references are **remapped** on load rather than preserved, because a saved handle's slot may
be live in the world being loaded into. That only works for fields declared `Entity`; a number that
happens to hold one is a number.

## Documentation

This file is the reference, including the five things the model refuses and what
would reverse each.
