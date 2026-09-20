# Upgrading a consumer across a major release

One section per major. Read the one you are moving to.

---

# 4.0.0 — nothing breaks, and that is the notable part

**What breaks: nothing.** Across every package barrel this release **adds 769 public symbols and
removes none**. No export was renamed, no default flipped, and no signature narrowed. A game built
against 3.63.0 compiles against 4.0.0 with no edit, and the four lines that moved in `core`'s
barrel moved because the re-export beside them was widened — `exactLog` joined the exact
transcendentals, `boxInFrustum` joined the frustum tests, `RenderPipeline` joined the renderer's
types.

**So why a major.** Because the surface is a different size: five new packages — `capture`,
`native-host`, `nav`, `texture` and `tools` — an editor application, and a second host. A version
number is quoted in bug reports and compared across machines, and a consumer reading "3.64.0"
would have no way to tell that the engine now reconstructs a scene from a video and runs without a
browser. The number is carrying the scale of the addition, not a warning about removal.

## Doing it

One line, and then the install:

```sh
npm install @driftengine/core@4.0.0
```

**If you take more than one package, they must all move together.** The packages peer-depend on
each other at an exact version, so a tree holding `@driftengine/core@4.0.0` beside
`@driftengine/animation@3.63.0` is a tree npm will either refuse or resolve into two copies of
core — and two copies of core is two renderers, two clocks and one very confusing afternoon. Move
every `@driftengine/*` range in your manifest in the same commit, then run `npm ci` rather than
`npm install`, because that is the command that reads the lockfile the way your CI will.

**A path dependency needs nothing but a pull.** Nothing about the `drift-source` condition changed.

## What you gain by doing nothing else

The new packages are peers that stay out of the payload until something imports them, so an
upgrade with no other edit changes the bytes your players download by nothing. Every new
capability is opt-in at the point you call it:

- **Reconstruction** is `quality.reconstruction` on the renderer, off unless you pass a ratio.
- **The GPU-driven pipeline** is `createRenderer({ pipeline: 'gpu-driven' })`, and it **throws**
  on a backend without indirect draws rather than falling back quietly. That refusal is checked
  against the backend that will draw, not the one you asked for.
- **Indirect light** is CPU-side and drawn by nothing, so exporting it changed no scene.
- **`@driftengine/nav`, `texture`, `tools`, `capture` and `native-host`** are separate installs.

## The one thing to read before you reach for it

**`@driftengine/capture` states its maturity stage by stage, and the statement is the contract.**
It reconstructs what a clip saw from where the clip saw it. Colliders hold where the capture has a
surface and the capture does not have one everywhere; delighting recovers colour and reports how
little it trusts it; entity proposals arrive unlabelled for a person to accept. Six frames is the
ceiling measured on the development device, and **the metric scale is unverified** — the metres
are the depth model's claim rather than a measurement. Build on it knowing that, or wait.

---

# 3.0.0 — the mix is a tree, and `AudioGraph` no longer holds it

**What breaks:** every mixing method on `AudioGraph` is gone. The class keeps the transport — what
is playing, from where, at what rate — and the mix moved to a bus tree reached through
`graph.layout` and `graph.console`.

**Why they were removed rather than left forwarding.** A shim that works forever is a second answer
to every question the console already answers, and the two drift the first time one of them grows a
clamp. Nothing here is a rename for its own sake: each method below became a method on the thing
that actually owns the stage, and several of them stopped being one-per-effect calls at all — a
send is `bus.send(returnBus, amount)`, which is the same verb for every return there will ever be.

**Every site is a compiler error naming the member**, so the list is exact rather than a search.

## What moved

