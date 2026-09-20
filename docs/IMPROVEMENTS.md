# Improvements — what is known, what it costs, and what it would take

**A register, not a plan.** `ROADMAP.md` says what to do next and why; this says what has been
_found_ and left undone, so a finding is not rediscovered from scratch the third time somebody
trips over it. Every entry here was paid for by an investigation, and the expensive part of each
was almost never the fix.

Add an entry whenever a measurement turns up a cost that is real and is not being taken today.
Delete one when it lands, and put the number in `CHANGELOG.json` where a consumer will read it.

---

## How to measure the WebGPU backend, and what cannot be measured

**This section is about that backend specifically.** Entries below it are not all WebGPU's;
the register takes any finding that cost an investigation and has not been taken.

**Read this before opening an entry below.** More time has been lost to instruments that cannot
see the thing than to any bug in the list.

**`submit` is asynchronous, so a timer around it measures nothing.** A CPU-side stopwatch on any
WebGPU call reports single digits while the GPU is stalled for seconds. Use
`device.queue.onSubmittedWorkDone()` and time the promise: that resolves when the queue has
actually drained, and it is the only honest read of a frame's own cost from JavaScript.

**`createRenderPipeline` does not compile.** It returns before the driver has produced anything
and defers the shader to the first draw that uses it. A pipeline count and a build time both
look trivial because creating the object _is_ trivial. This cost one investigation most of a day:
"twelve pipelines in 2ms" was read as a clearance when the compile had not happened yet.

**A frozen page with no long task is a GPU stall, not a main-thread stall.** `PerformanceObserver`
with `entryTypes: ['longtask']` distinguishes them in one reload. If nothing fires while the page
is visibly stuck, stop looking at JavaScript.

**Attachment traffic is device-independent, so a desktop measures a phone's frame exactly.** Wrap
`GPUDevice.prototype.createTexture` to record each texture's size, format and sample count, wrap
`GPUCommandEncoder.prototype.beginRenderPass` to account a load and a store per attachment, and
divide by frames. Pass counts, load/store ops and byte sizes are properties of the frame, not of
the part. This is how the mobile bandwidth work was done without a handset in the room.

**The shot harness cannot prove a `discard` is safe.** An immediate-mode desktop GPU has nowhere
else to put multisample data, so discarding costs it nothing and changes nothing; a tile-based
mobile GPU really drops it. A change of that kind renders perfectly on every machine available
here and returns garbage on exactly the device it was made for. Reason from the usage flags and
the specification, and verify on a tiler.

---

## Open

### The fitted LTC fit works now, and what is left is that a polynomial cannot carry it

**Reopened and moved on 2026-09-05**, at the condition the fourth attempt wrote: fit against polygon
integrals rather than against the lobe. `scripts/ltcFit.mjs --check` is the measurement, `--lobe`
reproduces the four attempts before it, and the script's header carries the account.

Every figure is "worst over the grid (worst where the rectangle covers at least 5% of the lobe)":

```
                                as fitted        through the polynomials
  analytic, the floor           85.7% (72.3%)    86.0% (71.8%)
  fitted against the lobe       75.2%            77.3%
  fitted against polygons       11.7% ( 8.8%)   172.9% (78.4%)
```

**On the placement the bound is set on, the shipped term's 71.8% becomes 8.8%.** That is the first
time in five attempts a fitted table has beaten the analytic matrix at all, and the reason it works
is the one the fourth attempt named: the search was optimising a hemisphere match and being judged
on a polygon integral, so it _chose_ matrices that won the first and lost the second.

**It is affordable because a reference does not depend on the candidate.** The brute force runs once
per entry over six placements before the search; every evaluation afterwards is six closed-form form
factors, which is cheaper than the two thousand hemisphere samples it replaces. The magnitude is
solved in closed form rather than searched, so the parameter count stays at four.

**Two things had to be fixed before the result was visible, and one of them is a lesson about
bounds.**

- _The objective is flat at low roughness_, where a near-delta lobe is either inside a rectangle or
  outside it and the four parameters stop mattering. The simplex wandered, neighbouring entries
  wandered elsewhere, and what reached the polynomial stage was noise with no surface under it —
  relative errors around 1e143. A ridge holds those entries at the analytic answer, which is a
  function rather than a search and is therefore smooth by construction.
- _A relative error against a near-zero reference is not a bound._ The analytic term's headline
  85.7% is the cell where the rectangle covers 0.02% of the lobe and the reference is 0.000204 —
  black on any screen. Five attempts compared that number against fitted ones taken at 28% share.
  Every figure is now reported twice and the second is the one a picture can see.

**What is left is the storage, and it is what this row said at the start.** These are fitted data
that "cannot be generated, only shipped", and the engine has spent four attempts generating them
from polynomials. Read back through degree 5 the good table is worse than doing nothing, and degree
is not the lever: 6, 7, 8, 9 and 10 measure 147.8%, 85.7%, 113.5%, 105.2% and 99.7% against 92.4%,
because a higher-degree fit to a rough surface oscillates. Smoothing the parameter grid until
entries sit on their neighbours' average reaches 78.4% and no further.

**And then the table was measured the way a shader would read it, which stops the row here.**

