# Architecture — the packages, the boundaries, and the two mechanisms

**Eight of the fourteen packages exist.** `core`, `drft`, `assets`, `audio` and `media` shipped in
2.0.0, `package` and `splats` followed, and `animation` is Track A's; the rest are tracks on
`ROADMAP.md` and **will be born as packages rather than extracted**, so nothing has to anticipate
them.

**This line said five until 2026-08-25** and had been wrong since the sixth package landed —
`@driftengine/package` is the fourteenth name and was never in the design's thirteen, which is why
the total moved too. A count in prose beside a directory that grows is the shape `docs/README.md`
opens by describing; correct it in the commit that adds a package.

Not all fourteen, because the import graph was measured rather than assumed and it allowed exactly
four extractions from the original package. Everything else — `render`, `geometry`, `math`, `core`,
`physics`, `ui`, `cinematic`, `environment`, `input`, `dev` — is mutually entangled and stays in
`core` until something breaks the entanglement.

**A package born rather than extracted does not need the graph to allow anything**, which is why
the count has moved three times since that measurement without it being retaken: `splats` and
`animation` were written as packages from their first line. `animation` is the first one whose
capability also required a change _inside_ core — the two vertex attributes, the palette texture
and the shader permutation — because §1's rule puts a feature that lives in the lit pass there
whatever package its runtime belongs to.

`CAPABILITIES.md`
says what exists today; `ROADMAP.md` says in what order the rest arrives.

---

## 1. Two mechanisms, and why there must be two

A subsystem with its own runtime becomes a **package**. A feature that lives inside the lit pass
cannot be, because a shader permutation compiled into a shared program is not tree-shakeable by
any bundler. Those become **compile-on-demand shader features**, cut from the source string unless
asked for.

The second mechanism is not speculative. `RenderQuality.nightEmissive` exists precisely so the
term is absent from `flat.ts` when it is off, and the measurement that justified building it that
way is on record: a uniform declared and never used moved **0** pixels, a branch present with an
empty body moved **1**, a body naming nothing the emissive line already named moved **0**, and the
real expression moved **109**. The cost of an unused shader feature is therefore zero, and it is
zero because the text is not compiled rather than because the branch is not taken.

**The cost of an unused shader feature is zero on one path and 2^n on the other, and that was
measured.** The paragraph above is about what a _driver_ compiles, where it is
exactly right: text that is cut out is register pressure nobody pays. It is not true of what a
_consumer downloads_. The WebGPU backend ships every permutation as pre-generated WGSL in one
`Record<string, string>`, so the flag count is an exponent on the bundle: adding a fifth flag for
clustered lighting took the generated file from 914 KB to 1,906 KB raw and **cost 196,910 bytes
gzipped, 49% of `core-only`, on every consumer including those who never enabled it.** Gzip does
not absorb it, because deflate's window is 32 KB and a permutation is larger than that, so sixteen
near-identical copies do not dedupe into one.

So the mechanism has a second rule, and `scripts/size-gate.test.mjs` is where its arithmetic lives:
**a feature inside the lit pass becomes a permutation only if it is large enough that carrying it
compiled-in would cost more than doubling the shader corpus.** Clustered lighting is not — it is a
different _source_ for six values the loop already reads — so it is a branch on a uniform, and it
cost 36,838 bytes instead. The ORM maps reached the same conclusion by reasoning a day earlier;
this is the number under it. What is still permuted is what earns it: the shadow paths, whose
absence removes samplers and a 190-line filter rather than an arm of one branch.

**Consequence for planning:** a feature's home is decided by where it lives in the frame, not by
how large it is. Clustered lighting is a bigger job than the splat renderer and belongs in core;
splats are smaller and belong in a package.

## 1a. Two hosts, one engine

**A host is capability implementations plus a surface**, and the engine has two: a browser, and
`@driftengine/native-host` — Node, Dawn and SDL, with the page a game expects installed around one
canvas. The engine does not know which it is on. That is only possible because `AGENTS.md` already
forbade calling a platform API directly: persistence is a `KeyValueStore` the caller supplies, time
is a clock, files are a `FetchLike` or a `TileSource`, so a second host implements those and the
browser's surface around the canvas, and changes no engine code.