| Was on `AudioGraph`     | Now                                                                         |
| ----------------------- | --------------------------------------------------------------------------- |
| `setMusicVolume(v)`     | `graph.layout.music.setLevel(v)`                                            |
| `setEffectsVolume(v)`   | `graph.layout.effects.setLevel(v)`                                          |
| `fadeMusic(v, s)`       | `graph.layout.music.duck(factor, s)` — **see below, the semantics changed** |
| `setMusicLift(a)`       | `graph.layout.lift.setAmount(a)`                                            |
| `slamLowEnd(a)`         | `graph.layout.slam.strike(a)`                                               |
| `setMasterCutoff(hz)`   | `graph.layout.masterFilter.setCutoff(hz)`                                   |
| `setMasterResonance(a)` | `graph.layout.masterFilter.setResonance(a)`                                 |
| `setReverbSend(a)`      | `graph.layout.music.send(graph.layout.reverb, a)`                           |
| `setLongReverbSend(a)`  | `graph.layout.music.send(graph.layout.longReverb, a)`                       |
| `setDelaySend(a)`       | `graph.layout.music.send(graph.layout.delay, a)`                            |
| `setDelayTime(s)`       | `graph.layout.delayLine.setTime(s)`                                         |
| `delayTimeSec`          | `graph.layout.delayLine.timeSec`                                            |
| `setDelayFeedback(a)`   | `graph.layout.delayLine.setFeedback(a)`                                     |

`levels`, `loadStem`, `start`, `hold`, `release`, `restart`, `startsInSec`, `at`, `wake`,
`audible`, `setStemGain`, `setPlaybackRate`, `createLoop`, `createKickDetector`, `captureStream`,
`play`, `registry` and `dispose` are **unchanged**. `levels` is now derived from the two buses
rather than mirrored, which is invisible to a caller and removes a second place the answer was kept.

## `fadeMusic` became a duck, and that is the one behaviour change

`fadeMusic(volume, seconds)` took an **absolute** level and deliberately did not move `levels`, so
a caller coming back out of a fade had to pass `graph.levels.music` back in. `duck(factor, seconds)`
takes a **multiplier over the fader** and does not move it either — so coming back is `duck(1, s)`,
and the level to return to stops being something the caller has to have remembered, including
across a settings change made mid-fade.

```ts
soundtrack.fadeOut(s); // was: graph.fadeMusic(0, s)
// now: graph.layout.music.duck(0, s)
soundtrack.fadeIn(s); // was: graph.fadeMusic(graph.levels.music, s)
// now: graph.layout.music.duck(1, s)
```

**And it fixes a defect you may have been living with.** `fadeMusic` scheduled on
`context.currentTime` rather than on the graph's own clock, so in an _offline_ render — the path an
exported clip takes — a fade landed at instant zero however late `at()` said to put it. Measured on
this repository's own reference render at the moment of the change: a four-second mix that should
have ducked only in its last half second had been rendering ducked throughout, RMS 0.129 against
0.344. Live playback was never affected, because live the two clocks agree.

## What you gain, and it is not only a rename

The mix is a tree now. A bus can be created, nested, soloed, muted and snapshotted, and a reverb
zone is one of those buses rather than a special case — so an application that wants a dialogue bus
ducking under music, or a mixer page, or a saved "underwater" mix, builds it out of what is already
there:

```ts
const dialogue = graph.console.bus('dialogue', { parent: graph.layout.effects });
dialogue.send(graph.layout.reverb, 0.2);
graph.console.snapshot('above-water');
graph.console.recall('underwater', 1.5);
```

## Spatial audio arrives in the same release, and costs nothing until you import it

`createListener`, `createSpatialSource` and `addReverbZone` are standalone functions rather than
methods, so a bundler drops them for an application that never places a sound in the world:
measured, the audio graph adds 1,441 bytes gzipped to a core bundle and the spatial layer another
1,479 that only its users pay. `distanceGain` and `stereoPan` are **not deprecated** — a diffuse bed
is what they are for, and a panner per brazier is the expensive way to get the same two numbers.

---

# 2.0.0 — the engine is five packages

**What breaks:** core's barrel no longer re-exports the container format, the model readers, the
audio graph or the clip encoder. Every one of those is now its own package, and an application
that imported them from `@driftengine/core` fails to compile until it installs the package that
owns them and imports from there.

**Why it is not a re-export.** A barrel that re-exports audio means importing core pulls audio in,
and the split buys nothing. The break is the feature: a game that records nothing now installs no
`mp4-muxer`, and one that imports no model compiles no reader.

## What moved

