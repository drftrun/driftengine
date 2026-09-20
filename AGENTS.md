# AGENTS.md — DriftEngine technical direction

Binding for everything in this repository. A consumer's own `AGENTS.md` governs
that consumer's code; where the two overlap, **this file is authoritative for
engine code**.

`docs/CAPABILITIES.md` is the capability map: what ships, what is absent, and a test behind each
absent row. `docs/ROADMAP.md` says in what order the remaining gaps close. `docs/HANDBOOK.md` is
the handbook for working with imported models.

**`examples/` is where to start when writing code against the engine** — six small runnable
programs, one capability each, served by `npm run examples`. See "Start from an example" below for
which one answers which question, and for two traps that read as engine bugs and are not.

## Quickstart

```sh
npm install
npm run typecheck  # strict TS over src/
npm test           # vitest
npm run changelog  # release notes for the current version
```

### What each gate costs, and the order that runs each thing once

**The suite is not free: 74 s of wall clock, about five CPU-minutes and 885 MB peak, measured
2026-08-28.** Everything else together is under fifteen seconds. So run the cheap ones first, run
the suite **once**, and take the counts from that run rather than from a second one.

**`areaSpecular.test.mjs` is 4.5 s on its own and costs about one second here**, because
`node --test` runs the files across workers and the rest of the suite covers it. It integrates a
rectangle by brute force at 512 samples a side, since an under-sampled reference in that subject
produced a confidently wrong number once already. Worth knowing before anybody trims it on the
strength of its solo timing.

```sh
npm run typecheck        #  1 s   two configs: the engine, and the Node-side tools
npm run test:scripts     # 10 s   scripts/*.test.mjs and every packages/*/src/**/*.test.mjs
npm run wgsl:check       #  2 s   the committed WGSL against the GLSL it is generated from
npm test                 # 74 s   vitest, and it writes .vitest/summary.json on the way
npm run docs:counts      #  0 s   reads that summary; it does not run a suite
```

- **`docs:counts` used to run the whole suite** to scrape one number out of the last line, so a
  session that ran the suite and then refreshed the counts paid twice. It reads the summary now, and
  refuses to write a count taken from a filtered, red or stale run — saying which. `npm test` first,
  then this.
- **`npm run capabilities:check` is already inside `test:scripts`**, which runs
  `scripts/capabilities.test.mjs`. Running both does the same work twice; run the suite of gates.
- **`npm run docs:check` is a subset of `test:scripts` too** — it is the fast door when a
  documentation edit is all you changed.
- **`--isolate=false` is not the saving it looks like**: measured at 73.7 s against 75.9 s, and one
  test file fails without isolation. The suite's time is transform and import, not isolation.
- A single file is `npx vitest run path/to/file.test.ts`, which is a second or two and is what a
  fix under way wants. It writes a summary too — a partial one, which `docs:counts` detects and
  declines to read.

**Do not run the full suite twice in one session.** Run it after the cheap gates are green, and
again only if something has changed since.

**The default is the build, and source is the opt-in.** `main`, `types` and the default `exports`
condition all resolve to `dist`, so a stranger's `npm install` works whatever their bundler does
with TypeScript in `node_modules`. The `drift-source` condition resolves to `src/index.ts`, and a
consumer editing this tree as a path dependency names it to get an edit live with no build step —
which is what a consumer developing against this tree does, and what this repository's own
`tsconfig.json` and `vitest.config.ts` do.

**That default was the other way round until 2026-09-13, and flipping it is why the condition
exists.** A published package whose default entry is TypeScript breaks any consumer whose bundler
skips `node_modules` in its TS pipeline, and the error surfaces inside a dependency where it reads
as the engine being broken. `npm run cleanroom` proves the default half, because nothing inside a
workspace can: a dependency resolves through a symlink whose real path has no `node_modules`
segment, and Node's refusal to strip types only fires under one.

## The two goals

**Clean** and **fast**, in that order of appearance and with neither sacrificed: readable,
precisely-scoped modules that compile to allocation-free, GPU-friendly hot paths. Faster but
unreadable gets redesigned until it is both. Prettier but slower in a hot path does not ship.

## The engine outlives its first consumer

DriftEngine is a reusable 3D engine, not one game's private plumbing. Its first production use
case is one game and nothing more. Every system here — rendering, lighting, shadows,
particles, water, cameras, input, audio DSP, physics, tooling — must be expressed in game-agnostic
terms and be usable by a second, unrelated game without edits.

Engine APIs take **positions, colours, sizes and time**. Never a "runner", a route, or anything else
that only means something in one game. **If a module needs to know what something _is_ in order to
draw it, the boundary is in the wrong place.**

**The same rule governs prose.** Comments, tests and docs carry no personal names, no quoted private
conversations, and no proper nouns from one game's world. A bug report becomes "reported as…"; a
game's noun becomes the generic thing it is an instance of. **`scripts/docs.test.mjs` asserts this**
rather than leaving it to review — it failed on its first run against nine source files and the
porting guide, which is how long a rule survives on memory alone. There is no exemption: the rule
holds for every file in this repository, and the list of nouns it refuses is kept outside the tree
so that stating the rule does not break it.

**Ask the question when you add something, not at review.** The default drift is to build a
capability in the game, because that is where the need appeared, and generic code then accumulates
there until nobody wants to move it. If what you are writing has no game-specific noun in it —
persistence, a queue, a mixer stage, format resolution, a state machine over ids — it is an engine
module with a game-side _configuration_ on top. Audio is the worked example: the DSP graph, slot
resolution, accepted formats and placeholder synthesis are engine; which sounds exist and when they
play is game.

**The physics line was drawn in the wrong place until 2026-08-26.** This section said collision
primitives were engine while "a controller built on them is game (friction, coyote time and slide
boost are one game's feel, not physics)". The audio rule above draws it correctly: a controller
taking a friction curve and a coyote-time count takes **numbers and time**, which is what this
document says engine APIs take, and it never takes a runner. So the mechanism _and its parameters_
are engine; what stays game is **which numbers**. That is why `CharacterController` ships in
`@driftengine/physics` with acceleration, air control and a jump buffer on it. **What would make it
wrong** is a parameter that only means something in one game.

**Nothing here may call a platform API directly when a consumer might want a different one.**
`localStorage` is the case that caught us: persistence goes through a `KeyValueStore` the caller
supplies, so a save can live in a browser, on a server, in a native shell, or nowhere. Same for any
clock, network or filesystem access — take the capability as a parameter, ship a browser
implementation as the default.

**`scripts/platform.test.mjs` asserts this**, and until 2026-09-15 nothing did. The first run found
eleven defects: the loader for this engine's _own_ container format fetched through the global while
two audio modules a directory away took a `FetchLike`; three deadlines were measured with `Date.now`,
which steps, so a clock correction either fired them at once or never; and a media query sat
unguarded in a constructor, so an embedder without `matchMedia` could not construct input at all.
Two exemptions exist. **A marked line** — `// platform: browser default — <reason>` — is a call
that _is_ the documented default of a capability the caller may replace, and the rest of the file
stays scanned. **A declared browser module**, listed in the gate with its reason, is a file a
runtime with no DOM never loads; that list is also what a native host has to reimplement.

**And a second host is what the rule was for, 2026-09-19.** `@driftengine/native-host` runs the
engine on Node, Dawn and SDL with no engine code changed, and draws the published scenes
pixel-identically to Chrome: every platform touch it had to answer was a capability or a page
global, never a call buried in the engine. **The count above is the finding worth keeping**: the
rule had been held by review for years, and the first test of it found eleven places it had not
held. What each host can do that the other cannot is recorded both ways in
`docs/CAPABILITIES.md` §2a, the host's side guarded by a `present` block so a capability cannot
quietly go.

The test for anything new: **if a second, unrelated game would want it unchanged, it belongs here.**

## Looking at what you changed

`npm run demo` opens the scenes in `demo/`, one button each. Use it. **A rendering change that has
not been looked at has not been checked**, and the website is where these are _published_ rather
than where they are verified.

- Drag turns, wheel zooms, double click releases the camera. `?scene=3` opens one directly.
- **`SCENES` is published; `DRAFT_SCENES` is not.** A consumer builds its demos page from `SCENES`,
  so registering a scene there puts it in front of readers the moment the file exists.
- Models are baked with `npm run bake -- <file-or-folder> -o demo/dev/public/car.drft`. Nothing
  under `models/` or `demo/dev/public/` is committed: a bought asset is tens of megabytes and is not
  the engine's to redistribute.
- Quality options are typed at the address bar and apply to any scene: `?bloom=0.5&hdr=1`,
  `?bloomthreshold=0.2`, `?exposure=1.9`, `?samples=4`, `?ao=0.5`, `?blur=1`. **The pair matters** —
  a bloom strength without a threshold it can clear is one of the settings that is silently nothing.
- **`/probe.html` is the page for what a scene cannot show.** The speed rush is a per-frame dial no
  scene calls, camera motion blur cannot be measured against a held clock at all, and the
  environment probe's bake is gated on a model this checkout does not have. It draws two frames a
  fixed camera step apart and stops, so the frame photographed really does have a previous view
  behind it. Takes `?rush=`, `?blur=`, `?mirror=1`, `?probe=256`; capture with
  `--urls=probe=/probe.html --hold=2`.

### Drive the browser over CDP. It is in this repository, and it is the first thing to reach for

`scripts/shots.mjs` and its four modules are how a rendering change gets looked at, and they are
engine code rather than something to write again each time. They had been rebuilt from scratch three
times across two repositories, with a different set of traps found the hard way in each.

```sh
npm run demo                      # in one terminal
npm run shots -- capture before   # every published scene, at a held frame
# change one thing, and restart the dev server
npm run shots -- capture after
npm run shots -- diff before after --region=0,92,1280,678 --speckle
```

`browser.mjs` launches, `cdp.mjs` speaks the protocol, `png.mjs` decodes, `frames.mjs` measures and
`heldClock.mjs` freezes the page's clock. **All five live in `packages/core/scripts/`, and the reason
is a consumer's import path rather than tidiness.** `heldClock.mjs` sat at this repository's own
`scripts/` until 2026-08-25, so a consumer importing `@driftengine/core/scripts/heldClock.mjs`
resolved nothing — and a game's entire visual gate had been unable to start, on its first import, for
as long as that was true. Nothing failed here, because this repository's own `shots.mjs` reached it
by a relative path. **A module a consumer imports by package path is part of the package**, and the
check is to import it the way a consumer does.

