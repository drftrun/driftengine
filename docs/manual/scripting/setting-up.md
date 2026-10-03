---
title: Setting up scripts
description: The build that compiles .drs files, loading and binding a script, the services a host gives it, calling it, and hot reload that keeps the game's state.
packages: ['@driftengine/script']
areas: ['script']
plain: ['Lamp', 'Puck', 'Sky', 'ContactKind', 'MatterPhase']
---

# Setting up scripts

A script goes through four steps between the file and the game: the bundler compiles it, the page
loads it, the page binds it to the engine, and the page calls it. A fifth, hot reload, replaces its
functions when the file is saved. Each is a few lines, and the starter project has all of them.

## The build

```ts sample=starter/vite.config.ts#plugin
import { fileURLToPath } from 'node:url';
import { driftScript } from 'driftscript/vite';
import { defineConfig } from 'vite';

export default defineConfig(({ command }) => ({
  plugins: [
    driftScript({
      /* The engine's capabilities, as data: every `drift/*` function, its types and its effects. */
      capabilities: fileURLToPath(import.meta.resolve('@driftengine/script/capabilities.json')),
      /* The engine modules a script in this game may import. Add one here when a script needs it;
         an import of a module not named is refused when the file compiles, naming the module. */
      manifest: { name: 'my-game', provides: ['drift/random', 'drift/scene', 'drift/input'] },
      /* `vite build` compiles for shipping: the editor's metadata stays out of the bundle. */
      mode: command === 'build' ? 'production' : 'development',
    }),
  ],
  build: {
    target: 'es2022',
    /* Just above the engine's WebGPU renderer, one module of about 2,100 kB minified that loads only
       where WebGPU does. Vite warns past 500 kB by default; anything larger than the renderer still
       warns. */
    chunkSizeWarningLimit: 2200,
  },
}));
```

DriftScript compiles at the bundler, so a `.drs` file is imported like any other module and needs no
step of its own. The plugin reads two things. `capabilities` is the engine's description of every
function a script can call, as data: its module, its signature and its effects. The compiler checks
calls against it and infers effects from it. `manifest.provides` lists the engine modules this game's
scripts may import, and an import of one not listed is refused when the file compiles, with the
module named. List a module when a script first needs it, and the build says so if you forget.

An error in any script stops the build and lists every error, not only the first, so a script that
does not compile never ships. `mode` decides one thing: whether the editor's metadata rides along in
the compiled module. The starter passes `production` for `vite build`, which leaves it out, and
`development` while serving, which keeps it. A production build also refuses to run without
`capabilities` and `manifest`, since without them `@deterministic` would be a promise nothing
checked. [Installation](../start/installation.md#driftscript) has the two packages to install and
the declaration TypeScript needs.

## Loading and binding

```ts sample=starter/main.ts#script
/*
 * How fast the cube turns is a rule, and rules live in DriftScript: `spin.drs`. The bundler compiles
 * the file, `loadModule` makes a module of it, and `bindModule` gives it the engine capabilities it
 * imports. Saving the file while the page is open replaces its function in place.
 */
const spinModule = loadModule(spinScript as Record<string, unknown>);
const bound = bindModule(spinModule, {});
if (!bound.bound) throw new Error(bound.reason);
const rules = spinModule.exports as unknown as { spinRate(time: number): number };

if (import.meta.hot) {
  import.meta.hot.accept('./spin.drs', (next) => {
    if (next !== undefined) patchModule(spinModule, next as Record<string, unknown>);
  });
}
```

`loadModule` turns the compiled file into a module: its exports, and the metadata saying which
engine modules it imports. A module is not runnable until it is bound. `bindModule(module, services)`
fills every engine import with the engine's implementation and answers `{ bound: true }`, or
`{ bound: false, reason }` with a sentence when it cannot, for instance when the script imports
`drift/ecs` and no entity world was given. Check `bound` and stop: a script that half bound would
fail later, at the first call into the module it is missing, in the middle of a frame.

The examples share one helper for the two calls, with the services as its second argument:

```ts sample=common/script.ts#host
/**
 * Load a compiled `.drs` module and bind it. Most of the modules the examples import need no host;
 * `drift/navigation` needs the graph it routes over, which is what `services` is for.
 */
export function hostScript(compiled: unknown, services: HostServices = {}): DriftModule {
  const module = loadModule(compiled as Record<string, unknown>);
  const bound = bindModule(module, services);
  if (!bound.bound) throw new Error(bound.reason);
  return module;
}