**The rule had been reviewed rather than tested until the host was begun**, and the audit that
opened it (`scripts/platform.test.mjs`, 2026-09-15) found eleven places it had not held: the loader
for the engine's own container fetched through the global, three deadlines read `Date.now`, and a
media query sat unguarded in a constructor. The test holds it now. **The host then found what a
second implementation finds**: defects that were there in every browser, fixed in the engine and
not worked around in the host — a model's images decoded premultiplied, a WebGPU texture resize
that kept the old size, a store written in place, panels dropped without a word, a master filter
that started closed, an insert that combed against its own dry arm, and a published build that
named its worker by a file it did not hold.

**Pixel-identical is the gate**: the published scenes are drawn by both hosts on one machine and
compared pixel for pixel (`npm run native:gate`), and a difference is the host's fault until shown
otherwise. What each host can do that the other cannot is `CAPABILITIES.md` §2a, in both
directions; `@driftengine/package` builds for either (`native-linux-x64` beside the Electron and
mobile targets).

## 2. The packages

| Package                  | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@driftengine/core`      | math, loop, RNG, storage, preferences, input, geometry builders, camera, renderer and base passes, scene graph and culling. **Re-exports the whole of `@driftengine/physics`**, which it depends on                                                                                                                                                                                                                                                                                                                                                                                                               |
| `@driftengine/drft`      | the container format, reader and writer, standalone and Apache-2.0. **`MeshData` and `validateMeshData` live here**, and core re-exports them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `@driftengine/assets`    | glTF, OBJ and FBX readers, baker runtime, `DrftLoader`, coarse level                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `@driftengine/audio`     | the submix tree and its inserts, transport and stems, synth, rhythm, kick detection, the listener graph, HRTF sources, occlusion, reverb zones, doppler, and the two cheap positional functions                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `@driftengine/media`     | clip encoder, frame recorder, export targets                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `@driftengine/animation` | clips, tracks, skinning, blend trees, state machine, IK, morph, retargeting                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `@driftengine/physics`   | convex shapes and their faces, mass properties, the spatial hash, segment queries, **swept kinematic collision**, and the dynamics built on them — solver, joints, queries, sensors, a character controller, ragdolls, a raycast vehicle and cloth (complete 2026-08-26). **Imports no other engine package**; core depends on _it_, which is the one package where the arrow runs that way — see below                                                                                                                                                                                                           |
| `@driftengine/chemistry` | the closed element set, species whose molar masses are derived from their formulas, the species-by-element matrix, compositions, and the conservation reduction. Parcels, the reaction network, the atmosphere field and transport. **Imports no other engine package**, and unlike physics nothing in core depends on it either. **Seven further entry points under `library/*`** — organic, food, fuel, polymer, mineral, metal, biological — because a substance is data and forty of them is a payload: a consumer who wants a campfire imports one family for 953 bytes rather than seven for five kilobytes |
| `@driftengine/splats`    | readers, worker sort, splat pass                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `@driftengine/ui2d`      | sprites, sheets, tilemaps, retained tree, layout, focus                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `@driftengine/xr`        | sessions, stereo rendering, XR input                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `@driftengine/network`   | transport seam, replication, prediction, rollback. **Named `net` in this table until 2026-09-15**, which is the error a table nobody reads back keeps indefinitely                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `@driftengine/terrain`   | heightfield rendering, LOD, splat maps, terrain collision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `@driftengine/entities`  | entity identity, component storage, queries, the system schedule, prefabs, scene serialization. **Imports no other engine package** — see Track M's design §2                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `@driftengine/ai`        | the provider seam and capability probe, the agent session and its four states, the deterministic policy floor, tool and context registries, admission guards, budgets, the command log. **Depends on core alone** — for `MessageQueue`, and for nothing else — see Track O's design §2                                                                                                                                                                                                                                                                                                                            |
| `@driftengine/texture`   | the DriftTexture decode program and its reference decoder, residency and streaming, the writable overlay and its journal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `@driftengine/nav`       | geometry to a walkable voxel field, watershed regions, contours, convex polygons, and a query over core's own `NavSearch`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `@driftengine/tools`     | the in-game tool surfaces — command stack, selection, inspector, console, profiler, network and divergence panels                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `@driftengine/editor`    | inspector, gizmos, scene tree, play-in-editor                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

**Core depends on `@driftengine/physics`, and it is the only package where the arrow runs that
way.** Every other optional package takes core as a `peerDependency`, so a consumer pays for it only
by importing it. Collision cannot be arranged that way: the cinematic and third-person cameras, the
contact probe and the ribbon builder all need the sweep, so core needs the package. What that costs
is that collision is not optional — which is correct, since it never was — and what has to stay true
instead is that the **dynamics** never becomes reachable from `createRenderer`. That is a growth in
the `core-only` floor and nothing else, so `scripts/size-gate.test.mjs` is what holds it rather than
this paragraph.

**Compiled into core on demand rather than packaged:** PBR maps and tangents, spot lights, area
lights, clustered lighting, image-based lighting, depth of field, screen-space reflection, temporal
anti-aliasing, colour grading, decals.

## 2a. What each package costs

Measured by `scripts/size-gate.test.mjs`, gzipped, and asserted rather than quoted.

| Entry point                                   | Bytes gzipped |
| --------------------------------------------- | ------------- |
| `@driftengine/entities` alone                 | 632           |
| `@driftengine/drft` alone                     | 4,731         |
| `@driftengine/chemistry` alone                | 18,416        |
| chemistry + `present`                         | 20,894        |
| chemistry + three substances a consumer wrote | 11,648        |
| chemistry + `library/organic`                 | 12,927        |
| chemistry + `library/metal`                   | 12,273        |
| `@driftengine/physics` alone                  | 30,356        |
| `@driftengine/core` (`createRenderer`)        | 539,548       |
| core + `@driftengine/audio`                   | 545,790       |
| core + `@driftengine/splats`                  | 553,744       |
| core + `@driftengine/assets`                  | 551,047       |
| core + `@driftengine/animation`               | 545,589       |
| core + `@driftengine/script`                  | 549,513       |
| core + audio + the spatial layer              | 547,472       |

**Re-measured 2026-08-26 against the gate's own floors, and six of the seven rows were stale.**
Every one of them had been left behind — core by the splash badge, and the five that are core plus a
package by carrying core's growth. `entities-only`, `core-and-script` and `physics-only` were floors
with no row here at all. **A table of measurements that nothing re-measures is prose**, which is
what `docs/README.md` opens by saying, and the fix is the same one `packages.test.mjs` already
applies to every package README: derive it from `scripts/size-floors.mjs` rather than transcribing
it. Until something does, this table is the copy most likely to be behind.

**Re-measured 2026-08-25 against the gate's own floors**, which is the only way this table has
ever been right. **Every row moved when Track A landed**, and only two of them for reasons of
their own: `drft` by four chunk codecs, and `core` by the vertex stage's two permutation flags and
the two GLSL preludes beside them. The other four are core plus a package and carry core's growth,
which is exactly why they are re-measured together rather than one at a time. The two moved rows are skinning's: `drft` by three validator checks and
`core` by the vertex permutation, the GLSL prelude and a palette binder per backend. Only 1,118 of
core's 7,144 is the permutation — the rest is ordinary source, and the shader text does not
minify.

**`@driftengine/splats` is about 12 KB gzipped over core**, for two readers, the packing, a
counting sort and its worker, the shader for both backends, the pass, the budget, the frustum test
and the streaming capture. Small for what it is, and the reason is the design rather than luck: the
pass owns no vertex buffer and no vertex array, so there is no geometry code at all; the sort is
one function stringified into a worker rather than a second implementation; and the shader is
authored once in GLSL and generated to WGSL, so the two backends are one source.

**`@driftengine/drft` grew 17.6% in one step**, 2,800 to 3,293, and it is worth naming because it
is the largest single move that entry point has made. `SPLT` is most of it, and most of _that_ is
`coarseFirst.ts` — a Morton quantisation, a comparison sort and a bit-reversal walk that gzip
cannot dedupe against anything else in the package. What it buys is a capture that opens in a
fourteenth of its bytes.

**And it had gone stale again, by more than it did the first time.** It said 450,952 for core while
the gate's floor stood at 524,402 — **74,356 bytes** behind, against the 81,184 that prompted the
paragraph below. The mechanism it describes did not fail; nothing was using it.

**Every figure here was wrong until 2026-08-24 too, and the sentence introducing them is the reason
worth keeping.** It says these are asserted rather than quoted — and they were quoted, from 2.0.0,
while `scripts/size-gate.test.mjs` moved its floors underneath them four times. The gate asserts
the _floors_ and this table is prose beside them, so a table that drifts inside the gate's 3%
tolerance is invisible and a table that drifts past it is still invisible, because nothing compares
the two. **The only thing that would fix this properly is generating the table**, the way
`npm run docs:counts` generates the test counts that once drift in exactly this way. Until then
it is re-measured in any commit that moves a floor.

The last row is the one that pays for the arrangement it describes: **placing sound in the world
costs 1,479 bytes gzipped over the audio graph, and only its users pay it.** The spatial layer is
standalone functions rather than methods on `MixConsole` precisely so a bundler can drop it, since a
method would be a static reference from the mix to an HRTF panner that no consumer could shake out.

**Core is dominated by shader text, which does not minify.** That is why the optional packages
look small beside it and why the gate's growth assertion uses an absolute margin: audio is 5,003
lines of source and 6.4 KB gzipped, or 1.4% of core.

## 3. The render graph is a precondition, not a nicety

`splats`, `ui2d` and `xr` each need to contribute passes to the frame. The pass order currently
lives inside two hand-ordered renderers — `backend/webgl2/renderer.ts` and `backend/webgpu/renderer.ts`, whose sizes
`CAPABILITIES.md` §4 quotes and asserts — and **a package cannot register a pass into that**.

So the graph is what makes the package architecture possible at all, which is why it is scheduled
before the packages that need it rather than deferred again. It was deferred once, on the
reasoning that the WebGPU work would decide it; what that work produced was a second hand-ordered
renderer nearly twice the size of the first.

**The paragraph above is half out of date and is kept because its reasoning is not.** A package
_can_ register a pass now — `registerPass` ships, `splats` and `ui2d` both use it, and
`CAPABILITIES.md`'s Structure row is the current account. What is still true is the sentence about
where pass _order_ lives.

**Two schedulers now exist, and which one a frame uses is decided by whether its composition is
fixed.** `schedule.ts` groups a fixed composition addressed by a fourteen-entry bit mask, and it is
right for the forward path. Beside it, `virtual.ts`, `lifetime.ts`, `alias.ts`, `graphSchedule.ts`
and `validate.ts` address transients by identifier, because a mask cannot hold the hierarchical
depth chains, visibility buffers and per-material bin lists a GPU-driven frame allocates against
what it contains. `graphParity.test.ts` asserts the two agree on a frame both can express, which is
what keeps the second a generalisation of the first rather than a second renderer.

**Both drive production frames now, 2026-09-17.** The second pipeline's frame is genuinely not
fixed — an unshadowed frame has no map to draw — so `GpuDrivenPass` records its twelve stages into a
`Deps` table every `prepare` (`gpudriven/pipeline.ts`), `scheduleGraph` keeps what something reads,
and the pass encodes the kept stages in order: command for command the frame it encoded before, and
without the map pass where nothing samples it. The forward renderer's flush can be scheduled either
way: `quality.identifierGraph` sends it through `frame/flushGraph.ts`, which records each mask bit as
an identifier and derives the same passes, clears and discards, and every frame-graph test in
`webgpu/renderer.test.ts` runs under both. Off by default, and the eighteen scenes the harness walks
are pixel-identical with it on — `CAPABILITIES.md` §3 has the captures, and the one scene that varies
between runs of a single build whatever the flag says.

**Where pass order lives is unchanged.** Both renderers are still hand-ordered; what the graph now
decides is which recorded work runs and how it is grouped, which is the half that a package
contributing a pass, and a frame whose composition moves, both needed. The pure modules stay off the
package barrel, as `frame/index.ts` says — their public shape is still nobody's decision to make.

## 3a. A world bigger than a float: two coordinate systems, not one

**The simulation never rebases. Rendering does.** This is one rule and it decides the whole
large-world arrangement, so it is here rather than only in `core/src/world/rebase.ts`.

Simulation coordinates are absolute and double precision. A rebase that touched them would change
floating-point results, and therefore the replay fingerprint, for no reason a player could see —
and only in sessions that happened to cross an origin boundary, which is a divergence nobody
reproduces on demand and nobody attributes correctly.

Render coordinates are single precision relative to an origin that follows the camera **in whole
cells**. Whole cells, because a continuously-moving origin re-quantises every vertex every frame:
the world is numerically correct at every instant and shimmers, which is the precision problem it
was meant to solve wearing a different hat. Measured over a walk of two hundred and twenty ticks at
the far end of the world, the origin moves seventy-five times rather than two hundred and twenty.

**Three consequences a reader will otherwise meet as surprises.**

A view matrix is a `Float32Array`, so it cannot carry an absolute position in a world this large —
at 2²⁵ single precision counts in fours. Predicted views are therefore render-space and
`CellStream` is told the origin, which it adds back in double precision before anything is
quantised into a cell.

A navigation mesh is authored and queried in render space for the same reason, and
`nav/src/query.ts` never sees a large coordinate.

**Freezing is a simulation decision and unloading is a memory one.** A cell outside the simulated
radius freezes whether or not its contents are resident, and only a frozen cell may be unloaded. The
alternative — unloading causes freezing — makes the simulation depend on how much memory a machine
had, which is a divergence that appears on one player's computer and nowhere else.
`core/src/world/seam.test.ts` walks a world at six magnitudes and asserts the streamed run's
fingerprint against a run holding every cell, and asserts that the forbidden arrangement diverges.

## 4. Versioning and migration

Optional packages take `@driftengine/core` as a `peerDependency` on a caret range, so a game
upgrades core once rather than thirteen times.

Consumers move from the current `node_modules` symlink to npm workspaces. **Each consumer migrates
in a single commit**, which is the only shape that works while a consumer resolves the engine from
a path: a half-migrated consumer builds against neither version. `PORTING.md` records the WebGPU
move being done exactly this way and is the model for it.

## 5. The rules every package obeys

- **Determinism, and where its boundary runs.** Nothing in the simulation path reads a clock or
  `Math.random`. Physics is inside that boundary, which is what makes rollback netcode possible and
  is the reason the solver is written here rather than wrapped around a WASM one. Animation
  sampling is a pure function of a caller-supplied time. Audio is outside. A splat sort is outside,
  being view-dependent rather than simulated.
- **Payload, measured per package.** A size gate bundles a minimal application against each package
  and fails when a floor moves. Every optional package publishes its own cost. The promise stops
  being _the engine is small_ and becomes _you pay only for what you import, and here is the
  number_.
- **Both backends, or an explicit refusal in writing.** The port already demonstrated the
  alternative: capability drift that nothing detected until a consumer's phone went black.
- **Visual gate on hardware.** Held frames before and after, `shots.mjs` on a real GPU, and where
  the two backends claim the same picture they must be pixel-identical.
- **Opt-in defaults.** Every feature's default reproduces today's picture. A published scene that
  changes because a feature was added is a regression however good it looks.
- **Runtime dependencies stay MIT and few.** Two today, and a package earns a third by argument.