Every figure above is taken _at a grid entry_. A shader samples between them, and nothing measured
that for five attempts — the check evaluates at entries by design, so no interpolation is in the
way, which judges a fit and says nothing about a table. The `sampled` rows read the table half a
texel off every entry that produced it, at points fixed in `(roughness, cosTheta)` so two grid sizes
measure the same physical places:

```
                                   overhead (visible)   mirror (visible)
  what ships, the analytic term          71.8%               18.7%
  table at 32, sampled                   11.1%               51.4%
  table at 16, sampled                   13.1%               57.6%
  table at 8,  sampled                   25.5%               78.4%
  table at 32, smoothing x3              10.6%               53.1%
  table at 32, smoothing x8              10.8%               53.1%
  table at 32, sqrt(roughness) grid       8.4%               49.1%
  table at 16, sqrt(roughness) grid      12.7%               52.9%
```

**The mirror placement is worse than the closed form in every one**, by about the same factor of
2.7, and no size, no smoothing and no reparameterisation moves it. That is the placement an area
light is reached for — a softbox reflected in polished metal — so the trade on offer is an
eight-fold gain on the overhead tail against a near three-fold loss on the case that matters. This
engine should not take it.

**It is a reason rather than a tuning failure.** The analytic matrix is a smooth closed form; the
mirror placement's answer is _steep_ in roughness at the low end, where the lobe is a near-delta
landing inside the quad. Half a texel of roughness is a large change in that integral, so any
reconstruction from samples loses it and a formula does not. The table wins exactly where the
formula is structurally wrong and loses exactly where the formula is right and the function is fast.

**So the payload question is moot and the row does not close by shipping a table.** For the record
the payload was measured — both tables together are 3,866 gzipped bytes as float32 and 562 as 8-bit
— and it is not what stops this.

_A sixth attempt, if there is one, is a blend_: the analytic term near the mirror-dominant regime
and the fitted one for the wide and tail regimes, on a quantity both are functions of. That is a
different design again and needs its own measurement before any of it is written. Nothing waits on
it, and the two pieces of groundwork it would need are already in: `quadCoverage` builds the frame
the table was fitted in, and the check can measure between entries.

**One thing tried and worse, so nobody runs it twice.** `--viewframe` puts the matrix's shear on the
tangent lying in the view plane rather than across it, on the argument that a GGX lobe stretches
along the view at grazing angles. 14.9% against 11.7%.

### The medium's shadow reaches further than a surface's, and the two disagree

**Found on 2026-09-05 while building `demo/dev/medium.html`, and it is a property rather than a
defect in either half.** `directionalShadowMaxDistance` is 6 metres: a _surface_ shadow fades out
once its caster is further than that along the ground, because a shadow map's resolution and its
bias are both tuned for contact and a distant shadow is unreliable. The global medium's `sunReach`
has no such fade, because a shaft through a high window is the whole point of the feature and is
long-range by nature.

What that page photographed first was a clean shaft standing in the air over a floor showing no
shadow at all, from a ceiling nine metres up: past the surfaces' reach and not past the march's. The
page raises the profile's own limit so the two agree, which is what a consumer with a room taller
than six metres will have to do.

**What would close it** is deciding whether the medium should honour the same limit. The argument
against is that it would remove the effect's main case; the argument for is that a game should not
have to know that two terms reading one shadow map disagree about how far it reaches.

### An area light's specular was wrong by 90% to 100% on a smooth surface, and is an integral now

**Found and closed on 2026-09-04.** It was found by measuring the incumbent beside a candidate fit, which nobody had done: the representative point was described as diverging at grazing angles, and what it actually did was lose the reflection.

`--check` prints it in the `repr err` column at every entry. A two-metre rectangle on the mirror
direction, at roughness 0.226 and cos 0.184: the true integral is **0.9207** and the shader's term is
**0.000233**. At roughness 0.097 it is 0.9972 against 0.000011. Head-on at roughness 1 it errs the
other way, 0.2355 against 0.0624, which is **3.8 times too bright**.

**No single factor of the assembly accounts for it, which was worth measuring rather than
reasoning about.** `main.ts` multiplies `sphereLobe` by the rectangle's _diffuse_ form factor and by
`areaNdl`, and `sphereLobe` renormalises its own energy by `(a / widened)²` when it widens the lobe
for the source's size. Taking those apart on the mirror placement at roughness 0.097, cos 0.184,
against a reference of **0.9972**:

|                                    |          |
| ---------------------------------- | -------- |
| as shipped                         | 0.000011 |
| without the energy renormalisation | 0.008123 |
| without the form factor as well    | 0.184183 |

So the renormalisation is worth a factor of 738 here and the form factor another 23, and **with both
removed the term is still 5.4 times below the integral** — because `sphereLobe` is a normalised
distribution rather than a BRDF, with no `G`, no `1 / (4·ndv)`, and a peak capped at 1 where a smooth
surface reflecting a light it fully sees should return nearly its whole albedo.

**The same two factors are doing necessary work at the other end.** At roughness 1 head-on the term
as shipped is 3.7 times too bright, and with both removed it is 16 times too bright. The assembly is
calibrated where a lobe is broad and collapses where it is tight, which is the opposite of a term
with a single missing factor and is why this is a row rather than a one-line fix.

**A replacement is measured and waiting on a decision.** `scripts/areaSpecular.mjs` is the
instrument, and it compares what ships against a candidate on both placements, every error printed
beside the share of the albedo that cell carries.

