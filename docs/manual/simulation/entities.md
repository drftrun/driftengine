---
title: Entities
description: Generational handles, components as typed columns, systems that declare what they touch, prefabs, saved scenes and rewinds, from DriftScript and TypeScript.
packages: ['@driftengine/entities', '@driftengine/script']
areas: ['entities']
---

# Entities

`@driftengine/entities` is the entity model: handles that know when they have gone stale,
components stored as typed columns, queries over them, systems that say what they read and write,
a schedule on the fixed step, prefabs, scenes saved by stable field ids, and snapshots for a
rewind. It imports no other engine package and declares no components, so a world holds only
what your game says it holds.

DriftScript has the model built into the language. A `.drs` file declares `component`s, `prefab`s
and `system`s, and `for e in query<…>()` is a loop the compiler checks and lowers to an array index.
The example is a pond at dusk: fireflies wander over the water, four frogs on lily pads catch the
ones that come near, and new ones hatch to keep the number the pond is set to. Every rule is a
system in DriftScript; the page builds the world, puts the frogs on their pads and draws what the
stores hold. Set the pond to keep forty, or run time backwards and let it pick up from wherever it
stops.

<!-- run: entities -->

## Components

```drs sample=entities/pond.drs#components
component Position {
    x: f32 = 0
    y: f32 = 0
    z: f32 = 0
}

component Velocity {
    x: f32 = 0
    y: f32 = 0
    z: f32 = 0
}

// A fly, and its own seed and count of turns, which together pick its next heading.
component Fly {
    seed: u32 = 0
    turns: u32 = 0
}

// A frog: how far its tongue reaches, the fly it has its eye on if any, how many it has caught,
// how long before it can catch again, and how long its tongue stays out and where it went.
component Frog {
    reach: f32 = 2.5
    target: Entity?
    caught: u32 = 0
    resting: f32 = 0
    tongue: f32 = 0
    tongueX: f32 = 0
    tongueY: f32 = 0
    tongueZ: f32 = 0
}

// The pond itself: how many flies it keeps, and how many have hatched.
component Pond {
    flies: u32 = 12
    hatched: u32 = 0
}
```

A component is a named set of fields, and each field becomes one column in a store: `f32` and
`f64`, the integer widths from `i8` to `u64`, `bool`, `Entity` for a handle, `String`, and a
fieldless `enum`, whose variant is kept as an integer, which is where a state machine's state
lives. A store is a sparse set, so adding a component to an entity, taking it away and walking
everything that has it all cost the same whoever else is in the world. A component with no data
of its own, a marker, narrows a query by a fact, not by a value.

An optional field, `T?`, keeps its absence in a column beside its value, and reads and writes as an
option from a script, in a query loop or through a handle. A frog's `target` is an `Entity?`: `none`
while it has no fly in its eye, `some(fly)` once it has, and `if let` reads it back.

## Prefabs

```drs sample=entities/pond.drs#prefabs
// What a hatchling and a frog start as. Every value is a constant: where each goes is set after.
prefab Hatchling {
    Position { y: 1 }
    Velocity {}
    Fly {}
}

prefab Sitter {
    Position {}
    Frog { reach: 2.5 }
}
```

A prefab is a value: a name and the components an entity made from it starts with. Every value in
it is a constant, so it can be read, saved and shown without being run, and an entity made from
one keeps no link back to it. A script makes one with `ecs.instantiate(world, "Hatchling")` and
writes whatever should differ afterwards; the page makes the frogs with `instantiate`, below.

## Systems

```drs sample=entities/pond.drs#move
// Everything that has a velocity moves by it, a sixtieth of a second each fixed step.
system Move {
    reads Velocity
    writes Position

    update {
        for e in query<Position, Velocity>() {
            e.Position.x = e.Position.x + e.Velocity.x / 60
            e.Position.y = math.clamp(e.Position.y + e.Velocity.y / 60, 0.4, 2)
            e.Position.z = e.Position.z + e.Velocity.z / 60
        }
    }
}
```

A `system` is a body the schedule runs every fixed step, and it declares what it `reads` and
`writes`, a write implying a read. The declarations are checked twice. The compiler works out what
the body touches and refuses a declaration that leaves something out, naming the system and the
component, and warns about one that names something the body never touches. The schedule refuses
again at run time: a system that touches a component it did not declare is skipped, and the
console says which and why, once. A schedule built from declarations is only right if they are
true, which is why both ends check.