| Was in `@driftengine/core`                                                                                                                                                                                                                                                                                                                                                         | Now in                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `readDrft`, `writeDrft`, `streamDrft`, `DrftStream`, `DrftError`, `DrftMaterial`, `DrftTexture`, `DrftTextureSource`, `DrftHead`, `DrftAsset`, `DrftManifest`, `DrftSource`, `codecName`, the `CODEC_*` constants, `DRFT_VERSION_*`                                                                                                                                                | `@driftengine/drft`   |
| `readModel`, `readerFor`, `MODEL_FORMATS`, `ModelSource`, `UpAxis`, `orientMeshes`, `weldMesh`, `DrftLoader`, `DrftLoadProgress`, `assetCandidates`, `AssetReference`, `basenameOf`, `extensionOf`, `describeImage`, `readZip`, `ZipEntry`, `Inflate`, `browserInflate`, `browserInflateRaw`, `prepareZipInflate`, `prepareFbxInflate`, `DEFAULT_COARSE_CELLS`, `buildCoarseLevel` | `@driftengine/assets` |
| `AudioGraph`, `AmbientLoop`, the synth and rhythm surface, `KickDetector`, `distanceGain`, `stereoPan`, `claimPlaybackSession`, `audioContextConstructor`                                                                                                                                                                                                                          | `@driftengine/audio`  |
| `ClipEncoder`, `clipEncodingSupported`, `offlineEncodingSupported`, `framesReachEncoder`, the frame-delivery surface                                                                                                                                                                                                                                                               | `@driftengine/media`  |

**`MeshData` and `validateMeshData` did not move**, although they now live in `@driftengine/drft`.
Core re-exports both, so an application taking them from the renderer is unaffected.

## Doing it

Install only what you actually use:

```sh
npm install @driftengine/drft @driftengine/assets @driftengine/audio @driftengine/media
```

Then let the compiler find the sites. Every one is a `has no exported member` error naming the
symbol, so the list is exact rather than a search:

```sh
npm run typecheck
```

```ts
// before
import { createRenderer, readDrft, AudioGraph } from '@driftengine/core';

// after
import { createRenderer } from '@driftengine/core';
import { readDrft } from '@driftengine/drft';
import { AudioGraph } from '@driftengine/audio';
```

**Do the whole list in one commit and land it with the engine.** A consumer resolving the engine
from a path compiles against whatever that checkout is on, so a half-migrated consumer builds
against neither version. That rule is unchanged from the 1.0.0 move below.

**If you read the engine's `CHANGELOG.json` by file path** rather than by package specifier, it
moved to `packages/core/CHANGELOG.json`. By specifier — `@driftengine/core/CHANGELOG.json` — it is
unchanged.

## What it is worth

Measured, gzipped, by `scripts/size-gate.test.mjs`: the format package alone is **2.7 KB**, the
audio graph adds **4.9 KB** to a core bundle and the model readers **9.3 KB**. If your application
uses all of them you have gained nothing but clarity. If it uses none, you have stopped shipping
them.

---

# 1.0.0 — the WebGPU release

A major release. It adds a second backend, and it changes five things a consumer can be holding.
This is the list, in the order it is least painful to do them.

**Nothing here is optional reading for an application that draws.** Three of the five fail to
compile, which is the good case. The other two change a picture and compile perfectly.

> **Written from the upgrade rather than about it.** Real projects have been through it —
> one on `webgpu-text-handles`, the other on `webgpu-migration` — and every step below is
> what that actually took, in the order it took it.
>
> **Do the whole list in one commit and land it with the engine.** A consumer resolving
> `@driftengine/core` from a path (`file:../../driftengine`) is compiling against whatever that
> checkout is on, so a half-migrated consumer does not build against either version.

---

## 0. Stop naming the concrete classes — do this one first

**A consumer that holds the concrete `Renderer` is pinned to WebGL2 by its own type annotations**,
and every other item on this list is easier once it is not.

`createRenderer()` returns `RendererApi`. `Renderer` is the WebGL2 class. They are not the same
type, and the difference is invisible until a handle meets an annotation:

```ts
// engine/src/render/backend/webgl2/renderer.ts — the WebGL2 class
createText(): TextRenderer
// engine/src/render/backend/api.ts — the surface both backends implement
createText(): TextHandle
```