The candidate is **the surface's own specular albedo times the fraction of the lobe the rectangle
covers**, and the fraction is an ordinary polygon form factor taken in the space where the lobe _is_
a clamped cosine: an orthonormal frame on the lobe's dominant direction, scaled across it by the
lobe's width. That is a linearly transformed cosine with an **analytic** matrix instead of a fitted
one, so it needs no table, no texture unit and no polynomial — and both pieces it uses,
`quadFormFactor` and `envBrdfApprox`, are already in the shader.

Over cells a viewer could see, with the environment BRDF the shader actually has:

|                                   | shipped | candidate |
| --------------------------------- | ------- | --------- |
| rectangle on the mirror direction | 287.0%  | **41.1%** |
| rectangle straight overhead       | 287.0%  | **79.3%** |

and across the whole smooth range on the mirror placement, where the shipped term loses 99% to 100%
of the reflection, the candidate is **0.0% to 2.9%**.

**Each piece of it was measured rather than chosen.** The dominant direction against the lobe's
sampled direction, which agree to within a per cent — a frame on the mirror ray instead is worth
213% against 42%. The scale law by fitting one isotropic scale per grid entry, which lands at **2·α**
below about a quarter and **1.15·α** at α = 1.

**Shipped in 3.52.0**, on by default and on both backends, because today's picture was the wrong
one rather than a look somebody chose. `quadCoverage` in `lobes.ts` is the term and
`scripts/areaSpecular.test.mjs` holds the arithmetic behind it — a JavaScript mirror of shader code,
which cannot prove the GLSL and does stop the two measured constants being adjusted on taste.

_What is still open inside it_ is the anisotropy an isotropic scale cannot carry, which is the 40.1%
and is what a fitted matrix's shear terms are for. That is the row above, and it is not blocking:
the term is now closer to the integral everywhere than the one it replaced, at about the same cost.

### `drift/2d` could not be called, and DriftScript 1.11.0 fixed it at the import

**Filed and closed on 2026-09-03, which is the shortest round trip this file has recorded.** A
capability is reached through a namespace, and the namespace was `module.split('/').pop()` — three
copies of that line in the compiler, no alias anywhere. `drift/2d` derives `2d`, a number followed
by an identifier the lexer refuses before the checker sees the call. Five spellings were compiled
against the real registry and every one failed, while `ui.layout` and `terrain.heightAt` compiled in
the same harness, so the failure was the name and nothing else.

**Track F refused the module rather than shipping it.** A registered binding would have traded
`DS0301` — which says nothing here implements it, and is actionable — for `DS0003` inside a script
author's own call. It carried the `driftscript-2d` sentinel for exactly one day, which is the
mechanism working rather than a row going stale: the refusal was recorded, and what resolved it was
a release of the language rather than an edit to a list.

**The fix went where it belonged.** DriftScript 1.11.0 lets an import name its own namespace —
`import { sprite } from "drift/2d" as sprites` — at the import rather than at the derivation,
because a rule that turned a bad segment into a good identifier would be the language picking a name
on the author's behalf. `DS0139` refuses a namespace that cannot be written, where it is written,
with the line to write; and `link.test.ts` there now names every specified module needing one, so a
second cannot arrive by accident.

**The release found a second defect on the way**, which is the part worth keeping: its hot-path pass
looks a capability up by the callee written in the file, and its table was keyed by the module's own
last segment — so an aliased call would have missed it by _finding nothing_, which reads as a call
the pass has no opinion about rather than as a lookup that went wrong.

The engine's pin moved in three manifests and `drift/2d` is bound: twelve capabilities over a batch,
a sheet and a tilemap.

Kept short, and only where the number is worth remembering.