```drs sample=entities/pond.drs#hunt
// Four times a second, each rested frog fixes on the nearest fly within its reach.
system Hunt {
    reads Fly
    reads Position
    writes Frog

    update at 4Hz {
        for frog in query<Frog, Position>() {
            if frog.Frog.resting > 0 {
                continue
            }
            var best = frog.Frog.reach * frog.Frog.reach
            frog.Frog.target = none
            for fly in query<Fly, Position>() {
                let dx = fly.Position.x - frog.Position.x
                let dy = fly.Position.y - frog.Position.y
                let dz = fly.Position.z - frog.Position.z
                let distance = dx * dx + dy * dy + dz * dz
                if distance < best {
                    best = distance
                    frog.Frog.target = some(fly)
                }
            }
        }
    }
}
```

`update at 4Hz` runs the body every fifteenth step of the 60 Hz fixed step; a rate that does not
divide it exactly is refused, because rounding it would make a replay run the system a different
number of times. Queries nest, and a component named in a query counts as a read, even one whose
fields the body never looks at. `.without<T>()` narrows a walk to entities that do not carry `T`,
and `.with<T>()` to those that do.

```drs sample=entities/pond.drs#catch
// A frog with a fly in its eye catches it: out goes the tongue, and the fly is gone.
system Catch {
    reads Position
    writes Frog

    update {
        for frog in query<Frog, Position>() {
            frog.Frog.tongue = math.max(frog.Frog.tongue - 1 / 60, 0)
            frog.Frog.resting = math.max(frog.Frog.resting - 1 / 60, 0)
            if let fly = frog.Frog.target {
                if ecs.alive(world, fly) {
                    frog.Frog.tongueX = fly.Position.x
                    frog.Frog.tongueY = fly.Position.y
                    frog.Frog.tongueZ = fly.Position.z
                    frog.Frog.tongue = 0.2
                    frog.Frog.resting = 4
                    frog.Frog.caught = frog.Frog.caught + 1
                    ecs.destroy(world, fly)
                }
                frog.Frog.target = none
            }
        }
    }
}
```

`e.Component.field` reads and writes through any handle, not only the one a loop is on. Inside a
loop it is an index into a column; through another handle it is a lookup, still checked by name, so
a misspelt field is an error at the line that wrote it. `ecs.destroy` inside a system waits until
the system returns, because removing an entity moves the last one in its store into the gap, and a
walk in progress would skip it. `ecs.alive` answers whether a handle still names a live entity.

```drs sample=entities/pond.drs#hatch
// Four times a second, while the pond has fewer flies than it keeps, one hatches over the water.
// A hatchling is made with every component its prefab names, so the system declares all three: the
// compiler sees the fields this body writes, and the schedule checks the components it adds.
system Hatch {
    writes Pond
    writes Position
    writes Velocity
    writes Fly

    update at 4Hz {
        for pond in query<Pond>() {
            if ecs.count(world, "Fly") < pond.Pond.flies {
                pond.Pond.hatched = pond.Pond.hatched +% 1
                let seed = pond.Pond.hatched *% 2246822519
                let fly = ecs.instantiate(world, "Hatchling")
                fly.Position.x = random.range(seed, -5, 5)
                fly.Position.z = random.range(seed +% 1, -5, 5)
                // Hatching from the water, it rises before it wanders.
                fly.Velocity.y = 0.6
                fly.Fly.seed = seed
            }
        }
    }
}
```

Making an entity is immediate, and one made during a walk may be visited by it. A system that makes
an entity from a prefab writes every component the prefab names, so it declares them all: the
compiler sees the fields its body writes and the schedule checks the components it adds. `ecs` also
has `create`, `attach`, `detach` and `has` for an entity built by hand, `count` and `at` to walk a
store by index, and `findNearest`, a search for the nearest entity within a radius by three
position fields you name.

## The host

```ts sample=entities/main.ts#host
/**
 * The script's components become stores, its prefabs become prefabs, and its systems become a
 * schedule. The registry and the world outlive every reload; the schedule is rebuilt on one.
 */
const pond = loadModule(pondScript as Record<string, unknown>);
const registry: ComponentRegistry = new Map();
const prefabs = new Map<string, Prefab>();
let registered = registerEntityModule(pond, registry);
for (const prefab of registered.prefabs) prefabs.set(prefab.name, prefab);
const bound = bindModule(pond, { entities: { components: registry, prefabs } });
if (!bound.bound) throw new Error(bound.reason);

const world = new World();
let schedule = buildSchedule(registered.systems);
if (import.meta.hot) {
  import.meta.hot.accept('./pond.drs', (next) => {
    if (next === undefined) return;
    patchModule(pond, next as Record<string, unknown>);
    /* The stores are kept, so every fly and frog keeps its components; the systems are new. */
    registered = registerEntityModule(pond, registry);
    for (const prefab of registered.prefabs) prefabs.set(prefab.name, prefab);
    schedule = buildSchedule(registered.systems);
  });
}
```

