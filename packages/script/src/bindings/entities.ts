/**
 * `drift/ecs` and `drift/prefab` — the entity model as DriftScript reaches it.
 *
 * These are the two surfaces the linker has refused by name since Track N shipped, and this file is
 * what kills that refusal. Like every binding here, nothing in it is new engine code: a binding is a
 * description and a lookup.
 *
 * ---
 *
 * ## A component is named by a string, and that is forced rather than chosen
 *
 * A script cannot hold a `ComponentType` — it is an object with a schema, and the language's types
 * are numbers, strings, booleans and opaque handles. So a component is addressed by name and the
 * host resolves it. **The cost is that a typo is a runtime refusal rather than a compile error**,
 * and the fix is DS-5's `component` declaration, which is Track N's to build now that this exists.
 * Refusing in words naming the component and listing what the world has is what the interim owes.
 *
 * ## There is no query here, and that is not an omission
 *
 * Iterating a query needs a loop form the language does not have for it — that is DS-5 and DS-6.
 * What a script can do today is walk a component's dense array by index, which `while` expresses
 * perfectly. **The order is insertion modified by swap-removal**, so an entity removed during a
 * walk moves the last one into a position already passed; a script that removes while walking
 * should walk backwards, and the doc on `at` says so.
 */
import {
  ENTITY_INDEX_CEILING,
  type ComponentType,
  type ComponentView,
  type Entity,
  type Prefab,
  type QueryCursor,
  type World,
  instantiate,
} from '@driftengine/entities';
import { type CapabilityDefinition, type OpaqueType, defineCapability } from 'driftscript';

export const ECS_MODULE = 'drift/ecs';
export const PREFAB_MODULE = 'drift/prefab';

const define = (
  module: string,
  name: string,
  params: readonly { name: string; type: string }[],
  returns: string,
  effects: CapabilityDefinition['effects'],
  deterministic: boolean,
  doc: string,
): CapabilityDefinition =>
  defineCapability({
    module,
    name,
    signature: `fn(${params.map((p) => `${p.name}: ${p.type}`).join(', ')}) -> ${returns}`,
    params: [...params],
    returns,
    effects,
    deterministic,
    doc,
    implementation: `${module}.${name}`,
  });

export const ENTITY_TYPES: readonly OpaqueType[] = [
  {
    module: ECS_MODULE,
    name: 'World',
    doc: 'A world: its entities, their components and its systems.',
  },
  {
    module: ECS_MODULE,
    name: 'Cursor',
    doc: "A query in progress. Borrowed from the world's pool and given back when the walk ends, so it may not outlive the loop that opened it.",
  },
  {
    module: ECS_MODULE,
    name: 'View',
    doc: "A component's live columns. The object stays valid across a reallocation; the arrays inside it do not, so index through the view rather than holding one.",
  },
];

/**
 * An entity is `Entity`, and it took the language until DriftScript 1.6.0 to have the word.
 *
 * A handle carries a 26-bit index and a 27-bit generation, which is the entire 53-bit budget a
 * double holds. A `u32` would truncate the generation — and a truncated generation is a stale
 * handle that compares equal to a live one, which is the exact failure the generation exists to
 * prevent. So the width was never negotiable, and until the language could name it these all said
 * `f64` with this paragraph explaining why.
 *
 * **`Entity` is a type of its own there rather than an alias**, which is what makes the change worth
 * making: a handle is assignable *to* an `f64` and not *from* one, so a number a script computed
 * cannot arrive where a handle is wanted, and `e.Health` is legal on a handle and on nothing else.
 * The language's own note asked for this by name — a capability that hands back a handle as an
 * `f64` and expects it to keep working as one is what it said would make the asymmetry wrong.
 *
 * **`read` still answers `f64`**, and that is not an oversight: it reads a component *field*, which
 * is a number, and typing it as a handle would be the same mistake in the other direction.
 */