```js
import { launch, requireHardwareGpu } from '@driftengine/core/scripts/browser.mjs';
import { connect } from '@driftengine/core/scripts/cdp.mjs';
```

**Prefer this over a browser MCP.** The Chromium MCP has been unstable here and has timed out
launching a browser.

**The guard in `browser.mjs` is not optional and not tuning.** Plain `--headless=new` on this machine
selects **SwiftShader**, measured, and says nothing about it: every frame is a lie about what a
player sees, and it saturates the CPU producing it. `launch()` passes `--use-angle=vulkan` and
`requireHardwareGpu()` refuses a software rasteriser. Print that renderer string in anything that
captures, and stop the browser when the check is done.

**Measure the floor before believing a diff, and know what decides it.** Capture one _unchanged_
build twice: what comes back is the instrument rather than the change. **The floor is how much of a
frame is a function of something other than the time it was asked for.**

- These scenes mount synchronously and sample state from a clock, so two runs differ in **zero
  pixels of 921,600**.
- **That zero is WebGPU's; WebGL2's floor on the same scenes is not zero.** Measured 2026-08-25 on
  two captures of one unchanged build: `gilded-chamber` 189 pixels, `night-court` 119, `wind-field`
  109, `storm-sea` 65, `day-clock` 51, `showroom` and `collapse` 0 — at mean deltas up to 56, so
  they are a few score pixels moving a long way rather than a wash. The two backends have opposite
  patterns, which is the tell that it is the instrument. **So a WebGL2 diff under about 200 pixels
  on these scenes says nothing**, and a change that has to prove it moved nothing proves it on
  WebGPU or against a same-build pair from the same run.
- A game _integrates_: its state is the accumulation of every frame before it, so its floor is real
  and differs per shot. Measured on one unchanged build, the same shot came back at **369, 5,739 and
  86** across three pairs.

So a held clock is worth what determinism the page does not already have. An app that can be asked
for frame N by number gains nothing from one; a game gains the difference between 12,023 changed
pixels and 369.

**A dev server left running serves a stale transform, behind an HTTP 200 — hard rule (2026-08-25).**
A Vite server up for hours can hand back a module that does not match the file on disk. It answers
200, the page loads, the capture succeeds, and the numbers are about code that is not being run.
Measured: a server started before a session's edits served a renderer with **none** of them in it,
and a full round of captures was read as evidence that a fix had not worked. So **restart the server
after editing engine source, and prove what is being served**:

```sh
curl -s "http://localhost:5202/@fs/$PWD/packages/core/src/render/backend/webgpu/renderer.ts" \
  | grep -c "a string from your diff"
```

That is the same rule as verifying a deploy by its content rather than by its asset hash, one layer
down, and it fails the same way: silently, in the direction that looks like a working measurement.

### An instrument that reports success on an empty input is the worst kind — hard rule (2026-09-20)

**`diff` prints "identical" when it compared nothing.** Check the PNGs exist before believing a
green diff, and pass the same `--scenes=` to both halves of a comparison — `diff` takes it as well
as `capture` does. Generally: **before believing a green instrument, check it consumed anything.**

**A knob that does nothing looks exactly like a feature that is not the cause.** Run a flag against
a page that exercises it before believing a sweep: one point-shadow switch moves 4,803 pixels of the
page built for it and none at all of a scene with no point shadows.

**The harness keeps calling `frame` after a hold**, with the clock stopped — several hundred times
in the seconds a capture waits — so a capture labelled by its hold photographed a much later frame.
Two builds matching under that arrangement can be luck. And **`hold` inside `--query` is ignored**
when the scene URL already carries one, because `URLSearchParams.get` returns the first; use
`--hold=`.

**Stop a dev server in a call of its own.** `pkill -f 'vite demo/dev'` matches any shell whose
command line holds that text, including the one about to restart it. Use a bracket form, or a
separate call.

**This repository's shell does not split an unquoted variable into words**, so a counting loop over
one silently iterates once. Run such loops under `bash -c`.

### What only a person at the machine can find — hard rule (2026-09-20)

**Seven defects were found in one day by running the product, and every gate here was green for all
of them.** Two of the seven the gates actively confirmed as _working_, because the fixture and the
code were written from the same wrong assumption. The general rule this leaves behind:

> **A gate tests what somebody thought to assert, through a fixture somebody wrote. Where the
> fixture shares the code's assumption, the gate confirms the defect.** Only running the real thing
> on real hardware breaks that symmetry.

The four worth carrying as rules of their own:

- **`false !== 0` is `true`.** A platform's types declared a key repeat as a number and it gave a
  boolean, so `(event.repeat ?? 0) !== 0` marked _every_ press a repeat — and an `InputSource`
  discards repeats. **What that looks like is half a keyboard**: a digit still switches a hotbar,
  because a press is an edge, while walking reads a level that is never set. A replayed key carried
  the number `0`, which coerces correctly, so a unit test and a full scene capture both agreed with
  the bug.
- **A handle the platform has already taken away must not take the process with it.** Closing an
  SDL window and promoting a joystick to a controller each close a handle the platform has already
  invalidated. Guard the close and free the slot either way.
- **A keyboard is not a gamepad.** A keyboard exposes a second HID endpoint for its media keys and
  SDL lists it among the joysticks. The rule is what a pad can be **steered** with — no axes _and_
  no hats — rather than a name or a vendor, which would be a list to maintain forever.
- **An instrument can fail to see what it was built to find.** A key probe that polled on a timer
  and printed only while a key was held could never show a tapped key, which reads exactly like the
  engine not receiving one. **Check the instrument before believing it**, and before saying
  "cannot reproduce", say what the instrument can actually see — a readback is not a screen, and a
  replayed event is not a delivered one.

**Never drive the maintainer's real pointer or keyboard to test something.** Replay through the
host's own door — `HostWindow.replay`, `--click=`, `--drag=` — and prove it with held captures.
`xdotool` once pressed and dragged on the desktop because it found no window.

**And typecheck with `npm run typecheck`, never `tsc -p .` alone**: the native host and
`demo/native` are only in `tsconfig.scripts.json`.

### A control has to separate the two states it is testing

**A negative needs a positive control, and the control needs to be the right one.** Both halves have
failed here, and the second is worth writing down because it produces a _green_ result rather than a
confusing one.

- **The control that could not tell the two apart.** A reflection probe was verified by comparing a
  matte sphere against a polished one. That separates _reflective_ from _not_, which was never in
  doubt; it cannot separate a baked cube from the sky-and-ground gradient the shader falls back to,
  and those look alike. The comparison would have passed with the bake completely broken. **Turn the
  one thing under test on and off, and nothing else.**
- **The toggle that could never have moved a pixel.** `askedQuality`'s `positive()` discards anything
  not above zero, so `?ao=0` is thrown away with a warning. Two captures went on probes that could
  not have shown anything.
- **The zero that was correct.** `?blur=1` moves _exactly zero pixels_ on both backends, because the
  two-capture gate freezes the clock, a frozen clock freezes the camera, and camera motion blur has
  nothing to reproject. **Distrust an exact zero until you know which kind it is.**
- **The limit that was not the limit.** An environment probe was said to be blocked by a device
  ceiling. Two ceilings were read as one: the sampled-texture limit is a _default_ a device can raise
  and `select.ts` already does; only the sampler limit was hardware. Ask the adapter and the device
  separately, and use a fresh adapter to ask twice — one is consumed by the device it creates, which
  the first attempt read as a refusal.

## Repository layout

**This block described a single package until 2026-08-26**, which it had not been since 2.0.0 split
the tree in April of this repository's life — and it named three documents that do not exist. It is
the first thing an agent reads, so a wrong map here costs more than a wrong map anywhere else.

```
packages/           Twenty-two engine packages, all on the engine's version line.
  core/             The runtime: loop, RNG, storage, input, geometry, cameras, renderer,
                    scene graph and culling. Barrel at src/index.ts, the public surface.
                    Re-exports @driftengine/physics wholesale.
  core/src/render/  The only place raw WebGL or WebGPU is allowed.
  core/src/render/backend/
                    The two backends and the surface they both implement. api.ts is that
                    surface, createRenderer.ts picks one, select.ts and probe.ts decide
                    which and whether it can be trusted. Neither is "the" renderer.
  core/src/render/frame/
                    The graph's pure half: the recording arena, the resource table, the
                    scheduler and the replay. Imports neither backend, which is what lets
                    the scheduling be proven by assertion rather than by a picture.
  core/scripts/     browser.mjs, cdp.mjs, png.mjs, frames.mjs, heldClock.mjs — the visual
                    gate's modules, here because consumers import them as
                    @driftengine/core/scripts/*.mjs and that path has to resolve.
  core/CHANGELOG.json
                    The release notes, read at build time by every consumer.
  physics/          Collision and dynamics. Imports no other engine package; core depends
                    on it, which is the one place that arrow runs backwards.
  chemistry/ drft/ entities/
                    The other three that import nothing: thermochemistry of bulk matter,
                    the container format, and the entity model.
  animation/ assets/ audio/ media/ splats/ ai/ package/ nav/ network/ terrain/ texture/
  tools/ ui2d/ xr/ editor/
                    Optional packages, each taking core as a peer.
  native-host/      The engine on a native window: Node, Dawn and SDL, with the page a game
                    expects around its canvas. A host, like package/'s Electron shell, so
                    platform code is what it is; the packager loads it for the native target.
  script/           Where the engine describes itself to DriftScript. The only place the
                    two are coupled, and the coupling crosses as data.
scripts/            Tooling a person or an agent runs, never a game. changelog.mjs writes
                    release notes; bake.ts and drft-diff.ts are the asset pipeline's;
                    shots.mjs is the visual gate; determinism.test.mjs is the physics one.
examples/           Small runnable programs, one capability each — `npm run examples`.
demo/               Scenes that prove something about the engine — `npm run demo`.
  native/           The same scenes on the native host, and its pixel gate against Chrome —
                    `npm run native:scene -- <id>`, `npm run native:gate`.
docs/               ARCHITECTURE.md, CAPABILITIES.md, ROADMAP.md, FORMAT.md, HANDBOOK.md,
                    RENDERING.md, IMPROVEMENTS.md, PORTING.md, SHIPPING.md — one job each,
                    listed with that job in docs/README.md. Plus corpus/.
```