- **2026-09-02** — **a per-frame ceiling reports a number instead of a console line**, and three
  things were found on the way that are worth keeping.

  **A warning that never described the code.** `WebGPU: more than 1024 materials in a frame; the
rest reuse the last` went in alongside `if (material === null) return;` in one diff. The draw is
  skipped and always was. The two failures send an investigator to opposite ends of a renderer —
  wrong texture is a material question, missing geometry is a culling question — and the consumer
  that reported it spent its weeks on culling.

  **A sizing decision argued from that wrong failure.** The ring went from 256 to 1,024 on the
  strength of a comment reading _reads as a stretch of the world losing its texture and has been
  reported twice from a consumer_. The number may well be right. The argument recorded next
  to it was for a symptom the code cannot produce, which is worse than no argument, because the
  next person to weigh the memory reads it as evidence.

  **Two tests that stopped testing what they are named for, silently, in that same commit.** Both
  hardcoded the old 256 and issued 257 draws. Measured before the fix: 257 slots taken of 1,024 —
  they never reached the null return once. They pass because the restore they assert happens on the
  ordinary path too. Fixed by reading the ceiling off the renderer, so the next raise cannot unhook
  them.

  **The general shape.** Thirteen ceilings on WebGPU and none on WebGL2, with one warn-once each as
  the only signal. Both report the same line names now, WebGPU with its ceiling and WebGL2 with
  `null`, and `frameBudget.dropped` is a boolean a consumer's suite can fail on. **That was three
  of the lines on WebGL2 until 2026-09-19**, whatever this said; all fifteen now, each counted after
  the guards its WebGPU twin counts after, material changes by one shared rule, and a test running
  one scene through both backends and comparing every line.

  **And the two that measure how much world is in frame grow.** Growing _mid-frame_ stays refused
  for the reason `UniformRing` gives at its own `allocate`; growing at `beginFrame` is a different
  question and the answer is yes — everything outstanding has been submitted and no staging has
  been written. The cost is that the buffer is replaced and every bind group over it rebuilt, which
  for the flat pair is a path the file already had. The other eleven are feature counts — sixteen
  bodies of water, eight flocks — where a bigger ring answers the wrong question.

  **What one failing GPU wrote into this file.** This entry first recorded four things about this
  machine: that it offers no headless WebGPU adapter, that `--use-angle=vulkan` takes the GPU
  process down, that `scripts/batch-uniforms-check.mjs` cannot run on it at all, and that a WebGPU
  canvas reads back black. None of the four are true. The card was already failing while they were
  measured and it died outright an hour later, so each one is a symptom of that written up as a
  property of the hardware. After a reboot, on the same flags: the adapter is `vendor amd`,
  `architecture rdna-4`, `ring-growth-check.mjs` passes all seven of its assertions on it,
  `batch-uniforms-check.mjs` passes twenty-four across both backends, and the WebGPU shot of the
  rings page carries 197,880 lit pixels.

  **What reads as "no adapter" and is not one.** `navigator.gpu` is exposed only to a secure
  context, so a probe that opens `about:blank` to ask what the adapter is gets told there is none
  on a machine that has one. On `http://localhost` the adapter is there on the two flags
  `GPU_FLAGS` already carried, and `--enable-unsafe-webgpu` beside them changes neither answer —
  measured in both directions, since guessing at that flag is what a blank-page probe invites.

  **What the card measures that SwiftShader could not.** The picture. The frame that discovers the
  ceiling reads 165,527 lit pixels and the settled frame reads 194,650, matching WebGL2 to the
  pixel; with `growRings` disabled the settled frame stays at 165,527. Those 176 dropped quads are
  a 29,123-pixel hole in the grid, which is the assertion `nothing dropped` cannot make, that
  string being the renderer's own account of itself.

- **2026-09-02** — **spring secondary motion ships**, which closes the one ask inside a consumer's
  rig runtime request that was still genuinely open. The finding worth keeping is not that it works;
  it is what the purity test cost to satisfy.

  **A stepped integrator cannot hold the assertion the design rests on at any price worth paying.**
  Evaluating at `t` has to equal marching to `t` from the beginning of time, or the forgetting
  argument is decoration. Semi-implicit Euler missed a four-thousand-step reference by 0.058 at
  thirty-two substeps a period, 0.029 at sixty-four and 0.0075 at two hundred and fifty-six — a clean
  halving, which is what said the _integrator_ carried the error and not the lookback. Holding a
  hundredth took about a thousand substeps a period, three thousand per joint per frame.

  **The closed form was already in the design note and it took a measurement to go back and read
  it.** Subtracting the moving anchor's own trail — `-2ζ va / ω`, the offset a mass holds under an
  anchor moving at constant speed — leaves an _unforced_ damped oscillator, whose transition over a
  fixed step is a 2x2 that depends on nothing that changes inside the march. Error second order:
  1.7e-2, 4.1e-3, 1.2e-3 and 4.0e-4 at four, eight, sixteen and thirty-two, flooring at 2.3e-4, which
  is the reference's own error and not the sampler's.

  **A chain needed the assertion made again, and would have passed a weaker one.** Four links in
  series do not forget at their slowest link's rate: the cascade carries a polynomial in `t` beside
  the exponential. Cutting the lookback back to a single link's — in fact to something _longer_ than
  one link's — still fails the chain purity test, which is how that test was shown to have teeth.

- **2026-09-02** — **an uncompressed DDS decodes**, which was the last of that consumer's surfaces
  this reader would not take. **All 766 of them now decode and none is refused**, against 477 and
  289 an hour earlier.

  **A pixel format that describes channels rather than naming a compression**, so there is no block
  and no new arithmetic: a bit count, four masks and a copy. **One mask walk, no per-format branch**,
  because the masks _are_ the format — a reader with a case per layout is a reader with a case
  missing. Surveyed first rather than guessed at, and the five shapes those bundles carry are 210 at
  32-bit BGRA, 27 at 16-bit luminance-with-alpha, 23 at 32-bit RGBA, 15 at 8-bit luminance and 14 at
  24-bit BGR.

  **Three things it would have got quietly wrong, each with its own test.** A narrow channel scaled
  by a shift instead of by replication puts five bits of `0x1F` at 248, so a surface that should be
  white comes back very slightly grey on every texel. A 24-bit surface has no alpha channel at all,
  and a reader assuming four bytes a texel walks off the end of every row. And a declared row pitch
  is padding a decoder must skip, or it walks diagonally and returns the right picture progressively
  more sheared down the frame — which reads as a bad texture rather than as a bad reader.

  **Four surfaces come back black and are meant to.** They are the `metal_detail` maps of black
  skins, and the check was made rather than assumed: the raw bytes are `0 0 0 57` a texel, 199
  distinct values, RGB at zero with the mask living entirely in alpha.