export const ECS_CAPABILITIES: readonly CapabilityDefinition[] = [
  define(
    ECS_MODULE,
    'create',
    [{ name: 'world', type: 'World' }],
    'Entity',
    ['ecs.write'],
    false,
    'A fresh entity with nothing on it. The handle is exact; do not put one in an `f32`.',
  ),
  define(
    ECS_MODULE,
    'destroy',
    [
      { name: 'world', type: 'World' },
      { name: 'entity', type: 'Entity' },
    ],
    'bool',
    ['ecs.write'],
    false,
    'Remove an entity and every component it had. False when the handle was already stale.',
  ),
  define(
    ECS_MODULE,
    'alive',
    [
      { name: 'world', type: 'World' },
      { name: 'entity', type: 'Entity' },
    ],
    'bool',
    ['ecs.read'],
    true,
    'Whether this handle still names a live entity. A handle to something destroyed is false, even after its slot is reused.',
  ),
  define(
    ECS_MODULE,
    'has',
    [
      { name: 'world', type: 'World' },
      { name: 'entity', type: 'Entity' },
      { name: 'component', type: 'String' },
    ],
    'bool',
    ['ecs.read'],
    true,
    'Whether an entity carries a component.',
  ),
  define(
    ECS_MODULE,
    'attach',
    [
      { name: 'world', type: 'World' },
      { name: 'entity', type: 'Entity' },
      { name: 'component', type: 'String' },
    ],
    'void',
    ['ecs.write'],
    false,
    'Give an entity a component, every field at the zero for its type. Set them with `write`.',
  ),
  define(
    ECS_MODULE,
    'detach',
    [
      { name: 'world', type: 'World' },
      { name: 'entity', type: 'Entity' },
      { name: 'component', type: 'String' },
    ],
    'bool',
    ['ecs.write'],
    false,
    'Take a component away. False when it did not have one.',
  ),
  define(
    ECS_MODULE,
    'read',
    [
      { name: 'world', type: 'World' },
      { name: 'entity', type: 'Entity' },
      { name: 'component', type: 'String' },
      { name: 'field', type: 'String' },
    ],
    'f64',
    ['ecs.read'],
    true,
    'One numeric field. Reading a field of a component an entity does not have is 0.',
  ),
  define(
    ECS_MODULE,
    'write',
    [
      { name: 'world', type: 'World' },
      { name: 'entity', type: 'Entity' },
      { name: 'component', type: 'String' },
      { name: 'field', type: 'String' },
      { name: 'value', type: 'f64' },
    ],
    'void',
    ['ecs.write'],
    false,
    'Set one numeric field.',
  ),
  define(
    ECS_MODULE,
    'count',
    [
      { name: 'world', type: 'World' },
      { name: 'component', type: 'String' },
    ],
    'u32',
    ['ecs.read'],
    true,
    'How many entities carry a component.',
  ),
  define(
    ECS_MODULE,
    'at',
    [
      { name: 'world', type: 'World' },
      { name: 'component', type: 'String' },
      { name: 'index', type: 'u32' },
    ],
    'Entity',
    ['ecs.read'],
    true,
    'The nth entity carrying a component. **The order is insertion modified by swap-removal**, so a walk that removes should count downwards — removing moves the last entity into a position already passed.',
  ),
  /*
   * **Two capabilities rather than one, and the split is what `Entity` cost.**
   *
   * A search that finds nothing has to say so, and once the answer is an `Entity` there is no value
   * left to say it with: a handle is not a number a script can compare to −1, which is the whole
   * point of it being its own type. An option would say it and allocates one object per call, on a
   * path written to run every frame for every agent that looks around — the allocation `next`
   * refuses one screen up.
   *
   * So the result is read back through a second accessor, which is exactly what `raycast` and its
   * `hitBody` already do in this repository and for the same reason. **The cost is the same too**:
   * the result is only valid until the next search on the same world, and that is said here and on
   * the accessor rather than left for somebody to find out.
   */
  define(
    ECS_MODULE,
    'findNearest',
    [
      { name: 'world', type: 'World' },
      { name: 'component', type: 'String' },
      { name: 'fieldX', type: 'String' },
      { name: 'fieldY', type: 'String' },
      { name: 'fieldZ', type: 'String' },
      { name: 'x', type: 'float' },
      { name: 'y', type: 'float' },
      { name: 'z', type: 'float' },
      { name: 'radius', type: 'float' },
    ],
    'bool',
    ['ecs.read'],
    true,
    "Whether any entity carrying a component has position fields putting it within a radius, and the search `nearest` then reads. **A linear scan of that component's column, not an index** — the entity model keeps no spatial structure, so this costs one pass over everything carrying the component. Position is read from three fields you name, so nothing here knows what a transform is called.",
  ),
  define(
    ECS_MODULE,
    'nearest',
    [{ name: 'world', type: 'World' }],
    'Entity',
    ['ecs.read'],
    true,
    'The entity the last `findNearest` on this world found. **Valid only until the next one**, and meaningless when that answered false — the same lifetime a raycast hit has.',
  ),
];