Only `AGENTS.md`, `README.md`, `CONTRIBUTING.md`, `CREDITS.md`, `SECURITY.md`, `LICENSE` and
`NOTICE` belong at
the root; those are read
by tooling or are the first thing a stranger opens. Everything else that is prose goes in `docs/`.
**`CHANGELOG.json` is not among them** — it lives at `packages/core/`, where the package it
describes is, and `packages/core/scripts/releases.mjs` is what every consumer reads it through.

There is no `engine/` directory level: this repository _is_ the engine.

## Start from an example, not from the demos

**When writing code against the engine — or answering a question about how to use it — read
`examples/` first.** Six small programs, one subject each, all typechecked by `npm run typecheck` and
served by `npm run examples`.

| Want                                             | Read                                                              |
| ------------------------------------------------ | ----------------------------------------------------------------- |
| The shape of any program at all                  | `examples/starter/` — canvas, renderer, fixed-step loop, one mesh |
| A complete game loop with state, input and a HUD | `examples/game-2d/`                                               |
| Ambient occlusion, bloom, tone mapping           | `examples/postprocess/`                                           |
| Multisampling                                    | `examples/antialiasing/`                                          |
| Screen-space panels and text                     | `examples/overlay-text/`                                          |
| Strokes and polylines in the world               | `examples/lines/`                                                 |

`demo/` is not a substitute. Those scenes exist to _prove_ something about the engine — a partition
that prunes, a pass that contributes, a governor that holds a budget — and the smallest is a thousand
lines. They are evidence, not instruction.

Four rules examples exist to demonstrate, and that engine-facing advice must respect:

1. **Only the barrel.** `@driftengine/core` is the whole public surface. Advice reaching into
   `packages/core/src/…` is advice a consumer cannot follow.
2. **Nothing allocates per frame.** Size buffers once, rewrite in place, reuse nodes.
3. **Interpolate on `alpha`.** The simulation is fixed-step and the display is not; anything that
   moves and ignores `alpha` judders on most refresh rates.
4. **Quality options are construction-time.** `bloom`, `ambientOcclusion`, `sceneSamples`, `hdrScene`
   and the rest are chosen when the renderer is built. Only `setBloom`, `setCameraMotionBlur` and
   `setOutputExposure` move within a frame.

Two traps that look like engine bugs and are not:

- **Emissive is gated on `nightFactor`.** The shader multiplies emissive by exactly that, so a lamp
  in an environment with `nightFactor: 0` emits nothing however high its own emissive value, and
  bloom then finds nothing above its threshold.
- **A fixed clip-space z is written at the end of the buffer this engine reverses.** `REVERSED_DEPTH`
  is on, so the far plane is **0** and the compare is `greater`; a shader that writes `1.0` because
  that is the conventional far plane is writing the _near_ plane. The sky did it and painted over
  the world, which is loud, and `glslFarDepth` exists because of it. The inset's clearing quad did
  it and painted over nothing, which is a black box on a menu: with `depthCompare: 'always'` and
  depth writes on it stamped the near plane across the rectangle, and every mesh drawn between
  `beginInset` and `endInset` failed the test. Read the end off `depthConvention.ts`.

**One that was in this list and is not true**: _overlays drawn after `endFrame` vanish on WebGPU_.
They do not. `openPass` opens an overlay pass against the presented swap view, with its own depth
texture, precisely so a consumer can draw its interface after the present and escape the
screen-space chain — measured on the demo above, where text and an inset both land under `?after=1`
on both backends. The note outlived whatever made it true, and while it stood it gave the inset bug
above a sanctioned explanation: the box was blank, the game drew it after `endFrame`, and the
documented answer said that was expected. A stale "known issue" is worse than no note.

## How a consumer consumes this

**Ordinarily from the registry**, one package at a time:

```sh
npm install @driftengine/core
```

`main`, `types` and the default `exports` condition all resolve to `dist` — compiled JavaScript with
declarations beside it — so this works whatever the consumer's bundler does with TypeScript in
`node_modules`. `npm run build` emits that with `rewriteRelativeImportExtensions`, a type strip with
no code generation in it, and the build config is a separate file precisely so the fast gate never
emits. `npm run cleanroom` proves the result imports under plain Node from a real tarball.

**A module started by URL is not an import, so `tsc` does not see it** (2026-09-19). The published
physics build started its island worker from `new URL('./islandWorker.ts', import.meta.url)` beside
a `dist` holding only `islandWorker.js`, and the native host's hand-written `workerScope.mjs` was not
in its `dist` at all — both invisible from the workspace, which resolves source, and found only by
packaging a game from the build. `scripts/emitModules.mjs` now renames such URLs and copies such
modules after `tsc`, and the clean room checks every module a tarball names by URL is in it.

**A path dependency is the other arrangement, and it is for developing the engine**, not for
shipping against it:

```json
"dependencies": { "@driftengine/core": "file:../../driftengine" }
```

npm symlinks `node_modules/@driftengine/core` at the working tree, and a consumer that also names
the **`drift-source` condition** resolves `src/index.ts` rather than the build — so an engine edit
is live in that consumer the moment it is saved, with no publish and no version bump per
experiment. In Vite:

```js
import { defaultClientConditions, defineConfig } from 'vite';

export default defineConfig({
  resolve: { conditions: ['drift-source', ...defaultClientConditions] },
});
```

Spread rather than replaced: `resolve.conditions` overrides Vite's defaults instead of extending
them. **Node cannot read the source** and does not have to — it refuses to strip types anywhere
under `node_modules`, which is why the default is the build.

- **Nothing inside `packages/core` may import `@driftengine/core` by name**, including its tests. It
  is that package's own name; there it resolves only by accident when a workspace symlink happens to
  exist. Use relative imports. **A sibling package is the opposite case and does use the name** —
  `assets`, `media` and `drft` each import types that way and declare it as a peer dependency, which
  is what makes the range in the manifest load-bearing.
- **The barrel is the contract.** A game reaches a package's code only through that package's
  `src/index.ts`. Anything not exported there is private, whatever its file permissions suggest.
- **`src/build/` is the exception, and the only one.** It holds code a consumer's _bundler_ runs
  rather than code its game runs. Nothing under `src/` may import it, and importing it into a game's
  runtime would ship a build tool to a player. What belongs there has to be true of _any_ consumer's
  build; if it needs to know what the game is, it is the game's.

## Module rules

- One module = one responsibility, stated in a header comment. If you can't name
  the responsibility in one sentence, split the module.
- Guideline ceiling: ~250 lines per file. Approaching it is a smell; blowing past
  it needs a reason in the commit description.
- Named exports only, no `default`. No barrels except the public one.
- Classes only for stateful, long-lived things (GPU resources, controllers, input
  sources). Everything else is plain functions over plain data. Functional style
  is welcome where it stays allocation-free and readable — never
  `.map().filter()` chains in per-frame code.
- No dead code, no speculative abstractions. A system lands in the milestone that
  needs it, not before.

## Performance rules (hot path = anything called per frame or per sim tick)

- **Zero allocations in hot paths.** Preallocate scratch objects/vectors at
  module scope; mutate in place; drain accumulators into caller-owned objects. No
  closures created per frame, no spread, no array literals, no string building.
- **Zero DOM reads/writes in hot paths.**
- Bulk data lives in typed arrays. Static geometry is merged at build time — a
  whole world should be a single draw call until profiling says otherwise.
- Budgets the engine must leave room for: 60 fps on a mid-range Android phone
  (hard gate), < 10 MB gzipped initial payload, no GC pauses attributable to us,
  and a draw-call figure that is a **band rather than a number**.

  **This line said `< 100 draw calls` until 2026-09-01, and it had been wrong for
  as long as anybody was using the engine.** A production game measures
  **744 draws in its worst world frame** and has since its world existed, so the
  budget was not a target anyone was holding to — it was a number a reader would
  either design around needlessly or, correctly, ignore, which is the failure this
  file opens by describing. Roughly: **1,000–2,000** for a high-refresh target,
  **2,000–10,000** for ordinary 60 fps, and far past that where the draws are
  instanced. `MAX_DRAWS_PER_FRAME` is 4,096 and is a ring size rather than an
  opinion; it is sized so that a consumer inside those bands never meets it.

  **The number to hold down is material changes, not draws.** A slot of the frame's
  material ring is spent per _change_, and it is the ring whose overflow is silent —
  every draw after it reuses the last material set. `drawInstanced` is the answer
  when the same mesh repeats: many copies, one draw, and one material slot.

- Measure before micro-optimizing (`performance.mark`), but _design_
  data-oriented from the start — retrofitting is what we don't do.

### A release note is written twice, in one place — hard rule (2026-08-08)

**Every changelog entry carries `text` and `short`.** `text` is the full prose the public release
pages show; `short` is one sentence and is what a game's menu shows. Both live in the same entry in
`packages/core/CHANGELOG.json`, because two files would be two things to keep in sync and the first
edit to one would end that.

A game's panel is a scanning surface over a running world and links to the page carrying the whole
thing, so brevity there costs a reader nothing. `text` is where the detail belongs, technical detail
included: those pages are indexed, and the engine's history is a reason people arrive at the site.

**The consumer enforces it** — `game/src/version.test.ts`: a `short` must be trimmed, non-empty, at
most **200 characters**, and shorter than the `text` it summarises. Required on every entry dated
**2026-08-08 or later**; the 177 entries written before the field existed are grandfathered.

**Nothing to republish, as of 2026-08-24.** `CHANGELOG.json` here is the source of truth and every
consumer reads it directly at build time, through `packages/core/scripts/releases.mjs` — so the
ordering is one implementation rather than four. **A product's history is ordered by version and
never by date**, because a date is metadata that can be wrong and a version cannot. That was a real
bug: 2.5.0 listed above 2.6.0 on a date somebody had guessed.

Two habits worth keeping:

- **A demo scene is not a release note.** What a scene does with a feature is a decision about that
  scene. A reader deciding whether to upgrade does not care which of our own scenes uses it.
- **Check an entry against the code before it ships, not against the commit message that produced
  it.** Three versions were minted in one day here and two described work reverted the same
  afternoon, because the entries were written from intent at the time.

**The asset pipeline's exemption is over, and this is the only place that records it.** For the whole
of its construction nothing in `.drft`, the readers, the baker or the showroom took a version bump or
a changelog entry, because shipping it a fragment at a time would have announced an importer that
imports without materials and a format not yet frozen. It went out as one release in **0.12.0**, so
anything added to it now is an ordinary change and follows the rule above.

### A version bump is eighty-four places, not two — hard rule (2026-08-08, widened 2026-09-20)

