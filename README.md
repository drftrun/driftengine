<p align="center">
  <img src="packages/package/assets/lockup.svg" alt="DriftEngine" width="150">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@driftengine/core"><img alt="npm" src="https://img.shields.io/npm/v/@driftengine/core?logo=npm&label=%40driftengine%2Fcore"></a>
  <a href="LICENSE"><img alt="Licence" src="https://img.shields.io/npm/l/@driftengine/core?label=licence"></a>
  <a href="https://github.com/drftrun/driftengine/actions/workflows/test.yml"><img alt="Tests" src="https://github.com/drftrun/driftengine/actions/workflows/test.yml/badge.svg"></a>
  <a href="https://www.npmjs.com/org/driftengine"><img alt="Packages" src="https://img.shields.io/badge/packages-18-blue"></a>
  <a href="https://www.npmjs.com/package/@driftengine/core"><img alt="Install size" src="https://img.shields.io/bundlephobia/minzip/@driftengine/core?label=core%20gzipped"></a>
</p>

DriftEngine is a 3D engine written in strict TypeScript. It draws through WebGPU and falls back to
WebGL2 where a browser offers no usable device.

**A game built on it is not confined to a tab.** The same build ships as a web page and as an
installed native application — Linux, Windows, macOS and Android, from one manifest, through
[`@driftengine/package`](packages/package/README.md). A consumer installs only the packages it
uses.

**Nothing here decides what your game is.** There is no character type, no route, no world
generator, no HUD. The API takes positions, colours, sizes and time, so the shape of what you build
stays yours — and when you outgrow a piece of it, you replace that piece rather than fight the
engine's idea of your game.

That is enforced rather than intended. A package reaches outside itself only through a dependency
it declares, and installing `@driftengine/core` alone pulls in nothing optional; both are asserted
by tests that run on every push.

**Twenty-three packages, and a consumer takes only what it uses:**

| Package                                                      | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Gzipped            |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| [`@driftengine/core`](packages/core/README.md)               | The runtime: loop, renderer, geometry, input, cameras, scene graph. Re-exports the whole of `@driftengine/physics`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 698.4 KB           | **698.4 KB**          |
| [`@driftengine/animation`](packages/animation/README.md)     | Skeletons, clips sampled as a pure function of a time you supply, blend trees, IK, morph targets, and **spring secondary motion that scrubs backwards**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 6.1 KB             | **6.1 KB over core**  |
| [`@driftengine/audio`](packages/audio/README.md)             | Layered stems, synthesis, rhythm analysis, positional placement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 6.1 KB             | **6.1 KB over core**  |
| [`@driftengine/assets`](packages/assets/README.md)           | Model readers for seven formats, and the streaming loader                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 12.5 KB            | **12.5 KB over core** |
| [`@driftengine/splats`](packages/splats/README.md)           | Gaussian splat captures: readers, view-dependent colour, an off-frame sort, a pass that composes into the scene                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 16.5 KB            | **16.5 KB over core** |
| [`@driftengine/texture`](packages/texture/README.md)         | A texture as a compiled, sampled field rather than an image: one object per material carrying every channel, declared conventions so nothing downstream guesses which way a normal points, normal mips that get rougher instead of sparkling, content-addressed tiles, and a decoder that is **data walked by one shader rather than a shader permutation** — ARCHITECTURE.md prices the alternative at 196,910 gzipped bytes for one flag. Time is a sampling argument rather than a clock, so an animated texture is byte-exact under replay, which no other engine's can claim. **2,305 bytes gzipped, standalone**                                                                                                                                                                                                                                                                                                                                                                                                      | **2.3 KB**         |
| [`@driftengine/capture`](packages/capture/README.md)         | A video to a playable scene, on the player's own device. So far, the models a capture runs, each a definition the one neural runtime builds a graph from at whatever size a clip needs: **Depth Anything 3** — depth, its confidence and a camera per view, from one view or several at once — **MobileSAM** — masks from a point or a box — **SAM 2.1**, which also tracks objects through a video, and **OWLv2**, boxes for things named in words, each answering as the upstream's own code does on a seeded miniature of its layout, which ships beside it, and the frames a capture runs on — a host's own source, read one at a time, and each model's own preparation. **66,373 bytes gzipped**                                                                                                                                                                                                                                                                                                                      | **64.8 KB**        |
| [`@driftengine/nav`](packages/nav/README.md)                 | A navigation mesh, reversing a refusal the refused module named its own trigger for: `navGraph.ts` says a mesh is "the row that is still open" if walkable space is genuinely a region, and a streamed open world is that. Geometry becomes a voxel field, a watershed partition, contours that are checked for self-intersection rather than assumed simple, and convex polygons that border each other both ways. **One A\* in the repository**: the query builds a `NavGraph` and hands it to core's existing `NavSearch`, then funnels — so open ground is one straight line and not a walk along polygon centres. The graph is not replaced; it stays right for roads and corridors. **8,401 bytes gzipped**                                                                                                                                                                                                                                                                                                           | **8.2 KB**         |
| [`@driftengine/tools`](packages/tools/README.md)             | The editor's panels as something a shipped game can carry: an inspector, a console, a profiler and a network panel, with the command stack that makes their edits undoable. **The line is what a panel needs, not what it shows** — a scene tree and an asset browser want a project and a shipped game has none, so those stayed in the editor. `Panel.route` returns a `Command` or nothing, which is why an in-game inspector edit is undoable without the game arranging anything. Optional: nothing in core imports it, and every other package's size floor is unchanged by its existing. **5,391 bytes gzipped**                                                                                                                                                                                                                                                                                                                                                                                                     | **5.3 KB**         |
| [`@driftengine/terrain`](packages/terrain/README.md)         | Heightfields: a query that answers the surface that is drawn, and patches that meet at different detail without cracks. Imports no renderer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 1.4 KB             | **1.4 KB over core**  |
| [`@driftengine/ui2d`](packages/ui2d/README.md)               | The 2D layer: batched sprites, sheets, tilemaps culled to the view, and a retained interface tree with layout, focus and input routing. Draws through `registerPass`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 8.7 KB             | **8.7 KB over core**  |
| [`@driftengine/script`](packages/script/README.md)           | The `drift/*` capability bindings — the only place the engine and DriftScript are coupled                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 36.8 KB            | **36.8 KB over core** |
| [`@driftengine/physics`](packages/physics/README.md)         | Rigid body dynamics: shapes, broadphase, contact manifolds, a substepped soft-constraint solver, seven joint types including a configurable six-DOF one, ray and shape queries, sensors, a character controller, a stall escape, ragdolls, a raycast vehicle, cloth with two-way coupling and self-collision, and **static concave mesh colliders**. Imports no other engine package; core depends on it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 45.1 KB standalone | **45.1 KB**           |
| [`@driftengine/chemistry`](packages/chemistry/README.md)     | Thermochemistry of bulk matter: a closed element set, species whose molar masses are derived from their formulas, the species-by-element matrix, compositions, the conservation reduction every later phase is asserted with, **enthalpy as the state variable** — so a phase change is a gated reaction whose plateau the solver produces — a **depth stack**, so a twig catches and a log does not, a **reaction network** balanced against the element matrix and costed by Hess's law, **one atmosphere** carrying oxygen to a fire and smoke away from it, **radiation with the 1/r² that makes distance mean something**, ignition as a criterion rather than a flag, and **thirty-nine substances across seven optional entry points** so a consumer pays only for the families they use, **condensed tar**, so a smouldering fire's smoke is pale where a flaming one's is black with nothing choosing between them, and a `drift/chemistry` surface a script tends a fire through. Imports no other engine package | 18.1 KB standalone | **18.1 KB**           |
| [`@driftengine/editor`](packages/editor/README.md)           | The model of a scene editor: a flattened, collapsible tree of what exists, an inspector that reflects over a component's declared schema so it works for one a `.drs` file wrote, play-in-editor that snapshots and restores a world, and panel builders that produce `@driftengine/ui2d` nodes rather than pixels. Carries no renderer — `Gizmo` is its only value import from core                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 10.4 KB standalone | **10.4 KB**           |
| [`@driftengine/network`](packages/network/README.md)         | One rewind core under both networking models, because prediction and rollback are the same operation: put the state back to a tick, correct it, step forward. A transport seam a caller supplies, an input log whose window is explicit so a peer running ahead cannot evict a retained input, and a snapshotter generic over its own slot type. Carries no renderer, which is what lets an authoritative host run it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 2.4 KB standalone  | **2.4 KB**            |
| [`@driftengine/entities`](packages/entities/README.md)       | Entities with generational identity, component storage, queries, systems with declared reads and writes, prefabs and scenes. Imports no other engine package                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 0.6 KB             | **0.9 KB**            |
| [`@driftengine/ai`](packages/ai/README.md)                   | Provider-neutral intelligence sessions, typed tools and context, budgets — and an agent loop that does not wait, so a slow or absent provider costs quality rather than motion. Bound to DriftScript as `drift/ai`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | not gated          | **1.7 KB**            |
| [`@driftengine/xr`](packages/xr/README.md)                   | WebXR sessions, stereo views, controller input and twenty-five hand joints a hand, over `XRGPUBinding` where a runtime has one and `XRWebGLLayer` otherwise. Supplies views to a camera, which is why core never reaches back for a session. Bound to DriftScript as `drift/xr`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | not gated          | **10.6 KB**           |
| [`@driftengine/drft`](packages/drft/README.md)               | The `.drft` container itself. Declares no runtime dependency                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 8.1 KB standalone  | **8.1 KB**            |
| [`@driftengine/media`](packages/media/README.md)             | Clip encoding and frame delivery. Carries `mp4-muxer` so core does not                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | not gated          | **11.3 KB**           |
| [`@driftengine/package`](packages/package/README.md)         | Turns a built game into an installable desktop, native or Android application                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | build-side         | **a build tool**      |
| [`@driftengine/native-host`](packages/native-host/README.md) | The engine on a native window and a native WebGPU device — Node, Dawn and SDL — with the page a game expects around its canvas. Loaded by `@driftengine/package` for its native target only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Node-side          | **a Node host**       |

**And the language, on its own version line**, because DriftScript is a reusable language this
engine merely hosts — an engine patch release must never announce a language change that did not
happen:

| Package                                                    | What it is                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`driftscript`](https://www.npmjs.com/package/driftscript) | The language: compiler, runtime, capability registry, linker, `std/*`, formatter and Vite plugin. An MIT package on npm with its own repository at [drftrun/driftscript](https://github.com/drftrun/driftscript), which this engine pins like any other dependency |

**Every `drift/*` module the language specifies is described by this engine.**
`drift/xr` was the last, and a script that names one this host does not provide is refused by the
linker at link time with the module named, rather than failing at a call.

The editor client is on the marketplace as [DriftScript (.drs)](https://marketplace.visualstudio.com/items?itemName=DriftTech.driftscript-vscode), and it is not a development artefact
rather than something a consumer installs.

A game that never records a clip never installs an encoder. That is the point of the split,
and it is why the payload budget survives the engine growing.

**The sizes above are derived from the floors `scripts/size-gate.test.mjs` asserts**, not typed into
this table. `scripts/packages.test.mjs` fails when one drifts, when a package has no README, and when
this table and the directory disagree — each of them a way a table quietly stops being true.

Backends: WebGL2 and WebGPU, behind one surface. **WebGPU is the default**, and WebGL2 is
the floor it falls back to — silently, wherever a browser offers no usable device. A device is
accepted by **drawing with it**, not by asking whether it exists: the probe compiles what it is
given and reads back a known pixel, and a device that refuses either lands on WebGL2 carrying its
own words. See [`docs/PORTING.md`](docs/PORTING.md).

**The scope is the full engine.** Nothing is declined on principle: what is missing is scheduled
rather than refused — [`docs/ROADMAP.md`](docs/ROADMAP.md) is the order it arrives in and
["What does not exist yet"](#what-does-not-exist-yet) is the honest state of it today. What the
growth is not allowed to cost: a feature a game never uses is a package it never installs, hot
paths allocate nothing, and the API still has to serve a second unrelated game unchanged.

## Start here

Three doors, depending on what you came for.

| If you want to                    | Go to                                                                                                                                                                              |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Write code against the engine** | [`examples/`](examples/README.md) — six small runnable programs, one capability each. `npm run examples` serves them. This is the shortest path from nothing to a frame on screen. |
| **See what it can do**            | [`npm run demo`](#looking-at-the-demos) — the scenes in `demo/`, one button each, including a voxel sandbox, a chemistry sandbox and a WebXR page.                                 |
| **Judge whether it fits**         | [`docs/CAPABILITIES.md`](docs/CAPABILITIES.md) — what ships, what is absent, and a test behind each absent row. Nothing is claimed there that is not measured.                     |

**The documentation, one job each** — [`docs/README.md`](docs/README.md) is the index and states
the rule that keeps them from overlapping:

| Document                                  | Its one job                                                                                                                                     |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| [`CAPABILITIES.md`](docs/CAPABILITIES.md) | What the engine does and does not do. The single map.                                                                                           |
| [`HANDBOOK.md`](docs/HANDBOOK.md)         | **Working with imported models**: commands, flags, and what to do when an import comes out wrong. The one to read when a model looks incorrect. |
| [`ARCHITECTURE.md`](docs/ARCHITECTURE.md) | The package split, the boundaries, and the rules every package obeys.                                                                           |
| [`RENDERING.md`](docs/RENDERING.md)       | How the picture is made, and for each effect the approaches that looked plausible and were not.                                                 |
| [`FORMAT.md`](docs/FORMAT.md)             | The `.drft` container specification, and which model formats are read at which tier.                                                            |
| [`SHIPPING.md`](docs/SHIPPING.md)         | Turning a web build into an installed desktop or Android application.                                                                           |
| [`PORTING.md`](docs/PORTING.md)           | Upgrading across a major release, written from the upgrade rather than about it.                                                                |
| [`ROADMAP.md`](docs/ROADMAP.md)           | What is coming, in what order, and the reasoning for that order.                                                                                |
| [`IMPROVEMENTS.md`](docs/IMPROVEMENTS.md) | Findings that are measured and not yet taken, so none is rediscovered twice.                                                                    |

Each package carries its own README with its full surface — the table above links all twenty.
[`AGENTS.md`](AGENTS.md) is the engineering doctrine this repository is held to, and
[`CONTRIBUTING.md`](CONTRIBUTING.md) is what a change has to satisfy.

## What exists today

| Area           | DriftEngine capability                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core           | Fixed-timestep loop with interpolation and pause; deterministic seeded RNG and seeded selection; priority message queue                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Persistence    | Pluggable key/value backend; validated preference records with change notification; persisted one-time flags                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Audio          | Layered stem graph with independent music/effects volume, speed-driven master filter, reverb and delay sends; slot registry resolving real files with synthesised fallbacks; seamless ambient loops with distance and stereo placement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Rhythm         | Offline kick detection producing a beat map, a matching live detector, and tap-tempo grids                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Capture        | Canvas + audio recording to a shareable file; generated pixel cursors                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Input          | Keyboard, relative pointer and multitouch capture; configurable dynamic stick plus tap/hold/swipe/look mobile controls; multiple subscribers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Cameras        | Perspective camera, configurable collision-safe third-person orbit rig, and a cinematic rig with hard cuts and a shot vocabulary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Geometry       | Typed mesh data and procedural box/cylinder mesh building; arc-length splines with rotation-minimising frames; swept banked ribbons with interruptions, self-measuring facet subdivision and collision emitted from the same corners as the mesh                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Physics        | **Convex collision**: arbitrary multi-polygonal shapes swept per axis with SAT, resolved against the geometry as drawn rather than its bounding box; spatial-hash broad phase over packed bounds; sub-stepped integration bounded by travel per tick; AABB primitives and segment tests; exact banked-surface ground queries separable from the solids, which the character controller and the raycast vehicle both stand on, and `heightSurface` to turn any consumer's `heightAt(x, z)` into one — **or a list of them, so a road can pass under a road**: each layer says `NaN` where it is not there, and the height every caller already passes picks the floor under the body's feet; `colliderSurface` makes a `ColliderSet` answer as ground, so a solid holds a body up at the slope of its own faces rather than at its bounding box                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Scene          | Transform hierarchy with world matrices derived only for what moved; bounds measured at upload; frustum culling, **occlusion culling against declared occluders** and LOD selection, where a node's bounds enclose its subtree so one test discards a whole branch                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Animation      | **`@driftengine/animation`**: a skeleton resolving a pose into a skinning palette, clips sampled as a pure function of a time you supply, blending and additive layers, blend trees whose nodes may each be sampled on a clock of their own — so one set holds an idle advancing with time and a gait advancing with distance travelled — and a crossfading state machine over parameters you name, two-bone IK, morph targets, retargeting by joint name, and secondary motion: a damped spring or a chain of them, sampled at whatever time you ask about rather than advanced, so hair and a coat scrub backwards with the playhead. Skinning and morph run on both backends as vertex-shader permutations, so a mesh with no rig carries none of their instructions. glTF's skins, animations and morph targets import, and `.drft` carries them                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Materials      | Normal, ORM and emissive maps end to end — glTF's packing, a real metal/dielectric split, and the container carrying all four texture indices. Both of glTF's material models import: the core metallic-roughness one, and `KHR_materials_pbrSpecularGlossiness`, whose specular and glossiness are solved jointly into a metalness and a roughness                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Lighting       | Directional, budgeted point and spot lights shaped by IES photometry, **rectangular area lights that occlude, with a penumbra the shape of the emitter**, persistent omnidirectional maps, live-caster handoff, shared quality-tier filtering; **clustered lighting** over 320 lights in 16x9x24 froxels, off by default; **irradiance from nine spherical-harmonic coefficients**, evaluated with no texture fetch; **a GGX-prefiltered specular chain** with the split sum's analytic BRDF term beside it, so a reflection's blur and its brightness are both integrals rather than curves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Rendering      | Flat-shaded meshes carrying **an optional four-lane per-vertex channel: leaf sway against a wind the frame samples once, so a canopy and its own shadow bend together; a sky factor that scales the sun and leaves ambient untouched; per-vertex alpha; and a glass thickness**, **heightfield terrain with blended materials, meeting its own levels of detail without cracks and colliding without its triangles**, procedural sky, atmosphere/fog, underwater medium, world-fixed volumetric plumes, **rain as streaks that land on the ground and stop under a roof**, Gerstner water in bodies bounded by a rotated rectangle, full-scene planar reflections, **screen-space reflection in a declared region**, **order-independent transparency**, **refraction that bends what is behind a surface and absorbs it by Beer-Lambert over a path that lengthens at grazing angles, so a pane goes green at its edge while its middle stays clear**, decals as clipped geometry and as a projector evaluated in the frame, and an opt-in screen-space pass (off-screen scene target resolved through a radial speed blur, camera motion blur, **depth of field** and **temporal antialiasing**)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Structure      | A package can contribute a render pass with declared reads **and a target of its own** — filled in `prepare` before the frame's pass opens, sampled in `draw` — and can **dispatch compute on WebGPU**; `computeSupported` answers false on WebGL2 and refuses in words rather than doing nothing quietly                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Text           | A 5x7 pixel font built from bitmasks at load — no asset, no request, no licence — and opt-in SDF text for a consumer that supplies an atlas                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Assets         | The `.drft` container: eight source formats baked to one streaming file, embedded textures addressed by name, material parity measured across readers, and a source's node hierarchy carried through so a consumer can animate imported parts by name. A surface's _cutout_ travels beside its opacity, so a masked grille keeps its holes and an alpha test is never spent on transparency                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Environment    | Allocation-free sun/moon/lunar-phase/cloud clock sampling, with an **optional latitude and season**: name a site and the sun's arc follows the place and the time of year, the poles get their midnight sun and their polar night, and the moon stands where its phase says rather than always opposite the sun                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Host           | Capabilities a shell implements and a browser answers honestly: window mode, surface size — asked with `canSetSize()` before it is changed, so a settings screen greys a control without resizing a window to find out whether it may — the display list and refresh rate — a video settings screen a game drives from its own menu — plus focus and quit, orientation and safe areas for phones, file dialogs, and store services with no default at all. Taken as parameters, so nothing in the engine names a shell                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Packaging      | `drift-package`: a game becomes an installable Linux, Windows or macOS application in a bundled Chromium, or an Android APK around the system WebView, from one manifest. `bootstrap` fetches the whole toolchain, every build says how it was signed, and Steam's cloud saves and achievements bind to seams that already existed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Boot           | **The engine badge, on by default for a web-delivered game.** `createRenderer` mounts a full-viewport plate carrying the mark, holds it for three seconds after the game's first frame reaches the screen, then fades out — and **the fixed loop is frozen for that hold**, so an intro or a music cue is not spent behind an opaque screen. It sits in the top layer, so nothing a consumer draws can cover it. `{ splash: false }` declines it and `?splash=0` overrides it either way; the packaged shell shows its own, so a packaged build never doubles up                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Quality        | Construction-time render profiles for DPR, shadows, water, reflections, atmosphere and procedural detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Networking     | **A transport seam, one rewind core, lockstep and an authoritative host with prediction**, as [`@driftengine/network`](packages/network/README.md) at 2.3 KB gzipped standalone — and 6,901 bytes raw, which is the claim: no renderer is in its module graph, so an authoritative host can run it. **Prediction and rollback are the same operation**, so there is one driver rather than two: put the state back to tick _T_, correct what was wrong about _T_, step forward to where you were. A lockstep peer does it when a guessed input turns out wrong; a predicting client does it when its authority disagrees. The state that goes back is a `WorldSnapshot`, which preserves entity handles exactly — deliberately not the save format, which remaps them. `Transport` is a caller's, with three implementations: a loopback whose latency, jitter, loss, reordering and duplication all come from a seed, a WebSocket, and an unreliable unordered WebRTC channel. Nothing here knows what an input _is_: a payload is a fixed number of bytes a consumer encodes. A desync is caught by a per-tick fingerprint and **names the tick it began at**, which is the whole of the debugging. `Sim` is opt-in 48.16 fixed point for a consumer who would rather not depend on an argument about IEEE 754 at all                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Editing        | **Debug draw, a transform gizmo, an inspector, a scene tree and play-in-editor.** The first two are generators rather than passes: they produce line segments and `drawLines` draws them. `DebugLines` turns a mesh's vertex normals and every collider a `PhysicsWorld` holds into segments, dispatched on what a shape _is_, allocating nothing after construction and counting a segment past capacity in `dropped` instead of throwing. `Gizmo` answers what a ray is over and what a drag does to a transform: translate, rotate and scale, thirteen handles, world or local axes — except scale, which is always local, because a non-uniform scale along a world axis would shear the object rather than scale it. Every drag answers from the anchor rather than accumulating, so it cannot drift, and every degenerate ray keeps the previous value rather than teleporting what it is dragging. **4.53 KB gzipped over core, and nothing to a game that never imports one.** The rest is [`@driftengine/editor`](packages/editor/README.md) at **10.3 KB standalone**: a flattened, collapsible tree whose names live in the tree rather than on every `SceneNode`; an inspector that is reflection over a component's declared schema, so it works for one a `.drs` file wrote and takes the field's kind from the declaration because `bool`, an enum and an `Entity` all read back as numbers; and play-in-editor that snapshots a world, steps exactly one tick at a time, and restores — clearing first, because a load _creates_ entities rather than replacing them, and re-finding the selection by its place in the snapshot, because every handle changes. Panels are ui2d nodes and not pixels. Picking is separate and older: `PickableSet` behind `registerPickable` and `pickAt` on both backends, a world-space box rejecting nearly everything before any triangle is touched |
| Editor         | **The editor opens**: `npm run editor` gives a menu bar, a viewport, docked panels, picking, a gizmo, undo and a command palette, in a browser or on a native window. Every edit is a `Command` on a stack, so no panel can touch the world except through something the stack can put back. **Play in editor restores the scene exactly**, checked by a digest of the whole world rather than a spot check. **A scrubber runs the simulation backwards** to any recorded frame and forward again, frame-for-frame identical to a run that never scrubbed, from a keyframe every _n_ frames plus the input log between; a frame the ring dropped is reported as gone rather than as the nearest one. **An edit at frame four hundred re-simulates from there** rather than being applied on the spot, so scrubbing away and back keeps it. **When two runs stop agreeing**, a binary search over the per-frame fingerprints gives the frame and `@driftengine/tools` gives the component. A node canvas over three vocabularies sits beside it: materials compile to a `DTEX` decode program, particles to the `ParticlePoolOptions` the engine already takes, and behaviour to DriftScript source that DriftScript's own compiler judges. What it does not do is in [`editor/README.md`](editor/README.md): no tabs, no splitter dragging, and nothing paints the gizmo's arms                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| In-game tools  | **A shipped game can carry the editor panels, at 5,391 bytes gzipped**, and one that does not pays nothing. [`@driftengine/tools`](packages/tools/README.md) is the inspector, the console, the profiler and the network panel with the command stack under them. The line is what a panel _needs_ rather than what it shows: a scene tree and an asset browser want a project and a shipped game has none, so those stayed in the editor. `Panel.route` returns a `Command` or nothing, so an in-game edit goes onto an undo stack without the game arranging anything                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| DriftCapture   | **A video becomes a scene you can walk around in, on the player's device and with no service.** [`@driftengine/capture`](packages/capture/README.md) takes a `FrameSource` — a video element in a browser, ffmpeg on the native host — chooses frames, runs Depth Anything 3 Small for poses, depth, intrinsics and confidence together, fuses them into a signed-distance volume, marches and decimates it, then makes colliders, bakes a navmesh, delights the colour and proposes entities. **7.2 s in the browser and 9.05 s on the native host** over six frames of a 1080p handheld clip on an RX 9070 XT, with nothing in the package different between them. **Its maturity is stated stage by stage**: three of nine dropped controllers land on the surface, delighting reports a mean confidence of 0.249 on a room and cannot remove a cast shadow, and every entity proposal arrives unlabelled for a person to accept or reject. **Six frames is this device's ceiling and the metric scale is unverified**, both recorded as limits. No weights are distributed with the engine: `tools/capture-weights/` fetches each at a pinned revision, and a game that ships one ships it under that model's own licence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| DriftTexture   | **A texture as a compiled decode program over a latent, rather than an image.** [`@driftengine/texture`](packages/texture/README.md) is the interpreter and the `DTEX` chunk is the storage: a latent grid, channel specs, the graph, a small network and a tile table with a content hash per tile, so two identical tiles share one payload. The container validates containment and never meaning, because `@driftengine/drft` has no dependencies and does not know what an operation means. **Residency is decided from where the camera will be**, not where it has been: `predictViews` advances the deterministic simulation _n_ steps with no rendering and restores, so there is no feedback buffer and no readback and it works for passes that could never write feedback. Measured on a scripted flight through 452 tiles and a 256-page cache, **296 late samples predicted against 1,294 reactive**; under a camera reversing every three frames, the case prediction cannot help with, **102 against 755**. **A tile that will not arrive stops being waited for.** Runtime-writable overlays go into the input log, so a replay burns the same wall                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Navigation     | **Geometry becomes walkable convex polygons and a straight line across them**, in [`@driftengine/nav`](packages/nav/README.md) at 8,401 bytes gzipped: a walkable voxel field (two layers under an overhang, which is why it is voxels), a watershed partition, contours checked for self-intersection rather than assumed simple, and polygons whose adjacency is symmetric. **One A\* in the repository** — the query builds a `NavGraph` and hands it to core's existing `NavSearch`, then funnels, so open ground is a line and not a walk along polygon centres. The graph is not replaced; it stays right for roads and corridors. Two limits ship with a test pinning each: a free-standing pillar loses the inner loop, and the funnel gives the shortest path through the corridor A\* chose. **Steering stays refused**: a path is a function of geometry, and how a character moves along one is a game's feel                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Worlds         | **Bigger than a float, and the simulation never rebases.** `core/src/world/` holds a sparse cell grid and a render origin that follows the camera in **whole cells**, while simulation coordinates stay absolute and double — because a rebase changes floating-point results and therefore the replay fingerprint, but only in sessions that crossed a boundary, which is a divergence nobody reproduces on demand. Measured over a 220-tick walk at the far end of the world the origin moves **75 times rather than 220**, and a round trip costs an ulp and does not grow with distance, where single precision is wrong by **exactly one metre** at 2²⁴–2²⁵. **Freezing is a simulation decision and unloading a memory one**, kept apart on purpose so that how much memory a machine had cannot change what the simulation computes; a frozen cell still contributes to the fingerprint, from a digest taken when it froze                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Terrain        | **Which squares of the field to draw, at what detail, as one decision per patch**, reading the frame and nothing else so it can move into a compute pass rather than be rewritten there. Each level snaps to an **even** patch index, which is the whole of why the levels nest, and the hole a finer level leaves is not fixed at the centre — which looks wrong and is right, and is what removes the stitching strip the usual implementation carries. Asserted by counting: **65,536 field cells drawn, exactly, at every one of thirty-three camera positions**. **A heightfield is a `DTEX` layer and collision reads the decoded numbers**, not the source ones, because a renderer reading the layer while a query reads the source differ by exactly the tolerance, everywhere and permanently, and a character floating a fraction of a millimetre above every surface is a defect nobody attributes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Reconstruction | **DriftTR, the analytic tier, on WebGPU and off by default.** `quality.reconstruction` takes a ratio from 1.3 to 2.0: the world draws at the output size divided by it, jittered along a Halton sequence, and a compute resolve accumulates it — history read bicubically where the surface was, clipped to its neighbourhood in YCoCg, refused where depth, motion or normals say it is another surface. **Measured on the gilded chamber at 1280 by 607: 3.08–3.15 ms of GPU off, 2.42–2.49 at 1.5 and 2.16 at 2**, and a replay fingerprints the same at every ratio as with it off. A multisampled frame is not reconstructed and says so once. The learned tier and frame generation are absent, with a sentinel each                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| GPU-driven     | **Opt-in, WebGPU only, and it refuses rather than falling back.** `createRenderer({ pipeline: 'gpu-driven' })` on a backend without indirect draws throws with the reason in words, checked against the backend that will _draw_ rather than the one that was asked for, because three of the paths into that decision arrive having already fallen back. Instance culling, a level cut, a depth reduction, cluster culling, compaction into one draw, a visibility buffer, material binning and the lit expression. **Every pass is written twice** — once in TypeScript as the reference and once in WGSL — and `gpu-parity.mjs` runs twenty checks requiring the two to agree on a real device, which is possible at all because `core/scripts/gpuCompute.mjs` runs WGSL on a device and reads the buffers back. The audit that earned that check broke the WGSL five ways and it caught all five                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Indirect light | **Three levels that fall back to each other and never off the end**: the screen as an accelerator, a world-space distance field whose error is bounded by its own resolution, and a probe volume behind that, which is never wrong and only ever coarse. **This does not reverse the refusal of screen-space global illumination**, whose error is unbounded because a ray leaving the frame has no answer. `traceIndirect` reports which level answered, so a caller sees the fallback rather than inferring it. **It is CPU-side and nothing draws with it yet**: no WGSL, no pass and no renderer option, measured rather than asserted at 0 of 921,600 pixels across the published scenes and a byte-identical `core-only`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Native         | **The engine on a native window and a native device, with no browser and no engine code changed.** [`@driftengine/native-host`](packages/native-host/README.md) supplies the page a game expects around its canvas — window, GPU, events, gamepads, audio — and draws the published scenes pixel-identically to Chrome, checked by `npm run native:gate`. This is what the platform rule was written for: every platform touch it had to answer was a capability the caller supplies or a page global, never a call buried in the engine, and what each host can do that the other cannot is recorded both ways in [`docs/CAPABILITIES.md`](docs/CAPABILITIES.md) §2a. The Linux target is built and measured; Windows and macOS are not                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Tooling        | Strict type checking, focused Vitest contracts and a reusable throttled FPS/worst-frame meter                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

Both graphics APIs are private to `packages/core/src/render/`. A game submits data and draw
calls; it does not own shader programs, framebuffers, shadow maps, pipelines or GPU state,
and it does not know which backend drew — `createRenderer` reports that rather than letting
anything infer it.

## Using it

Install the packages you need, and nothing else:

```sh
npm install @driftengine/core @driftengine/audio
```

Every package is taken separately, and each states its own dependencies — `@driftengine/core`
pulls in `@driftengine/drft` and `@driftengine/physics` because it re-exports them, and nothing
else pulls in anything you did not ask for.

**To work against a checkout of the engine instead** — because you are changing it, or tracking
`main` — depend on it by path and npm will symlink it:

```json
"dependencies": {
  "@driftengine/core": "file:../../driftengine/packages/core",
  "@driftengine/audio": "file:../../driftengine/packages/audio"
}
```

Add the `drift-source` condition in that case, so your bundler reads the engine's TypeScript and
your edits are live without a build. See [Attribution](#attribution) below for the resolution
details.

Each package is taken separately, by path to that package rather than to the workspace root.

**By default you get compiled JavaScript**, from each package's `dist`. That is what `main`,
`types` and the default `exports` condition all resolve to, and it is what every bundler and Node
itself will find without being asked. `npm run cleanroom` proves the whole surface imports under
plain Node, from a real tarball outside the checkout.

**Every package also ships its TypeScript source, and you can ask for that instead.** The
`drift-source` condition resolves to `src/index.ts`, which is worth taking when the engine is a path
dependency you are editing: your bundler reads the source and an engine edit is live in your build
with no build step in between.

```js
// vite.config.js — read the engine's source rather than its build
import { defaultClientConditions, defineConfig } from 'vite';

export default defineConfig({
  // Spread rather than replaced: `conditions` overrides Vite's defaults instead of extending them.
  resolve: { conditions: ['drift-source', ...defaultClientConditions] },
});
```

Taking the source has one requirement: **set `allowImportingTsExtensions: true` in the tsconfig that
typechecks your project.** Every relative import in these packages names `.ts`, your compiler
follows into that source, and without the flag it answers `TS5097`. It is legal beside `noEmit`,
which a typecheck-only config already sets. **A compile that emits from this source rather than only
checking it** — a build script turning one module into JavaScript, say — adds
`rewriteRelativeImportExtensions: true` beside it, which is what makes the flag legal without
`noEmit` and rewrites each specifier on the way out. None of this applies if you take the default:
Node refuses to strip types anywhere under `node_modules`, which is exactly why the default is the
build.

Import only from the public package barrel:

```ts
import {
  InputSource,
  TouchControls,
  createCelestialState,
  createRenderer,
  startLoop,
} from '@driftengine/core';
```

Dependency direction is strictly `game -> engine`, and the engine never imports
from a game. Inside `packages/core` the same applies to its own name: nothing
there may import `@driftengine/core`, because it resolves only when a symlink
happens to exist — use relative imports. **A sibling package is the opposite
case**: `assets`, `media` and `drft` import from `@driftengine/core` by name and
declare it as a peer dependency, which is what makes the version range in each
manifest load-bearing rather than decorative.

### Rendering

**Build the renderer with `createRenderer`.** It picks the best backend the browser will
actually give, and tells you which one it built:

```ts
const { renderer, backend, reason } = await createRenderer(canvas, {
  maxDevicePixelRatio: 1.75,
  directionalShadows: true,
});
console.log(`drawing with ${backend}: ${reason}`);
```

It prefers WebGPU unless told otherwise; `preferWebGpu: false` declines the attempt and
boots straight onto WebGL2 with no adapter request at all.

It is asynchronous because it has to be: asking for a WebGPU adapter returns a promise and
there is no synchronous way to learn whether a usable device exists. The fallback to WebGL2
is automatic and silent, and it happens on three counts — no `navigator.gpu`, an adapter the
browser refuses, or a device request that fails. `reason` says which, in words a bug report
can carry.

`?backend=webgl2` forces the fallback and `?backend=webgpu` forces the attempt, **in every
build rather than in development only**, because a fallback that cannot be exercised on
demand is a fallback nobody tests.

> **`new Renderer(canvas, quality)` is deprecated and still works.** It can only ever give
> you WebGL2, so calling it opts out of WebGPU silently and permanently — which is the whole
> reason it is marked. It is not going away: the factory calls it internally to build the
> WebGL2 branch, and the applications that construct one today are not being made to move.

Quality options are chosen before the renderer exists, so allocation-sized decisions stay
out of the frame loop:

```ts
const { renderer } = await createRenderer(canvas, {
  maxDevicePixelRatio: 1.75,
  directionalShadows: true,
  pointShadows: true,
  water: true,
  waterReflections: true,
  waterReflectionScale: 1,
  waterReflectionFilterTaps: 9,
});
```

Changing map sizes or reflection resolution later means recreating the
renderer. A settings UI selects a whole profile; individual effects do not grow
unrelated game-side flags.

**The lit shader is sized to the part it is about to run on, and a consumer needs to write
nothing for that to happen.** Twenty of its uniform arrays are sized by the point-light budget and
fourteen by the area-light one, and GLSL ES spends a whole row of the fragment uniform grid per
array _element_ whatever its base type — so the full budget declares 440 rows where an Adreno 740
offers 256 and WebGL2 guarantees only 224. A shader that will not link is not a slower frame, it
is no frame at all. So the renderer counts the shader it is about to compile against what the
device reports, builds at the largest budget that fits, and says so once in the console — rather
than failing out of `createRenderer` and leaving a game showing a page's background colour with no
reason attached. **Point shadows survive it**: 8 lights and 2 rectangles is 252 rows with them
compiled in, where switching the feature off wholesale is the only other lever.

`maxLights` and `maxAreaLights` are the ceiling if you want to choose one yourself, and
`renderer.shadedLights` reports what was actually resolved. **Size a `PointLightBuffer` from that
number**: `selectPointLights` fills a buffer to its own capacity and evicts the weakest when it is
full, so a buffer wider than the shader leaves an arbitrary subset lit rather than the nearest
ones. A wider upload is otherwise harmless — GL ignores array elements past the end of a uniform,
measured on ANGLE. This is a WebGL2 concern only: WebGPU has no per-stage uniform-vector ceiling
to be short of, and `shadedLights` reports all sixteen there.

**The post chain is opt-in, one option each, and every default reproduces the
picture that existed before the effect did**: `cameraMotionBlur`,
`ambientOcclusion`, `bloom`, and `outputTransform` with `outputExposure` for the
grade. Three of those have a per-frame dial beside them — `setCameraMotionBlur`,
`setBloom` and `setOutputExposure` — because how much of an effect a moment wants
is not a property of the world.

**A photometric profile shapes a light the way a real fixture does**, and an asymmetric one — a
street light, a wall washer — keeps its horizontal planes. `renderer.setIesProfiles([profile])`
uploads what `readIesProfile` read from an IESNA LM-63 file; a light takes a row with
`lightIesProfiles`, and an asymmetric profile also needs `lightIesAxes` to say where its azimuth
zero points. **That reference cannot be derived from the light's aim** — there is no continuous
field of unit vectors tangent to a sphere, and every obvious construction is singular exactly where
these fixtures point, straight down. An axially symmetric profile, which is nearly all of them,
ignores it and costs nothing.

**A cookie is the mask a fixture throws**, and a spot light projects one.
`renderer.setSpotCookies([image])` takes a consumer's images into an atlas; a light picks a tile
with `lightCookies` and is oriented by the same `lightIesAxes` a photometric profile uses. It fills
the light's **outer cone**, so a mask drawn once works in a narrow spot and a wide one, and it
**tints** rather than scales — a stained window is the case that makes the difference. The engine
ships no cookie: what a fixture throws is your art.

**A colour grade is a lookup table, and it goes on last.** `setColourGrade(lut, strength)` takes
an `RGBA8` cube of display values — 32 or 33 lattice points a side is what a grading tool exports
— and the composite samples it after the tone curve and before the frame veil. A `.cube` is
_display-referred_, which is why it goes after the curve rather than before it.

```ts
const look = identityGradeLut(32);
// bend it however you like, then hand it over; it uploads only when the object changes
renderer.setColourGrade(look, 1);
```

It **needs `screenEffects`** and says so on the console rather than doing nothing — without a
composite every pass grades itself and there is nowhere to apply a look once, which is the same
rule `hdrScene` carries. Measured on hardware on both backends: an inverting grade changes every
pixel and 99.97% of them invert exactly, the rest by one of 255.

Two of them are worth knowing about together. `hdrScene` keeps the scene's real
brightness to the end of the frame instead of clipping it into 0..1 as each
surface is shaded, and `bloom` reads a threshold **in scene units**, so the two
belong together: without the range, a lamp and a white wall arrive at the
composite as the same colour and a threshold of 1 finds nothing at all. The
renderer says so once at construction rather than leaving a switched-on effect
that cannot do anything.

`drawMesh` takes an optional per-draw **tint** — a colour multiplier, white by
default and reset after the call. Colour here is vertex data, which is what makes
the world one flat-shaded draw call and also what makes it unable to answer a
question about the current frame; a tint gives anything that must take on a colour
decided at runtime somewhere to put it, without a texture and without rebuilding
geometry every frame.

**A mark on a surface has two shapes here, and which one you want depends on whether
the surface changes.** `projectDecal` clips the receiving mesh's own triangles to a
projector box and hands back a mesh: exact, lit as the surface is lit, and free every
frame after the one that built it. It is decided once, against the mesh as it stood.

```ts
const scorch = renderer.createMesh(
  projectDecal(roadMesh, {
    center: [x, y, z],
    halfExtents: [1.2, 1.2, 0.6],
    forward: [0, -1, 0],
    up: [0, 0, 1],
    color: [0.2, 0.18, 0.16],
  }),
);
```

`drawDecal` keeps the projector alive instead, and the mark is decided each frame from
the depth the frame has drawn. That is what a surface that deforms, streams in, or has
no CPU-side geometry needs — cloth, a heightfield being rewritten, a skinned mesh, an
instanced crowd:

```ts
const wet = new DecalProjector({
  center: [x, y, z],
  halfExtents: [1.2, 1.2, 0.6],
  forward: [0, -1, 0],
  up: [0, 0, 1],
  color: [0.55, 0.6, 0.7],
});

// every frame, wherever the thing it is stuck to lives
wet.setPose([x, y, z], [0, -1, 0], [0, 0, 1]);
renderer.drawDecal(wet);
```

**A drawn mark multiplies what is under it**, so it darkens and tints and takes the
receiver's lighting; it cannot brighten. It needs `screenEffects`, since without the
off-screen target there is no depth to read, and it says so on the console rather than
dropping the marks. Thirty-two a frame is the cap. The shape is a soft-edged ellipse
rather than a texture.

**A reflection is declared the same way, and for the same reason.** There is no G-buffer
here, so nothing on screen records which surface was polished; a `ReflectiveSurface` is a
box and a facing rule, and the pass marches a reflected ray against the frame's own depth
for the surfaces inside it:

```ts
const wetFloor = new ReflectiveSurface({
  center: [0, 0, 0],
  halfExtents: [6, 6, 0.3], // across, along, and how thick a slab of world counts
  forward: [0, -1, 0], // surfaces facing back along this reflect
  up: [0, 0, 1],
  strength: 0.4,
  reachM: 8,
});

renderer.drawReflection(wetFloor);
```

This is what a planar reflection cannot reach. `beginPlanarReflection` re-renders the world
from a mirrored camera for one horizontal plane at one height — right for a lake, nothing
for a floor that undulates or a tilted pane, and a second pass over the whole scene. A march
costs one scissored pass per surface, follows the surface per pixel, and is exact where an
object meets the floor.

**It can only reflect what is on screen.** Anything behind the camera, or hidden behind the
reflecting surface, is not in the colour buffer and cannot be recovered from it; a ray that
leaves the frame or points back at the eye fades out rather than answering with the wrong
pixel. It needs `screenEffects`, excludes multisampling, and says so once. Eight surfaces a
frame is the cap.

### Input and controls

DriftEngine owns device capture and reusable control mechanisms:

```ts
const input = new InputSource(canvas, ['Space', 'ArrowUp']);
const touch = new TouchControls(input, stickBase, stickNub, {
  splitRatio: 0.5,
  stickDeadzone: 0.12,
});
```

`TouchControls` reports `moveX`, `moveY`, `primaryHeld`, `secondaryHeld`, a
consumable primary press, and look deltas. It deliberately does not report
`jump`, `slide`, `fire`, or `grapple`: mapping generic signals to gameplay
verbs belongs to the game and is also the replay-recording seam.

`InputSource.subscribe()` supports independent layers without callback
overwrites. Dispose long-lived sources and controls when their owning screen is
destroyed.

**A pad's motors are driven by duration and magnitude, and the refusal is half the feature.**
`pad.canRumble` says whether this browser can drive this pad at all, and `pad.rumble(ms, strong,
weak)` and `pad.stopRumble()` each answer whether the platform took the call. Most pads on most
browsers cannot, so read the boolean and grey the control out rather than offering a slider a
player's hardware ignores. `strong` is the low-frequency motor and `weak` the high-frequency one.

```ts
const pad = input.pad(0);
if (pad?.canRumble === true) pad.rumble(180, 0.7, 0.2);
```

`ActionMap` carries the same three, aimed at the pad it already reads.

### Camera policy

`ThirdPersonCamera` owns smoothing, orbit geometry and collision-safe boom
shortening. Its caller supplies target height and desired FOV. A game therefore
keeps policies such as crouch height or speed-based FOV without reimplementing
camera collision.

**Four things about it are the caller's, because a rig that assumes them fits one game.** The arm's
frame is `setBasis`/`setBoomForward`, so a subject walking up a wall keeps a camera behind it rather
than behind world Z. `boomTiming` is the four numbers the boom moves at, and they are stated in
metres a second: the defaults suit an arm of several metres and do not scale down, so a rig whose
arm is 170 mm asks for `{ retractLambda: Infinity, retractSpeed: Infinity }` and comes out of a wall
on the tick it touches one. (`damp` is `lerp(a, b, 1 - exp(-lambda dt))`, so an infinite lambda is
the target exactly; there is no special case to find.) The extension stays eased either way, which
is the half that stops the picture pumping. A `BoomObstruction` is the fourth constructor argument
and replaces the `ColliderSet` entirely, for a consumer whose world is a `PhysicsWorld` and who
would otherwise keep a second copy of it for the camera alone. And `dampRoll: false` takes the rig's
roll easing off, for a caller that has already damped its own and applies the same value to a
first-person view.

```ts
const camera = new ThirdPersonCamera(
  colliders,
  { ...options, boomTiming: { retractLambda: Infinity, retractSpeed: Infinity }, dampRoll: false },
  surface,
  { distance: (fx, fy, fz, ax, ay, az, r) => world.sweepSphere(fx, fy, fz, ax, ay, az, r) },
);
```

### Persistence

Nothing in the engine reaches for `localStorage` directly. Persisted systems
take a `KeyValueStore`, so a game can save to the browser, a server, a native
shell or nowhere:

```ts
const settings = new PreferenceStore({
  key: 'mygame.settings',
  defaults: { musicVolume: 0.8, quality: 'high' },
  ranges: { musicVolume: [0, 1] },
  options: { quality: ['low', 'high'] },
});

settings.subscribe((value) => audio.setMusicVolume(value.musicVolume));
settings.update({ musicVolume: 0.4 });
```

Records are validated **field by field** on read and on update: a stored value
of the wrong shape costs that field only, never the whole record, because a
saved record always lags the code reading it. Numbers are clamped to their
declared range and strings must be a declared option — a control that can
produce an illegal value must not be able to store one. An update that changes
nothing notifies nobody, so a subscriber that writes back cannot loop.

`OnceSet` is the same idea for one-time flags (tutorials, first-run hints), kept
as one key holding a set rather than a key per flag.

The seam is **synchronous**, because these are read during boot and an await
there means a frame drawn with the wrong settings and then corrected.
`BrowserStore` degrades to memory when storage is blocked or write-only, so a
locked-down browser costs the session's settings rather than the boot.

**A backend that answers later rides the same seam**, rather than a second asynchronous one every
consumer would have to learn. `RemoteSaveStore` hydrates a cache once, then drains writes behind
the synchronous surface: a burst of writes to one key becomes one batch, a failed batch is retried
with a growing delay and merged back _under_ anything written since, and failure is a status rather
than a throw.

```ts
const saves = new RemoteSaveStore({
  load: () => fetch('/saves').then((r) => r.json()),
  save: (changes) =>
    fetch('/saves', { method: 'POST', body: JSON.stringify([...changes]) }).then(() => undefined),
});
await saves.load(); // before the first frame
const settings = new PreferenceStore({/* … */}, saves);
```

Read `saves.status` — `idle`, `pending`, `saving` or `failed` — to draw an indicator, and call
`saves.flush()` from whatever your platform gives you for leaving. **A write is durable later, not
now**: a player who closes the tab inside the flush delay loses it, and the engine registers no
`visibilitychange` listener of its own because that is a decision about the page.

### Audio

**`@driftengine/audio`.** DSP topology is the engine's; musical decisions are the game's.

```ts
const graph = await AudioGraph.create({ stemCount: 3 });
graph?.registry.register('jump', {
  urls: audioCandidateUrls('jump'),
  synth: (ctx) => toneBuffer(ctx, 0.16, 300, 620, 2.6),
});
```

Every sound is a named slot that resolves to a real file if one is present and
to a synthesised placeholder if not, so a build is audible before any asset
exists and adding the asset is a file drop rather than a code change. Slots
accept `.opus`, `.mp3`, `.ogg`, `.m4a` or `.wav` and settle independently — one
missing file cannot silence the rest.

Music and effects have separate gain stages ahead of the shared bus, so a player
can mute the score without muting the game while the master filter and both
sends still cover everything.

Continuous world sounds are `AmbientLoop`s — a looping buffer whose level and
stereo position the game drives each frame:

```ts
const fire = graph.createLoop(graph.registry.get('fireLoop'));
fire?.setGain(distanceGain(distanceToBrazier, 32, 1.7));
fire?.setPan(stereoPan(dx, dz, listenerYaw));
```

`fireLoopBuffer`, `waterLoopBuffer` and `windLoopBuffer` synthesise seamless
beds — filters warmed before recording, an equal-power crossfade at the join,
and any swell placed at whole cycles per loop, so none of the three ways a loop
betrays itself is audible. `ambienceBuffer` is the same builder with the
parameters exposed. Both setters are change-gated, so a value that has not moved
schedules no ramp.

`distanceGain` reaches **exactly** zero at its radius rather than approaching
it, so a level full of emitters cannot sum into an unidentifiable hiss.
`stereoPan` works in the listener's frame, which is what keeps a source on the
correct side after the player turns around. One-shots take the same pan through
`play(buffer, gain, pan)`.

**A room is a bus, and a source can be in one the listener is not.** `addReverbZone` registers a
space — full inside its radius, faded across a blend, at most two sounding at once — and by default
whichever space the _listener_ occupies decides the reverb for everything. `source.attachZone(cave)`
is the other model: the source's own position decides its send, so a sound heard from outside a cave
carries the cave's tail. It is a second **routing** into a return that already has a convolver, not a
second convolver.

```ts
const cave = addReverbZone(
  listener,
  'cave',
  { x: 40, y: 0, z: 0, radius: 10, blend: 2 },
  { seconds: 4, decay: 2, wet: 0.7 },
);
const drip = createSpatialSource(listener, buffer, { bus: mix.bus('placed') });
drip.attachZone(cave);
```

Put source-zoned sources on a bus **outside** the one the zones are fed from. A source on the zone's
own feed reaches the return twice whenever the listener is in the same space, which is inaudible as
a fault; `attachZone` walks the bus's parents and says so on the console.

**A soundfield is not a source, and it costs a fixed six.** `createAmbisonicSoundfield` takes a
four-channel first-order B-format buffer — ACN order, SN3D — and decodes it through six virtual
speakers on the world axes, each panned through the same head model. That is six convolutions for a
whole recorded scene, where placing its contents as separate sources would be six _per sound_.

```ts
const forest = createAmbisonicSoundfield(listener, foaBuffer, { loop: true });
forest.start();
// each frame, after listener.set(...)
forest.follow();
```

The speakers are fixed in the **world** and the head's rotation is applied once, by the listener the
panners already answer to. A decoder that also rotated the field would apply it twice, and the
symptom — a field that counter-rotates at double speed as a player turns — reads as a broken
recording. The cost of that choice is that a **head-locked** field, which is what a music bed wants,
is not available this way. `encodeFoa` builds a field from mono signals if you have no recording.

### Rhythm

**`@driftengine/audio`.** Two detectors over one set of bands, so "a kick" means the same
thing in both:

```ts
const map = analyseTrack(buffer.getChannelData(0), buffer.sampleRate);
const detector = graph.createKickDetector();
detector?.update(performance.now());
```

`analyseTrack` runs **offline** over decoded samples and is the one to cut
against. A live detector necessarily fires _after_ the transient and by a
varying amount; offline the onset curve can be peak-picked and then walked back
to where the rise began, which is the same reference point for a soft kick and a
hard one. It is also deterministic — nothing reads a clock or `Math.random` —
so two people watching the same recording see the same edit.

The detection itself defeats the genre's hard case, a sustained 808 under the
kick, by _whitening_: subtract a weighted bassline/mud/low-mid mask from the
kick band and take fast-minus-slow envelopes, leaving only the transient.
Thresholds adapt from a running mean and deviation, so one analyser works across
tracks mastered ten decibels apart. Roughly 70 ms for a three-minute track.

The tempo comes from the gaps between reported beats, and those gaps are whole numbers of
beats rather than one — a strict detector skips hits. Taking a median of the raw gaps counts a
track with half its kicks reported at half its tempo, which 2.5.3 fixed by choosing the gap
that accounts for the most others and folding the rest down to it.

`KickDetector` is the live counterpart, for things that react in the moment —
lighting, particles — where being tens of milliseconds behind is imperceptible.
`beatGrid` and `TapTempo` produce the same `BeatMap` shape from a tempo the
player supplies, which is how an edit can be cut to a song the engine has never
heard.

### Cinematic camera

`CinematicCamera` is a rig that can be **cut**, for replays and cutscenes:

```ts
camera.cut({ kind: 'lookAt', distance: 8, height: 2.4, fovDeg: 66, anchor }, atSec);
camera.update(dt, subjectX, subjectY, subjectZ, subjectYaw);
```

Six shots — chase, low wide, orbit, flyby, overhead and a `lookAt` that frames a
fixed point rather than the subject. A cut is instantaneous, because a cut that
eases is a swoop and destroys any sync with music; motion _within_ a shot is
damped, because footage that steps judders under frame-by-frame viewing. The
boom shortens against real geometry, and no combination of degenerate parameters
can put a NaN into a view matrix.

Which shot suits which moment, and when to cut, belong to the game.

### Tracks: splines, ribbons and the ground under them

Three pieces, deliberately separate, because they answer different questions and
a single "track" object would tangle all three.

```ts
const spline = new Spline(points); // where the route goes
const metres = spline.lengthM; // its arc length, not `length`
const { mesh, colliders } = buildRibbon(spline, { color, holes });
const surface = new RibbonSurface(spline, { holes });
```

`Spline` is Catmull-Rom **sampled by arc length, not by parameter**. Parameter
spacing bunches samples in tight corners and stretches them on straights, which
gives a swept surface triangles the size of a room on the fast sections and a
width that pulses through every bend. Its frame is **transported** from the
previous sample rather than rebuilt from world up, so it cannot flip when the
tangent passes vertical — the failure that puts one inside-out segment in an
otherwise perfect track. Bank and width follow the control points through a
smoothstep; interpolating them linearly would put a crease across the surface at
every control point, and a runner feels that as a bump nobody authored.

`buildRibbon` sweeps a closed slab along it. `holes` are stretches where the
surface simply is not there — an interrupted track, so a player who does not
jump goes down. Geometry and colliders both respect them, because a hole that is
drawn but still solid looks like a jump and plays like a floor.

`RibbonSurface` answers _"where is the ground in this column, and which way does
it face?"_ — the exact banked surface, not the collider's approximation of it.
The two are split on purpose: a world-axis AABB over a banked strip has a flat
top at the height of the strip's highest corner, so boxes are the right tool for
keeping a runner inside the world and the wrong one for telling them what they
are standing on. Queries cost a grid lookup and a fixed five Newton steps, which
solve arc length and lateral offset **together** — separating them looks correct
and is wrong on exactly the shape this is for, because a banked normal on a
climbing track leans backward along the direction of travel.

The fixed step count is a determinism requirement, not a performance choice: a
loop that stops "when close enough" runs a different number of times on
different hardware, and a physics step that depends on that is a replay that
diverges.

None of the three knows what a track _is_. They take numbers.

### Physics: the shape you drew, not the box around it

```ts
const world = new PhysicsWorld({ substeps: 4 });
world.addBody({ type: BODY_STATIC, shape: boxShape(50, 1, 50), y: -1 });
const crate = world.addBody({ type: BODY_DYNAMIC, shape: hullShape(points), y: 4 });
world.step(1 / 60); // fixed clock, always
```

**A level is a mesh and everything in it is a hull.** `meshShape` takes triangles and builds a tree
over them; it is static only and that is enforced rather than documented, because a moving concave
thing wants convex decomposition. Every triangle goes through the same narrow phase everything else
does, so a box, a sphere, a capsule, a cylinder and a hull are all exact against one on the day it
lands. Interior edges are filtered, which is what stops a box catching on the seam between two flat
triangles: measured at 80% of its speed kept across sixteen quads, against 1% without.

**One shape representation**: a point cloud plus two kinds of rounding, with its separating features
enumerated once. A box is its eight corners, a sphere one point and its radius, a capsule two points
and its radius, and a banked slab of track its own drawn cross-sections. So a hull is solid exactly
where it is drawn, and a drawn deck and a solid deck cannot drift apart — `buildRibbon` emits its
colliders from the same corners it emits triangles from.

**A cylinder is the second kind**, and the number is why it exists. A uniform radius grows around
every feature and so rounds a rim along with a side; `cylinderShape` grows the shape by a _disc_
perpendicular to its axis instead, which leaves two flat caps and a sharp rim. The workaround it
replaces was an n-gon prism, a 64-point hull caps that at 32 sides, and a 32-sided wheel of radius 1
rolling at 6 m/s bobs 16 mm with no sides left to add. As a cylinder it bobs under 2 mm.

That matters because a world-axis box around a banked, climbing cross-section has a flat lid at its
highest corner: **floor where nothing is drawn**, and an invisible wall where the next slab rises
above a character's feet. Consumers hit both, and neither has a fix that does not involve lying
about the geometry somewhere.

**Constraints are soft**, carrying a stiffness in hertz rather than a fraction of penetration per
step, which is what makes `substeps` a quality dial: a ten-box stack rests at the same height at
four and at eight, and a ball bounces to the same height. Contacts persist across ticks by a feature
id rather than by proximity, which is what makes warm starting correct rather than order-dependent.

**The tick is bit-identical on any JavaScript engine**, and that is a construction rather than a
promise: it uses only the operations ECMAScript specifies exactly, and a gate over the package
refuses every function the specification declines to pin down. Joint limits therefore compare
cosines rather than angles, and a tyre's grip comes from a table you supply rather than a formula
built on `sin` and `atan`.

Around the solver: seven joint types with motors, one-sided limits and a breaking threshold; world
raycast, shapecast and overlap filling caller-owned buffers; sensors reporting overlap they never
resolve, drained after the tick rather than raised during it; a kinematic character controller with
its feel parameters; ragdolls; a raycast vehicle; and cloth.

**Friction is a box by default and an ellipse if you ask.** The two tangent rows are each clamped
to `mu * N` on their own, so along the diagonal between them the pair reaches `sqrt(2) * mu * N` —
measured, a box launched at 4 m/s travels 1.064 m along the axes and 0.737 m along the diagonals.
`new PhysicsWorld({ frictionModel: 'elliptical' })` couples the two rows and the distance becomes
1.06 m in every direction. It is **not** the default because every stacking result moves under it,
and a stored replay or a golden fingerprint is a thing consumers keep.

The seventh is **configurable**: `JOINT_SIX_DOF` makes each of three linear and three angular
degrees free, limited or locked, in body A's own frame. The other six keep their unrolled rows and
none of them gained a branch — the six-DOF joint is a seventh arm, not a runtime constraint set the
others go through. It solves six independent scalar rows rather than two coupled blocks, because a
coupled solve has no meaning when only some rows exist, so **an all-locked six-DOF joint is softer
than `JOINT_FIXED`**: reach for the fixed one when you want all six.

**And what a character does when the geometry has stopped cooperating**, which is the half a
controller never covers. `StallEscape` watches a kinematic body that has been asking to move and
going nowhere, and finds the cheapest way out or reports that there is none — with the rules that
only show up in a shipped game: progress is net travel over a window rather than this tick's
displacement, because a body under a low ceiling _jitters_; grounded, supported and headroom are
three separate facts, and a body with all three is not stuck however blocked it is; a direction the
world would refuse is not an escape route, so an `EscapeVeto` is taken structurally the way
`GroundProbe` is; and **sealed is reported rather than acted on**, because what being stuck costs a
player is a game's decision. `applyBuoyancy` is what water does to a kinematic body — drag on every
axis, so falling in costs momentum, and a terminal sink speed. `accelerateAlong` is Quake's
accelerate with its trap named.

**The controller's command is flattened onto the body's own tangent plane, unless it is already a
velocity.** Splitting the command into an along-up part and a tangent part is right for a stick: two
axes of input have to become three of movement somehow, and the ground is the sensible place to put
them. It is wrong for a caller that has already resolved a direction in three dimensions, which is
what any body that walks on walls has done — the along-up component of its own command is thrown
away and the turn arrives late. `ControllerInput.projectMove: false` steers the whole velocity
toward the whole command, keeping the speed clamp, the acceleration and deceleration curves,
`airControl` and gravity. The default is unchanged.

**The kinematic sweep is still there and still separate**, because it answers a different question.
`moveAxis` resolves one axis at a time against a static `ColliderSet` and reports what stopped it —
`contactSupport` for whether the face was worth standing on, `contactNormalX/Y/Z` for which way is
out. The cameras depend on it, and a character controller built on a dynamic body would be a worse
character controller.

### Particles and arcs

```ts
const pool = new ParticlePool({ capacity: 520, lifeSec: 0.6, /* … */ alphaStart: 0.7 });
const smoke = renderer.createParticles(pool.particles.capacity, {
  fragmentSource: PARTICLE_SMOKE_FRAG, // or PARTICLE_SPARK_FRAG
  label: 'tyre-smoke',
  blend: 'alpha', // 'additive' for anything hot
  erosion: 0.8,
});
pool.update(frameDt);
renderer.drawParticles(smoke, pool.particles, camera, env, timeSeconds);
```

`ParticlePool` is the simulation and holds no GPU resources, so it is testable
without a context. What it publishes is a per-particle stream — position, size,
spin, colour, **opacity, age and seed** — and the materials read all of it: the
smoke fragment erodes a soft body with the same value noise the plumes use and
lights it with the sun, the ambient _and_ the nearby point lights; the spark
fragment is additive, unlit, and stretched along the particle's own velocity so a
fast ember reads as a streak.

Several pools may share one material's program via `reuse`, keeping their own
buffers and constants — four kinds of smoke need four ring buffers and one shader.

**Emissive materials put their energy in the colour and leave alpha at 1.** The
additive blend is `rgb * a`, so carrying the same factor in both squares it, and
squaring a number below one is how an effect authored as blinding arrives faint.

Electrical arcs are a second, related system:

```ts
const arcs = new BoltPool({ capacity: 22, nodes: 9, lifeSec: 0.22, jitter: 0.26, restrikeHz: 20 });
arcs.strike(x0, y0, z0, x1, y1, z1, seed, brightness);
arcs.update(frameDt);
renderer.drawBolts(batch, arcs.segments, camera, env, t, core, edge, widthM, coreGain);
```

A bolt is a jagged polyline between two points, laid out by seeded mid-point
subdivision and **re-drawn while it lives** rather than animated — real arcs are
replaced many times a second, and interpolating node positions gives a wobbling
snake instead of a crackle. Each segment is expanded into a view-facing quad with
a floor on its world width, because a filament under a pixel wide does not fade,
it strobes.

### Characters that deform

```ts
import {
  AnimationStateMachine,
  BlendTree,
  Skeleton,
  createPose,
  sampleClip,
  solveTwoBone,
} from '@driftengine/animation';
import { readGltfSkins } from '@driftengine/assets';

/* A rig out of a glTF document, or out of a `.drft` the baker wrote. */
const { skins, clips } = readGltfSkins(document, buffers);
const skeleton = new Skeleton(skins[0].joints, skins[0].inverseBind);

/* The bind pose. Supply it to anything that blends — see the note below. */
const bind = createPose(skeleton.jointCount);

const pose = createPose(skeleton.jointCount);
const tree = new BlendTree({ kind: 'clip', clip: clips[0] }, skeleton.jointCount, bind);
const machine = new AnimationStateMachine([{ name: 'idle', tree }], [], skeleton.jointCount, bind);

/* Per frame, with the step your loop already has. Nothing here reads a clock. */
machine.advance(dtSec);
machine.evaluate(pose);
solveTwoBone(skeleton, pose, shoulder, elbow, hand, target, poleHint);
skeleton.applyPose(pose);

renderer.setSkinPalette(skeleton.palette);
renderer.setMorphWeights(weights); /* or null, for a mesh without targets */
renderer.drawMesh(mesh, model);
renderer.setSkinPalette(null);
```

**A mesh carries its rig, and a draw carries its pose.** `MeshData.joints` and `weights` are two
more optional attributes, and `morphTargets` a third — absent means unskinned and nothing about an
existing mesh changes. Morph _deltas_ belong to the mesh because they are geometry; the _weights_
are per draw, so two characters sharing one head mesh wear different expressions without a second
copy of it.

**Sampling reads no clock.** `sampleClip`, every blend, the tree and the state machine are pure
functions of a step you supply, which is what lets an animated character replay bit-identically
from an intent stream. Animation is where an engine usually reaches for `performance.now`; this one
does not, anywhere.

**If you built your own skinning while this was missing**, three things are worth knowing before
you delete it. The palette is a `Float32Array` of sixteen floats a joint, column-major, world times
inverse bind — the same layout every skinning shader wants, so an existing palette can be handed
straight to `setSkinPalette`. Joints must be sorted **parents-first**; `readGltfSkins` sorts and
remaps every index that names one, and `Skeleton` refuses an unsorted rig rather than producing one
wrong in a single limb. And joint indices are `float32` rather than bytes, matching every other
vertex attribute in the format.

**Supply the bind pose to anything that blends.** `sampleClip` leaves a channel no track mentions
exactly as it found it, so a rotation-only clip preserves whatever the pose held. `blendPoses`
cannot: it interpolates every channel, so a tree or a transition without a bind pose starts from
zero translation and collapses every joint onto its parent's origin. The failure is a figure folded
in on itself rather than an error, which is why it is said here as well as at the parameter.

**What it does not do:** morph targets move positions and not normals, the IK solver has no joint
limits and no twist and handles two bones only, there is no root motion, and skinned meshes do not
cast shadows yet.

### Captured places

```ts
import { SplatSorter, createSplatPass, packSplats, readSplatPly } from '@driftengine/splats';

const capture = packSplats(readSplatPly(bytes));
const splats = createSplatPass(capture);
const handle = renderer.registerPass(splats);
const sorter = new SplatSorter({
  splats: capture,
  budget: defaultSplatBudget(renderer.rendererName),
});
```

A Gaussian splat capture: a real place, photographed and optimised into a few hundred thousand
elliptical blobs, read from `.ply`, `.splat` or `.sog` and drawn **into** the scene rather than
instead of one. A wall standing in front of a capture occludes it, and a beam drawn after it passes through.
It reaches the frame through `registerPass`, so a project that never imports the package carries
none of it — about twelve kilobytes gzipped, asserted by the size gate rather than claimed.

**Colour is view-dependent where the capture carries it.** A `.ply` from a training run stores a
spherical-harmonic expansion, and the reader keeps the **l=1 band** — nine coefficients, one extra
texel a splat, +50% on the record — so glass, a wet floor and a polished surface change as you move
past them. Degrees 2 and 3 are the sharp specular detail and cost four and six times as much: at
400,000 splats degree 3 would put 307 MB a frame of texture reads through a device already carrying
389, so they are declined with the arithmetic on record. A capture without harmonics is untouched
and pays nothing.

**`.sog` is what newer capture tools write**, and it is a ZIP of lossless WebP images with a
manifest saying what each channel is — about fifteen times smaller than the `.ply` it came from:

```ts
import { browserWebpDecoder, readSplatSog, unbundleSog } from '@driftengine/splats';

const capture = await readSplatSog(await unbundleSog(bytes), browserWebpDecoder());
```

The decoder is a parameter because a decoder is a host capability: Node has none, and this package
will not vendor a WebP implementation to pretend otherwise. `browserWebpDecoder` is the ordinary
one and reads texels back through a texture upload rather than a canvas — a canvas stores colour
premultiplied, and these images are lookups rather than pictures, so a premultiplying read lands a
codebook index several entries away wherever a Gaussian is transparent. Pass your own decoder if
your host has a better one.

**Two formats share the name.** The self-organising-Gaussians paper is a _technique_ for sorting
Gaussians onto a grid so image compression can carry them, and its released scenes decompress to
`.ply`. This reads the container capture tools emit, version 2.

The pass owns **no vertex buffer and no vertex array on either backend**. Six vertices a splat come
off the vertex id and everything else is an integer texture fetch, so the whole per-backend surface
is a pipeline, two textures and a uniform block. Depth is tested and never written, which is what
lets a cloud compose into a scene without culling its own tail.

Sorting is where the engineering is. Splats blend back to front and `over` is not commutative, so
the order is the picture — and it changes whenever the view turns. `SplatSorter` runs a counting
sort over a sixteen-bit depth key in a worker built from a `Blob`, holds **at most one sort in
flight** and drops rather than queues, and re-sorts only once the view has turned about two and a
half degrees. A still camera sorts zero times a second.

Put a capture in a `.drft` and it streams. The container writes it as blocks interleaved across the
whole capture, so the **first block that arrives is a complete sparse version of the place** rather
than a finished corner of one: measured on `demo/dev/splatstream.html`, 662 splats out of 24 KB of
a 332 KB file, and it draws the whole room. The rest densify it.

**Two things fail silently and are worth knowing about.** Colour comes from the spherical-harmonic
DC term alone — the `f_rest_*` coefficients are counted and carried and never read — so a capture's
speculars read painted on rather than shifting as you move. And a budget keeps the splats largest
on _screen_, which means a capture whose splats are very flat and seen edge-on is ranked by a
number that over-estimates them.

### Light in the air

```ts
const beam = new Mesh(gl, buildLightVolume({ lengthM: 90, spread: 0.09, color, nearM: 1.1 }));
renderer.drawLightVolume(beam, model, camera, strength, 90, 0.09, {
  nearM: 1.1,
  dust: 0.3,
  dustScaleM: 2.5,
  driftM: wind.drift,
  sunShadow: 0.8,
  env,
});
```

A beam, a shaft through a window, the cone under a lamp. Its own pass because it
is not a surface: everything the mesh pass does to one is wrong for light, which
gets lit, fogged toward the medium's colour and scaled by how dark the world is.
A beam is _more_ visible in mist, because the mist is what there is to light. This
pass adds and does nothing else.

`buildLightVolume` returns a closed hull and the pass **walks the view ray inside
it**, so the geometry only decides which pixels run. Every one of them integrates
the air along its own line of sight, which is where the path length that makes a
volume read as a volume comes from. Two optional terms ride the same walk: `dust`
breaks the body up with a noise field in world space, drifting with an offset you
supply rather than a clock, and `sunShadow` cuts the volume where the directional
light does not reach, so a shaft carries the bars of the window it came through.

**A beam is a body somebody placed. For the air itself, there is a second call:**

```ts
// The ceiling, once, from what the device can afford:
createRenderer(canvas, { globalMediumSteps: 32 });
// The dial, per frame, from what the weather is doing:
renderer.setGlobalMedium(0.03, 0.9, 0.6, 120);
```

`setGlobalMedium` fills the whole frustum: extinction per metre, how much of what the air takes out
comes back as light, the Henyey-Greenstein anisotropy that makes haze glow toward a low sun, and how
far the search for light to scatter runs. It marches every pixel against the depth the frame already
drew and samples the sun's own shadow map, so a doorway puts its shape on the floor — which is the
one thing distance fog cannot do, because fog asks how much of a _surface_ survives the journey and
this asks what the journey adds.

**`density: 0` is a real off**: no target is allocated, no program is compiled and no composite is
drawn, so a game that never sets it renders the frame it rendered before the feature existed. So is
`globalMediumSteps: 0`, which is the default — the profile decides what a march may cost and the
game decides what the weather is doing, the same split `bloom` and `setBloom` already draw.

The march runs at half resolution behind a depth-aware upsample, which is what keeps fog off the
wrong side of a railing. `steps` and `maxDistance` set the segment length between them: 200 metres
over 32 steps is six metres a sample, and a shadow boundary crossed at that spacing is coarse.

**Pass `buildLightVolume` the same `lengthM` and `spread` you pass the draw call.**
Both are read in the geometry's own space, and both fail silently when the two
disagree: a spread wider than the hull leaves the fade still climbing where the
hull ends, which cuts the volume instead of dissolving it, and a length longer than
the geometry puts the whole thing inside the first fraction of its own falloff,
which draws nothing at all. Building the hull from those numbers keeps them agreeing.
`strength` fades the whole thing and is clamped at 1, so raising it past one is not
the answer to a beam that looks faint.

### Wet surfaces

```ts
const patch = buildFilmPatch(spline, { fromM, toM, centreM, halfWidthM, liftM, color, seed });
renderer.drawFilm(mesh, camera, timeSeconds, env, sheen);
```

A thin iridescent film — an oil slick, a puddle, wet stone. Its own pass because it
is its own material: **view-dependent**, nearly black looking straight down and a
shifting sheen at a glance, which is the whole of what makes a surface read as wet
rather than as dark paint. Textureless like everything else here; the rainbow is a
hue swept by view angle plus a slow travelling ripple, both generated per fragment.

`buildFilmPatch` supplies the silhouette: an ellipse along the curve, roughened by
a seeded wobble, lying on the surface's own frame so it follows bank and curvature.
It emits a **coverage** value per vertex — 1 through the middle, 0 at the rim,
carried on the attribute the mesh format calls emissive, which a film has no other
use for — and the shader squares it into alpha. A hard edge is what makes a patch
read as a sticker stuck onto the world however good the material is.

The wobble only ever narrows the patch, never widens it. A caller usually has a
_physics_ window matching the band it asked for, and a drawn shape reaching outside
it means ground that looks wet and grips normally.

### Capture

**`@driftengine/media`.** `FrameRecorder` records the canvas with an audio stream mixed in and hands the
result to `navigator.share` or a download. `supportedClipMimeType()` reports
what the browser can actually produce — MP4 first, since that is what social
apps accept without transcoding — and returns null where it can produce
nothing, so a caller can hide the button rather than emit a file that will not
play.

### Determinism

The fixed loop and physics can participate in deterministic simulation. Render
systems, touch sampling and the celestial clock are explicitly outside it.
Passing wall time or render state into simulation is a caller error.

## Source layout

```text
packages/core/src/
  behavior/     steering, perception and the behaviour trees over them
  cinematic/    the shot vocabulary and the rig that cuts between shots
  core/         fixed loop, seeded RNG, key/value storage
  dev/          development-only instrumentation
  environment/  reusable environmental state sampling
  geometry/     procedural mesh construction, splines, ribbons, the pixel font
  host/         the seam a shell implements, taken as parameters
  input/        raw devices and generic control mechanisms
  math/         scalar and colour utilities
  models/       the network graphs the engine can run on a device
  nav/          path following over a mesh another package bakes
  physics/      convex shapes, sweeps and spatial indexing
  render/       cameras, both backends, GPU resources, shaders and the frame graph
  scene/        transform hierarchy, bounds, culling and LOD
  ui/           DOM-adjacent helpers: generated cursors, fullscreen
  world/        a spatial origin the render path rebases and the simulation never does
  build/        code a consumer's bundler runs — outside the barrel by design
  index.ts      the only public barrel

packages/ai/src/           provider-neutral sessions, typed tools, an agent loop that does not wait
packages/animation/src/    skeletons, clips, blending, blend trees, IK, retargeting, springs
packages/assets/src/       model readers and the streaming loader
packages/audio/src/        DSP graph, sound registry, synthesis, rhythm/
packages/capture/src/      a video to a playable scene: depth, fusion, colliders, entities
packages/chemistry/src/    elements, species, substances and what they turn into
packages/drft/src/         the container format
packages/editor/src/       the model of a scene editor, independent of any front end
packages/entities/src/     generational identity, component storage, systems, scenes
packages/media/src/        clip encoding and frame delivery
packages/native-host/src/  the engine on a native window and a native device, no browser
packages/nav/src/          geometry to walkable convex polygons, and a line across them
packages/network/src/      a transport seam, rewind and replay, lockstep, an authoritative host
packages/package/src/      the desktop and Android packagers, and their bootstrap
packages/physics/src/      collision and dynamics; imports no other engine package
packages/script/src/       the drift/* capability bindings
packages/splats/src/       splat readers, the off-frame sort, the splat pass
packages/terrain/src/      heightfields, patches that meet without cracks
packages/texture/src/      DriftTexture: a texture as a compiled, sampled field
packages/tools/src/        the editor panels a shipped game can carry, and its command stack
packages/ui2d/src/         batched sprites, sheets, tilemaps, a retained interface tree
packages/xr/src/           WebXR sessions, stereo views, controller input, hand joints
                                     (the language, its server and its editor client live in
                                      their own repository and reach this one from npm)

editor/src/              the editor application: dock, panels, graph canvas, viewport
packages/core/scripts/   browser.mjs, cdp.mjs, png.mjs, frames.mjs, heldClock.mjs
```

**Twenty-three packages, and a game pays for the ones it imports.** `core` is the runtime and the
only one most games name; everything else is a peer that stays out of the payload until something
imports it. Four reach for nothing in this tree at run time — `physics`, `chemistry`, `drft` and
`entities`, whose only engine imports are in their own tests — and `core` depends on `physics`,
which is the one place that arrow runs backwards.

**`packages/core/scripts/` is part of the package, not tooling beside it.** A consumer imports
those five by path — `@driftengine/core/scripts/browser.mjs` — and gets the same visual gate the
engine uses on itself. They live inside the package rather than beside it so that import
resolves: from the repository root it would resolve to nothing, and a consumer's visual gate
could not start.

## What does not exist yet

Genuinely absent, rather than hidden behind an API that answers nothing. Each bullet is guarded:
[`docs/CAPABILITIES.md`](docs/CAPABILITIES.md) names a sentinel symbol per row — the symbol that
would exist if the work had landed — and the suite goes red on the day one arrives.

**One gap per bullet**, because a bullet naming five capabilities matches its guard while four are
still missing, so the one that shipped leaves no trace. **And gaps only**: when a row closes it
leaves this list, and the release it closed in is the changelog's business.

**Every track on [`docs/ROADMAP.md`](docs/ROADMAP.md) is complete.** So what is
below is not a subsystem waiting to be built. Two rendering rows are absent and neither is
scheduled:

- Screen-space GI: one bounce of indirect light traced against the frame's own depth and colour. A
  probe grid already carries the static bounce, so what this adds is light that moves with what is
  in the room. Unscheduled rather than deferred, and nothing waits on it.
- A fitted LTC matrix for an area light's specular. **Attempted five times, and the fifth found the
  objective.** The highlight is already an integral over the rectangle through an analytic
  transform. Four attempts fitted the transformed cosine to the _lobe_ and were judged on _polygon
  integrals_, which are different questions — the search was choosing matrices that won the first
  and lost the second. Fitting against polygon integrals directly takes the placement the bound is
  set on from the shipped term's **71.8%** to **8.8%**. What is still absent is the way to ship it:
  the degree-5 surfaces the shader evaluates cannot carry that fit, at **78.4%** read back, and
  neither a higher degree nor a smoother grid is the lever. The row asked at the start what payload
  a table would cost; it is 562 gzipped bytes at 8 bits, so the answer is to ship the table and drop
  the polynomial, and that is a texture upload nobody has written.

### Written, and never run

**Two things exist in full and have never met the hardware they are for.** They are not gaps, so
they are not bullets here, and neither carries a sentinel: a sentinel guards the symbol that would
exist if the work had landed, and both sets of symbols are already here. What stands behind them is
that each is tracked as an open row, and that no check anywhere prints a pass for what has not
been run.

**WebXR against a headset.** Sessions over both backends, stereo, controller input, hand joints, and
`drift/xr` bound. `npm run check:xr` asserts thirteen things a machine with no headset reaches,
including every refusal path, and everything past the first frame is exercised against a synthetic
runtime. **No `XRFrame` has ever been produced against this code**, because a rendering context
cannot be made XR compatible without a device attached. A real session, stereo on hardware,
controller input, hand tracking, device performance and the compositor's reprojection are unmeasured.

**An iOS build on a Mac.** The Swift host, the scheme handler, the XcodeGen spec and the build step
are written and no machine has run them. The first device answers the open question by loading the
origin probe: if the custom scheme is not a secure context, the fallback is a loopback server and
`SchemeHandler.swift` is the only file that changes. Expect to fix something on the first run.

### Declined, and why

**Reordering passes.** Dependency ordering was one of two things gate 1.2 promised and withdrew,
because the API is immediate-mode and the caller's draw order is already the semantic one.

**A `drift/core` binding.** The language specifies the module and this engine describes nothing for
it, deliberately and permanently. Its provider is `startLoop`, which _drives_ a script rather than
being called by one: a capability there would let a script start the loop it is already running
inside. It is the one specified module that is refused on purpose rather than pending.

**Chemistry's nine.** Fluid dynamics, detonation, electrochemistry, radiative transfer through
participating media, structural failure, two-way buoyancy on rigid bodies, toxicology, nuclear and
smell. Track P declined each at the design rather than deferring it, and recorded beside each what
would reverse it: a consumer with a need, a measurement showing a scene reads wrong, or Track B
growing something two of them wait on. Three of those conditions are written as _nothing
foreseeable_. **The fourth is measured rather than assumed**: fluid dynamics is not refused for
want of a compute-shader budget — a pressure solve is 5% of the transport it would join, on the
CPU, in double precision. What refuses it is that the field stores no velocity
to project. Eight of the nine hold sentinels, so building one fails both documents.

## Shipping the game

A game built on this engine ships in a tab and as an installed application from the same build:
`drift-package` wraps the web bundle in a desktop shell around a bundled Chromium, or an Android
APK around the system WebView, from one manifest.

```sh
npx drift-package doctor                     # what is configured, how each target would sign
npx drift-package bootstrap                  # fetch the toolchain each target needs
npx drift-package build --target=linux-x64
npx drift-package verify --contains="<a string from your diff>"
```

[`docs/SHIPPING.md`](docs/SHIPPING.md) is the route: what has to be true of the web build first,
the three files a consumer adds, where each target is built and which one is cross-built, what the
game itself has to implement to behave inside a shell rather than a tab, the two secrets that
cannot be recovered once lost, and the traps that have each cost a day.
[`packages/package/README.md`](packages/package/README.md) is the reference underneath it, field by
field.

## Development contract

```sh
npm install
npm run typecheck
npm test
```

There is no `build` — consumers bundle `src/` directly, and `tsc` runs with
`noEmit`.

The binding rules are in [`AGENTS.md`](AGENTS.md), including the game/engine
boundary, zero-allocation hot paths, the rendering quality entrypoint,
determinism, hardware-GPU browser verification, and the small load-bearing test
doctrine.

Because a consumer symlinks this tree, there is no version gate between a
commit here and a game running it. Verify against a real consumer before
committing anything that touches a hot path or the public barrel.

## Contributing

[`CONTRIBUTING.md`](CONTRIBUTING.md) covers setup, the game/engine boundary,
the determinism contracts, the testing doctrine and what a reviewable change
looks like. Read it before opening a pull request.

## Licence

Apache-2.0 — see [`LICENSE`](LICENSE). Every dependency the browser engine ships is MIT or
Apache-2.0, which is a deliberate constraint rather than a coincidence: `@driftengine/core` takes
`gl-matrix` (MIT), `media` takes `mp4-muxer` (MIT) behind a dynamic import, and `entities` and
`script` take `driftscript` (MIT).

**The native host is the one place copyleft reaches the tree, and it is not bundled.**
`@driftengine/native-host` takes `ogg-opus-decoder` (MIT), which depends on `codec-parser` — and
that is **LGPL-3.0-or-later**. It is the only copyleft package in the whole shipping graph. A
packaged game therefore ships it as a **file of its own that a person can replace**, never linked
into the bundle, with the GPL's text beside it; `@driftengine/package` refuses to bundle any
copyleft library and fails the build rather than doing it quietly. See
[`packages/native-host/README.md`](packages/native-host/README.md) and
[`docs/SHIPPING.md`](docs/SHIPPING.md).

## Attribution

**Section 4(d) of the licence is not decorative.** Distribute this engine, or anything derived from
it, and you must reproduce the contents of [`NOTICE`](NOTICE) — in your source, in your
documentation, or in a display the work generates. A credits screen, an about page or a
third-party-licences page each satisfy it.

Every package barrel opens with the same line, in the comment form a minifier keeps by default. That
is deliberate: bundle this engine and the notice travels into your build rather than dying at it, so
meeting the requirement takes no work on your part.

The short version: **use it for anything, including commercially, and say where it came from.**

### The splash, and what is asked rather than required

The engine mounts a badge on boot, on by default. **Leaving it on is a request, not a condition.**
Apache-2.0 gives you the right to modify this engine, and that right is real: `{ splash: false }`
turns the badge off, `?splash=0` turns it off without a code change, and nothing in the licence
says otherwise. Anyone telling you a permissive licence can compel a splash screen is wrong about
the licence.

So this is an ask, made plainly. A new engine becomes known because the things built on it say what
built them, and three seconds at boot is the cheapest way anyone has found to do that. If the badge
does not suit what you are shipping — a client's product, an embedded view, a site where a splash
would be absurd — turn it off and use the engine with a clear conscience. **The only thing the
licence actually requires is the NOTICE above**, and the barrels already carry that for you.

Where anything here came from somewhere else, [`CREDITS.md`](CREDITS.md) names it, its author and
its licence. The short list: the voxel sandbox demo is a port of Babylon Lite's, Apache 2.0, whose
code is read and never vendored; its block tiles are Kenney's Voxel Pack, CC0, fetched at runtime
and never committed.

## Looking at the demos

The engine ships **nine published scenes and ten drafts** in `demo/`, and it can show them
itself — the website is where they are published, not where they are checked.

```sh
npm run demo          # opens the harness, one scene per button
```

Editing a scene updates the page as you save it: the harness accepts the hot update,
disposes the live scene and remounts it, so the context and the compiled programs survive
and the picker stays where you left it.

Drag to turn, wheel to zoom, double click to hand the camera back. `?scene=3` opens
straight to one. Buttons marked **(draft)** are in `DRAFT_SCENES` rather than `SCENES`:
the harness shows both, a consumer sees only `SCENES`, so an unfinished scene cannot
reach a public page by being written.

### Showing a model in it

The `Showroom` draft builds its room at load and fetches a car from `car.drft`. Nothing
in `models/` or `demo/dev/public/` is in the repository — both are ignored — so bake your
own:

```sh
npm run bake -- path/to/model.fbx -o demo/dev/public/car.drft
npm run bake -- ./some-bought-bundle -o demo/dev/public/car.drft
```

The baker takes a **file or a folder**. Given a folder it inventories what is there,
picks the highest tier available and prints what it chose and what it passed over —
`glb`, `gltf`, `obj` and `stl` are tier 1, `fbx` is experimental. `--from fbx` overrides
it, for comparing readers on one asset.

Without a `car.drft` the showroom is an empty lit room on its turntable, which is not an
error and says so in the figures under the frame.

See `docs/FORMAT.md` for the format, the tiers and what each one promises.