- **2026-09-02** — **`kn5.ts` no longer binds Assetto Corsa's `txMaps` as a glTF ORM map**, which had
  every AC car's paint rendering at roughness 1.0 — the widest probe blur there is — while the file
  said 0.180. Reported from outside, re-measured here on the same bundles.

  **The channels are not that packing.** glTF's ORM is occlusion in R, roughness in G, metallic in B.
  Two independent references give AC's `txMaps` as specular intensity in R, reflection and specular
  _sharpness_ in G, and reflection intensity in B. Sharpness is the inverse of roughness, so a G
  pinned at 255 — which is what the paint map of every bundle measured holds — is a file asking for
  the sharpest reflection available and was being read as the bluntest. Measured, G against the
  material's own roughness: the i20 N 255 against 0.180, the Panda 255 against 0.140, the Giulia 255
  against 0.196. **R equals B** on all twelve of the i20 N's pinned materials, which no ORM reading
  explains either.

  **The half that needed no reference at all is why this could be closed now.** `roughness` is
  derived from `ksSpecularEXP` two lines above the binding and is correct; the shader _replaces_ it
  with the map's G rather than scaling it. So the reader computed the right number and discarded it
  for a channel `occlusionStrength: 0` already described as unestablished — about R alone, while G
  and B were consumed as if the packing were known. Not binding it is not a claim about what
  `txMaps` means: it is declining to assert a packing that is not there.

  **What is not established, and is not pretended to be.** The exact curve between AC's sharpness and
  this engine's roughness. `ksPerPixelMultiMap` is a Kunos shader with no public source, the Custom
  Shaders Patch reimplementation documents only its `_emissive` variants, and the two forum threads
  carrying the channel list refuse a fetch. A shader reference settling that curve is what would make
  the map's per-texel detail worth carrying properly, and is the condition for revisiting this.

  **The reader says so out loud**, once per model, rather than reading the texture past in silence —
  which is the failure this format's reader has now made three times.

  **The consumer's `paintReflectivity` wants re-tuning.** It is a hand-tuned constant in their
  `bodywork.drs`, settled by somebody looking at a car and saying it was wrong, and it was tuned
  against the old behaviour.

- **2026-09-02** — **the DDS reader takes both header spellings and BC2, and a BC3 defect went with
  them.** Reported from outside against six vehicle bundles, and every number below re-measured here
  against the same files.

  **Both spellings.** A `DX10` header states the format in a 20-byte extension rather than in the
  four characters at byte 84, and the blocks behind it are the same blocks — the consumer counted the
  bytes: 5,592,580 against 5,592,560 for the classic spelling of one 2048² BC3 chain, which is
  148 + 5,592,432 against 128 + 5,592,432. `resolveSurface` resolves either into one format name and
  one data offset, so nothing downstream knows which it read. A cube map, an array or a volume behind
  that header is **refused**, because a classic header cannot say those and taking one would answer
  with a picture rather than an error.

  **BC2.** Eight bytes of explicit four-bit alpha, one nibble a texel, scaled by replication so `0xF`
  arrives as 255 and not 240.

  **And the defect underneath.** `decodeColourBlock` was reached unconditionally, so it applied BC1's
  three-colour punch-through mode to BC3 — but BC2 and BC3 carry alpha in their own half of the block
  and their colour half is _always_ four-colour, whatever the endpoint order. A BC3 block written with
  `c0 <= c1` therefore decoded its fourth index to transparent black instead of to the interpolant.
  Invisible in every test this file had, because they all order their endpoints the other way. Found
  by reading BC2's specification, which says the same thing about the same bytes, and it has its own
  failing test.

  **What it recovers, on the real bundles: 31 of 766 surfaces**, all of which returned a 1x1 white
  pixel before — 19 at `DXGI_FORMAT_BC3_UNORM_SRGB`, one at BC1, and 11 DXT3. The nineteen are one
  car's paint, wheels, lamps, plate and seven interior maps, and they cost that consumer a _lighting_
  bug rather than a missing texture: white in an ORM map is roughness 1 **and** metallic 1, and a
  fully metallic surface in the flat shader has no diffuse and no sun term, so the bodywork became a
  blurred mirror of the field the car was parked in.

  **A consumer's workaround can go.** `blockDdsFromDx10` in their `scripts/dds.mjs` exists purely
  because this reader would not take the file; the release note names the format so they know to
  delete it.