**Never bump one without the others.** A release moves `version` in **twenty-four manifests** —
the workspace root and each of the twenty-three engine packages — the **fifty-nine internal
`@driftengine/*` ranges** that pin them to each other, and **`package-lock.json`**, and writes
`CHANGELOG.json` in the same commit.

**Raised again 2026-09-03 by `@driftengine/ui2d`** — one manifest and _two_ ranges, its own peer on
core and `@driftengine/script`'s peer on it — to sixteen and twenty-six. Counted with the snippet
below rather than read off the previous sentence, which is the only reason it is right.

**And again the same day by `@driftengine/editor`, to seventeen and thirty.** One manifest and
_four_ ranges: three peers of its own — core, entities and ui2d — and `@driftengine/script`'s peer on
it. That is the seventh time this number has moved and the third time a _peer_ rather than a package
was the reason, which is the pattern worth keeping: a peer dependency is invisible in every count
anybody does by eye.

**And an eighth time, the same day again, by `@driftengine/network`, to eighteen and thirty-three.**
One manifest and _three_ ranges: a peer on `@driftengine/entities`, `@driftengine/script`'s peer on
it, and a **devDependency** on `@driftengine/core` — test-only, declared so the package can import
core's reproducible transcendentals in a test while importing nothing but entities at run time. That
last one is a new shape of invisible: not a peer this time, but an entry in a field nobody scans
when they are looking for versions.

**And an eleventh time, 2026-09-20 — by a workspace that had been there all along.** The count
walked `packages/*` and the root, and `editor` is a workspace too: the editor application, with a
version of its own and **seven `@driftengine/*` ranges pinned exactly**, none of them counted here
or checked by `scripts/version.test.mjs`. A release moving the eighty-five places this paragraph
knew about would have left the editor asking the registry for an engine version nobody published —
**the exact failure this paragraph opens by describing, sitting inside the instrument written to
catch it.** So: **twenty-five manifests, sixty-nine ranges and the lockfile, ninety-five places**,
and it was sixty-seven ranges in this same paragraph until 2026-09-20, when the snippet was run
before a release and answered two more — **a twelfth staleness, found by counting rather than by
anything failing**,
and the snippet below and the gate both read `workspaces` now rather than a list, so the next
workspace is counted the day it is added.

**And a tenth time, 2026-09-20, by a range with no package behind it**: `@driftengine/drft` took a
**devDependency** on `@driftengine/entities`, so that the `ENTS` chunk's structural agreement with
`SerializedScene` is asserted by a test rather than by review — twenty-four manifests and sixty
ranges, **eighty-five places**. Nothing new appears in `packages/` for it, which is the shape of
drift this paragraph is worst at.

**And a ninth time, 2026-09-19, by `@driftengine/native-host`, to twenty-three and fifty-three —
and the number was already stale by four manifests and fifteen ranges before it.** `nav`, `texture`,
`tools` and `xr` had landed underneath "eighteen and thirty-three", with the peers others grew on
them, and neither this paragraph nor the floors moved, so the truth was twenty-two and forty-eight
when the host added one manifest and five ranges: its peers on core, the packager, texture and ui2d,
and a devDependency on audio for a test. The packager names no range back, because that would be a
build cycle; it resolves the host from the game's own tree and refuses one at another version. Four
packages in a row shipped without anybody running the snippet below, which is the finding: the rule
is only as good as the habit of counting at the commit that adds.

**And a tenth, the same day, by `@driftengine/capture`, to twenty-four and fifty-five** — one
manifest and its two peers, on core and texture — counted with the snippet in the commit that
created the package, the first of five to be.

**This number has been stale six times, and the sixth ran for a whole release.** It said ten and
thirteen against eleven and sixteen; corrected to eleven and sixteen it was already wrong, because
the truth was **twelve and nineteen**; corrected again to fourteen and twenty it was right for a day,
and then `@driftengine/script` grew a `chemistry` peer range when Track P bound `drift/chemistry` and
the truth became **fourteen and twenty-one**. Then 3.38.0 shipped `@driftengine/terrain` — one
manifest and _three_ ranges — and corrected neither this paragraph nor the floors, so the truth was
**fifteen and twenty-four** for an entire version while everything stayed green. The floors in
`scripts/version.test.mjs` carried the same slack every time, which is why a floor cannot be the only
instrument: **it passes at the true number and at every stale one below it.**

**The commit that adds a _range_ is as much a correction to this paragraph as one that adds a
package**, and that is the lesson of the fifth: a peer dependency is invisible in every count anybody
does by eye.

**So count, do not read.** This paragraph has said so since 2026-08-08 and was itself wrong twice
while saying it:

```sh
node --input-type=module -e '
import { readFileSync, readdirSync } from "node:fs";
const read = (f) => JSON.parse(readFileSync(f, "utf8"));
const files = ["package.json"];
for (const pattern of read("package.json").workspaces ?? []) {
  if (!pattern.endsWith("/*")) { files.push(`${pattern}/package.json`); continue; }
  const dir = pattern.slice(0, -2);
  files.push(...readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => `${dir}/${e.name}/package.json`));
}
const engine = files;
const ranges = files.flatMap((f) => {
  const m = read(f);
  return ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]
    .flatMap((k) => Object.keys(m[k] ?? {}))
    .filter((n) => n.startsWith("@driftengine/"));
});
console.log(engine.length, "manifests,", ranges.length, "ranges,", engine.length + ranges.length + 1, "places");
'
```

**The ranges are the half that is invisible locally.** Every package is a workspace link, so a range
left at the previous version is green through `npm test`, `npm run typecheck` and every capture —
nothing resolves it. It fails the first time anybody runs `npm install` on a machine with no
workspace built, where npm goes to the registry and gets a **404 for a package that has never been
published**. The error names the registry rather than the bump, so it reads as infrastructure.
2.4.1 shipped exactly that way: six manifests moved, five ranges left behind, red in a consumer's CI
within the hour.

**The lockfile is the last of them and had been stale since 2.10.0.** `npm ci` tolerates a workspace
whose recorded version is old; what it does _not_ tolerate is a workspace it has never heard of, so
adding `@driftengine/splats` turned five releases of drift into a red CI with an error about a
missing package. `npm install --package-lock-only` writes it, and the diff should contain nothing but
workspace versions and any package genuinely added. **Run `npm ci` before pushing a release** — it is
the one command that reads the lockfile the way CI does.

**A tenth time, 2026-09-20, by `@driftengine/capture` — and for once by a package that already
existed.** The package landed earlier in the wave with two peers, and both halves were corrected
with it. What moved the number again is a _capability inside it_: the Gaussian fit's output **is**
`@driftengine/splats`' `SplatSource`, so that is a peer, and the test that loads a fit through the
container is a devDependency on `@driftengine/drft`. Twenty-four and fifty-seven.

**Which is the shape worth adding to the nine above.** Every previous entry was a new package
carrying ranges in with it, and a reader could come away thinking the count only moves when
`packages/` grows. It moves whenever a package reaches for another one — and the commit that
writes the import is the commit that owes the count, whether or not anything was created.

**And twice more the same day, by the same package**, which is what that paragraph predicts: the
surface work gave `@driftengine/capture` a peer on `@driftengine/drft` for `MeshData` (its
devDependency for the round trip became a real one), and the collision work gave it peers on
`@driftengine/physics` and `@driftengine/nav`. Twenty-four and fifty-nine. A package that is being
built reaches for a new neighbour every few days, and each time is a correction here.

**The commit that adds a package or a range is the commit that corrects this paragraph and raises the floors.**
A package once moved to 0.7.1 with no changelog entry, leaving a consumer failing on its engine
half until somebody traced it back and wrote the entry after the fact, from the commit message,
having not made the change.

### A release is tagged, and the tag is what a reader arrives at — hard rule (2026-09-13)

**`v<version>`, annotated, on the commit that bumped it**, pushed, and then a GitHub release whose
body is `npm run changelog`. That script exists for this and says so in its own header: a release
body is a `>` away. Using it is what stops the notes and the version the build reports from
disagreeing, because both read `CHANGELOG.json`.

**Why this became a rule only now.** Until this repository was published there were no tags at all,
in any copy of it, and nothing needed one — a consumer took a path dependency and read the source.
A published package changes that. `npm install @driftengine/core@3.61.0` hands somebody the code
and no way to see what changed or which commit produced it, and a release attached weeks later
cannot point at a commit that was never marked. The tag is the only thing that answers both.

`v3.61.0` is the first and sets the shape: the `v` prefix, annotated rather than lightweight so the
tag carries its own message and date, and one tag per release rather than one per tranche — which
is the cadence rule below, applied to the thing a stranger sees.

### A capability that lands unbound is a capability DriftScript cannot reach (2026-08-25)

**When a track ships, bind it.** `@driftengine/script` is where this engine describes itself to
DriftScript, and a subsystem not described there is one a consumer can call from TypeScript and not
from a script.

**Nothing fails when a binding is missed**, which is the whole reason this is a rule. The linker
refuses an unbound module by name and says which track it waits on — so a script author hits a
refusal that reads exactly like a track that has not shipped, and concludes it has not. The
capability exists, is finished, is tested, and is unreachable.

The five steps are written at the top of `packages/script/src/host.ts`, beside the code that does
them: describe it, implement it, add the module to `ENGINE_MODULES`, check whether an optional
parameter must become required at the language boundary, and correct the two tables that must agree —
`docs/CAPABILITIES.md` and the list `driftscript/compiler` exports as `UNSHIPPED_MODULES`, which
`scripts/docs.test.mjs` compares.

**And regenerate `packages/script/capabilities.json` in the same commit** — `npm run capabilities`,
gated by `capabilities:check`. That file is what the language server reads, because it cannot read
the registry: engine packages use extensionless relative imports, which a bundler resolves and Node
does not. Left stale, an editor completes and greys against a previous commit's capabilities — a
completion list that lies about the target.

**Step four is the one worth reading twice.** A TypeScript signature may make a parameter optional
because its caller has the context to know when to pass it. A script author is further from the
subsystem, meets the trap first, and gets a wrong _result_ rather than an error. Where that is true,
the binding requires the parameter and says why. `bindings/animation.ts` is the worked example; Track
B added two more — a raycast's layer mask, and an impulse's application point, which through the
centre of mass produces no rotation at all.

A binding is a table entry and a lookup. If one needs the engine to grow a function, that function
belongs in the package that owns the subsystem.