`registerEntityModule(module, registry)` turns what a module declares into the engine's own
objects: a component type per `component`, registered by name, a `Prefab` per `prefab`, and a
`SystemDefinition` per `system`. `bindModule` is handed the same registry and the prefabs by name,
which is how `ecs` resolves the names a script writes. `buildSchedule(systems)` orders the systems
and `runSchedule(world, schedule, tick)` runs one fixed step of them; the tick decides which
strided systems are due. A system that throws is skipped and the rest still run. The failure is
logged once per system, or handed every time to a reporter passed as a fourth argument, which gets
the system's name, the tick and the error and can throw to stop the schedule there.

A reload keeps the registry, so every store, and with it every entity's components, survives an
edit. The module is patched, registered again for any new component or system, and the schedule is
rebuilt over the same world. A component the host made itself is declared in a script as
`component Name from host { … }`, which asserts its shape when the module binds instead of making a
second one.

```ts sample=entities/main.ts#frogs
/** A frog on each lily pad, from the script's own prefab, with the page saying where. */
const PADS: [number, number][] = [
  [4, 0],
  [0, 4],
  [-4, 0],
  [0, -4],
];
const sitter = prefabs.get('Sitter');
if (sitter === undefined) throw new Error('pond.drs declares no Sitter');
const frogs: Entity[] = PADS.map(([x, z]) =>
  instantiate(world, sitter, { Position: { x, y: 0.15, z } }),
);
const pondEntity = world.create();
world.add(pondEntity, Pond, { flies: 12 });
```

`instantiate(world, prefab, overrides)` makes an entity from a prefab, with overrides by component
name; an override for a component the prefab does not have is refused, since adding it or ignoring
it would both hide a typo.

## From TypeScript

```ts sample=snippets/entities.ts#components
/** A component is a name and its fields' types; each field becomes one typed column. */
const Health = defineComponent('Health', { current: 'f32', max: 'f32' });
const Hunger = defineComponent('Hunger', { value: 'f32' });
/** A field holding a handle is typed `Entity`, so a scene load can rewrite it. */
const Follows = defineComponent('Follows', { leader: 'Entity' });

const world = new World();
const wolf = world.create();
world.add(wolf, Health, { current: 30, max: 30 });
world.add(wolf, Hunger, { value: 0 });
```

```ts sample=snippets/entities.ts#system
/** Hunger rises once a second, and health falls while it is high. Each says what it touches. */
const schedule = buildSchedule([
  {
    name: 'hunger',
    writes: [Hunger],
    everyTicks: 60,
    run(view) {
      const hunger = view.view(Hunger, true);
      for (const entity of view.query(Hunger)) {
        const at = hunger.sparse[entity % 2 ** 26] ?? 0;
        (hunger.value as Float32Array)[at] = ((hunger.value as Float32Array)[at] ?? 0) + 1;
      }
    },
  },
  {
    name: 'starve',
    reads: [Hunger],
    writes: [Health],
    everyTicks: 60,
    after: ['hunger'],
    run(view) {
      for (const entity of view.query(Hunger, Health)) {
        if ((view.read(entity, Hunger, 'value') as number) < 50) continue;
        const current = view.read(entity, Health, 'current') as number;
        view.write(entity, Health, 'current', current - 1);
        if (current <= 1) view.destroy(entity);
      }
    },
  },
]);

/** One fixed step: the schedule, at the tick the loop is on. */
export function tick(count: number): void {
  runSchedule(world, schedule, count);
}
```

The same model with no script: `defineComponent(name, fields)` declares a type, and a world's
`create`, `add`, `remove`, `has`, `read`, `write` and `destroy` do what they say. A system is a
`SystemDefinition`: a `name`, `reads` and `writes`, `everyTicks` for a stride, `after` for the
systems it must follow, and `run(view)`, whose `SystemView` checks every access against the
declarations. The schedule keeps declaration order, adjusted by `after`, and refuses a cycle by
naming the systems in it.

## Reading the stores

```ts sample=entities/main.ts#views
/* A host reads the stores' columns directly, the way any renderer would. */
const positions = world.view(Position);
const frogColumns = world.view(Frog);
const spot = (entity: Entity): number => positions.sparse[entity % 2 ** 26] ?? 0;
```