/**
 * The four a query loop is built on.
 *
 * **Nobody writes these by hand.** They are what `for e in query<…>() { … }` compiles to, and a
 * script author never names one — which is why their docs describe the shape of the generated code
 * rather than how to call them. They are capabilities rather than a second bind hook so that
 * generated code reaches them exactly as it reaches everything else, through `__bind($host)`.
 */
export const QUERY_CAPABILITIES: readonly CapabilityDefinition[] = [
  define(
    ECS_MODULE,
    'query',
    [
      { name: 'world', type: 'World' },
      { name: 'a', type: 'String' },
      { name: 'b', type: 'String' },
      { name: 'c', type: 'String' },
      { name: 'd', type: 'String' },
    ],
    'Cursor',
    ['ecs.read'],
    true,
    'Open a walk over everything carrying these components. The cursor is borrowed from the world’s pool; ending the walk gives it back.',
  ),
  define(
    ECS_MODULE,
    'without',
    [
      { name: 'cursor', type: 'Cursor' },
      { name: 'component', type: 'String' },
    ],
    'void',
    ['ecs.read'],
    true,
    'Narrow an open walk to entities that do **not** carry a component.',
  ),
  define(
    ECS_MODULE,
    'next',
    [{ name: 'cursor', type: 'Cursor' }],
    'Entity',
    ['ecs.read'],
    true,
    'The next entity, or a **negative** number when the walk is done — which also gives the cursor back. Negative rather than zero, because zero is a legal handle.',
  ),
  define(
    ECS_MODULE,
    'view',
    [
      { name: 'world', type: 'World' },
      { name: 'component', type: 'String' },
      { name: 'forWriting', type: 'bool' },
    ],
    'View',
    ['ecs.read'],
    true,
    'A component’s live columns. `forWriting` decides which of a system’s declarations is checked — a loop that only reads takes a readable view, and asking for more than the system declared is refused.',
  ),
];

export const PREFAB_CAPABILITIES: readonly CapabilityDefinition[] = [
  define(
    PREFAB_MODULE,
    'spawn',
    [
      { name: 'world', type: 'World' },
      { name: 'prefab', type: 'String' },
    ],
    'Entity',
    ['ecs.write'],
    false,
    'Make one, with every component the prefab names. Overrides are the host’s to apply; a script that wants a different value writes it after.',
  ),
];

/** What a host supplies so a name can become a component type or a prefab. */
export interface EntityServices {
  /**
   * Component types by the name a script writes.
   *
   * There is no world here: every capability takes the world as a parameter, because a consumer
   * with two worlds — a simulation and a preview — would otherwise need two hosts.
   */
  readonly components: ReadonlyMap<string, ComponentType>;
  /** Prefabs by name. Absent when the host has none, which makes `drift/prefab` refuse in words. */
  readonly prefabs?: ReadonlyMap<string, Prefab>;
}