### Relative imports may name the `.ts` file, and the reason changed owner (2026-08-27)

**`allowImportingTsExtensions` arrived for `driftscript` and stayed for a different reason.** That
package shipped its TypeScript source and its Vite plugin is loaded by Node, whose ESM resolver
requires an extension — so every relative import in it named the file. `driftscript` is a published
dependency now, ships compiled JavaScript with declarations, and asks nothing of this repository's
configuration.

**What keeps the flag is that four packages here adopted the convention while it was set.** `ai`,
`chemistry`, `entities` and `script` write the extension on 714 relative imports between them.
Removing it is a rename across those files, not a config change, and it is worth doing deliberately
or not at all.

It only _permits_ the extension, so a package that omits one is untouched. Both tsconfigs set it.

**The constraint that went with it is gone.** `driftscript` also had to avoid TypeScript syntax
needing code generation, because Node loads `.ts` by stripping types. Nothing here is loaded that
way, so `enum` and `namespace` cost nothing now — they are still a bad idea, for the ordinary
reasons, and no longer a hard error.

### A bundler config is Node, so it cannot import this engine — hard rule (2026-08-26)

**`import { engineRegistry } from '@driftengine/script'` inside a `vite.config.ts` fails**, with
`ERR_MODULE_NOT_FOUND`. Every engine package but `@driftengine/entities` and `@driftengine/physics`
uses extensionless relative imports, which a bundler resolves and Node does not — and a bundler
_config_ is loaded by Node before any bundler exists.

`driftscript` itself is now the exception that proves the rule: it ships compiled JavaScript, so a
consumer's `vite.config.ts` _can_ import it, which is how `registerStd` in a config works.

**This shipped as documentation telling consumers to do the impossible.** The Vite plugin's
`registry` option said passing one "for this engine is one import". It is not, and the failure was
silent in the direction that matters: a build with no registry infers no effects and refuses no
unprovided module, so **`@deterministic` was decoration in every real consumer's build**.

**The mechanism to avoid it already existed and is the general answer.** A registry _describes and
never invokes_, so nothing in a definition is a function and all of it survives a process boundary.
`packages/script/capabilities.json` is that data, and the plugin takes it:

```ts
driftScript({
  capabilities: fileURLToPath(import.meta.resolve('@driftengine/script/capabilities.json')),
  manifest: { name: 'my-game', provides: ['drift/ecs'] },
});
```

So: **anything a consumer's toolchain must reach crosses as data, or lives in a package whose imports
name a `.ts` file.** Before adding an option that takes an engine object, ask which of the two it is
— and if the answer is "they import it in their config", it is neither.

### Vite finds `import.meta.hot.accept` by reading source, not by running it (2026-08-25)

**Spell the call out.** Vite scans for a literal `import.meta.hot.accept(` to build its HMR graph.
Reading the handle into a local and calling `hot?.accept('./x', …)` runs perfectly, is invisible to
that scan, and makes the module look as though it accepts nothing — so an edit propagates to the root
with no accepting module and Vite falls back to a **full page reload**. The page still works, which
is why this survives review: the failure is that state is destroyed on every edit, which is the one
thing hot reload exists to prevent. The same rule governs `import.meta.glob`.

### The language is a published dependency, pinned exactly (2026-08-27)

`driftscript` and `driftscript-language` used to live in `packages/` on their own version line. They
are MIT packages on npm now, with their own repository, and this engine pins `driftscript` like any
other dependency — **exactly, at a version this repository does not own**.

**Three manifests carry that pin**: the workspace root, because `scripts/capabilities.ts` imports
`serializeRegistry` and a package that imports something declares it; `@driftengine/script`, which
describes this engine to the language; and `@driftengine/entities`, which takes `Schema` and
`migrate` — 406 bytes gzipped — because one description of a component is the spine of the entity
model and a second one can drift from it.

**They have to agree with each other, and the reason is sharper than tidiness.** npm resolves two
copies of `driftscript` into one tree when two manifests disagree, and `entities` and `script` are
then compiling against different definitions of the same type. Both succeed. Nothing fails until a
component round-trips through storage and comes back not equal to itself.

**An engine release does not move that pin.** That is the old two-line rule surviving the mechanism
that used to enforce it: a release that bumped every version it found would drag the language's along
and pin something nobody published. `scripts/version.test.mjs` asserts the pins agree, that they are
exact rather than a caret, that they are _not_ the engine's version, and that the installed tree
matches — because a pin nothing installed is a pin npm quietly resolved to something else.

**An exact pin rather than a caret is the language's decision, not ours.** `driftscript` and
`driftscript-language` ship as one release in a fixed order so that the compiler and the language
server are the same code, and a caret gives that up on a consumer's machine without telling them.

To take a new language version: change the three pins, `npm install`, run the suite. A language
change that alters a diagnostic's wording will break a test here — `packages/script/src/host.test.ts`
asserts one — and that is the seam working rather than a problem.

**A consumer that compiles `.drs` carries a fourth pin, and moving these three obliges it to move
in the same step** (2026-08-28). The engine describes itself to the language, so a consumer's
compiler reads a registry this engine filled; if the two are different versions, the older compiler
is handed capabilities it has no types for. A consumer pinned 1.4.0 while the symlinked engine
resolved 1.5.0, npm installed both, and every `.drs` file came back `DS0237`, "`float` is not a type
this host registered". Nothing here was red, and nothing there was either until the build: a
consumer's `tsc` does not compile `.drs`, only its bundler does, so a typecheck and a full suite
both pass over it. **`driftengine.dev` is the fifth**, where the compiler is bundled into the
playground while every page around it is generated from the language checkout — the site documented
a keyword its own playground rejected. Both now assert their pin against the engine's; the two
places that could still get this wrong are a new consumer and a vendored copy.

### One release a session, not one a tranche — hard rule (2026-08-24)

**Sixteen releases of 2.x in three days, eleven of them on one day.** Every one added real public
surface, so none was empty, but the _cadence_ was wrong and the owner noticed before anybody else:
"we didn't introduce a lot and from 2.0.0 we are already at 2.9.0".

**What caused it.** A release was cut after every finished tranche because that was how work reached
consumers: the notes had to be republished from another repository. That friction is gone.

**The rule.** At most one release per working session, carrying everything that session finished. A
**minor** where public surface was added or its behaviour changed; a **patch** where nothing a
consumer can name is different. A version number is quoted in bug reports and compared across
machines, and sixteen in a week makes every one of those conversations harder.

**What would make this wrong**: a consumer blocked on a fix. Ship it, then.

### Identify the object before explaining it — hard rule (2026-08-10)

**When something on screen looks wrong, the first move is to establish _which draw call puts those
pixels there_, by switching draws off one at a time until they disappear. Not after a theory. Before
one.**

A report of "one bird in the flock is giant" cost most of a session. Five explanations were produced,
each measured, each internally sound, and each about the flock: a wingspan out by a factor of two, an
orbit hash with a fixed point at zero, wings flat at the bottom of every stroke, a single card
foreshortening, a body card too deep. Two were real bugs and were kept. **None was the thing being
reported.** The shape was the lighthouse beam — ninety metres long, sweeping a full turn every nine
seconds, passing over the camera, crossing the flock.

Every wrong step came from the same root: the object was named from what it looked like and sat near,
and everything after that explained an object that was not there. Measurement did not save it,
because measuring the flock very carefully tells you nothing when the artefact is not the flock. **A
precise answer to the wrong question reads exactly like progress.**

What settled it in one step: set the flock to four birds. The frame showed five shapes.

- **Isolate by elimination, and do it first.** A per-system switch and one screenshot each costs
  minutes. Every theory built before that is a theory about an unidentified object.
- **Count what should be countable.** If a system draws N things, make it draw a small N and count.
- **Two draws vanishing together does not mean one causes the other.** Hold the frame, change one
  thing, diff the two images.
- **Take the reporter's words as evidence about pixels, not about objects.** "A bird" is where it was
  and what it resembled.
- **When a fix does not move the artefact, stop fixing and re-identify.** Changing the wing outline
  changed every bird and left the shape untouched — proof it was not built from those vertices, and
  available two steps before it was used.

### A comment that states a choice must state its cost — hard rule (2026-08-11)

**When a comment explains a decision, say what it gives up and what would change it.** A comment that
says only what the code does reads as settled, and a reader outside this repository will design
around it instead of telling you it is wrong.

Bloom shipped measuring brightness as luminance, which cannot pass a saturated source: a pure blue at
1.4 reads as 0.101 and would need to reach 13.8 to cross a threshold of 1. Two of a consumer's worlds
were built entirely out of coloured light and bloomed by **zero pixels**. They found it, measured it,
and reported it as _a choice with a cost_, proposing an option they explicitly declined to request —
because the prefilter's comment read as deliberate, "and a consumer who cannot see the arithmetic
reaches for an option where the answer is a fix."

The comment was not lying. It named Rec. 709 luminance and said it was what "bright" means elsewhere
in the renderer, which was true. What it never said was what that measure _cannot see_, and that
omission nearly bought a permanent configuration knob standing in for a one-word repair.

So the shape to write is: **what this does, what it gives up, and what would make it wrong.** The
third clause is the one that gets omitted and the only one that invites a correction.

### A texture sample inside a branch must not need a derivative — hard rule (2026-08-07)

**Any `texture()` call reached through control flow that is not provably uniform must be
`textureLod(..., 0.0)`** (or an explicit-gradient call) unless the texture is genuinely mipmapped and
the blur across mip levels is wanted. No exceptions without a measurement attached.

`texture()`'s implicit derivatives are only well-defined under uniform control flow, and a compiler
that cannot prove a branch uniform — one shape being a chain of `if (i == uSomeIndex[k])` over a
per-iteration variable, exactly what a fixed light budget forces when GLSL ES 3.00 has no dynamically
indexable sampler array — is free to **flatten** it: compute every arm and discard the ones not
taken. That turns "the one light that matched" into "all ten, discarded but costed", and it is
backend-specific: Vulkan/radv and ANGLE/D3D11 are not obliged to make the same call.

**This shipped for six weeks, measured 60 fps the whole time, and cost 13 ms a frame on the
reporter's stack.** `render/shaders/flat.ts`'s point-light loop called `texture()` twice inside
exactly this shape. The dev machine's driver branched it for free; ANGLE/D3D11 did not, and the
densest point-light scene paid: the main scene pass went from **17.50 ms to 4.50 ms** switching both
calls to `textureLod`, wall clock from 17.00 to 8.50 — the display's vsync interval, meaning the
frame stopped being GPU-bound at all. Bit-for-bit identical output, because those cubemaps are
allocated with one storage level and `NEAREST` both filters: there is no mip to select. The fix cost
nothing visual and was available from the first line of shader code. Nobody looked, because nothing
was measuring GPU time — the instrument itself was the first thing that had to be fixed.