**Do this before you read any further, or item 1 will look broken.** A file that imports
`TextHandle` and passes it to something typed `Renderer` produces a page of errors that read as a
half-finished text migration. In one that was _twelve_ errors whose call sites were already
correct: the renderer's type was the fault, and every one of them went when it changed.

| stop importing       | use                    |
| -------------------- | ---------------------- |
| `Renderer`           | `RendererApi`          |
| `Mesh`               | `MeshHandle`           |
| `InstancedMesh`      | `ScatterHandle`        |
| `TextRenderer`       | `TextHandle`           |
| `SurfaceTexture`     | `SurfaceTextureHandle` |
| `PlumeRenderer`      | `PlumeHandle`          |
| `ParticleBatch`      | `ParticleHandle`       |
| `WaterRenderer`      | `WaterHandle`          |
| `CausticsRenderer`   | `CausticsHandle`       |
| `BoltBatch`          | `BoltHandle`           |
| `FlockRenderer`      | `FlockHandle`          |
| `WindStreakRenderer` | `WindStreakHandle`     |

**The bottom half of that table only appears once the top half is done**, which is why it is worth
having in full: the compiler cannot see a `WaterHandle` meeting a `WaterRenderer` until the
renderer holding both has the shared type. One consumer found three that way and the other six.

**Find them by name, not by error.** A real upgrade had far more sites than it had errors —
one had 285 across 37 files against 10 errors — because an annotation only fails where a
handle actually reaches it. The ones that compile are the ones still pinned.

Two things worth knowing before you sweep:

- **A `build(renderer: Renderer)` interface propagates.** One consumer types its scenario contract
  once in `scenario/types.ts`, and that single annotation put the WebGL2 class into all
  twenty-five worlds.
- **Do not rewrite prose.** A blind search and replace will edit the class names inside comments
  and string literals. One consumer's own release notes are string literals naming
  `Renderer.onContextRestored`, and a test caught them being rewritten into history.

### Constructing it, which you may not have to change

```ts
const { renderer, backend, reason } = await createRenderer(canvas, quality);
```

**`new Renderer(canvas, quality)` keeps working and is not deprecated.** It is synchronous, and
`createRenderer` cannot be: asking for a WebGPU adapter returns a promise. If your renderer is
built in a constructor, that is a lifecycle change rather than a line change, and it is a fair
decision to defer — one consumer did, and holds `RendererApi` everywhere downstream of the one line
that still says `new Renderer`. A consumer that never calls the factory simply never reaches
WebGPU, which is the same position it is in today.

---

## 1. Text is a handle the renderer draws

`createText()` returned a `TextRenderer`, and a `TextRenderer` held a `WebGL2RenderingContext`.
Any code holding one was code pinned to a single backend, which is what kept the engine's own
`showroom` scene off WebGPU.

Text now looks like every other resource in the engine: an opaque handle from the renderer, and
verbs on the renderer.

```ts
// before
import { TextRenderer, DEFAULT_TEXT_STYLE } from '@driftengine/core';

const label = renderer.createText();
label.setText('LAP 3');
label.draw(width, height, x, y, style, timeSec);
label.dispose();

const w = TextRenderer.widthPx('LAP 3', cell);
const h = TextRenderer.heightPx(cell);
```

```ts
// after
import { textWidthPx, textHeightPx, DEFAULT_TEXT_STYLE } from '@driftengine/core';
import type { TextHandle } from '@driftengine/core';

const label: TextHandle = renderer.createText();
renderer.setText(label, 'LAP 3');
renderer.drawText(label, width, height, x, y, style, timeSec);
renderer.disposeText(label);

const w = textWidthPx('LAP 3', cell);
const h = textHeightPx(cell);
```

- `TextRenderer` is **no longer exported**. Import `TextHandle` for the type.
- `setPlate` and the instance `widthPx` moved the same way: `renderer.setPlate(handle, …)` and
  `renderer.textWidth(handle, cellSize)`.
- The viewport stays an argument to `drawText` rather than being read off the renderer, because
  an overlay is laid out in whatever box the caller is using and that is not always the canvas.