```ts sample=entities/main.ts#flies
/* Every entity with a Fly and a Position, drawn where its Position column says. */
let count = 0;
for (const fly of world.query(Fly, Position)) {
  const i = spot(fly);
  flyModel[12] = (positions.x as Float32Array)[i] ?? 0;
  flyModel[13] = (positions.y as Float32Array)[i] ?? 0;
  flyModel[14] = (positions.z as Float32Array)[i] ?? 0;
  renderer.drawMesh(flyMesh, flyModel);
  count += 1;
}
```

`world.view(type)` hands back a component's live columns, typed arrays by field name, and `sparse`,
which maps an entity's slot to its row: `sparse[entity % 2 ** 26]`. A renderer reads positions this
way, with no call per entity. `world.query(a, b, c, d)` walks the entities carrying up to four
components, narrowed further with `with` and `without`; the cursor comes from a pool and goes back
when the walk ends, so a query in a frame allocates nothing.

## Saving a scene

```ts sample=snippets/entities.ts#prefab
/** A pack: a leader, and followers made from one prefab with a handle to it written after. */
const pupPrefab = definePrefab('pup', [
  [Health, { current: 10, max: 10 }],
  [Follows, {}],
]);
const pups: Entity[] = [0, 1, 2].map(() => {
  const pup = instantiate(world, pupPrefab, { Health: { max: 12 } });
  world.write(pup, Follows, 'leader', wolf);
  return pup;
});
```

```ts sample=snippets/entities.ts#scene
/** A save names the component types it holds; a load is handed the same, and refuses in words. */
export function save(): string {
  return JSON.stringify(serializeWorld(world, [Health, Hunger, Follows]));
}

export function load(text: string): World {
  const fresh = new World();
  const result = deserializeWorld(fresh, JSON.parse(text) as SerializedScene, [
    Health,
    Hunger,
    Follows,
  ]);
  if (!result.loaded) throw new Error(result.reason);
  return fresh;
}
```

`serializeWorld(world, types)` writes the entities carrying those component types, and
`deserializeWorld(world, scene, types)` reads them into a world, answering `loaded` with the new
handles, or a `reason` and nothing written. Every value is stored by a field id, never by position
or bare name, so a field added in the middle of a component does not shift the ones after it.
Loading across a change migrates: a field added since arrives with its default, one removed is
dropped, and one whose type changed is refused by name. A handle in an `Entity` field is saved as a
position in the scene and rewritten on load to the new handle, so a pup still follows its leader in
the world it was loaded into.

## Rewinding

```ts sample=entities/main.ts#rewind
/**
 * Five seconds of the whole world, a snapshot a tick. A slot is reused once it is written, so after
 * the first lap the ring allocates nothing.
 */
const RING = 300;
const ring: WorldSnapshot[] = Array.from({ length: RING }, createWorldSnapshot);
const ringTicks = new Float64Array(RING);
let head = 0;
let held = 0;
let tick = 0;

function step(): void {
  /* The switch's number wins over whatever the world held, rewound or not. */
  world.write(pondEntity, Pond, 'flies', flies);
  runSchedule(world, schedule, tick);
  tick += 1;
  world.saveInto(ring[head % RING] as WorldSnapshot);
  ringTicks[head % RING] = tick;
  head += 1;
  held = Math.min(held + 1, RING);
}

function stepBack(): void {
  if (held <= 1) return;
  head -= 1;
  held -= 1;
  const at = (head - 1 + RING) % RING;
  world.loadFrom(ring[at] as WorldSnapshot);
  tick = ringTicks[at] ?? tick;
}
```

A snapshot is the whole world at one tick: `createWorldSnapshot()` makes a slot, `saveInto` fills
it and `loadFrom` puts the world back. It covers every store the world has and takes no list of
types, since a component left out of a rewind is state that survived it. A slot grows to the
world's size on its first save and is reused after, so a ring of them allocates nothing once it has
gone round. A snapshot is not a save: it never goes on a wire or into a file, and it does not
migrate.

## Handles

```ts sample=snippets/entities.ts#handles
/** A handle is one number: which slot, and how many times that slot has been reused. */
export function describe(entity: Entity): string {
  return `slot ${entityIndex(entity)}, use ${entityGeneration(entity)}, ${world.alive(entity) ? 'alive' : 'gone'}`;
}
```

An `Entity` is one number: a 26-bit slot and a 27-bit generation, the whole 53 bits a double holds
exactly. Destroying an entity frees its slot, and the next entity to take the slot has the next
generation, so an old handle is not alive and never names the newcomer. That gives sixty-seven
million live entities and 134 million reuses of each slot. `entityIndex` and `entityGeneration` take
a handle apart and `packEntity` puts one together. In a script a handle is `Entity` and stays one: it
can be stored in an `f64`, but a number a script computed cannot be passed where a handle is
wanted.