**The tell, if this recurs:** disabling a supposedly expensive feature makes the frame _slower_.
That is not noise to average away — removing real work cannot cost more.

### Shaders are authored in GLSL and WGSL is generated — hard rule (2026-08-12)

**`src/render/shaders/*.ts` is the source of truth.** `src/render/shaders/generated/*.wgsl.ts` is
written by `npm run wgsl` and committed, and `npm run wgsl:check` fails when it is stale. **Never
hand-edit a generated file.**

**The direction is the safety property.** A defect in the generator can only reach the WebGPU path,
which has a fallback, and never the WebGL2 path, which does not. Authoring in WGSL and generating
GLSL would invert exactly that.

The cost is a dev-time dependency on two external tools, paid to avoid maintaining 5,599 lines of
shader source twice. **Neither tool ships and neither is importable from `src/`**: **glslang** as a
devDependency for GLSL → SPIR-V, and **naga** on PATH for SPIR-V → WGSL. Generated WGSL contains no
code from either — no injected helpers, no licence headers — so what this package ships stays MIT.
**Babylon's `twgsl` was tested and is not used**: it ships from a CDN rather than npm, so it cannot
be locked, and a freshness check is worth nothing if the thing it runs is not reproducible.

**The GLSL is rewritten before it is compiled, and every rule answers a compiler error**
(`scripts/wgsl/transform.mjs`, one test per rule). The one worth knowing: **WGSL has no combined
image sampler**, so `uniform sampler2D` splits into a `texture2D` and a `sampler` recombined at use,
and a sampler-typed function parameter becomes two. That is the language's rule rather than one
translator's gap — naga answers a combined sampler with `invalid id %NNN` and Tint, given the
identical SPIR-V, answers _"WGSL does not support combined image-samplers"_. Both were run.

The 2026-08-07 `textureLod` rule survives the toolchain, asserted rather than assumed:
`scripts/wgsl.test.mjs` compiles an explicit-level fetch inside a branch and fails if the WGSL comes
back with an implicit-derivative sample.

**Compute shaders are the one exception, and the rule's own reasons make them one (2026-08-24).**
`packages/core/src/render/backend/webgpu/shaders/*.wgsl.ts` is hand-authored and `wgsl:check` does not
police it. Both justifications fail here rather than being overridden: **there is no second copy to
avoid**, since a compute shader has no WebGL2 twin — not "not yet", the language has none; and **the
safety property inverts**, because a compute shader would be the _only_ path with nothing beneath it.
The mechanical cost corroborates: `transform.mjs` would need a third binding range, rules for
hoisting SSBO declarations it has never seen, and a workgroup declaration with no GLSL ES 3.00
equivalent — so the source would be authored in a dialect **no backend in this engine can run**.
**What would make it wrong** is a compute and a fragment shader wanting to share substantial source;
the sharing is then the thing to solve.

### A device's arithmetic is not your arithmetic — hard rule (2026-09-20)

Four rules, each of which cost a session.

- **An index lattice is integer arithmetic and has to be written as integer arithmetic.** A shader
  compiler implements a division as a multiplication by a reciprocal, so a GPU here answers **3 for
  `3.0 % 3.0`** and **0 for `floor(12.0 / 12.0)`**. Use `u32` division and `%`, which are exact.
- **A `vec3<f32>` is sixteen-byte aligned and twelve bytes long**, so an `f32` declared after one
  lands at the fourth float of that row rather than the first float of the next. **A caller that
  counts rows gets this wrong and a caller that names the field cannot.**
- **Never put a backtick or a `${...}` inside a WGSL template literal**, and avoid WGSL's reserved
  words as identifiers: `register`, `target`, `set`, `mod`, `filter`, `layout`, `pass`, `ref`,
  `self`, `type`, `use`, `with`, `of`, `new`, `meta`, `match`, `static`, `resource`, `sample`.
- **An A/B of a shader constant changes WebGL2 and not WebGPU.** The GLSL is assembled from those
  constants at runtime; the WGSL is generated and committed, so a WebGPU capture keeps drawing the
  old number until `npm run wgsl` runs. Editing the constant and capturing twice on WebGPU
  therefore compares a build with itself. **Either regenerate between the two captures, or run the
  A/B on WebGL2.**

The WebGPU defaults the GPU-driven design is built on, so a budget can be checked against them: **8
storage buffers per stage, 65,536-byte uniform bindings, 16 sampled textures and 16 samplers per
stage, 4 storage textures.**

### Two backends, one decision — hard rule (2026-08-13)

**Anything added to one backend must be reachable by the other, and anything either cannot do must
fail loudly rather than quietly.** Written after a week in which five separate defects were the same
shape: one backend was given something the other was not, and the frame that came out looked
plausible.

**1. Decisions live in backend-neutral code; only the binding is per-backend.** A helper taking a
`WebGL2RenderingContext` is a decision the other backend cannot reach, so it will be reimplemented
there, and two implementations of one rule drift. Split it: a `resolveX(..., out)` choosing the
numbers, and one thin binder per backend uploading them. `resolveAtmosphere` and `resolvePointLights`
are the worked examples. Fill a caller-owned target rather than returning an object.

**2. A missing property is silent where a missing method is loud.** `renderer.createMesh is not a
function` names itself. A missing _property_ is `undefined`, and `undefined` in arithmetic is a
picture rather than an error: `shadowMapSize` was absent from one backend, a scene divided by it, the
light matrix became NaN in all sixteen entries, and the result was a scene drawn uniformly black —
diagnosed twice, wrongly, before anybody read the value back. So **every value-typed member of the
shared surface must be answered by every backend**, and answered honestly.

**3. A capability one backend lacks degrades to a defined state, never a silent no-op.** A pass not
ported yet is an empty method with a comment naming the row that fills it, so the absence is visible
in the picture. Never a stub returning a plausible number, and never a uniform left unwritten — an
unwritten uniform is zero, and zero is a real value for most of them. `uGrain` unwritten did not
weaken grain, it switched grain off across every surface; `uEmissiveGain` pinned at 1 lit every lamp
at noon.

**4. When you add a uniform, bind it in both backends in the same change.** The shared surface catches
a missing _method_ at compile time and cannot catch a missing _uniform_ at all. The audit that finds
these is a diff of what each backend binds — and it must follow the calls out of the function, not
read the body: `bindPointLights` was invisible to exactly that audit because it is a helper.

**5. The parity gate is a floor rather than a ceiling.** Differences are counted **at a delta
threshold**, because a count including 1/255 reports an indistinguishable frame as 38% wrong; and
WebGL2 is the reference for _correctness_, not the ceiling for _quality_ — a missing step is a bug, a
better result is an explained difference and is never degraded to match.

### Capture both backends, and lead with the one consumers run — hard rule (2026-08-23)

**A rendering change is looked at on both backends or it is not looked at.** Three defects shipped on
the WebGPU path and were invisible for two sessions because every capture passed `?backend=webgl2`.
Each drew a plausible picture and none raised an error: an environment probe's mip chain sampling a
uniform buffer nobody uploaded, so a metal reflected flat colour; `beginPlanarReflection` answering
null before `beginFrame` opens an encoder, so a consumer lost its mirror every frame and read the
null as "no target"; and a mesh past `maxBufferSize` coming back invalid and taking every command
buffer that touched it.

**The two backends are a control for each other and the comparison is free.** Same scene, same frame,
two flags. A difference is a defect in one of them until something says otherwise, and that finds a
whole class — a silent no-op, a uniform never uploaded, a pass that never ran — which no test and no
single-backend capture can see. Capture the backend consumers run first, print which backend produced
a number, and distrust a healthy measurement on one as evidence about the other.

### What WebGPU rejects, and when it tells you — hard rule (2026-08-14)

**A WebGPU validation failure is reported at `finish` or at `submit`, not at the call that caused it,
and it invalidates the whole command buffer.** So the failure mode is not a wrong picture. It is _no_
picture, from a frame that recorded correctly, with the cause in a console line nobody was reading.
Two of the five defects found on the last day of the port were this one rule.

**1. A pipeline's colour target must equal its attachment's format exactly.** `PipelineCache` was
built against the swap chain's format while the world lands in the scene target under a composite.
They agreed only because this machine's `getPreferredCanvasFormat()` happens to be `rgba8unorm` — so
`hdrScene` read as six times too dark here, and **on any `bgra8unorm` device the backend drew nothing
at all under the default profile**. Nobody had a device to see that on. The format every world pass
targets is now chosen once and carried by the cache, like the sample count.

**2. A texture may not be bound while it is being written.** A probe bake writes a face of the cube
the mesh bind group still holds. Turning the uniform off is not enough on its own: a driver may fetch
a sampler's descriptor before it evaluates the arithmetic that discards the result, so the binding
has to move too.

**3. Ask the device before you measure the frame.** `createGpuSurface` listens for `uncapturederror`
and prints one line per distinct message, legible only because every resource carries a label. Read
them — a handoff for this work asserted "the capture reports no device errors" about a capture that
was reporting them in full. For a resource not built yet, a throwaway page wrapping it in
`device.pushErrorScope('validation')` answers in a minute, about _this_ machine rather than about the
specification.

## Determinism

The engine supplies the two pieces a replayable game is built on, and both are
contracts:

- **The fixed-timestep loop.** Simulation advances only in fixed `1/60` steps.
  Render code interpolates (`alpha`) and may never mutate sim state.
- **Seeded RNG sequence stability.** A silent change to the generator
  invalidates every ghost and every stored replay any consumer has saved. The
  sequence is frozen; a different distribution is a new function, never an
  edit to an existing one.

Nothing under `src/` may reach for `Date.now()`, `performance.now()` or
`Math.random()` on a path a consumer might simulate. Time is a tick count the
caller supplies. Input _sampling_ reads the clock — that is the boundary, and
intents cross it as data.

## Rendering rules

- No raw WebGL calls and no `GPUDevice` outside `packages/core/src/render/`. New GPU features
  are expressed as engine API first, and every other package draws through `registerPass`.