- **2026-09-02** — **`shots.mjs` named every capture after the scene before it**, and the entry that
  found it was itself wrong because of it. `voxelSandbox` went to the front of `demo/index.ts`'s
  `SCENES` and never into `DEFAULT_SCENES`, so every index shifted by one: a file written as
  `storm-sea` was a picture of the wind field, `--scenes=4` selected a scene its own label did not
  name, and the last scene was never captured at all. A before-and-after diff still compared like
  with like — one index against the same index — which is exactly why it survived: the failure was
  in what the pictures were _called_, and only a person reading a filename could have caught it.
  `scripts/shots.test.mjs` reads `SCENES` out of the source and asserts the two agree, and it was
  watched failing on the old list.

  **What the mislabelled number really was.** Held at frame 420, 1280x720, rows 92 to 678:

  | scene      | WebGL2 against WebGPU |
  | ---------- | --------------------- |
  | storm-sea  | **614** of 750,080    |
  | wind-field | **68,864** of 750,080 |

  So the disagreement worth a paragraph belongs to the wind field, and storm-sea — the scene the
  first version of this entry named, and the one carrying a flock, arcs and rain — agrees.

  **The wind field's difference is the grass, and it is not a defect.** Every input is identical:
  the held clock is deterministic and two captures of one backend differ in 0 pixels. The scatter's
  per-draw uniforms come from a ring already, and its fragment block carries only frame-wide values
  — light, ambient, camera, atmosphere — so the two scatter calls in that frame write the same
  bytes. The generated WGSL is a term-for-term translation of the GLSL, `bend` included, and
  `wgsl:check` gates that. What is left is the shader compiler: ANGLE on Vulkan for WebGL2 and Dawn
  on Vulkan for WebGPU, free to contract multiplies and implement `sin` differently. Across 42,000
  thin blades a sub-pixel bend reaches a lot of pixels.

  **The scale says the same thing.** The backend difference is 68,864 pixels concentrated at a
  delta of 8 to 31, with 7 pixels past 64. One _frame_ of the same animation moves 191,437 pixels,
  9% of them past 64. The two backends are about a third of a frame apart on a blade, which is
  what a rounding difference in a bend looks like and is not what a lost draw or a stale uniform
  looks like.

  **What would change the answer:** a scene where the same difference appears on geometry that is
  not thin and not swaying. There is none today, and the two published scenes that draw scatter
  without wind agree.

- **2026-09-02** — **the four passes that shared a uniform slot each hold a ring now**, so a frame
  may draw as many bolt pools, flocks, wind-street lattices and caustic batches as it likes.
  Measured on `batches.html`, which draws two of each tinted red and blue, with WebGL2 as the
  control since it sets uniforms and draws in one stream:

  |              | batch 0 alone | in the frame with both, before | after  |
  | ------------ | ------------- | ------------------------------ | ------ |
  | bolts        | 4,492 red     | **0**                          | 4,492  |
  | caustics     | 21,088 red    | **0**                          | 21,088 |
  | flock        | 1,699 red     | **0**                          | 1,699  |
  | wind streaks | 1,023 red     | **0**                          | 1,003  |

  **The flock said more than the tint.** Both flocks drew at the _same centre_ under the defect, so
  the shared slot was carrying placement and not only colour — the blue count did not double, it
  stayed at exactly one flock's.

  **The assertion is colour presence rather than an identity, and the blend modes forced that.**
  Bolts add, caustics add, a flock is opaque and writes depth, and wind streaks are alpha blended
  and order-dependent. `both = solo0 + solo1 - background` covers the first two and nothing covers
  the last two, so what is asserted is that both signatures survive. Under the defect the first
  batch's signature does not merely shrink; it goes to zero.

  **A published scene drawing one batch each is unchanged**: `storm-sea` on WebGPU, before against
  after, **0 of 921,600 pixels differ** at a tolerance of 1. Its 78,403-pixel disagreement with
  WebGL2 is pre-existing and untouched — which is worth knowing and is a row of its own.

  Two instrument faults were found and fixed before any of these numbers meant anything: the
  margin that decides a signature was 18, where a wind streak's strongest pixel is a margin of 25
  and the count falls from 1,023 to 16; and the second streak field drew 134 pixels against the
  first's 1,023 until the two winds were made mirror images.

- **2026-09-02** — **a light volume can travel, and two of them in one frame do not share a uniform
  slot.** Both were open because nothing had ever drawn a second cone or moved one: `volume.html`
  drew a single cone at a fixed pose, and one cone is the arrangement in which a shared slot draws
  the right picture. `?cones=`, `?only=`, `?phase=` and `?warm=` are the switches;
  `npm run check:cones` reads the answers.

  **Two volumes in one frame are the sum of each drawn alone, to 0 of 844,800 pixels, on both
  backends, with nothing clamped.** So `drawLightVolume` really does take its uniforms from a ring,
  which was a claim in a comment until now — the hazard four other WebGPU passes still carry is
  absent here. **The check was watched failing at 21,292 pixels** with the last draw's strength and
  dust forced onto both draws, so it can see the defect it exists for.

  **A pose swept into over twelve frames is the pose drawn cold, to 0 of 844,800**, in haze, on
  both backends. Nothing the volume derives from the camera survives a frame.

  **Two controls, and the first one earned its keep immediately.** A first run reported 0 pixels
  differing three times on both backends and meant nothing: the second cone stood outside the
  ceiling's aperture, so the sun's map left it drawing almost nothing, and the two solo captures
  differed in 563 pixels of 844,800. A second version compared halves of the frame and failed on
  12,004 pixels of honest screen-space overlap between cones 6.4 m apart. The additive identity
  replaced the split and needs no guess about where anything landed.

- **2026-09-02** — **the tangent frame is derived after the weld**, in the baker, and the reader
  gained `deriveTangents` to let it decline. The default is unchanged, because a consumer reading a
  model straight into a renderer never welds and would otherwise lose normal mapping in silence —
  so this is an option arriving rather than public behaviour leaving.

  **Two figures in this repository disagreed about the size of it and both are right about
  different unwraps.** The frame is normalised, so two triangles differ only where the _direction_
  u increases in differs. A separable unwrap — u from x, v from y — gives every triangle on a flat
  surface the same frame, which is the 253-mesh CAD export's seven vertices of 728,168. A
  rotational unwrap turns the direction with position: **9,600 corners weld to 1,681 with no frame
  and 9,482 with one derived per corner**, six frames at one point at worst. Two versions of that
  measurement showed nothing before the third, both because they unwrapped separably, which is the
  shape of a test that passes with the bug present.

  End to end through the real baker, `scripts/bake-weld.test.mjs`: a normal-mapped soup bakes to
  **169 vertices against 830** on the old order, and the test was watched failing on it.