export function entitiesImplementation(services: EntityServices): Record<string, unknown> {
  const { components } = services;

  /**
   * Resolve a component name, or refuse naming what the world has.
   *
   * **Not `undefined` and not a no-op.** A script that misspells a component would otherwise read
   * zeroes and write into nothing, which is a behaviour that runs, reports success and is wrong —
   * the silent no-op this repository forbids, arriving through a string.
   */
  const resolve = (name: string): ComponentType => {
    const type = components.get(name);
    if (type !== undefined) return type;
    throw new Error(
      `no component is registered as \`${name}\`. This host has ` +
        `${[...components.keys()].map((k) => `\`${k}\``).join(', ')}. A script naming one that ` +
        'does not exist would otherwise read zeroes and write into nothing.',
    );
  };

  /*
   * The last search's result, per world, held **here rather than on the world**.
   *
   * A script cannot receive a record, so the result is read back through an accessor — and putting
   * the state in the binding keeps `World` free of a field that exists only because of a language
   * limitation. A `WeakMap` rather than one shared slot, because two worlds are two questions and a
   * shared slot would let one answer the other's. The same arrangement `physicsImplementation` makes
   * for a raycast hit, for the same reasons.
   */
  const found = new WeakMap<object, number>();

  return {
    create: (w: World) => w.create(),
    destroy: (w: World, entity: Entity) => w.destroy(entity),
    alive: (w: World, entity: Entity) => w.alive(entity),
    has: (w: World, entity: Entity, component: string) => w.has(entity, resolve(component)),
    attach: (w: World, entity: Entity, component: string) => w.add(entity, resolve(component)),
    detach: (w: World, entity: Entity, component: string) => w.remove(entity, resolve(component)),
    read: (w: World, entity: Entity, component: string, field: string) => {
      const value = w.read(entity, resolve(component), field);
      /* An entity without the component reads `undefined`, and a script's `f64` may not hold one:
         the language has no null, so the honest zero is what a missing value is. */
      return typeof value === 'number' ? value : 0;
    },
    write: (w: World, entity: Entity, component: string, field: string, value: number) =>
      w.write(entity, resolve(component), field, value),
    /*
     * A query opens against whatever the caller passed as the world.
     *
     * **A `SystemView` and a `World` both satisfy this**, structurally, and that is the point: a
     * loop inside a system runs against the view the schedule handed it, so every declaration
     * check the engine makes still applies — and the same generated code runs against a bare world
     * where there is no system to declare anything.
     */
    query: (w: QuerySource, a: string, b?: string, c?: string, d?: string) =>
      w.query(
        resolve(a),
        b === undefined ? undefined : resolve(b),
        c === undefined ? undefined : resolve(c),
        d === undefined ? undefined : resolve(d),
      ),
    without: (cursor: QueryCursor, component: string) => {
      cursor.without(resolve(component));
    },
    /*
     * A negative ends the walk, and zero would not: zero is the handle of the first entity a fresh
     * world ever allocates. Nothing is allocated to say "done" — a result record per step is the
     * per-frame allocation the whole design refuses.
     */
    next: (cursor: QueryCursor) => {
      const step = cursor.next();
      return step.done ? -1 : (step.value as number);
    },
    view: (w: QuerySource, component: string, forWriting: boolean) =>
      w.view(resolve(component), forWriting),
    count: (w: World, component: string) => w.store(resolve(component)).size,
    at: (w: World, component: string, index: number) => {
      const store = w.store(resolve(component));
      return index < store.size ? (store.dense[index] as number) : 0;
    },
    /*
     * **A boolean rather than an option, and a second accessor for the handle.** `Sound?` is an
     * option because a slot is resolved once at load; this is written to be called every frame by
     * every agent that looks around, and `some(entity)` is one object per call — the same reasoning
     * `next` gives one screen up. A sentinel is not available either: the result is an `Entity`, and
     * a handle is not a number a script can compare to −1, which is the point of it having its own
     * type. So the search answers whether it found anything and `nearest` reads what it found, the
     * shape `raycast` and `hitBody` already have here.
     *
     * **Compared squared, so nothing takes a square root**, and the scan walks the dense columns
     * directly: a store's dense position *is* its column index, so neither `sparse` nor a per-entity
     * `read` is on this path. One pass, no allocation, no call per entity.
     *
     * A field this component does not have reads as absent rather than throwing, and an entity with
     * no position contributes nothing — the honest answer for a component whose author named the
     * wrong field is "nothing was near", reported by finding nothing, rather than a frame-loop
     * throw that `AGENTS.md` forbids.
     */
    findNearest: (
      w: QuerySource,
      component: string,
      fieldX: string,
      fieldY: string,
      fieldZ: string,
      x: number,
      y: number,
      z: number,
      radius: number,
    ) => {
      const type = resolve(component);
      const view = w.view(type, false);
      const columnX = view[fieldX];
      const columnY = view[fieldY];
      const columnZ = view[fieldZ];
      if (columnX === undefined || columnY === undefined || columnZ === undefined) {
        /* A component whose author named the wrong field answers "nothing was near" rather than
           throwing: a frame loop may not throw, and the boolean already carries that answer. */
        found.set(w, -1);
        return false;
      }

      /*
       * **A cursor rather than the store's dense array, because `world` is not always a `World`.**
       *
       * Inside a system the value a script calls this with is the `SystemView` the schedule handed
       * it, which carries `query` and `view` and no `store` — the same structural pair `query` and
       * `view` above are typed against. A first version read `store.size` and `store.dense`, which
       * works from a bare world and throws `w.store is not a function` the moment a system calls it.
       * Going through the cursor is also what keeps a system's declared reads doing their job.
       *
       * The walk always runs to exhaustion, which is what gives the cursor back: it comes from a
       * pool and is returned when `next` reports done, so an early exit on finding something close
       * enough would leak one per call.
       */
      const cursor = w.query(type);
      const limit = radius * radius;
      let best = -1;
      let bestDistance = Infinity;
      for (;;) {
        const step = cursor.next();
        if (step.done === true) break;
        const entity = step.value as number;
        const at = view.sparse[entity % ENTITY_INDEX_CEILING] as number;
        const dx = (columnX[at] as number) - x;
        const dy = (columnY[at] as number) - y;
        const dz = (columnZ[at] as number) - z;
        const distance = dx * dx + dy * dy + dz * dz;
        if (distance > limit || distance >= bestDistance) continue;
        bestDistance = distance;
        best = entity;
      }
      found.set(w, best);
      return best >= 0;
    },
    /*
     * The handle the last search found, or zero when it found nothing.
     *
     * **Zero rather than a refusal**, because a frame loop may not throw and a script that read this
     * without testing has a bug in its own logic rather than a broken host. Zero is a legal handle,
     * so it is not a sentinel and is not documented as one — the honest test is the boolean, which
     * is why the search answers one.
     */
    nearest: (w: QuerySource) => Math.max(0, found.get(w) ?? -1),
  };
}

/**
 * What a query needs from whatever it was handed as a world.
 *
 * **A `SystemView` and a `World` both satisfy it**, which is what lets one piece of generated code
 * run inside a system and outside one. Inside, every call goes through the system's declarations;
 * outside, there are none to go through. Neither is named here, because naming one would make this
 * file choose.
 */
interface QuerySource {
  query(a: ComponentType, b?: ComponentType, c?: ComponentType, d?: ComponentType): QueryCursor;
  view(type: ComponentType, forWriting: boolean): ComponentView;
}

export function prefabImplementation(services: EntityServices): Record<string, unknown> {
  const prefabs = services.prefabs ?? new Map<string, Prefab>();
  return {
    spawn: (w: World, name: string) => {
      const prefab = prefabs.get(name);
      if (prefab === undefined) {
        throw new Error(
          `no prefab is registered as \`${name}\`. This host has ` +
            `${[...prefabs.keys()].map((k) => `\`${k}\``).join(', ')}.`,
        );
      }
      return instantiate(w, prefab);
    },
  };
}
