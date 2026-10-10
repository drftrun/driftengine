---
title: What a script can reach
description: Every engine module a DriftScript file can import, what the host binds it from, and each function's signature and whether it is deterministic.
packages: ['@driftengine/script']
covers: ['Scripting reach']
---

# What a script can reach

A script reaches the engine only through the modules listed here, and only through the ones the
game's manifest provides. Each function is declared with its signature, its effects and whether it
is deterministic, which is what the compiler checks a call against and what `@deterministic`
depends on. "Bound from arguments" means every function takes what it acts on as an argument the
page passes in; "bound from `services.x`" means the page gives that once, to `bindModule`
([Setting up scripts](setting-up.md#what-a-host-gives)). `std/math` and `std/time` are the
language's own and need no host at all.

The page links each module to the chapters whose examples import it. The language's own reference,
types, records and the rest, is at [script.driftengine.dev](https://script.driftengine.dev/docs).

<!-- generated script-reach -->
25 modules and 343 functions, written from `capabilities.json` by `npm run manual:sync`.

| Module | Functions | Deterministic | Bound from |
|---|---|---|---|
| [`std/math`](#stdmath) | 13 | 13 | the language |
| [`std/time`](#stdtime) | 3 | 3 | the language |
| [`drift/2d`](#drift2d) | 12 | 7 | arguments |
| [`drift/ai`](#driftai) | 9 | 7 | `services.ai` |
| [`drift/animation`](#driftanimation) | 17 | 9 | arguments |
| [`drift/audio`](#driftaudio) | 9 | 3 | `services.audio` |
| [`drift/behavior`](#driftbehavior) | 8 | 4 | `services.behavior` |
| [`drift/camera`](#driftcamera) | 2 | 1 | arguments |
| [`drift/chemistry`](#driftchemistry) | 53 | 53 | `services.chemistry` |
| [`drift/ecs`](#driftecs) | 17 | 11 | `services.entities` |
| [`drift/editor`](#drifteditor) | 43 | 0 | arguments |
| [`drift/events`](#driftevents) | 3 | 3 | arguments |
| [`drift/input`](#driftinput) | 14 | 0 | arguments |
| [`drift/navigation`](#driftnavigation) | 12 | 12 | `services.navigation` |
| [`drift/network`](#driftnetwork) | 9 | 2 | arguments |
| [`drift/persistence`](#driftpersistence) | 5 | 0 | arguments |
| [`drift/physics`](#driftphysics) | 42 | 32 | arguments |
| [`drift/random`](#driftrandom) | 3 | 3 | arguments |
| [`drift/render`](#driftrender) | 10 | 0 | arguments |
| [`drift/rollback`](#driftrollback) | 6 | 0 | arguments |
| [`drift/scene`](#driftscene) | 11 | 8 | arguments |
| [`drift/terrain`](#driftterrain) | 8 | 8 | arguments |
| [`drift/time`](#drifttime) | 4 | 0 | `services.clocks` |
| [`drift/ui`](#driftui) | 18 | 6 | arguments |
| [`drift/xr`](#driftxr) | 12 | 0 | `services.xr` |

### std/math

Part of the language: every script may import it and no host binds it. Effects: `pure`. Used by [Animation](../simulation/animation.md), [Characters](../simulation/characters.md), [Colour and motion](../rendering/colour-and-motion.md), [Entities](../simulation/entities.md), [Fog and weather](../rendering/fog-and-weather.md), [Hello world](../start/hello-world.md), [Input](../interface/input.md), [Large worlds](../worlds/large-worlds.md), [Light in the air](../rendering/light-in-the-air.md), [Navigation](../simulation/navigation.md), [Networking and rollback](../systems/networking.md), [Procedural solids](../worlds/procedural-solids.md), [Queries and colliders](../simulation/queries.md), [Recording and clips](../systems/recording.md), [Saves and preferences](../systems/saves.md), [Sound and music](../content/audio.md), [Sprites and tilemaps](../interface/sprites.md), [Terrain](../worlds/terrain.md), [Vehicles](../simulation/vehicles.md), [Wet surfaces](../rendering/wet-surfaces.md), [XR](../interface/xr.md).

| Function | Signature | Deterministic | What it does |
|---|---|---|---|
| `abs` | `fn(x: float) -> float` | yes | The magnitude of a number. |
| `min` | `fn(a: float, b: float) -> float` | yes | The smaller of two numbers. |
| `max` | `fn(a: float, b: float) -> float` | yes | The larger of two numbers. |
| `clamp` | `fn(x: float, low: float, high: float) -> float` | yes | A number pinned between two bounds. |
| `lerp` | `fn(a: float, b: float, t: float) -> float` | yes | A value between two others. |
| `floor` | `fn(x: float) -> float` | yes | The largest whole number no greater than this. |
| `ceil` | `fn(x: float) -> float` | yes | The smallest whole number no less than this. |
| `round` | `fn(x: float) -> float` | yes | The nearest whole number, halves rounding up. |
| `sqrt` | `fn(x: float) -> float` | yes | The square root. |
| `sin` | `fn(radians: float) -> float` | yes | The sine of an angle in radians. |
| `cos` | `fn(radians: float) -> float` | yes | The cosine of an angle in radians. |
| `atan2` | `fn(y: float, x: float) -> float` | yes | The angle to a point, in radians. |
| `exp` | `fn(x: float) -> float` | yes | Euler's number raised to this power. |

### std/time

Part of the language: every script may import it and no host binds it. Effects: `pure`.

| Function | Signature | Deterministic | What it does |
|---|---|---|---|
| `seconds` | `fn(duration: float) -> float` | yes | A duration in seconds. |
| `milliseconds` | `fn(duration: float) -> float` | yes | A duration in milliseconds, for formatting. |
| `progress` | `fn(elapsed: float, total: float) -> float` | yes | How far through a duration something is, from 0 to 1. |

### drift/2d

Bound always: what each function acts on arrives as an argument the host passes in. Effects: `scene.read`, `scene.write`. Used by [Sprites and tilemaps](../interface/sprites.md).

| Function | Signature | Deterministic | What it does |
|---|---|---|---|
| `sprite` | `fn(batch: SpriteBatch, texture: i32, x: f32, y: f32, w: f32, h: f32) -> void` | no | Put one quad in the batch, covering the whole of a texture. |
| `tinted` | `fn(batch: SpriteBatch, texture: i32, x: f32, y: f32, w: f32, h: f32, r: f32, g: f32, b: f32, a: f32) -> void` | no | The same, multiplied by a colour picked for the screen: sRGB, 0 to 1, decoded to linear as a tint on a node is, with alpha kept as given. |
| `frame` | `fn(batch: SpriteBatch, sheet: SpriteSheet, frame: i32, x: f32, y: f32, w: f32, h: f32) -> void` | no | Put one frame of a sheet in the batch. |
| `named` | `fn(sheet: SpriteSheet, name: String) -> i32` | yes | The index a name has in a sheet, or -1. |
| `frames` | `fn(sheet: SpriteSheet) -> i32` | yes | How many frames the sheet was cut into. |
| `tilemap` | `fn(batch: SpriteBatch, map: Tilemap, sheet: SpriteSheet, x: f32, y: f32, w: f32, h: f32) -> i32` | no | Draw the tiles a view rectangle can see, and answer how many that was. |
| `tile` | `fn(map: Tilemap, column: i32, row: i32) -> i32` | yes | The frame in a cell, or -1 for an empty one — including for a cell outside the map, which answers empty rather than another row. |
| `setTile` | `fn(map: Tilemap, column: i32, row: i32, tile: i32) -> void` | no | Put a frame in a cell. |
| `columns` | `fn(map: Tilemap) -> i32` | yes | How wide the map is, in cells. |
| `rows` | `fn(map: Tilemap) -> i32` | yes | How tall the map is, in cells. |
| `count` | `fn(batch: SpriteBatch) -> i32` | yes | How many quads are in the batch this frame. |
| `dropped` | `fn(batch: SpriteBatch) -> i32` | yes | How many quads did not fit this frame. |

### drift/ai

Bound when the host passes `services.ai` to `bindModule`; without it, an import of this module is refused at bind with a sentence saying so. Effects: `ai`, `navigation.read`, `navigation.write`, `network.read`, `pure`. Used by [Agents and behaviour](../simulation/agents.md).

| Function | Signature | Deterministic | What it does |
|---|---|---|---|
| `agent` | `fn(id: String) -> Agent?` | yes | Resolve an agent by the id the consumer registered it under. |
| `wake` | `fn(agent: Agent, reason: String, priority: i32) -> void` | no | Tell an agent something happened. |
| `consider` | `fn(agent: Agent) -> void` | no | Ask an agent to think, at ordinary priority. |
| `intentId` | `fn(agent: Agent) -> String` | yes | What the agent is doing now. |
| `degraded` | `fn(agent: Agent) -> bool` | yes | Whether the agent is over budget and running on its policy floor alone. |
| `reachable` | `fn(agent: Agent, x: float, y: float, z: float) -> bool` | yes | Whether a route exists from where this agent is to a point, without writing one. |
| `navigate` | `fn(agent: Agent, x: float, y: float, z: float) -> bool` | yes | Route this agent to a point. |
| `path` | `fn(agent: Agent) -> NavPath?` | yes | The route object this agent follows, for `drift/navigation` to read or steer along. |
| `deciding` | `fn(agent: Agent) -> bool` | yes | Whether this peer decides this agent’s model intents. |

### drift/animation

Bound always: what each function acts on arrives as an argument the host passes in. Effects: `animation.write`, `pure`. Used by [Animation](../simulation/animation.md).

| Function | Signature | Deterministic | What it does |
|---|---|---|---|
| `pose` | `fn(jointCount: u32) -> Pose` | yes | A new pose at rest. |
| `toRest` | `fn(pose: Pose, jointCount: u32) -> void` | no | Return a pose to rest without allocating another, which is what a state machine does on re-entry. |
| `sample` | `fn(clip: Clip, at: f32, into: Pose) -> void` | no | Sample a clip at a time. |
| `blend` | `fn(a: Pose, b: Pose, amount: f32, into: Pose) -> void` | no | Blend two poses into a third, clamped at the ends. |
| `blendSet` | `fn(tree: Blend, parameter: String, value: f32) -> void` | no | Set one of a tree's parameters. |
| `blendAt` | `fn(tree: Blend, at: f32, into: Pose) -> void` | no | Evaluate a whole tree into a pose. |
| `reach` | `fn(skeleton: Skeleton, pose: Pose, root: u32, mid: u32, tip: u32, targetX: f32, targetY: f32, targetZ: f32, poleX: f32, poleY: f32, poleZ: f32) -> bool` | no | Bend a two-bone chain so its tip reaches a target. |
| `motion` | `fn() -> Motion` | yes | A new root displacement, at zero. |
| `rootMotion` | `fn(clip: Clip, joint: u32, from: f32, to: f32, into: Motion) -> void` | no | How far the root travelled between two times, in its own frame at `from`. |
| `stripRoot` | `fn(clip: Clip, joint: u32, pose: Pose) -> void` | no | Pin a sampled pose's root to the clip's value at time zero, so the displacement `rootMotion` handed you is not also in the pose. |
| `motionX` | `fn(motion: Motion) -> f32` | yes | The displacement along the root's own x axis at the earlier time. |
| `motionY` | `fn(motion: Motion) -> f32` | yes | The displacement along the root's own y axis at the earlier time. |
| `motionZ` | `fn(motion: Motion) -> f32` | yes | The displacement along the root's own z axis at the earlier time. |
| `motionTurnX` | `fn(motion: Motion) -> f32` | yes | The x part of the rotation the root turned through, as a quaternion. |
| `motionTurnY` | `fn(motion: Motion) -> f32` | yes | The y part of the rotation the root turned through, as a quaternion. |
| `motionTurnZ` | `fn(motion: Motion) -> f32` | yes | The z part of the rotation the root turned through, as a quaternion. |
| `motionTurnW` | `fn(motion: Motion) -> f32` | yes | The w part of the rotation the root turned through, as a quaternion. |

### drift/audio

Bound when the host passes `services.audio` to `bindModule`; without it, an import of this module is refused at bind with a sentence saying so. Effects: `audio.write`, `nondeterministic`, `pure`. Used by [Sound and music](../content/audio.md).

| Function | Signature | Deterministic | What it does |
|---|---|---|---|
| `sound` | `fn(slot: String) -> Sound?` | yes | Resolve a sound slot. |
| `play` | `fn(sound: Sound, gain: f32) -> void` | no | Play a resolved sound through the mix. |
| `playPanned` | `fn(sound: Sound, gain: f32, pan: f32) -> void` | no | Play a resolved sound at a stereo position, -1 left to 1 right. |
| `distanceGain` | `fn(distance: f32, radius: f32) -> f32` | yes | How loud something is at a distance, falling off to nothing at the radius. |
| `stereoPan` | `fn(dx: f32, dz: f32, yaw: f32) -> f32` | yes | Where something sits in the stereo field, relative to a listener facing yaw. |
| `duck` | `fn(bus: String, factor: f32, seconds: f32) -> bool` | no | Take a bus down to factor of its fader over seconds, 1 to bring it back, leaving the fader where the player set it. |
| `fade` | `fn(bus: String, level: f32, seconds: f32) -> bool` | no | Move a bus's fader to level over seconds. |
| `recall` | `fn(snapshot: String, seconds: f32) -> bool` | no | Crossfade every level, mute and send to a snapshot the host captured, over seconds. |
| `pulse` | `fn() -> f32` | no | How hard the music is kicking, 0 to 1, spiking on each kick and falling back. |

### drift/behavior

Bound when the host passes `services.behavior` to `bindModule`; without it, an import of this module is refused at bind with a sentence saying so. Effects: `behavior.read`, `behavior.write`. Used by [Agents and behaviour](../simulation/agents.md).

`TreeStatus`: `Failure`, `Success`, `Running`. What a behaviour tree answered: it failed, it finished, or it is still going.

| Function | Signature | Deterministic | What it does |
|---|---|---|---|
| `tick` | `fn(behavior: Behavior) -> TreeStatus` | no | Advance the routine one tick, and answer whether it failed, finished or is still going. |
| `step` | `fn(behavior: Behavior) -> TreeStatus` | no | Advance one tick even while paused, which is what a step button is. |
| `restart` | `fn(behavior: Behavior) -> void` | no | Forget where the routine had got to, so the next tick starts it from the top. |
| `setPaused` | `fn(behavior: Behavior, paused: bool) -> void` | no | Hold this one agent while the world carries on. |
| `paused` | `fn(behavior: Behavior) -> bool` | yes | Whether it is being held. |
| `status` | `fn(behavior: Behavior) -> TreeStatus` | yes | What the last tick answered, without ticking again. |
| `doing` | `fn(behavior: Behavior, node: String) -> bool` | yes | Whether the agent is currently inside a node of this name — the routine's own answer, not a copy of it. |
| `depth` | `fn(behavior: Behavior) -> i32` | yes | How deep in the tree the last tick reached. |

### drift/camera

Bound always: what each function acts on arrives as an argument the host passes in. Effects: `scene.read`, `scene.write`. Used by [Cameras and cinematics](../interface/cameras.md).

| Function | Signature | Deterministic | What it does |
|---|---|---|---|
| `snap` | `fn(camera: Camera) -> void` | no | Jump the camera to where it is heading, skipping the ease. |
| `shotAge` | `fn(camera: Camera) -> f32` | yes | Seconds since the current shot began. |

### drift/chemistry

Bound when the host passes `services.chemistry` to `bindModule`; without it, an import of this module is refused at bind with a sentence saying so. Effects: `chemistry.read`, `chemistry.write`. Used by [Chemistry](../simulation/chemistry.md).

`MatterPhase`: `Solid`, `Liquid`, `Gas`, `Mixed`. What a parcel is made of now. Mixed is a real answer: wet wood is a solid and a liquid at once.

`ChemistryEvent`: `Ignited`, `Extinguished`, `SmoulderStart`, `SmoulderEnd`, `Consumed`, `Charred`, `StructuralFail`, `Frozen`, `Melted`, `Boiled`, `Condensed`, `Sublimed`, `Corroded`, `Calcined`, `Dissolved`, `Denatured`, `Browned`, `Caramelised`, `Fermented`, `Decayed`, `Exploded`. What happened to a parcel this tick: it caught, went out, melted, boiled and the rest.

| Function | Signature | Deterministic | What it does |
|---|---|---|---|
| `substance` | `fn(chem: Chemistry, id: String) -> Substance` | yes | A registered material by id, such as `oak`. |
| `species` | `fn(chem: Chemistry, id: String) -> Species` | yes | A registered species by id, such as `O2`. |
| `parcelCount` | `fn(chem: Chemistry) -> i32` | yes | How many parcel handles have ever been issued, live or not. |
| `parcelAt` | `fn(chem: Chemistry, index: i32) -> i32` | yes | The handle at an index, for iteration. |
| `alive` | `fn(chem: Chemistry, parcel: i32) -> bool` | yes | Whether a parcel still exists. |
| `substanceOf` | `fn(chem: Chemistry, parcel: i32) -> Substance` | yes | What material a parcel is made of. |
| `temperature` | `fn(chem: Chemistry, parcel: i32) -> f32` | yes | K, averaged over the whole parcel. |
| `surfaceTemperature` | `fn(chem: Chemistry, parcel: i32) -> f32` | yes | K at the outermost shell — the one that decides whether it catches. |
| `coreTemperature` | `fn(chem: Chemistry, parcel: i32) -> f32` | yes | K at the innermost shell — the one that decides whether it is cooked. |
| `mass` | `fn(chem: Chemistry, parcel: i32) -> f32` | yes | How much of it there is, in kilograms. |
| `speciesMass` | `fn(chem: Chemistry, parcel: i32, species: Species) -> f32` | yes | kg of one species held anywhere in this parcel. |
| `moisture` | `fn(chem: Chemistry, parcel: i32) -> f32` | yes | kg of water per kg of dry matter — the dry basis, which is how moisture content is quoted. |
| `charFraction` | `fn(chem: Chemistry, parcel: i32) -> f32` | yes | Share of the parcel that is now carbon, 0 to 1. |
| `charDepth` | `fn(chem: Chemistry, parcel: i32) -> f32` | yes | Metres of char measured inward from the surface. |
| `wetness` | `fn(chem: Chemistry, parcel: i32) -> f32` | yes | kg of liquid water on the surface, per square metre of it. |
| `wettable` | `fn(chem: Chemistry, parcel: i32) -> bool` | yes | Whether this material can hold liquid water, which is what `wet` asks. |
| `phase` | `fn(chem: Chemistry, parcel: i32) -> MatterPhase` | yes | Whether the parcel is solid, liquid, gas or mixed. |
| `burning` | `fn(chem: Chemistry, parcel: i32) -> bool` | yes | Whether a flame stands over it. |
| `smouldering` | `fn(chem: Chemistry, parcel: i32) -> bool` | yes | Whether it is glowing with no flame. |
| `heatRelease` | `fn(chem: Chemistry, parcel: i32) -> f32` | yes | kW the reactions released last tick. |
| `ignitionProgress` | `fn(chem: Chemistry, parcel: i32) -> f32` | yes | How close to catching, 0 to 1: the least satisfied of the five criteria. |
| `structuralIntegrity` | `fn(chem: Chemistry, parcel: i32) -> f32` | yes | How much is still load-bearing, 1 down to 0, as char eats the thickness. |
| `massFlux` | `fn(chem: Chemistry, parcel: i32) -> f32` | yes | kg/(m²·s) of gas leaving the surface — the smoke. |
| `fuelFlux` | `fn(chem: Chemistry, parcel: i32) -> f32` | yes | The combustible share of that, which is what ignition is measured against. |
| `positionX` | `fn(chem: Chemistry, parcel: i32) -> f32` | yes | Where the consumer said this parcel is. |
| `positionY` | `fn(chem: Chemistry, parcel: i32) -> f32` | yes | Where the consumer said this parcel is. |
| `positionZ` | `fn(chem: Chemistry, parcel: i32) -> f32` | yes | Where the consumer said this parcel is. |
| `ambientTemperature` | `fn(chem: Chemistry, x: f32, y: f32, z: f32) -> f32` | yes | K of the air at a point. |
| `oxygenFraction` | `fn(chem: Chemistry, x: f32, y: f32, z: f32) -> f32` | yes | Volume fraction of oxygen. |
| `humidity` | `fn(chem: Chemistry, x: f32, y: f32, z: f32) -> f32` | yes | Relative humidity, 0 to 1. |
| `pressure` | `fn(chem: Chemistry, x: f32, y: f32, z: f32) -> f32` | yes | Pascals. |
| `concentration` | `fn(chem: Chemistry, species: Species, x: f32, y: f32, z: f32) -> f32` | yes | Parts per million by volume. |
| `smokeDensity` | `fn(chem: Chemistry, x: f32, y: f32, z: f32) -> f32` | yes | Extinction coefficient, 1/m: what to attenuate a light along a ray by. |
| `visibility` | `fn(chem: Chemistry, x: f32, y: f32, z: f32) -> f32` | yes | How far you can see, metres. |
| `place` | `fn(chem: Chemistry, substance: Substance, kilograms: f32, area: f32, x: f32, y: f32, z: f32) -> i32` | yes | Put a new parcel in the world. |
| `destroy` | `fn(chem: Chemistry, parcel: i32) -> void` | yes | Remove a parcel. |
| `move` | `fn(chem: Chemistry, parcel: i32, x: f32, y: f32, z: f32) -> void` | yes | Where it is. |
| `addHeat` | `fn(chem: Chemistry, parcel: i32, joules: f32) -> void` | yes | Joules into the surface shell, which is what a flux from outside does. |
| `addHeatDeep` | `fn(chem: Chemistry, parcel: i32, shell: i32, joules: f32) -> void` | yes | Joules into a named shell. |
| `setTemperature` | `fn(chem: Chemistry, parcel: i32, kelvin: f32) -> void` | yes | Set every shell to a temperature. |
| `wet` | `fn(chem: Chemistry, parcel: i32, kilograms: f32) -> void` | yes | Pour water on it: real liquid water into the surface shell, where boiling will find it. |
| `dry` | `fn(chem: Chemistry, parcel: i32, kilograms: f32) -> void` | yes | Take surface water away: a cloth, a hot dry pan, or wind. |
| `ignite` | `fn(chem: Chemistry, parcel: i32) -> void` | yes | Supply a pilot for one tick. |
| `douse` | `fn(chem: Chemistry, parcel: i32) -> void` | yes | Remove the pilot and the flame. |
| `addSpecies` | `fn(chem: Chemistry, parcel: i32, species: Species, kilograms: f32) -> void` | yes | Salt the water, oil the pan, poison the well. |
| `mix` | `fn(chem: Chemistry, from: i32, into: i32) -> void` | yes | Pour one parcel into another; the first is consumed. |
| `release` | `fn(chem: Chemistry, species: Species, kilograms: f32, x: f32, y: f32, z: f32) -> void` | yes | A gas release into the air: a leak, a vent, an extinguisher. |
| `addAirHeat` | `fn(chem: Chemistry, joules: f32, x: f32, y: f32, z: f32) -> void` | yes | Joules into a cell of air, which is what a heater does and what a fire does to the room. |
| `eventCount` | `fn(chem: Chemistry) -> i32` | yes | Events this tick. |
| `eventKind` | `fn(chem: Chemistry, index: i32) -> ChemistryEvent` | yes | What happened in one of this tick’s events. |
| `eventParcel` | `fn(chem: Chemistry, index: i32) -> i32` | yes | Which parcel it happened to. |
| `eventSpecies` | `fn(chem: Chemistry, index: i32) -> i32` | yes | Which species, or -1 where the kind does not name one. |
| `eventValue` | `fn(chem: Chemistry, index: i32) -> f32` | yes | The kind's own quantity. |

### drift/ecs

Bound when the host passes `services.entities` to `bindModule`; without it, an import of this module is refused at bind with a sentence saying so. Effects: `ecs.read`, `ecs.write`. Used by [Entities](../simulation/entities.md), [Saves and preferences](../systems/saves.md).

| Function | Signature | Deterministic | What it does |
|---|---|---|---|
| `create` | `fn(world: World) -> Entity` | no | A fresh entity with nothing on it. |
| `destroy` | `fn(world: World, entity: Entity) -> bool` | no | Remove an entity and every component it had. |
| `alive` | `fn(world: World, entity: Entity) -> bool` | yes | Whether this handle still names a live entity. |
| `has` | `fn(world: World, entity: Entity, component: String) -> bool` | yes | Whether an entity carries a component. |
| `attach` | `fn(world: World, entity: Entity, component: String) -> void` | no | Give an entity a component, every field at the zero for its type. |
| `detach` | `fn(world: World, entity: Entity, component: String) -> bool` | no | Take a component away. |
| `read` | `fn(world: World, entity: Entity, component: String, field: String) -> f64` | yes | One numeric field. |
| `write` | `fn(world: World, entity: Entity, component: String, field: String, value: f64) -> void` | no | Set one numeric field. |
| `count` | `fn(world: World, component: String) -> u32` | yes | How many entities carry a component. |
| `at` | `fn(world: World, component: String, index: u32) -> Entity` | yes | The nth entity carrying a component. |
| `findNearest` | `fn(world: World, component: String, fieldX: String, fieldY: String, fieldZ: String, x: float, y: float, z: float, radius: float) -> bool` | yes | Whether any entity carrying a component has position fields putting it within a radius, and the search `nearest` then reads. |
| `nearest` | `fn(world: World) -> Entity` | yes | The entity the last `findNearest` on this world found. |
| `instantiate` | `fn(world: World, prefab: String) -> Entity` | no | Make an entity from a prefab, with every component it names. |
| `query` | `fn(world: World, a: String, b: String, c: String, d: String) -> Cursor` | yes | Open a walk over everything carrying these components. |
| `without` | `fn(cursor: Cursor, component: String) -> void` | yes | Narrow an open walk to entities that do **not** carry a component. |
| `next` | `fn(cursor: Cursor) -> Entity` | yes | The next entity, or a **negative** number when the walk is done — which also gives the cursor back. |
| `view` | `fn(world: World, component: String, forWriting: bool) -> View` | yes | A component’s live columns. |

### drift/editor

Bound always: what each function acts on arrives as an argument the host passes in. Effects: `editor`.

`GizmoMode`: `Translate`, `Rotate`, `Scale`. Which tool a gizmo is: it moves, turns or scales.

`GizmoSpace`: `World`, `Local`. Which axes a gizmo’s handles point along: the world’s or the object’s own.

`GizmoHandle`: `None`, `TranslateX`, `TranslateY`, `TranslateZ`, `TranslateYZ`, `TranslateZX`, `TranslateXY`, `RotateX`, `RotateY`, `RotateZ`, `ScaleX`, `ScaleY`, `ScaleZ`, `ScaleUniform`. Which handle the pointer is over, or `None`.

`EditorMode`: `Edit`, `Play`, `Paused`. Whether the editor is editing, playing the world, or paused part way through playing it.

`FieldKind`: `Number`, `Integer`, `Boolean`, `Text`, `Entity`, `Enum`. How an inspector field is shown, taken from the type it was declared with.

| Function | Signature | Deterministic | What it does |
|---|---|---|---|
| `translateMode` | `fn(gizmo: Gizmo) -> void` | no | Make this an arrow gizmo, which moves what it is on. |
| `rotateMode` | `fn(gizmo: Gizmo) -> void` | no | Make this a ring gizmo, which turns what it is on. |
| `scaleMode` | `fn(gizmo: Gizmo) -> void` | no | Make this a scale gizmo. |
| `gizmoMode` | `fn(gizmo: Gizmo) -> GizmoMode` | no | Which of the three the gizmo is: translate, rotate or scale. |
| `worldSpace` | `fn(gizmo: Gizmo) -> void` | no | Point the handles along the world axes. |
| `localSpace` | `fn(gizmo: Gizmo) -> void` | no | Point the handles along the object’s own axes. |
| `space` | `fn(gizmo: Gizmo) -> GizmoSpace` | no | Which the handles are pointing along: the world or the object. |
| `size` | `fn(gizmo: Gizmo) -> f32` | no | How big the gizmo is in metres. |
| `setSize` | `fn(gizmo: Gizmo, metres: f32) -> void` | no | Set how big the gizmo is in metres. |
| `hovered` | `fn(gizmo: Gizmo) -> GizmoHandle` | no | What the pointer is over: `None`, or a handle such as `TranslateX`, `TranslateYZ`, `RotateY` or `ScaleUniform`. |
| `dragging` | `fn(gizmo: Gizmo) -> bool` | no | Whether a drag is running. |
| `dragAngle` | `fn(gizmo: Gizmo) -> f32` | no | How far a rotation drag has turned, in radians, signed and past a full turn if it went that far. |
| `positionX` | `fn(gizmo: Gizmo) -> f32` | no | Where the thing being edited is, along x. |
| `positionY` | `fn(gizmo: Gizmo) -> f32` | no | The same, along y. |
| `positionZ` | `fn(gizmo: Gizmo) -> f32` | no | The same, along z. |
| `setPosition` | `fn(gizmo: Gizmo, x: f32, y: f32, z: f32) -> void` | no | Put the gizmo, and the transform it is editing, somewhere. |
| `scaleX` | `fn(gizmo: Gizmo) -> f32` | no | How much the thing being edited is scaled, along x. |
| `scaleY` | `fn(gizmo: Gizmo) -> f32` | no | The same, along y. |
| `scaleZ` | `fn(gizmo: Gizmo) -> f32` | no | The same, along z. |
| `rotationX` | `fn(gizmo: Gizmo) -> f32` | no | The orientation being edited, as a quaternion: x. |
| `rotationY` | `fn(gizmo: Gizmo) -> f32` | no | The same: y. |
| `rotationZ` | `fn(gizmo: Gizmo) -> f32` | no | The same: z. |
| `rotationW` | `fn(gizmo: Gizmo) -> f32` | no | The same: w. |
| `mode` | `fn(editor: Editor) -> EditorMode` | no | What the editor is doing: editing, playing or paused. |
| `playing` | `fn(editor: Editor) -> bool` | no | Whether the world is advancing. |
| `play` | `fn(editor: Editor) -> bool` | no | Start playing, taking a snapshot of the world first so `stop` can put it back. |
| `pause` | `fn(editor: Editor) -> void` | no | Hold the world where it is. |
| `step` | `fn(editor: Editor) -> void` | no | Advance exactly one fixed tick, then hold. |
| `stop` | `fn(editor: Editor) -> bool` | no | Leave play and put the world back as it was. |
| `rowCount` | `fn(editor: Editor) -> i32` | no | How many rows the tree showed at its last rebuild. |
| `rebuildTree` | `fn(editor: Editor, root: Node) -> void` | no | Walk a node and everything under it into rows, honouring which branches are collapsed. |
| `rowName` | `fn(editor: Editor, row: i32) -> String` | no | What the node on a row is called, or "" for a row that does not exist. |
| `rowDepth` | `fn(editor: Editor, row: i32) -> i32` | no | How deep a row sits, with the root at zero. |
| `rowExpanded` | `fn(editor: Editor, row: i32) -> bool` | no | Whether a row is showing its children. |
| `toggleRow` | `fn(editor: Editor, row: i32) -> void` | no | Open a closed row or close an open one. |
| `selectRow` | `fn(editor: Editor, row: i32) -> void` | no | Select the node on a row, which points the gizmo at it. |
| `selectedRow` | `fn(editor: Editor) -> i32` | no | Which row is selected, or minus one. |
| `fieldCount` | `fn(editor: Editor) -> i32` | no | How many fields the inspector is showing. |
| `fieldLabel` | `fn(editor: Editor, field: i32) -> String` | no | A field’s name as it was declared, or "" for a field that does not exist. |
| `fieldGroup` | `fn(editor: Editor, field: i32) -> String` | no | What a field belongs to: a component’s name, or "transform" for a node. |
| `fieldKind` | `fn(editor: Editor, field: i32) -> FieldKind` | no | How to show a field: a number, an integer, a boolean, text, an entity or an enum. |
| `fieldNumber` | `fn(editor: Editor, field: i32) -> f32` | no | A field’s value as a number. |
| `setFieldNumber` | `fn(editor: Editor, field: i32, value: f32) -> bool` | no | Write a number into a field. |

### drift/events

Bound always: what each function acts on arrives as an argument the host passes in. Effects: `pure`.

| Function | Signature | Deterministic | What it does |
|---|---|---|---|
| `push` | `fn(queue: Queue, id: String, priority: f32, holdFor: f32) -> void` | yes | Queue a message by identity. |
| `current` | `fn(queue: Queue) -> String?` | yes | The id of the message showing now, if any. |
| `clear` | `fn(queue: Queue) -> void` | yes | Drop everything queued. |

### drift/input

Bound always: what each function acts on arrives as an argument the host passes in. Effects: `host`, `input.read`. Used by [Characters](../simulation/characters.md), [Input](../interface/input.md), [Sprites and tilemaps](../interface/sprites.md), [Vehicles](../simulation/vehicles.md).

| Function | Signature | Deterministic | What it does |
|---|---|---|---|
| `down` | `fn(actions: Actions, action: String) -> bool` | no | Whether an action is held. |
| `pressed` | `fn(actions: Actions, action: String) -> bool` | no | Whether an action went down this frame. |
| `axisX` | `fn(actions: Actions, action: String) -> f32` | no | A directional action's horizontal component, shortened to the rim with the vertical one so a keyboard diagonal is not faster than a straight line. |
| `axisY` | `fn(actions: Actions, action: String) -> f32` | no | A directional action's vertical component, shortened to the rim with the horizontal one. |
| `rawAxisX` | `fn(actions: Actions, action: String) -> f32` | no | An action's horizontal axis on its own, not shortened against the vertical one. |
| `rawAxisY` | `fn(actions: Actions, action: String) -> f32` | no | An action's vertical axis on its own, not shortened against the horizontal one. |
| `canRumble` | `fn(actions: Actions) -> bool` | no | Whether the pad these actions read has motors this browser can drive. |
| `rumble` | `fn(actions: Actions, durationMs: f32, strong: f32, weak: f32) -> bool` | no | Rumble for a duration in milliseconds, at two magnitudes in [0, 1]: `strong` is the low-frequency motor and `weak` the high-frequency one. |
| `stopRumble` | `fn(actions: Actions) -> bool` | no | Stop whatever that pad is playing. |
| `touchX` | `fn(touch: Touch) -> f32` | no | The touch stick's horizontal, -1 to 1, 0 while no thumb is on it. |
| `touchY` | `fn(touch: Touch) -> f32` | no | The touch stick's vertical, -1 to 1, up negative as a gamepad stick's is. |
| `touchHeld` | `fn(touch: Touch) -> bool` | no | Whether a thumb is held still on the action side of the screen: the held form of the primary. |
| `touchTap` | `fn(touch: Touch) -> bool` | no | Whether the action side was tapped since this was last asked. |
| `touchSlide` | `fn(touch: Touch) -> bool` | no | Whether a downward flick on the action side is being held: the secondary, a slide or a crouch. |

### drift/navigation

Bound when the host passes `services.navigation` to `bindModule`; without it, an import of this module is refused at bind with a sentence saying so. Effects: `navigation.read`, `navigation.write`. Used by [Navigation](../simulation/navigation.md).

| Function | Signature | Deterministic | What it does |
|---|---|---|---|
| `nearest` | `fn(graph: NavGraph, x: float, y: float, z: float) -> i32` | yes | The node nearest a place, or -1 where the graph has none. |
| `nearestWithin` | `fn(graph: NavGraph, x: float, y: float, z: float, maxDistance: float) -> i32` | yes | The nearest node within a distance, or -1. |
| `route` | `fn(path: NavPath, graph: NavGraph, fromX: float, fromY: float, fromZ: float, toX: float, toY: float, toZ: float) -> bool` | yes | Path from one place to another, storing the route. |
| `routeBetween` | `fn(path: NavPath, graph: NavGraph, from: i32, to: i32) -> bool` | yes | The same, between two nodes you already have. |
| `path` | `fn(agent: Entity) -> NavPath` | yes | The route this agent is following, kept by the host between steps. |
| `clear` | `fn(path: NavPath) -> void` | yes | Forget the route. |
| `following` | `fn(path: NavPath) -> bool` | yes | Whether there is a route to follow. |
| `steerX` | `fn(path: NavPath, x: float, y: float, z: float) -> float` | yes | Where a walker at this place should aim, along x. |
| `steerY` | `fn(path: NavPath, x: float, y: float, z: float) -> float` | yes | The same aim point, along y. |
| `steerZ` | `fn(path: NavPath, x: float, y: float, z: float) -> float` | yes | The same aim point, along z. |
| `remaining` | `fn(path: NavPath, x: float, y: float, z: float) -> float` | yes | How far is left, following the path rather than as the crow flies. |
| `arrived` | `fn(path: NavPath, x: float, y: float, z: float) -> bool` | yes | Whether the walker is there. |

### drift/network

Bound always: what each function acts on arrives as an argument the host passes in. Effects: `network.read`, `network.write`, `nondeterministic`.

| Function | Signature | Deterministic | What it does |
|---|---|---|---|
| `self` | `fn(session: Session) -> i32` | yes | Which participant this peer is. |
| `authority` | `fn(session: Session) -> bool` | yes | Whether this peer’s world is the authoritative one. |
| `participants` | `fn(session: Session) -> i32` | no | How many participants the session holds. |
| `confirmed` | `fn(session: Session) -> i32` | no | The highest tick every participant’s input has arrived for, or -1. |
| `halted` | `fn(session: Session) -> bool` | no | Whether the session has stopped, because an input arrived too late to apply or two peers computed different worlds. |
| `haltReason` | `fn(session: Session) -> String` | no | Why it halted, as a sentence, or an empty string. |
| `slots` | `fn(session: Session) -> i32` | no | How many replicated scalars each participant has. |
| `replicated` | `fn(session: Session, participant: i32, slot: i32) -> f32` | no | Read a participant’s published scalar. |
| `replicate` | `fn(session: Session, slot: i32, value: f32) -> void` | no | Publish a value in one of this peer’s slots. |

### drift/persistence

Bound always: what each function acts on arrives as an argument the host passes in. Effects: `persistence.read`, `persistence.write`. Used by [Saves and preferences](../systems/saves.md).

`SaveStatus`: `Idle`, `Pending`, `Saving`, `Failed`. Whether a store’s writes have landed: idle, waiting to send, sending, or failed.

| Function | Signature | Deterministic | What it does |
|---|---|---|---|
| `read` | `fn(store: Store, key: String) -> String?` | no | What is stored under a key. |
| `write` | `fn(store: Store, key: String, value: String) -> void` | no | Store a value under a key. |
| `remove` | `fn(store: Store, key: String) -> void` | no | Forget a key. |
| `saveStatus` | `fn(store: Store) -> SaveStatus` | no | Whether writes have landed: idle, pending, saving or failed. |
| `pendingSaves` | `fn(store: Store) -> u32` | no | How many keys are waiting to reach the backend. |

### drift/physics

Bound always: what each function acts on arrives as an argument the host passes in. Effects: `physics.read`, `physics.write`. Used by [Queries and colliders](../simulation/queries.md), [Rigid bodies](../simulation/rigid-bodies.md).

`ContactKind`: `Enter`, `Stay`, `Exit`. Whether two bodies began touching this step, are still touching, or have parted.

| Function | Signature | Deterministic | What it does |
|---|---|---|---|
| `colliderCount` | `fn(colliders: Colliders) -> u32` | yes | How many colliders a set holds. |
| `colliderCapacity` | `fn(colliders: Colliders) -> u32` | yes | How many slots the set has allocated, live or not. |
| `colliderBytes` | `fn(colliders: Colliders) -> u32` | yes | What the set costs in memory, in bytes. |
| `beginColliderGroup` | `fn(colliders: Colliders) -> void` | no | Open a group. |
| `addColliderBox` | `fn(colliders: Colliders, cx: f32, cy: f32, cz: f32, hx: f32, hy: f32, hz: f32) -> void` | no | A box in the open group, by centre and half-extents — the same numbers a mesh builder takes, so nothing is authored twice. |
| `endColliderGroup` | `fn(colliders: Colliders) -> u32` | no | Put the open group into the set and return the handle that drops it again. |
| `removeColliderGroup` | `fn(colliders: Colliders, group: u32) -> void` | no | Drop a group and everything in it. |
| `anyWithin` | `fn(colliders: Colliders, x: f32, y: f32, z: f32, radius: f32) -> bool` | yes | Whether any collider overlaps the *box* around a sphere. |
| `nearestWithin` | `fn(colliders: Colliders, x: f32, y: f32, z: f32, radius: f32) -> bool` | yes | Find the closest collider within a radius and record it. |
| `nearCollider` | `fn(colliders: Colliders) -> i32` | yes | The collider the last `nearestWithin` on this set found, or −1. |
| `nearX` | `fn(colliders: Colliders) -> f32` | yes | The closest point on that collider’s bounds, along x — the point on the wall rather than the wall’s centre. |
| `nearY` | `fn(colliders: Colliders) -> f32` | yes | The closest point on that collider’s bounds, along y. |
| `nearZ` | `fn(colliders: Colliders) -> f32` | yes | The closest point on that collider’s bounds, along z. |
| `nearDistance` | `fn(colliders: Colliders) -> f32` | yes | How far that collider’s bounds are, in metres. |
| `bodyCount` | `fn(world: PhysicsWorld) -> i32` | yes | How many bodies the world holds. |
| `bodyX` | `fn(world: PhysicsWorld, body: i32) -> f32` | yes | A body's world position along x. |
| `bodyY` | `fn(world: PhysicsWorld, body: i32) -> f32` | yes | A body's world position along y. |
| `bodyZ` | `fn(world: PhysicsWorld, body: i32) -> f32` | yes | A body's world position along z. |
| `bodyVelX` | `fn(world: PhysicsWorld, body: i32) -> f32` | yes | A body's velocity along x, in metres per second. |
| `bodyVelY` | `fn(world: PhysicsWorld, body: i32) -> f32` | yes | A body's velocity along y, in metres per second. |
| `bodyVelZ` | `fn(world: PhysicsWorld, body: i32) -> f32` | yes | A body's velocity along z, in metres per second. |
| `bodyMass` | `fn(world: PhysicsWorld, body: i32) -> f32` | yes | A body's mass in kilograms, or zero where it has none because it is static or kinematic. |
| `sleeping` | `fn(world: PhysicsWorld, body: i32) -> bool` | yes | Whether a body has been still long enough to stop being solved. |
| `raycast` | `fn(world: PhysicsWorld, x: f32, y: f32, z: f32, dx: f32, dy: f32, dz: f32, maxDistance: f32, mask: i32) -> bool` | yes | Cast a ray and record what it hit. |
| `hitBody` | `fn(world: PhysicsWorld) -> i32` | yes | The body the last `raycast` on this world found, or −1. |
| `hitX` | `fn(world: PhysicsWorld) -> f32` | yes | Where the last raycast struck, along x. |
| `hitY` | `fn(world: PhysicsWorld) -> f32` | yes | Where the last raycast struck, along y. |
| `hitZ` | `fn(world: PhysicsWorld) -> f32` | yes | Where the last raycast struck, along z. |
| `hitNormalX` | `fn(world: PhysicsWorld) -> f32` | yes | The surface normal the last raycast struck, along x. |
| `hitNormalY` | `fn(world: PhysicsWorld) -> f32` | yes | The surface normal the last raycast struck, along y. |
| `hitNormalZ` | `fn(world: PhysicsWorld) -> f32` | yes | The surface normal the last raycast struck, along z. |
| `hitFraction` | `fn(world: PhysicsWorld) -> f32` | yes | How far along the ray the last hit was, from 0 to 1. |
| `contactCount` | `fn(world: PhysicsWorld) -> i32` | yes | How many contact events the last step produced. |
| `contactKind` | `fn(world: PhysicsWorld, index: i32) -> ContactKind` | yes | An event's kind: the two bodies began touching, are still touching, or have parted. |
| `contactA` | `fn(world: PhysicsWorld, index: i32) -> i32` | yes | The lower-indexed body of a contact event. |
| `contactB` | `fn(world: PhysicsWorld, index: i32) -> i32` | yes | The higher-indexed body of a contact event. |
| `applyImpulse` | `fn(world: PhysicsWorld, body: i32, px: f32, py: f32, pz: f32, atX: f32, atY: f32, atZ: f32) -> void` | no | Apply an impulse at a world point. |
| `applyForce` | `fn(world: PhysicsWorld, body: i32, fx: f32, fy: f32, fz: f32, dt: f32, atX: f32, atY: f32, atZ: f32) -> void` | no | A force applied for one step, which is an impulse of force times dt. |
| `setVelocity` | `fn(world: PhysicsWorld, body: i32, vx: f32, vy: f32, vz: f32) -> void` | no | Set a body's velocity outright, waking its island. |
| `setPosition` | `fn(world: PhysicsWorld, body: i32, x: f32, y: f32, z: f32) -> void` | no | Move a body outright. |
| `wake` | `fn(world: PhysicsWorld, body: i32) -> void` | no | Wake a body and everything sharing its island, because a sleeping neighbour would settle it again. |
| `setGravity` | `fn(world: PhysicsWorld, x: f32, y: f32, z: f32) -> void` | no | The world's gravity, in metres per second squared. |

### drift/random

Bound always: what each function acts on arrives as an argument the host passes in. Effects: `pure`. Used by [Entities](../simulation/entities.md), [Fog and weather](../rendering/fog-and-weather.md), [Large worlds](../worlds/large-worlds.md), [Navigation](../simulation/navigation.md), [Rigid bodies](../simulation/rigid-bodies.md), [Saves and preferences](../systems/saves.md), [Wet surfaces](../rendering/wet-surfaces.md), [Worlds from a kit](../worlds/worlds-from-a-kit.md), [Writable textures](../worlds/writable-textures.md).

| Function | Signature | Deterministic | What it does |
|---|---|---|---|
| `unit` | `fn(seed: u32) -> f32` | yes | A value from 0 to 1 for a seed. |
| `range` | `fn(seed: u32, low: f32, high: f32) -> f32` | yes | A value between two bounds for a seed. |
| `index` | `fn(seed: u32, count: u32) -> u32` | yes | An index into a collection of `count` items. |

### drift/render

Bound always: what each function acts on arrives as an argument the host passes in. Effects: `scene.write`. Used by [Colour and motion](../rendering/colour-and-motion.md), [Light in the air](../rendering/light-in-the-air.md).

| Function | Signature | Deterministic | What it does |
|---|---|---|---|
| `bloom` | `fn(renderer: Renderer, scale: f32) -> void` | no | How much of the frame's bloom ceiling to take, 0 to 1. |
| `bloomAbove` | `fn(renderer: Renderer, scale: f32, threshold: f32) -> void` | no | How much of the bloom ceiling to take, 0 to 1, and how bright a pixel must be before it blooms, in scene units, above 0. |
| `exposure` | `fn(renderer: Renderer, stops: f32) -> void` | no | How far this frame is scaled into the tone curve, above 0. |
| `filmic` | `fn(renderer: Renderer, slope: f32, toe: f32, shoulder: f32, blackClip: f32, whiteClip: f32) -> void` | no | The `filmic` output transform's curve, held until changed: the straight segment's slope through mid grey, how much of the curve the toe and the shoulder take (0 to 1), and how far black and white clip past their ends (0 to 1). |
| `motionBlur` | `fn(renderer: Renderer, scale: f32) -> void` | no | How much of the camera motion blur ceiling this frame takes, 0 to 1. |
| `speedBlur` | `fn(renderer: Renderer, strength: f32) -> void` | no | How much speed blur the frame resolves with, 0 to 1. |
| `focus` | `fn(renderer: Renderer, distance: f32, range: f32, scale: f32) -> void` | no | Where this frame's lens is focused and how deep the sharp zone is, in metres, and how much of the depth-of-field ceiling to take, 0 to 1. |
| `occlusionFade` | `fn(renderer: Renderer, distance: f32, radius: f32) -> void` | no | Where ambient occlusion fades out with distance: whole up to `distance` metres from the eye and gone `radius` metres past it, so far scenery and a distant sky are not shaded in rings that follow the depth buffer. |
| `medium` | `fn(renderer: Renderer, density: f32, albedo: f32, anisotropy: f32, maxDistance: f32) -> void` | no | How thick the air is: a medium filling the whole frustum, rather than a beam inside a hull. |
| `veil` | `fn(renderer: Renderer, red: f32, green: f32, blue: f32, alpha: f32) -> void` | no | Composite a flat colour over the finished frame, for a cut dipping to white or to black. |

### drift/rollback

Bound always: what each function acts on arrives as an argument the host passes in. Effects: `nondeterministic`.

| Function | Signature | Deterministic | What it does |
|---|---|---|---|
| `tick` | `fn(rewind: Rewind) -> i32` | no | The last tick that was stepped, or -1 before the first. |
| `isReplaying` | `fn(rewind: Rewind) -> bool` | no | Whether this tick is being re-run to correct a mispredicted one. |
| `depth` | `fn(rewind: Rewind) -> i32` | no | How many ticks back a rewind can reach. |
| `earliest` | `fn(rewind: Rewind) -> i32` | no | The oldest tick still retained, or -1. |
| `replays` | `fn(rewind: Rewind) -> i32` | no | How many rewinds have happened. |
| `replayedTicks` | `fn(rewind: Rewind) -> i32` | no | How many ticks those rewinds re-ran in total. |

### drift/scene

Bound always: what each function acts on arrives as an argument the host passes in. Effects: `scene.read`, `scene.write`.

| Function | Signature | Deterministic | What it does |
|---|---|---|---|
| `positionX` | `fn(node: Node) -> f32` | yes | A node's local x. |
| `positionY` | `fn(node: Node) -> f32` | yes | A node's local y. |
| `positionZ` | `fn(node: Node) -> f32` | yes | A node's local z. |
| `setPosition` | `fn(node: Node, x: f32, y: f32, z: f32) -> void` | no | Move a node, marking it and its subtree for a world update. |
| `setScale` | `fn(node: Node, x: f32, y: f32, z: f32) -> void` | no | Scale a node. |
| `setRotation` | `fn(node: Node, x: f32, y: f32, z: f32, radians: f32) -> void` | no | Rotate a node about an axis. |
| `windDirectionX` | `fn(wind: Wind) -> f32` | yes | The prevailing wind's x, normalised; zero when there is no wind to have a direction. |
| `windDirectionZ` | `fn(wind: Wind) -> f32` | yes | The prevailing wind's z, normalised; zero when there is no wind to have a direction. |
| `windSpeed` | `fn(wind: Wind) -> f32` | yes | How hard it is blowing, metres a second, never negative. |
| `windGust` | `fn(wind: Wind) -> f32` | yes | The gust alone, -1 to 1, for a behaviour that wants the deviation and not the total. |
| `distance` | `fn(a: Node, b: Node) -> f32` | yes | The distance between two nodes, in local space. |

### drift/terrain

Bound always: what each function acts on arrives as an argument the host passes in. Effects: `physics.read`. Used by [Terrain](../worlds/terrain.md).

| Function | Signature | Deterministic | What it does |
|---|---|---|---|
| `heightAt` | `fn(terrain: Terrain, x: float, z: float) -> float` | yes | How high the ground is at a place, in metres. |
| `normalX` | `fn(terrain: Terrain, x: float, z: float) -> float` | yes | Which way the ground faces at a place, along x. |
| `normalY` | `fn(terrain: Terrain, x: float, z: float) -> float` | yes | The same, along y. |
| `normalZ` | `fn(terrain: Terrain, x: float, z: float) -> float` | yes | The same, along z. |
| `slopeAt` | `fn(terrain: Terrain, x: float, z: float) -> float` | yes | How steep the ground is at a place, in radians from flat. |
| `covers` | `fn(terrain: Terrain, x: float, z: float) -> bool` | yes | Whether a place is over the field at all. |
| `extentX` | `fn(terrain: Terrain) -> f32` | yes | How far the field reaches along x, in metres. |
| `extentZ` | `fn(terrain: Terrain) -> f32` | yes | How far the field reaches along z, in metres. |

### drift/time

Bound when the host passes `services.clocks` to `bindModule`; without it, an import of this module is refused at bind with a sentence saying so. Effects: `clock.read`.

| Function | Signature | Deterministic | What it does |
|---|---|---|---|
| `fixedDelta` | `fn() -> f32` | no | The fixed simulation step, in seconds. |
| `frameDelta` | `fn() -> f32` | no | Seconds since the previous rendered frame, after clamping. |
| `wallDelta` | `fn() -> f32` | no | Seconds of real time since the previous frame, unclamped. |
| `elapsed` | `fn() -> f32` | no | Seconds since the loop started. |

### drift/ui

Bound always: what each function acts on arrives as an argument the host passes in. Effects: `input.read`, `scene.read`, `scene.write`. Used by [Interfaces](../interface/interface.md).

| Function | Signature | Deterministic | What it does |
|---|---|---|---|
| `layout` | `fn(tree: UiTree, x: f32, y: f32, w: f32, h: f32) -> void` | no | Lay the tree out into a box. |
| `draw` | `fn(tree: UiTree, batch: SpriteBatch, white: i32) -> i32` | no | Put the tree in a batch and answer how many quads that was. |
| `has` | `fn(tree: UiTree, name: String) -> bool` | yes | Whether the tree holds a node of this name. |
| `left` | `fn(tree: UiTree, name: String) -> f32` | yes | Where a node ended up, along x. |
| `top` | `fn(tree: UiTree, name: String) -> f32` | yes | The same, along y. |
| `width` | `fn(tree: UiTree, name: String) -> f32` | yes | How wide a node ended up. |
| `height` | `fn(tree: UiTree, name: String) -> f32` | yes | How tall a node ended up. |
| `visible` | `fn(tree: UiTree, name: String) -> bool` | yes | Whether a node is shown. |
| `show` | `fn(tree: UiTree, name: String, visible: bool) -> void` | no | Show or hide a node and everything under it. |
| `setText` | `fn(tree: UiTree, name: String, text: String) -> void` | no | Change what a node says. |
| `tint` | `fn(tree: UiTree, name: String, r: f32, g: f32, b: f32, a: f32) -> void` | no | Change a node's background colour, given as picked for the screen: sRGB, 0 to 1, decoded here to the linear light the renderer draws, as a theme's hex token is. |
| `hovered` | `fn(tree: UiTree, name: String) -> bool` | no | Whether the pointer is over a node. |
| `pressed` | `fn(tree: UiTree, name: String) -> bool` | no | Whether the pointer went down on a node and has not come up. |
| `focused` | `fn(tree: UiTree, name: String) -> bool` | no | Whether a node has the keyboard. |
| `point` | `fn(tree: UiTree, x: f32, y: f32, down: bool) -> bool` | no | Route the pointer, and answer whether this call activated anything. |
| `activated` | `fn(tree: UiTree, name: String) -> bool` | no | Whether the last `point` activated this node. |
| `key` | `fn(tree: UiTree, key: String, shift: bool) -> bool` | no | Route a key, and answer whether it activated what has focus. |
| `focus` | `fn(tree: UiTree, name: String) -> void` | no | Give a node the keyboard. |

### drift/xr

Bound when the host passes `services.xr` to `bindModule`; without it, an import of this module is refused at bind with a sentence saying so. Effects: `input.read`, `scene.read`. Used by [XR](../interface/xr.md).

`Hand`: `Left`, `Right`, `None`. Which hand: left, right, or the input source with no side.

`HandJoint`: `Wrist`, `ThumbMetacarpal`, `ThumbPhalanxProximal`, `ThumbPhalanxDistal`, `ThumbTip`, `IndexFingerMetacarpal`, `IndexFingerPhalanxProximal`, `IndexFingerPhalanxIntermediate`, `IndexFingerPhalanxDistal`, `IndexFingerTip`, `MiddleFingerMetacarpal`, `MiddleFingerPhalanxProximal`, `MiddleFingerPhalanxIntermediate`, `MiddleFingerPhalanxDistal`, `MiddleFingerTip`, `RingFingerMetacarpal`, `RingFingerPhalanxProximal`, `RingFingerPhalanxIntermediate`, `RingFingerPhalanxDistal`, `RingFingerTip`, `PinkyFingerMetacarpal`, `PinkyFingerPhalanxProximal`, `PinkyFingerPhalanxIntermediate`, `PinkyFingerPhalanxDistal`, `PinkyFingerTip`. One of the twenty-five joints WebXR tracks on a hand, from the wrist to each fingertip.

| Function | Signature | Deterministic | What it does |
|---|---|---|---|
| `presenting` | `fn() -> bool` | no | Whether a session is running. |
| `supported` | `fn() -> bool` | no | Whether this device could present at all. |
| `headX` | `fn() -> f32` | no | Where the viewer’s head is, in metres. |
| `headY` | `fn() -> f32` | no | Where the viewer’s head is, in metres. |
| `headZ` | `fn() -> f32` | no | Where the viewer’s head is, in metres. |
| `trigger` | `fn(hand: Hand) -> f32` | no | How far a hand’s trigger is pulled, 0 to 1. |
| `squeeze` | `fn(hand: Hand) -> f32` | no | How far a hand’s grip is squeezed, 0 to 1. |
| `holding` | `fn(hand: Hand) -> bool` | no | Whether a hand is tracked this frame. |
| `jointX` | `fn(hand: Hand, joint: HandJoint) -> f32` | no | Where a hand joint is, in metres. |
| `jointY` | `fn(hand: Hand, joint: HandJoint) -> f32` | no | Where a hand joint is, in metres. |
| `jointZ` | `fn(hand: Hand, joint: HandJoint) -> f32` | no | Where a hand joint is, in metres. |
| `pinching` | `fn(hand: Hand) -> bool` | no | Whether a hand’s thumb and index tips are close enough to count as a pinch. |
<!-- end generated -->