- **2026-09-02** — **the baker re-encodes a decoded DDS**, so a block-compressed texture no longer
  triples. `encodePng` sits beside the decoder in `packages/core/scripts/png.mjs`: `node:zlib`, one
  filter chosen per row by the sum of absolute residuals, about a hundred lines, and nothing a game
  links. On the test's flat 64x64 surface, 16,384 bytes of RGBA became 259.

  **The unit tests are the wrong oracle for half of it, so a browser was used for that half.**
  `decodePng` in the same file never reads a CRC, so an encoder writing zeros there would round trip
  through it perfectly and be refused by every browser at `createImageBitmap`. Loaded into headless
  Chrome through the repository's own launcher, drawn and read back: **0 of 12,288 samples differ**.
  A first run showed 576 samples differing by 1, which was the canvas premultiplying alpha at 128
  and not the encoder — proved by re-running opaque, where the difference is zero.

  **The baker had no test at all**, which is how this stood for three minor versions.
  `scripts/bake-textures.test.mjs` is its first: it builds a BC1 DDS and a `.gltf` around it, runs
  the real baker, and reads `TEXS` back **by the layout `FORMAT.md` states** rather than with this
  repository's reader, since a reader and a writer sharing a mistake agree with each other. Run
  against the old baker it reports codec 4 and 16,384 bytes, which is the defect exactly.

- **2026-09-02** — **the loader's draw-call grouping key is exported**, so the copy a consumer's
  baker kept of it no longer exists. `drawKeyOf` and `resolveDrawGrouping` are in
  `@driftengine/assets`, and `DrftLoader.uploadOne` calls them, which is what makes the two
  impossible to separate — the inline key it used to build is gone rather than duplicated. The
  test asserts one case per field rather than looping the ten names, because the defect being
  closed is a field going missing and a loop cannot fail for an eleventh that nobody added to it.

- **2026-08-25** — **the frame graph is on by default**, which two defects had blocked and which
  neither a test nor a picture had been able to name. All seven published scenes are **0 of 921,600
  pixels changed** with it on against it forced off, whole frame, and no device errors on either
  path, measured on an AMD RX 9070 XT. `graphVerbFlushes` was already 0.

  **Both defects were the same shape and only recording could expose them: a decision taken at one
  moment being used at another.** A verb resolved its pipeline through `targetPipelines()`, which
  answered "which pass is open _now_" when the question is "which pass will this land in" — and for
  a recorded draw those are separated by the whole of a flush. And `bakeReflectionProbe` never
  replayed what `drawFace` recorded, so **not one draw reached the cube**: six with the graph off,
  zero with it on. A probe stored its clear colour and nothing else, a mirror reflected an empty
  room with no error anywhere to say so, and the six orphaned records were replayed into whichever
  pass opened next. The mirror had stated that rule in its own comment for months — what is
  recorded and not yet replayed belongs to the pass that is about to end — and a bake was the
  fourth such boundary and the only one never given the treatment.

  **The fix's own "what would make this wrong" clause was falsified within the hour**, which is the
  most useful thing here. It said nothing legitimately wants the scene's pipelines after the frame
  is presented; a probe bake does, and the showroom bakes after `endFrame` because that is when its
  model finishes streaming. Routing it to the overlay cache put a one-sample pipeline into a
  four-sample face — the original fault, inverted. `targetPipelines` now follows `openPass`'s own
  order, and the two are noted as answering one question so a branch added to either is added to
  both.

  **Three traps, each of which cost real time.** `submitMesh` returns on its first line unless
  `viewProj` is set and only `bindMeshPass` sets it, so both earlier repro attempts drew without a
  camera and never reached the code they were about — one failed identically with the fix and
  without it, and that was read as the fix not working. A test that asserts on a _sample count_
  rather than on **pipeline identity against the two caches** cannot tell the two failure
  directions apart. And a dev server left running for hours **served a stale transform behind an
  HTTP 200**, so a whole round of captures measured code that was not being run; see `AGENTS.md`.

- **2026-08-24** — both renderers now release every registered pass and compute definition when
  they are disposed, and empty the registry that held it. `unregisterPass` and `unregisterCompute`
  always released the one they removed; nothing called either on teardown, so a private field went
  out of scope and a definition kept its pipeline, its bind group and its buffers — per
  registration, per renderer, for as long as the process lived. The drain is one shared
  `drainRegistry` in `handleRegistry.ts` rather than a loop written four times, because two copies
  of a lifetime rule are two chances to get it wrong. **The order is the load-bearing part**: on
  WebGPU the registries are drained _before_ `surface.dispose()`, which ends in `device.destroy()`,
  and a definition releasing a buffer against a destroyed device is how this fix becomes the bug it
  replaced. The two backends guard differently on purpose — WebGL2 tells a definition only while it
  still has a context, since deleting a dead one's objects is the INVALID_OPERATION its own
  teardown already counted 48 of, where a lost WebGPU device swallows the call instead. Six tests
  hold it, three per backend: released once on teardown, not again once unregistered, and on
  WebGPU the drain ordered ahead of the device going. It was found while building the compute seam
  and left then deliberately, as a pre-existing gap in the pass surface rather than one the seam
  introduced — and it is the seam every contributed pass and kernel registers into.