- `TextStyle` and `DEFAULT_TEXT_STYLE` are unchanged.

**It will not compile until you have done it**, which is the whole reason it was shaped this way.

**Two things the real migration turned up**, neither obvious from the diff:

- **The renderer has to be reachable where you draw.** Both of one consumer's text classes were
  handed a renderer in their constructor and only one kept it. `EventText` used it to build its
  handles and then let it go, which was fine when the handles could draw themselves. It stores it
  now.
- **Watch for a local called `renderer`.** `EventText` had `const renderer = this.segments[i]`,
  holding a text object. That name now means the engine's renderer, and the two shadow each other
  in exactly the block where both are used. It is a `segment` now. A compiler catches this one;
  it is listed because it reads as a puzzling error rather than as a rename.

---

## 2. Surface textures are a handle too

Same change, same reason: `createSurfaceTexture` returned a class holding a context.

```ts
// before
import type { SurfaceTexture } from '@driftengine/core';
let sleeve: SurfaceTexture | null = null;

// after
import type { SurfaceTextureHandle } from '@driftengine/core';
let sleeve: SurfaceTextureHandle | null = null;
```

The verbs are the ones that already existed and are unchanged:
`createSurfaceTexture`, `updateSurfaceTexture`, `disposeSurfaceTexture`, `setSurfaceTexture`.
Only the type moves.

`SurfaceTexture` **is** still exported, like `Renderer` and for the same reason, and holding one
pins you to WebGL2 in the same way. `SurfaceTextureHandle` and `CausticsHandle` were not exported
at all until a consumer tried to name them — if your checkout cannot find either, it predates that
fix.

---

## 3. Textures are no longer flipped vertically — **this one is silent**

**Read this even if nothing you own fails to compile.**

`SurfaceTexture` set `UNPACK_FLIP_Y_WEBGL` around every upload. **WebGL ignores that flag for an
`ImageBitmap`**, which carries its own orientation, and honours it for a canvas, an image and an
`ImageData`. So the two source types the same method accepts arrived the opposite way up from
each other, and had done for as long as the method has existed.

| source                                  | before              | after                   |
| --------------------------------------- | ------------------- | ----------------------- |
| `ImageBitmap`                           | upright             | upright — **unchanged** |
| canvas, `HTMLImageElement`, `ImageData` | mirrored vertically | upright                 |

Nothing caught it because every canvas-sourced texture in the engine was symmetric under a
vertical flip: eroded noise, a radial halo, a sleeve blurred down to 24 pixels and back. One consumer
painted an artist and a title to a canvas beside a sleeve decoded as an `ImageBitmap`, and the
text came out upside down.

**What to do:**

- **If you upload only `ImageBitmap`s, nothing changes.** That includes every texture on a
  `.drft` model, which the loader decodes as bitmaps. This was the deliberate choice of
  direction: making bitmaps match canvases instead would have turned over every painted surface
  on every loaded model.
- **If you paint to a canvas and upload it, it is now the right way up.** Any code mirroring its
  own canvas to cancel the engine's flip has to stop mirroring. One consumer's `paintCaption` is
  exactly this and its own comment says it is a stand-in.
- **If a canvas texture of yours was symmetric, you will not be able to tell.** That is the
  expected case and is fine.

Both backends were measured on both source types before and after, sampling the first row of
texel memory. All four combinations now agree; before, one of the four did not.

---

## 4. Plumes and particles take a named material, not GLSL

Both APIs used to accept a fragment shader as a string. They take a named material now, so that
the engine can compile the same effect for two backends and so that a caller cannot hand one
backend source the other cannot use.

```ts
// before
renderer.createPlumes(count, { fragment: MY_GLSL });
// after
renderer.createPlumes(count, { material: 'fire' });
```

If you were passing your own GLSL, there is no drop-in replacement and there deliberately is not
one: a shader string is the one thing that cannot be honoured on both backends. Open an issue
naming the effect you had.

**The materials are `fire`, `smoke` and `arcane` for a plume, `smoke` and `spark` for a
particle.** `arcane` was added during this migration because a consumer drew its auras with
`ARCANE_FRAG` and nothing in the table covered it — which is the shape of the answer if you are
missing one, so say which effect rather than which shader.