- **The engine ships zero image assets, and that is not the same rule it used to be.** Colour
  still comes from vertex data and procedural shaders in everything this repository publishes,
  and the six demo scenes still fetch no image of any kind — that is the payload argument and it
  is unchanged. What changed is that a _consumer's_ images are now first class: normal, ORM and
  emissive maps through `setMaterial`, an HDR environment through the loader, and a splat capture
  through `@driftengine/splats`. So the rule is about what this repository ships, not about what
  a game may hand it. Anything that would make the engine itself carry pixels still fails it.
- Shaders live in `packages/core/src/render/shaders/`, one module per program, with the
  generated WGSL beside them under `backend/webgpu/shaders/`.
- **WebGPU is the default backend and WebGL2 is the fallback beneath it**, both behind
  `RendererApi`, chosen by `createRenderer` — callers must stay agnostic. This line read
  "a WebGPU backend may be added later" for a major version after that backend shipped,
  which is the failure `docs/README.md` opens by describing: a claim nothing asserts drifts.
  WebGL2 remains the floor and is not deprecated; it is what runs where there is no usable
  device, which is still most phones.
- GPU quality controls enter through construction-time `RenderQualityOptions`.
  Resolution, shadows, water and procedural-effect detail must not grow
  independent flags or magic literals in consumer code. Changing
  allocation-sized options recreates the renderer rather than mutating a live
  hot path.

### Per-draw GPU state on WebGPU is a ring, never one resource rewritten — hard rule (2026-08-27)

**A `queue.write*` call does not interleave with the draws it sits between.** Queue writes are
ordered on the queue timeline and the frame's encoder is submitted after all of them, so one buffer
or one texture rewritten between two draws hands **both** draws its final contents. Every draw of
the frame, not the nearest one.

`UniformRing` was written for exactly this and has said so since it existed, and the engine shipped
the same defect again anyway in the one per-draw resource that was a _texture_: the joint palette. It
cost 3.6.0 through 3.13.0, and it was invisible because a single character is the case that works —
the last write is also the only write. Two characters was the first frame that could tell, and
nothing here drew one until `demo/dev/skinning.ts?pair=1`.

So: **anything a draw reads and a later draw in the same frame overwrites takes a slot of its own,
and the slots reset where the encoder is replaced.** Cache a per-slot bind group beside it, or the
ring buys correctness back with an allocation per draw. WebGL2 needs none of it, because
`texSubImage2D` and a uniform write are commands in the same stream as the draws around them — which
is what makes this a binder's problem and not a decision, per the 2026-08-13 rule.

**What it looks like when it is wrong is not the resource.** A skin palette carries a character's
placement, so the picture was every character standing in the last one's pose; a per-draw model
matrix would be every object stacked on the last one drawn. Both read as a transform bug in the
consumer's own code, which is where two sessions went looking.

### Two kinds of text, and the difference is a promise — hard rule (2026-08-16)

The engine draws text two ways, and they are not interchangeable conveniences. The **5x7 pixel font**
(`src/geometry/pixelFont.ts`) is built from bitmasks at module load: no asset, no request, no licence,
unconditionally — the glyphs live in this repository's own source and every consumer gets them free
the moment it draws text.

**SDF text is opt-in, not absent.** Parsing a metrics document and laying out quads costs nothing
until a consumer supplies an atlas; nothing in the frame loop reaches for one. So a consumer that
never calls `createSdfText` fetches no atlas, ships no font file, and the pixel font's promise stays
exactly as true as it was — that is the guarantee this feature was built to keep rather than quietly
narrow.

**Adding a face is a licence decision, taken where `scripts/sdf-font.ts` is run, not here.** The
generator rasterises whatever TTF or OTF it is pointed at; this engine never inspects, redistributes
or vendors a font. Whoever runs it has cleared that face for what they are about to ship.

### A pre-shaped run is not shaping, and a stroke is not a line primitive — hard rule (2026-08-17)

- A font may carry **pre-shaped runs**: a glyph-table key longer than one character, baked by
  `scripts/sdf-font.ts` from a whole string. The engine does no shaping, so a script that joins or
  reorders its letters cannot be assembled at draw time; it arrives already assembled, shaped by the
  platform text stack the generator drives. This is not a step toward being a shaper: a run is a
  decision taken once, at bake time, about a string somebody knew in advance.
- **A stroke is triangles, not a line primitive.** WebGL2 clamps `lineWidth` to one pixel on nearly
  every driver and WebGPU has no line width at all, so `lineBatch` expands each segment into a quad
  across the line of sight, as `boltBatch` does. The two share `segmentQuads.ts` and nothing after
  it: an arc is light arriving, so it is additive, unlit, unfogged and allowed past white; a line is
  a thing in the world, so it is blended, fogged and cleanly edged. Adding a mode flag to one to get
  the other would be a noun lying about what it draws.

### Every forward pass grades itself when nothing follows it — hard rule (2026-08-17)

`outputTransform` is a conversion, not a look, and a frame where one pass applies it and another does
not is a frame where two surfaces disagree about what a colour means. With a composite the resolve
grades and every forward pass must **not**; without one, each pass is the last thing to touch the
frame and each must grade itself. The gate is one expression, `Renderer.gradeCode` and its WebGPU
twin, and a pass uploading the transform ungated double-grades any consumer that has a composite.

`shaders/outputTransform.ts` is the single definition. Include it, call `applyOutputTransform` at the
end of the fragment stage, and upload the two uniforms from the gate. Do not copy the curve.

This was wrong for as long as the option existed, and **the reason it survived is worth more than the
fix**: the mesh pass's own comment described the state accurately, so it read as a known limitation
rather than a fault. A linear value written into an eight-bit buffer is read as a display value —
clipped and oversaturated rather than slightly different — and the only reason nobody saw it is that
the passes it applied to were additive and fogged and therefore too dim to show it. Still ungraded
without a composite, named here so nobody rediscovers them one at a time: the sky, water, scatter,
the plumes, and the pixel font.

### `dFdy` does not mean the same thing on the two backends — hard rule (2026-08-17)

A WebGL2 framebuffer counts y upward and a WebGPU one counts it downward, and the mesh shader's
WebGPU path negates clip-space y to put the same picture on screen either way. The consequence:
**`dFdy` of anything points the opposite way on the two backends**, so a screen-space term only agrees
across them if it is exactly odd in that derivative, with every sign cancelling somewhere.

Found the expensive way in `setSurfaceTextureRelief`. The construction it borrows from three.js
survives the flip because `sign(det)` flips with `dFdy` and cancels. A _forward_ height difference,
`h(uv + d) − h(uv)`, breaks that, because it is not the negative of `h(uv − d) − h(uv)` anywhere the
picture curves. The symptom was bumps in the right places lit slightly wrong, on one backend only.
What identified it was writing the perturbed normal out as colour and comparing the two: the y
component disagreed by a mean of **18 of 255** against 4 for the two components `dFdx` drives, with no
dependence on pixel parity, which ruled out a coarse-versus-fine derivative. A centred difference is
exactly antisymmetric and made the two backends bit identical.

So prefer centred differences over forward ones in anything derivative-driven, and capture a `dFdy`
term on both backends before believing it — **a same-backend pair proves nothing here**, because each
backend is self-consistent.

Two rules already here apply to the same code. A derivative must sit in uniform control flow, which a
branch on a uniform satisfies and a branch on a varying does not; and **the tilt such a term applies
wants a ceiling**, because a perturbation the size of the surface it perturbs swings a long way on a
small input change — which is the sub-pixel sparkle **0.20.0** was spent removing.

### A shared analyser needs one scale, not one set of constants — hard rule (2026-08-17)

**Two implementations of one decision drift, and they drift invisibly when the constants are
identical.** `beatMap.ts` and `kickDetector.ts` both decided what a kick is, both headers said they
used the same bands, whitening and gates, and by the time anybody compared them line by line they
agreed on none of the three. The smoothing constants were the same numbers applied at a 5 ms hop in
one and once per rendered frame in the other, so `0.1` meant a 47 ms time constant offline and 158 ms
live — and live it moved with the consumer's frame rate. The decision lives in `kickCore.ts` now.

**A per-step smoothing factor is a bug the moment two callers step at different rates.** Take a
`dtSec` and smooth in time: `1 − exp(−rate · dt)`. Then one number means one thing at 60 Hz, at
144 Hz, and at a 5 ms hop.

**And `getByteFrequencyData` is not a level.** It maps the spectrum from `minDecibels` to
`maxDecibels` onto 0–255, defaulting to −100 and −30 dB, so it is a clipped decibel scale rather than
an amplitude. Feeding it to arithmetic tuned for amplitude is what a detector with its safeguards
switched off looks like: everything above −30 dBFS pins at 255, and a near-silent bin reads 0.28 where
an amplitude would read 0.0001, which makes every ratio gate between two bands nearly always true.
Use `getFloatFrequencyData`, convert with `10 ** (db / 20)`, and take a band as the **root mean
square** of its bins rather than their mean, or the number changes with the FFT size.

### Fidelity: reality is the target

**The bar is a grade-A game that happens to run in a browser.** Not "good for the web". When a
decision trades fidelity for convenience, that trade needs a measured reason.

- **Things that move in reality move here.** Fire flickers and rises, water swells and breaks, smoke
  billows and dissipates, clouds drift. A static block standing in for a dynamic phenomenon is a bug,
  not a style.
- **A light has a physical size, and its shadows follow from it.** A bulb is a couple of centimetres
  and throws crisp shadows; a flame is a volume half a metre across and throws soft ones that widen
  with distance from the caster. That belongs to the _source_, not to a per-effect softness setting.
  A light that moves moves its shadow map with it, or the shading desynchronises and the shadow warps
  instead of travelling.
- **Static world shadows persist; only movers need a live map.** A lamp shadowing its own post is a
  fact about the world and must hold from any distance. During an ownership change, a second live map
  crossfades the old light into the new one; dropping one and enabling the other in a single frame is
  a visible on/off bug.
- **Every light source casts a shadow, and the shadow behaves like light.** A light that illuminates
  without occluding reads as passing through solid stone. Shadows fade where their light fades and
  where their map runs out, never cut at a boundary — a hard edge reads as flashing, not as distance.
- **Light comes from something you can point at.** Emissive is a _material_; a light _source_ is a
  lamp, a fire, a candle. A point light with no fixture behind it reads as light arriving from
  nowhere, and wastes a slot in a fixed budget.
- **Cull what cannot be seen.** A light whose influence is entirely behind the camera, or so far that
  its pool is a few fogged pixels, must not hold a shadow slot a visible light could use.