- **2.5.3** — `beatMap.test.ts` was intermittently red because its _fixture_ was cut from
  `Math.random`, not because the analyser is nondeterministic. Measured at **5 failures in 6,000
  draws**, about **one run in 1,200**: an unlucky burst puts enough of the hi-hat in the kick band to
  clear its adaptive floor and report a single beat. The entry this replaces guessed **one run in
  three** from a single observation, which is 400 times the real rate, and 24 consecutive green full
  runs — 8 of them on a saturated 24-core machine — are what showed the guess was wrong before any
  threshold was touched. The fixture is pinned to a seed; **no detector threshold was changed**,
  because the measurement said the detector was not the problem.

- **2026-08-25** — the WebGPU shadow pipeline got the raster offset it never had, `depthBias: 4`
  and `depthBiasSlopeScale: 1.1`, matching `gl.polygonOffset(1.1, 4)` on the other backend. It had
  been measured at 2,178 pixels and filed as minor, and that measurement could not see what
  mattered: the pass was storing the _far_ side of every caster because its winding was inverted,
  and a caster's own thickness is an enormous accidental bias. 2.4.1 corrected the winding and
  removed the masking with it. On this repository's scenes it moves gilded-chamber 5,555 pixels,
  night-court 1,468, day-clock 565, collapse 222 and two scenes zero, with cross-backend parity a
  wash. **It is not the cure for the edge speckle reported the same day**, and the entry above says
  why: the shader's own 14 cm tolerance already dwarfs it.

- **2.4.2** — the light-volume cap was raised from 16 to 32, and it was **most of one world's
  parity difference** rather than a theoretical asymmetry. Twenty-six worlds of a consuming
  application were instrumented at the call: only six ask for a volume at all, the largest asks for
  **24**, and the next two ask for **15**. So sixteen sat inside the range worlds are built in, and
  the largest was losing eight beams on every frame anybody photographed. Against WebGL2 that world
  went from 34,827 pixels at mean delta 20.84 to 21,407 at 3.52. The whole ledger entry is in
  the WebGPU parity design, including the way the probe reported zero for
  every world until it stopped guarding on its own existence and started guarding on the renderer's
  identity: a scenario switch builds a new one.

- **2026-08-22** — text drawn after `endFrame` was a silent no-op on WebGPU and drew normally on
  WebGL2, for as long as anyone had been drawing it. `canDraw` allows an overlay past
  `framePresented` and `openPass` opens one; `openTextPass` read the encoder `endFrame` had nulled
  and returned first. Invisible whenever anything _else_ opened the overlay, which the engine's own
  demo always did by drawing an inset beside its label. Found by forcing a persistent message in a
  a consumer and counting branches: 456 `drawText` calls past every guard, 456 nulls.

- **1.4.2** — pipeline compilation moved off the main thread and in front of the first frame. A
  handset went from a 5.2 second frozen frame to a worst frame gap of 60ms.
- **1.4.2** — shader modules cached per source per device instead of built per pipeline that names
  them.
- **1.4.2** — a mesh builds a pipeline for the target it is drawn on rather than both.
- **1.1.0** — `storeOp: 'discard'` on terminal resolving attachments, the WebGL2 resolve
  invalidate, and a cap on live cubemap bakes.

## Convex decomposition bulges on a fat curved tube

**2026-09-03, measured rather than suspected.** `decomposeConvex` seeds from maximal axis-aligned
boxes, which is what makes it stable — a box is convex at every resolution, and the region growth it
replaced produced hulls that swallowed a cavity at one resolution and not the next. The cost of that
choice shows on a shape that curves in two directions at once.

A torus of major radius 1 and minor radius 0.35, decomposed into sixteen hulls, comes back at **27.0%
summed volume over the source and 16.2% occupied**. The gap between the two is overlap counted twice,
so the collider bulges by a sixth while a mass computed from it is out by a quarter.

**The part budget is not what binds.** The same torus measures 26.7% at eight parts and 20.6% at
thirty-two, and reaches the same figure with the merge's hull-measured tail switched off entirely. So
the merge is not choosing badly; the seeds cannot follow the curve. Every other shape in
`npm run check:decompose` is between 0% and 6.5%.

**What would improve it**, in the order worth trying:

1. **Seeds that follow curvature.** A region grown along the surface normal rather than along the
   axes would chord the ring instead of stepping across it.
2. **Splitting by a fitted plane instead of merging boxes.** The top-down family this design declined
   at §1; the reason it was declined was the mesh clipping it needs, and that reason has not changed.
3. **A tighter support set on curved regions.** Fifty directions leave a support hull inscribed in
   the true one, which shows in coverage at 89% on this shape against 100% on the boxy ones.

_What would make this urgent_ is a consumer whose collision reads as too fat on a curved body — a
pipe, a roll bar, a wheel arch. Nothing has reported one.