**`label` is gone from both option types.** A batch is named by its material now, so per-instance
labels have nowhere to go; a real upgrade dropped four or five of them. `PlumeOptions` keeps
`blend`, `sizePulse`, `windResponse` and `tint`; `ParticleBatchOptions` keeps `blend`,
`stretchSec`, `erosion`, `coreGain` and `reuse`.

**`tint` is read by `arcane` alone**, and it is the only plume option whose absence is invisible
rather than wrong: an untinted additive plume is not a bad colour, it is no plume.

**`reuse` takes a `ParticleHandle`**, which it did not until this migration — it named the
concrete `ParticleBatch`, so a consumer that had done item 0 correctly could not share a program
without holding the class it had just moved off. WebGPU ignores `reuse` and that is correct rather
than a gap: its pipelines are cached on the material and blend, so pools that would have shared
one already do.

---

## 5. Turning WebGPU on

Nothing is required. `createRenderer` returns WebGL2 unless WebGPU is asked for, and every
application keeps its current behaviour with no change.

```ts
const { renderer, backend, reason } = await createRenderer(canvas, quality, {
  preferWebGpu: true,
});
```

- `?backend=webgpu` in the address bar does the same thing, for a page you want to compare.
- **Report `backend`; never infer it from the query.** A browser without WebGPU, a device request
  that failed and a misspelt query all fall back silently and draw a frame that looks entirely
  reasonable. The engine warns on the console when the request was dropped, and says why.
- Falling back is not an error and needs no handling. It is the normal case on a lot of hardware.

### Linux, and why your machine may never use it

Measured on Chrome 149 with a Radeon RX 9070 XT on RADV: **Chrome exposes `navigator.gpu` and
then offers no adapter**, reporting at `chrome://gpu` that _"WebGPU has been disabled via
blocklist or the command line"_. Neither Vulkan flag helps alone; the pair does, and so does
`--enable-unsafe-webgpu`.

This is a fact about the browser rather than about any engine — `requestAdapter()` returns null
before a line of renderer code runs, so every WebGPU renderer on such a machine falls back
identically. **Do not ask a player to set a flag.** The fallback is the feature, and WebGL2
remains a first-class path rather than a legacy branch.

---

## 6. Knowing it worked, which a clean `tsc` does not tell you

**Three of the defects this migration found compiled, passed every test, and drew a plausible
frame.** Two of them were invisible until somebody looked at the picture on the second backend.
The list below is what it took, in the order it is worth doing.

**Load the page on both backends and read the console.** A WebGPU validation failure is reported
at `finish` or at `submit` rather than at the call that caused it, and it invalidates the _whole
command buffer_ — so the failure mode is not a wrong picture, it is a missing pass from a frame
that recorded correctly. One consumer's planar reflection was being dropped in full, every frame, and
the only evidence anywhere was one console line:

```
[Texture "reflection.color"] usage (TextureBinding|RenderAttachment) includes writable usage
and another usage in the same synchronization scope.
```

**Report the backend from `createRenderer`, and read it back.** Not from the query. Two sessions
of this port were spent comparing WebGL2 against WebGL2.

**Measure your capture floor before believing any diff.** A game that integrates state frame over
frame does not photograph the same pixels twice. Measured on one consumer, the same shot came back at
**369, 5,739 and 86** across three pairs of one unchanged build. A hard-coded threshold would have
called a real change nothing on one shot and the floor a regression on another. Compare at a delta
threshold too — counting anything above 1/255 reports an indistinguishable frame as 38% wrong.

**Two frames of an animating page are not a comparison.** An intro that is still running will
photograph at different points in two captures and every pixel figure from it is noise. Pin the
clock, or photograph something that has settled.

**`navigator.gpu` needs a secure context.** A `data:` or `about:blank` page reports it absent on a
machine where it works perfectly, which reads exactly like an unsupported browser. Serve the page
over `http://localhost` before concluding anything about the hardware.

**A new material has to be looked at.** `demo/dev/plumes.html` draws every plume material side by
side and reports which backend drew them:

```
npm run demo    # then /plumes.html and /plumes.html?backend=webgpu
```