- **Dynamic phenomena get real systems, not decals.** Water is a wave simulation, not a tinted plane.
  Smoke is advected and dissipating, not a fading sprite. Procedural is the means, not a reason to
  settle.
- **Do not pre-emptively cut fidelity for mobile.** The 60 fps gate is verified by _measuring on a
  device_, not by declining to build something in case it might be slow. Build it, measure it, cut
  only what the measurement indicts, and say what you measured.

## One wind, sampled once

Everything that moves in air answers to the same `WindField`: fire, smoke, grass, flowers, canopies,
clouds, the sea, birds. It is sampled **once per frame** and passed down.

A system that samples its own wind is a second wind, however identical the inputs — nothing then
guarantees the two stay in step, and the failure is not localised. It shows up as a scene that does
not cohere: smoke leaning one way while the sea runs another. Nobody identifies the cause, because no
single element looks wrong.

Anything _positioned_ by wind rather than displaced by it uses the field's accumulated drift.
Deriving position from `velocity × time` looks equivalent and is not: the bearing wanders, so a
changing direction against a growing clock jumps whatever it positions, by an amount proportional to
uptime.

## Audio

The DSP graph is engine; musical decisions are game. Layered stems mixed by intensity, one master
low-pass whose cutoff rides a caller-supplied speed, send buses, and a slot registry that resolves a
named slot to a real file when one exists and to synthesised approximation when it does not.

**Dropping a file into a consumer's assets folder must be the entire process of replacing a sound**:
no code change, no rebuild of the graph, no registration step. Effects are synthesised or tiny Opus
stems; the payload budget applies to audio too.

## Reliability rules

- Fail fast and loud at init (shader compile, missing DOM, no WebGL2) with actionable messages. After
  boot, the frame loop never throws.
- TypeScript strict; no `any`; no non-null assertions — narrow explicitly. `verbatimModuleSyntax`:
  type-only imports use `import type`.
- Dependencies: MIT-compatible only, each justified, and the bar for adding one is high.
  **Count them rather than reading this line** — it said "`gl-matrix`, and `mp4-muxer`" long after
  there were eleven, which is the same drift the version-bump paragraph documents about itself:
  `node -e` over every manifest's `dependencies`, `peerDependencies` and `optionalDependencies`.
  As of 2026-09-20: `gl-matrix`, `driftscript`, `mp4-muxer`, `@jsquash/jpeg` (Apache-2.0),
  `ogg-opus-decoder`, `node-web-audio-api` (BSD-3-Clause), `@kmamal/gpu`, `@kmamal/sdl`,
  `electron`, `electron-builder`, `esbuild` and `tsx`.
  - **One copyleft package reaches the tree, transitively, and it must never be bundled.**
    `ogg-opus-decoder` depends on `codec-parser`, which is **LGPL-3.0-or-later** — the only
    copyleft package in the non-dev graph. `packages/package/src/nativeLicenses.ts` names every
    copyleft part and `native.ts` refuses to bundle one; a packaged game gets it as a replaceable
    file with `licenses/GPL-3.0.txt` beside it. **Adding a dependency without checking what it
    drags in is how the second one arrives**, and nothing in `npm test` would say so: there is no
    automated licence scan of the dependency graph.
  - **`@webgpu/glslang`'s licence cannot be stated.** Its manifest names a file (`glslang/LICENSE.txt`)
    that the published package does not contain, and nothing here records it. It is a
    devDependency, never shipped and not importable from `src/`, which is why it is tolerated —
    but it is the one dependency whose terms nobody in this repository can quote.
  - `mp4-muxer` warns on install that Mediabunny supersedes it. **We stay, and the warning alone is
    not a reason to revisit.** Mediabunny is MPL-2.0 against mp4-muxer's MIT, which is a
    source-availability obligation on every site shipping a clip encoder, and the current one is
    frozen rather than broken.

### A list of roots is a scope, and a scope nobody re-reads shrinks — hard rule (2026-09-20)

**Eleven gates here described less than everybody believed**, and they failed in one shape: each
holds a hand-written list of directories, the repository grew a directory, and the list did not.
Nothing goes red when a gate stops covering something — that is the whole difficulty.

- **The editor was never typechecked.** `tsconfig.json`'s `include` read `["packages/*/src",
"demo", "examples"]` while `vitest.config.ts`, `scripts/docs.test.mjs` and
  `scripts/docs-counts.mjs` all walked `['packages', 'demo', 'editor']`. Forty files across three
  waves were tested and never checked; adding `editor/src` surfaced seven real errors at once.
- **Four workspaces imported packages they never declared.** One hoisted `node_modules` makes that
  invisible until somebody installs the package on its own.
- **No gate asked whether a package carried the licence it promised.** One shipped with neither
  `LICENSE` nor `NOTICE` while every other gate was green — a tarball claiming a licence with no
  licence text in it, and no NOTICE, which section 4(d) requires to travel with the work.
- **The package-count regex could not match a hyphenated number word**, so at twenty-one packages
  the sentence being _correct_ is what failed the gate.

**So: when you add a root, a package or a product directory, change every list** — `tsconfig.json`,
`vitest.config.ts`, `scripts/docs.test.mjs`, `scripts/docs-counts.mjs`, `scripts/platform.test.mjs`,
`scripts/deps.test.mjs` — and **audit the gate the way you audit anything here, by running it
against a deliberate violation and watching it fail.**

**What a new package owes the repository**, six things, each behind a gate:

1. `tsconfig.build.json`, copied from a sibling, **plus `LICENSE` and `NOTICE`, byte for byte from
   the root**. `scripts/packages.test.mjs` gates them.
2. The licence banner as the first line of `src/index.ts`. It costs about 79 real gzipped bytes.
3. A `README.md` quoting its measured gzipped cost.
4. A fixture at `scripts/fixtures/size/<name>-only.ts` and a floor in `scripts/size-floors.mjs`.
5. A row in the root `README.md` table, and the package-count **word** updated with it.
6. Every dependency its shipped source imports, declared. `scripts/deps.test.mjs` refuses otherwise.

And **do not exclude a tracked file from `files`**.

### Two ways a check can be worth nothing, both found here — hard rule (2026-09-20)

**A check that runs two copies of one expression proves they agree and nothing else.** Where the
reference and the implementation are the same arithmetic typed twice, the check is testing a
transcription. That is worth having — most of the WGSL here is exactly that, and it caught five
deliberate breakages out of five — but it must say so, and it must be **perturbed with the mistake
somebody would actually make** rather than an obvious one: negating a term fires every assertion
and tells you nothing, while reading the neighbouring texel fires none.

**And a test named for a mechanism can assert only an outcome.** Perturb the line the name refers
to; if the test still passes, the name is a claim the test does not make. Around twenty test
premises were wrong across this programme, all found this way.

**`npm run wgsl:check` reads the generated WGSL only.** A hand-written shader has no generator to
disagree with, so nothing reads it until a device does — which is true of most of
`shaders/gpudriven/` and all of `shaders/gi/`. Those need `scripts/gpu-parity.mjs` or they need a
person with a GPU, and there is no third option.

## Testing — few tests, each load-bearing

Vitest. Tests live beside their module as `*.test.ts` and are typechecked by the normal `tsc` pass.
`npm test` runs them.

**A test earns its place by protecting a contract that outlives today's tuning.** Bias hard toward
few, deep tests.

**Test these:** geometry and collision invariants (auto-step climbs ≤ `STEP_HEIGHT` and is blocked
above it; a body never ends inside a solid); pure math with a real contract (angle wrapping across
±π, seeded RNG sequence stability); the fixed-timestep loop's accumulator.

**Never test these:** tuning constants — they are _decisions_ and will change every feel pass, so
asserting their values produces tests that fail on intent and pass through bugs. Rendering, shaders,
DOM and gesture timing — verified by eye, on desktop _and_ a real phone. Constructors, getters and
forwarding that neither validate nor derive.

**Rules of engagement:** bug fixes start with a failing test that reproduces the bug — if you did not
watch it fail, you do not know it tests the right thing. **Then perturb the fix**: break the
implementation and confirm the test goes red. If it stays green, the test is what is wrong, and Track
B found nine of those by asking. Expected values are hand-derived literals; never build an
expectation with the code under test. Generators may produce test _inputs_, never test
_expectations_. **Read the whole output of a `node --test` run, not its tail** — failures print above
the summary, and a pipe eats the exit code, so `cmd | tail && git commit` commits through red.

### Commits carry one author — hard rule (2026-09-13)

A commit in this repository is authored by the person who owns it and by nobody else. No
`Co-Authored-By` trailer, no tool attribution, no session link. Tooling that adds those by default
must be told not to here, and a trailer that slips in is removed before the commit lands.

**A commit log is a statement about provenance**, and this repository now makes three others that
have to agree with it: the copyright line in `LICENSE`, the holder named in `NOTICE`, and the
`author` field in twenty-four manifests. A trailer naming a tool as co-author contradicts all three at
once, in the one record a reader checks when they want to know who stands behind the code.

## Definition of done

`npm run typecheck` clean · `npm test` clean · no console errors or warnings at runtime in a
consumer · zero new allocations in hot paths · docs updated if a decision changed · **anything
touching `src/render/` reaches both backends, or says in the parity ledger why it does not yet**.

**An effect no scene turns on is not ported.** It is written, which is a different word. The WebGPU
composite carried four effects no demo scene enabled — HDR, bloom, the speed rush, camera motion blur
— and every parity figure had been taken with the composite passing the image straight through. When
they were finally driven, **all four were wrong**: a scene target no pipeline matched, a bloom pyramid
that was one stage of eleven, a reprojection through the other backend's clip space, and two setters
still announcing that the composite did not exist. Every one compiled, validated and drew a plausible
picture.

So a feature is done when something has _turned it on_ and the result has been compared. If no scene
will, the harness gets a way to — a query flag where the option is construction-time, and a page under
`demo/dev/` where it is a per-frame dial. Writing that instrument is part of the work.

Because consumers bundle this source directly, **a change here is live in every consumer the
moment it is saved.** There is no version gate to hide behind: verify against a real consumer before
committing anything touching a hot path or the public barrel.

## Browser verification

Chromium visual checks must use the machine's hardware GPU. Never force SwiftShader or another
software renderer: it can saturate and overheat the CPU, and it gives misleading performance results.
Confirm Chromium selected a physical GPU when diagnosing rendering, and stop temporary browser
sessions after the check.