/** One of the module's exports, by name: a function, or the factory a `data` declaration makes. */
export function exported<T>(module: DriftModule, name: string): T {
  const value = module.exports[name];
  if (value === undefined) throw new Error(`the script exports no ${name}`);
  return value as T;
}
```

## What a host gives

Most engine modules need nothing from the page. What each of their functions acts on, a physics
world, an action map, a camera, arrives as an argument when the page calls the script. Eight need
something from the page as a whole, given once, in `services`:

| Module             | `services` field | What it is                                                               |
| ------------------ | ---------------- | ------------------------------------------------------------------------ |
| `drift/ecs`        | `entities`       | The component registry and prefabs the script's entity declarations made |
| `drift/audio`      | `audio`          | The audio graph, its sound registry, and a kick detector for music       |
| `drift/time`       | `clocks`         | The loop's fixed step, frame time, wall time and elapsed time            |
| `drift/navigation` | `navigation`     | The places a world has and how they connect                              |
| `drift/ai`         | `ai`             | The agents a script may ask about                                        |
| `drift/behavior`   | `behavior`       | What a behaviour tree's tick is handed                                   |
| `drift/chemistry`  | `chemistry`      | The chemistry world and its parcels                                      |
| `drift/xr`         | `xr`             | The session's head, controllers and hands                                |

[What a script can reach](reach.md) lists, for every module, whether it is bound from a service or
from arguments, and every function in it.

## Calling a script

```ts sample=input/main.ts#script
const script = hostScript(puckScript);
interface Puck {
  x: number;
  z: number;
  vx: number;
  vz: number;
  boost: number;
  braking: boolean;
  bumps: number;
  hit: number;
  raw: boolean;
  shake: boolean;
}
const puck = exported<() => Puck>(script, 'createPuck')();
type Drive = (puck: Puck, actions: ActionMap, touch: TouchControls, dt: number) => void;
if (import.meta.hot) {
  import.meta.hot.accept('./puck.drs', (next) => {
    if (next !== undefined) patchModule(script, next as Record<string, unknown>, { Puck: [puck] });
  });
}
```

A compiled module's exports are its functions, and a `create` function for each `data` declaration,
which builds a record with the declared defaults. TypeScript cannot see a `.drs` file's exports, so
the page states their shape once, as an interface for each record and a type for each function, and
casts. The record belongs to the page from then on: here `puck` is created once and passed to the
script's `drive` every step.

A value crosses as what the script compiled it to. A number, a string or a `bool` is itself, and a
record is a plain object with its fields. A variant of an enum is `{ tag: 'Won' }`, so the first
game's page reads `round.phase.tag`, and an option is `{ tag: 'some', value }` or
`{ tag: 'none' }`, which is how the cinematic director says whether to cut. A page that hands a
variant in takes it from the script's exports, as the weather page takes `Sky.Storm` from its
module, and compares a variant by its tag: a save makes a new object for every variant, so the one
the page kept is a different object with the same tag. An engine answer that is one of a few things
arrives the same way, as a variant of an enum the engine declares, such as `ContactKind` or
`MatterPhase`; [What a script can reach](reach.md) lists them with their variants.

Read a function through the module each time you call it, as `exported(script, 'drive')` does in
this example and `rules.tick(...)` does in the first game. A save replaces the module's exports in
place, so a reference read once at startup keeps calling the old function.

## Hot reload

The `import.meta.hot` block in each example is the whole of it. When a `.drs` file is saved, Vite
sends the newly compiled module, and `patchModule(script, next, records)` replaces the old module's
functions with the new ones. `records` names the live records by their type, here `{ Puck: [puck] }`,
so that a save which adds a field to `data Puck` gives the existing puck that field with its declared
default and keeps every other value. The game carries on from where it was.

A script that declares components and systems is reloaded the same way, and then registered again so
the schedule picks up the new systems:

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

Only the `.drs` file reloads in place. A change to the TypeScript reloads the page, which is one more
reason the rules belong in the script.

## When something is wrong

A mistake in a script is reported where it is made, with a code, the line and a sentence:

- **A compile error** (a type that does not fit, a field that does not exist, a `match` that misses
  a case) appears in the terminal and over the page, and the page keeps running the last version
  that compiled.
- **A module the manifest does not provide** is refused when the file compiles, naming the module
  and the file that imported it.
- **A service the page did not give** is refused by `bindModule`, naming the script and the engine
  module it needs.

The codes are the language's, `DS` and four digits, and they stay the same from one version to the
next, so an error can be searched for by its code.
