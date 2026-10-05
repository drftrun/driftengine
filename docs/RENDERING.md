# Rendering — the pass chain, and what each effect cost to build

**How the picture is made, and what was learned making it.** Separate from `FORMAT.md`, which is
about getting geometry _in_: this is about what happens to it once it is on screen.

**It is no longer the list of what is missing.** `CAPABILITIES.md` holds that, with a test behind
each row, and `ROADMAP.md` says in what order the gaps close. What stays here is the part neither
of those can carry: for every effect that shipped, the versions that looked plausible and were
wrong, and the measurement that settled it. Several of those cost a release each and are the
reason a second attempt does not have to.

**Everything here is opt-in.** The six published demos are tuned as they stand and a new
effect that changes them by default is a regression however good it looks. The pattern is
already established twice, by `setSurfaceGrain` and `setSurfaceReflectivity`: a pass property
whose default reproduces the old behaviour exactly, so a scene written before the feature
existed renders unchanged.

## Where this plan stands (engine 1.4.2)

| Item                                | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §1 Anti-aliasing                    | **done.** `sceneSamples`, multisampled off-screen target, default 1. The demos ask for 4 and the game gives it for free with an opt-out.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| §1a Grain as a material property    | **done.** `MeshData.grain`, `MeshBuilder.setGrain`, `ATTR_GRAIN`, `vGrain`. Absent means none.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| §1a The pattern itself              | **done.** 6% swing rather than 18%, and a second coarser octave.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| §2 Camera motion blur               | **done.** `cameraMotionBlur`, default 0. Reprojects through the previous view in the composite pass. Needed depth as a texture, which ambient occlusion will also want.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| §3 Reflection probe                 | **done.** `reflectionProbeSize` and `bakeReflectionProbe`, default off. Six faces into a mipmapped cubemap, once; roughness picks the mip. **Whether it fits is now a backend question** — see §3.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| §4 Ambient occlusion                | **done.** `ambientOcclusion` and `ambientOcclusionRadius`, default 0. Its own pass into a single-channel target, then a four-wide depth-aware blur, then the composite multiplies. 0.18 ms at 1.46 MP.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| §4 Shadow filtering (PCF)           | **done, and this row was wrong.** Both paths filter: a rotated Poisson disk on the directional cascade with receiver-plane depth gradient compensation, and a golden-angle disk on the omnidirectional path with a penumbra estimated from the source radius. `shadowFilterTaps` budgets both. The omnidirectional filter spans a pair of pixel columns and is folded back together after the lamp loops, which is one mechanism rather than two. See below.                                                                                                                                                                                                                                                                                                                          |
| §4 Texture filtering                | **partly done.** `SurfaceTexture` takes an `anisotropy` option and applies it where the extension is present. What is missing is any caller asking for more than the default, which is the tyre-tread case.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| §4a Bloom                           | **done in 0.30.0, corrected in 0.31.0.** The threshold measures the largest channel rather than luminance, because luminance weights blue at 0.0722 and a world built out of coloured light bloomed by zero pixels. Identical to the old behaviour on neutral grey, so it can only ever bloom more.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Relief from a surface texture       | **done in 1.4.0–1.4.1.** `setSurfaceTextureRelief` takes the bound texture's own luminance onto the shading normal, and procedural relief fades where a pixel covers more than a bump, so a road at a grazing angle reads as aggregate rather than as noise.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| A rough wet film                    | **done in 1.4.1.** `FilmOptions.roughness` and `roughnessCyclesPerMetre`, the same quantity `setSurfaceRelief` takes. A film patch over a textured surface no longer meets the dry surface at a mirror rim.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| A scene target that keeps its range | **done.** `hdrScene`, default off. Half floats in the scene target and the grade moved to the resolve, so a value above 1 survives the composite. It is the prerequisite for anything that reacts to brightness, and it is not neutral: see the option's own note for what it moves.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Bloom                               | **done.** `bloom` and `bloomThreshold`, default 0, plus `setBloom` as the per-frame dial. A prefilter that subtracts the threshold, six halvings and a tent added back up, composed with `outputTransform` rather than replacing it. Wants `hdrScene` and says so at construction if it does not have it. Brightness is the largest channel rather than luminance, corrected in 0.31.0 after a saturated source proved unable to cross the threshold at all. What is not measured is the cost: see below.                                                                                                                                                                                                                                                                             |
| The visual gate                     | **done, and it is engine code**: `scripts/shots.mjs` over `browser.mjs`, `cdp.mjs`, `png.mjs` and `frames.mjs`. Two captures of a held frame, compared by brightness band, with a check that refuses to measure on a software renderer. Every row in this table from here on is expected to arrive with output from it.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| §4 Tone mapping options             | **done as a dial, and the measurement half is deliberately not built.** `outputTransform` and `outputExposure` are the construction-time grade; `setOutputExposure` is the per-frame dial, so a scene with both a lit showroom and a dark interior in it can move between them. What is not built is the engine _measuring_ the frame to pick a number, which is written out below.                                                                                                                                                                                                                                                                                                                                                                                                   |
| §5 Depth of field                   | **done, 2026-08-27.** `depthOfField` is the construction-time ceiling and `setDepthOfField(distance, range, scale)` the per-frame dial, both in metres. A circle of confusion from the depth buffer and an eight-tap disc, spliced into the composite from `depthOfField.ts` rather than given a pass of its own. The foreground halo is handled by weighting each tap on whether it is behind the pixel it blurs into; a _near_ field spread over a sharp background is something a gather cannot do and is said rather than approximated.                                                                                                                                                                                                                                           |
| §5 Occlusion culling                | **done, and on the CPU.** `occlusionCulling` is the buffer's width, `addOccluder` declares a box things may hide behind, and `occluded` answers. A hardware query is a frame late and spelled differently on the two backends; a GPU pyramid needs a readback that stalls or a compute shader WebGL2 does not have; neither can be asserted without a GPU. So it is arithmetic: back faces rasterised into a small buffer, eroded by a texel, reduced into a max pyramid, and a rectangle test against the object's nearest point. 60 of 76 draws removed with zero pixels changed, on both backends.                                                                                                                                                                                 |
| §5 Frustum culling                  | **done, and a consumer could not find it.** `cullDraws` is the renderer doing it from inside `drawMesh`, which saves the GPU's share and nothing else: the caller has already walked the drawable, built its model matrix and switched material by the time it is asked. `renderer.visible(bounds, model)` is the same test offered before any of that, `MeshHandle.bounds` is what to pass for a mesh, and **`boundsOfBox` builds one for a region a consumer names itself** — which is what a streamed world wants, since it knows its 68 squares and would otherwise test the 1,620 meshes standing on them. Reported from outside 2026-08-30: every piece existed except the last one, and nothing here said so.                                                                  |
| §5 A mesh upload that can stop      | **done, and it is the whole of a consumer's slow frames.** A game streaming a world in 500 m squares budgeted its build at 4 ms and honoured it, then made that square's two dozen GPU handles in one burst outside every budget: a 66.5 ms frame of which 57.2 was `createMesh` alone. Spreading a square over its groups is not enough — one group was 248,928 of its 367,542 triangles — so `createMeshIncremental` divides the group, returning a usable handle at once and an iterator that moves a quarter of a megabyte a call, driven under `StepBudget`. WebGPU divides the interleave and the write; WebGL2, which has no interleave and **must not grow one**, divides by attribute. Nothing incomplete is drawn, and a lost device ends the upload with `complete` false. |

---

## 1. Anti-aliasing — done, through a multisampled off-screen target

**Reported as "too much rawness on the rendered models", and the report is right.** Edges on
an imported model are hard-stepped, most obviously along a sword or a panel gap seen at a
shallow angle.

The cause is specific rather than an omission. `Renderer` asks for
`antialias: !this.quality.screenEffects`, and the reasoning behind that is sound and
measured: with screen effects on, the scene is drawn into an off-screen target and the only
thing reaching the default framebuffer is one fullscreen triangle, which has no interior
edges to multisample. Forcing `antialias: false` there moved `gl.SAMPLES` from 4 to 0 with
identical screenshots, and saved a multisampled backbuffer and a full-screen resolve every
frame.

The half that was never finished is that **nothing replaced it**. So today:

| Screen effects   | Anti-aliasing                      | Result                                |
| ---------------- | ---------------------------------- | ------------------------------------- |
| off              | MSAA 4x on the default framebuffer | smooth, but no post-processing at all |
| on (the default) | none                               | every effect, and hard edges          |

Two ways out, and they are not equivalent.

**A multisampled off-screen target.** WebGL2 has `renderbufferStorageMultisample` and
`blitFramebuffer`, so the scene target can be multisampled and resolved into the texture the
post chain reads. This is true anti-aliasing: it works on geometry edges, it does not touch
texture detail, and it costs what MSAA has always cost, which is memory bandwidth
proportional to the sample count. It needs `sceneTarget.ts` to grow a resolve step and the
sample count to become a quality option, defaulting to 1 so nothing changes for anyone who
does not ask.

**Post-process AA in the composite pass.** FXAA is about forty lines in the shader that
already runs, costs one pass over the image regardless of scene complexity, and works on a
resolved image so it smooths shader aliasing and specular sparkle as well as edges. It also
softens texture detail slightly, which on a 4K base colour map is a real loss.

**Built.** `RenderQualityOptions.sceneSamples`, defaulting to 1 so nothing changes for anyone
who does not ask. `sceneTarget.ts` allocates a multisampled colour and depth pair when a
caller asks for more, draws the scene into it, and blits down into the texture the post chain
already reads — so everything downstream of the resolve is untouched, which is what keeps it
a quality option rather than a second rendering path.

The sample count is clamped to what `MAX_SAMPLES` reports and the framebuffer is checked for
completeness, falling back to no multisampling rather than to a black frame; a request that
was clamped says so once at init, because a quality setting that silently does not apply is
the failure `capabilityClamp` already exists to avoid.

Measured on the storm scene's lighthouse against the sky, at a held frame, on the machine's
real GPU: at 4x the edge spreads over 1.65x as many pixels, the mean luminance step across an
edge falls from 46.6 to 27.7, and steps above 40 — the hard ones — drop to 0.60x. That is
one hard step being replaced by several partial ones, which is what multisampling is.

FXAA is still worth having afterwards as the cheaper option for weak hardware. They compose:
a device that cannot afford 4x can take FXAA instead, which is exactly the shape
`RenderQualityOptions` exists for.

---

## 1a. Grain must become a material property, not a proxy for one

**The next thing to build, and it is small but not a tweak.** Procedural grain has now been
misapplied twice, and each fix was a better guess rather than an answer.

- It was gated on `vSpecular > 0.0`, which meant "this is stone" only while stone was the
  only shiny thing in the world. An imported car made paint, chrome and glass look sanded.
- It is now weighted by `vRoughness`, which is closer, and still wrong: the lighthouse tower
  in the storm scene is painted masonry at roughness 0.55, so it takes 55% grain and a white
  painted building reads as marble.

The reason no weighting will work is that **the two properties are independent**. Painted
plaster is rough and has no grain. Polished granite is smooth and has strong grain. Roughness
is how widely a surface scatters a highlight; grain is whether the surface has visible
mineral structure. Deriving either from the other is guessing, and the guess has now been
wrong in both directions.

**The fix is the same shape as `specular`, `uvs`, `emissiveColor` and `roughness`**, all of
which are optional per-vertex attributes that a mesh either carries or does not:

- `MeshData.grain?: Float32Array`, and a `MeshBuilder.setGrain(amount)` beside `setRoughness`,
  so a scene says which surfaces are mineral while it is building them
- a new `ATTR_GRAIN` bit in `.drft`, which is additive under §4.4 rule 4 and costs a minor
  version, plus its place in the frozen attribute order
- `vGrain` in the shader, replacing `uGrain * vRoughness` with the value the surface stated
- absent means **zero**, so a mesh that never mentions grain has none, and `weld.ts` drops the
  attribute when it is constant

`setSurfaceGrain` stays as the pass-level override, for an imported model that declares
nothing and should have none.

The cost of getting this wrong is worth stating, because it is why it is worth doing properly:
grain is _the_ thing standing in for texture in an engine that ships no images, so a wrong
answer does not look like a missing feature. It looks like every surface being made of the
same material.

### And the pattern itself is too strong, which is a separate problem

Placement is only half of it. The gilded chamber's papyrus columns are sandstone at
`ROUGH_STONE = 0.88`, so they take 88% grain — and they are _genuinely_ mineral, so an
attribute would leave them exactly as they are. They still read as marble rather than as
sandstone.

So the constants want revisiting on their own terms:

```
GRAIN_SCALE = 26.0   // cycles per metre
GRAIN_FLOOR = 0.8
GRAIN_CEIL  = 1.16   // a swing of about 18% either side
```

An 18% brightness swing is a lot. It is enough to read as _veining_ — a pattern with
structure, which is what marble is — rather than as a surface being slightly uneven, which
is what the comment above the constants says it is for. Two things to try, and both want
looking at rather than reasoning about:

- **A narrower swing**, nearer 5 to 8%, so it reads as unevenness rather than as figure.
- **Scale with the surface, not with the world.** 26 cycles per metre is one frequency for a
  column, a floor tile and a cliff, and the eye reads a repeated frequency across objects of
  different sizes as the same material. A per-material scale would let sandstone be coarse
  and plaster fine.

Do the attribute first, because it is the one that is unambiguously right. Then tune the
constants with the demos open, since this is a look question and the only instrument for it
is a screenshot.

## 2. Motion blur — camera blur done, per-object deliberately not

Wanted, and worth being precise about which kind, because they have very different costs and
only one of them suits this engine.

**Per-object motion blur** needs a velocity buffer: each mesh writes its own screen-space
motion into a second render target, which means a second set of matrices per draw and a
wider G-buffer. That is a structural change to a forward renderer that currently writes one
colour target.

**Camera motion blur** needs only the previous view-projection matrix, which the renderer
already has every reason to keep. Reproject each pixel through it, sample along the
difference, done in the composite pass. It covers the case that actually matters here — a
camera whipping round a turntable or through a world — and costs one pass and no change to
how anything is drawn.

**Start with camera blur.** The fixed-timestep loop already separates simulation from render
and hands an `alpha`, so the previous matrix is available without anything new being tracked.
Per-object blur can follow if something ever moves fast enough relative to a still camera to
need it, which in practice is rare.

The trap, recorded before anybody hits it: blur must be computed from the **render**
interpolation, not from the simulation step. Sampling along a velocity derived from the fixed
step makes the blur pulse at 60 Hz against a display running at any other rate, which reads
as a stutter that gets blamed on the frame pacing.

---

## 3. Environment reflection, properly

`setSurfaceReflectivity` currently mixes toward a sky-and-ground gradient weighted by Fresnel.
It restores the tonal range a mirror surface has and it is honest about being an
approximation, but there is no scene in it: a car body cannot show the room it is standing
in, or the four panels above it.

Two candidates. A **reflection probe** renders the scene once into a cubemap from a point and
samples it, which is general, costs six faces to bake, and can be baked once for a static
room. **Planar reflection already exists for water** and could be extended, which is cheaper
and exactly right for a showroom floor, and useless for a curved surface.

A probe is the general answer and the showroom is the case that wants it.

**Built.** `ReflectionProbe` renders six 90° faces from a point into a mipmapped `RGBA8`
cubemap, once, when the caller says the room is finished: `bakeReflectionProbe(origin, clear,
drawFace)`, six calls of a callback that submits the scene **into the mesh pass**, which is not the whole frame: anything a scene draws afterwards, particles, light volumes, the sky, is absent from the probe unless it moves into that pass.
The mirror direction in `flat.ts` then samples that instead of the gradient, at a mip level
chosen by roughness — which is the cheapest honest gloss blur there is, a fetch rather than a
pass. Nothing per frame.

Two things it had to be careful about, both of which would have been silent:

- **It is the seventeenth binding, and whether that fits is a backend question.** This row
  once said the probe declines wherever there is no unit spare, full stop. That is still
  exactly true on **WebGL2**: the lit pass binds 0 to 15, sixteen is what the specification
  guarantees, every Apple GPU reports exactly sixteen, and `textureUnitBudget.test.ts` holds
  the arithmetic. Dropping point shadows to make room would trade something every scene uses
  for one material's reflection. The sampler is _cut out of the shader source_ rather than
  declared and multiplied by zero, because a declared seventeenth sampler defaults to unit 0
  and shares it with a `sampler2D` shadow map, which is undefined rather than merely wasteful.
  `flat.test.ts` asserts its absence.

  **On WebGPU the probe fits, and has since the `wgsl:share shadow` markers landed.** Textures
  and samplers are counted separately there, and the fifteen shadow bindings share one sampler
  declaration because they were already one object — so the widest permutation asks for
  seventeen sampled textures and **three** samplers against an adapter offering forty-eight and
  sixteen. `probeFits` in `backend/webgpu/renderer.ts` checks both ceilings and warns naming whichever
  one bit. Reflective surfaces keep the gradient only where a device genuinely cannot afford
  it, which on that backend is now rare rather than usual.

- **A probe must not sample itself.** While the faces are being rendered the cubemap is
  attached to the bound framebuffer, so during a bake the uniform goes to zero _and_ the
  placeholder cube is bound, for the same reason `emptyTexture.ts` exists.

Measured on the showroom at a held frame, black paint, probe on against probe off from separate
dev servers: 17,313 pixels change, by at most 44 of 255, and every one of them is on the car.
The roof and the shoulder pick up the ceiling and the panels above them, which is what the
gradient could never supply.

---

## 3a. Point-shadow seams — the fifth attempt, and the one that worked

Four attempts went into widening `MAX_FILTER_RADIUS` and every one of them failed, so the cap sat
at 0.07 — near its floor — and point shadows stayed crisp where they should have been soft. This is
the version that worked and why the other four could not have.

**What the reports said.** Straight lines radiating outward from directly beneath a light, across
everything it touched. Seven of them, in different scenes. The word that finally identified the
cause was _radial_: lines from a point are where the six faces of its depth cube meet, projected
onto the ground.

**The four that failed, in order.**

1. **Widen the filter.** Made it worse, and that was the clue nobody read at the time: a wider
   angular filter is _more_ likely to straddle a face boundary, not less.
2. **Shrink the filter near a seam.** Could never work. The centre tap is already on the wrong side
   of the disagreement, so narrowing the disk around it changes nothing about what it reads.
3. **Bias harder near a boundary.** Bought a few degrees of tolerance and cost light leaking under
   anything standing diagonal to a light. It treated a marginal comparison, and the problem is not
   marginal: with `CLAMP_TO_EDGE`, a direction past a face boundary reads that face's _edge texel_,
   which holds the depth of whatever happened to be at the edge of a different 90° projection. No
   amount of bias fixes a stored depth that belongs somewhere else.
4. **Clamp the direction inside its own face.** This one worked, and it is why the cap could be
   held near the floor at all — but it caps the filter as a side effect, because a tap that cannot
   leave its face cannot open wide.

The fourth attempt is also what identified the real shape of it: **the light pool looked right
until a column entered it.** With no occluder the penumbra estimate is zero, the filter stays at its
floor, and nothing crosses a seam. The instant a caster is found the filter widens. The artefact was
never the columns' shadows — it was the search for their penumbra.

**The fix is not a filter change at all.** An octahedral map is _one_ projection over the whole
sphere. There is no second projection to disagree with, so there is nothing for a tap to cross, and
all four defences delete: the direction clamp, the flat tolerance, the boundary bias and the seam
guard. Every tap is still an angular perturbation of a direction, so nothing offsets in UV and the
map's border needs no wrap arithmetic — a tap that would have crossed a cube join lands on the
adjacent texel. See `shaders/octahedral.ts`.

**Then the cap could open, and it opened to 0.25 rather than as far as it goes.** The filter width
and the strength fade are driven by the same quantity: at `sourceRadius * spread` of 0.625 the
penumbra has swallowed the shadow entirely and there is nothing left to blur, and at 0.25 it is
still at 84% strength. Past about 0.25 the filter is scattering taps across the map for softness on
something already fading out. A sweep at 0.07, 0.15, 0.25, 0.40 and 0.625 was captured on both
point-lit scenes: no value drew a line, a band or a speckle, and **the GPU timings were too noisy to
choose on** — two runs of one build differed by more than two runs of two builds, so the number
comes from the arithmetic rather than from a stopwatch. Recorded because the temptation next time
will be to read a single timing and believe it.

## 4. Smaller things, in rough order of value

- **Ambient occlusion — done.** Contact shadows where geometry meets, which is most of what
  makes an imported model sit in a room rather than float in it.

  Three things came out of building it, and each of them cost a version that looked plausible:

  **A fragment shader's samplers default to `lowp`, and `precision highp float` does not
  change that.** It sets the default for `float`. A lowp sampler may hand back eight bits, so
  the depth arrived as a scene collapsed onto a couple of hundred planes: the reconstructed
  normal came out (0, 0, 1) over every surface, because inside one of those planes the depth
  does not change between neighbouring pixels and the cross product of the derivatives has
  nothing to work with. On screen it was contour banding — rings up the car's flanks, stripes
  across a floor, a topographic map of the quantisation. `uniform highp sampler2D uDepth` is
  the whole fix. **Camera motion blur had been reprojecting through that same eight-bit depth
  since it shipped**, and the 2D shadow maps in `flat.ts` already carry the qualifier, so the
  lesson was half-learned here once before.

  **Twelve taps used raw is salt and pepper, not shading.** Estimating occlusion inside the
  composite pass and multiplying by it directly was the first version and it is not a
  near-miss, it is unusable. The estimate needs its own target and a blur, which is what every
  renderer that ships this does.

  **The estimator's epsilon is a length, not a float guard.** At 1e-4 the nearest taps carry a
  weight of ten thousand, so a depth quantised to a millimetre invents several units of
  occlusion and a flat floor renders as static. It belongs at the scale below which two
  samples are the same surface: 0.01 m², a tenth of a metre.

  Built as `AmbientOcclusionPass`: the Alchemy estimator over 12 taps whose rotation repeats
  on a 4x4 tile, into an `R8` target, then a separable four-wide blur weighted by view-space
  depth so it will not carry a car's occlusion onto the wall behind it. Four pixels of blur is
  exactly one period of the rotation, so every blurred pixel averages all sixteen turns and
  twelve taps buys a kernel of 192. Measured on the chamber scene at 1280x1144 with the GPU
  timer moved to cover the composite: **4.22 ms to 4.40 ms**, so 0.18 ms for three
  full-frame passes. The six published scenes are bit-identical with it off, checked on held
  frames rather than asserted.

- **Shadow filtering — done, and the entry that once sat here was stale.** Both paths have
  been filtering for a long time: `DIRECTIONAL_PCF_OFFSETS` is a twelve-tap Poisson disk with
  receiver-plane depth gradient compensation, and `PCF_OFFSETS` is a twelve-tap golden-angle
  disk perpendicular to the light ray. Both are budgeted by `shadowFilterTaps`.

  **The point filter is a pair of pixels rather than one, and that is the part worth knowing.**
  Its taps turn by half a golden angle on every other pixel column, and `main` folds a pixel
  together with its neighbour once both lamp loops are over, so each pixel is shaded by the
  pair's twenty-four places while paying for twelve. Neither half stands alone: the turn on its
  own draws the tile as a one-pixel comb, and the fold on its own has nothing to fold. It is the
  same pairing the ambient-occlusion pass describes between its rotation tile and its blur, at
  the smallest size that needs no second pass — which matters here because the lit pass is the
  last thing to touch the frame and there is no blur behind it to hide a noisy estimate in.

  **What this replaced was a per-fragment hash**, and that is what made a penumbra stipple:
  twelve taps are a coarse estimate, and turning them by an unrelated angle at every pixel makes
  each pixel's error independent of its neighbour's. Two games reported the same coarse
  cross-hatch across a light pool. The fold is also why the derivative lives in `main` rather
  than beside the taps — inside the light loop the control flow is not uniform, so no derivative
  there is defined.

  `MAX_FILTER_RADIUS` is 0.25. It was 0.07 for as long as the map was a cube, because a wide
  angular filter crossed face seams and a tap across a seam read a face rendered under a
  different 90° projection — straight lines radiating from beneath the light, in seven separate
  reports. An octahedral map is one projection over the whole sphere and has no join to cross.
  Softness is still carried mostly by `PENUMBRA_FADE` fading the shadow out with distance from
  its caster, which changes how much a tap counts rather than where it samples.

  Anyone reopening this should read `pointShadow` in `shaders/flat/` first, and
  `packages/core/src/render/shaders/pointShadowFilter.test.ts` for what the tap set has to be.

- **Texture filtering.** `SurfaceTexture` takes anisotropy where the extension is present, and
  nothing currently asks for it. A tyre tread at a grazing angle is exactly the case it fixes.
- **Tone mapping options — the dial is done, the measurement is not, and the split is the
  interesting part.** `setOutputExposure` is a per-frame value beside `setCameraMotionBlur`, and
  it lands on the same uniform the graded value did, so a caller that never touches it keeps the
  grade it constructed with. `?exposure=` in the showroom switches the curve on and sets it, which
  is how it can be looked at: 0.6 against 1.6 is a dim room against a bright one, whole-image.

  **Adaptation is the caller's**, and that is a boundary rather than a shortcut: a game knows it
  walked into a cave, and easing toward a target is two lines wherever that state already lives.
  The clock belongs to the caller here in any case.

  What the engine could add on top, for a scene that cannot say what it is looking at: generate a
  mip chain on the scene colour target, read the smallest level as an average luminance, and smooth
  it in a 1x1 ping-pong so the value has somewhere to live between frames. **No readback**, which
  is the whole reason for the ping-pong — a `readPixels` of the frame would stall the pipeline, and
  a readback taken outside the frame reads zero, which this session confirmed the hard way while
  trying to measure exposure with one. Roughly 80 lines and one more pass, and it needs its own
  before-and-after because it changes a shipped picture the moment it is on.

---

## 4a. Bloom's cost is not measured, and the instrument is why

The pass is built and the picture is verified. What is **not** established is what it costs,
and the honest reason is that the tool available could not resolve it.

Measured on the night rig at a held frame, three hundred samples per run, on an RX 9070 XT
through headless Chromium: the same configuration run three times gave medians of **2.43, 5.12
and 1.74 ms**. A spread of three and a half milliseconds between a build and itself cannot
answer a question about half of one. Two things went past before that check was run, and both
would have read as evidence: bloom appeared to cost about 0.55 ms at 0.92 MP, and at four times
the pixels it appeared to cost _less_ than no bloom at all. The second one is the tell AGENTS.md
already names — removing real work cannot make a frame slower, so an impossible ordering is
proof the instrument is wrong rather than noise to average away.

What is known without a timer: the chain is one thirteen-tap pass at half resolution, five more
at a quarter and below, and six three-by-three tents on the way back, which is on the order of
five full-resolution taps per pixel in total. That is a description of the work, not a
measurement of it, and it is written here as one.

What would settle it: a real window rather than a headless one, `disjointDrops` read alongside
each sample, and the sanity check above run _first_ — a config against itself — before any pair
of configurations is compared. The rig can do this now; it could not before, because its own
`gpuTimer.beginFrame` was never called and every GPU figure it had ever printed was zero.

---

## 4b. The six uniform-strict-mode reports, sorted

`setUniformStrictMode` names a write whose location the bound program does not have. Pointed at
the game, it produced six. **They are not one kind of thing**, and the sorting is the useful part
rather than the list, because two were defects and four are the mechanism working as designed.

**Two were writes to nothing, and are gone.** `uGridScale` on the water and `uCameraPos` on the
flock: both fed lines that were deleted, one when the grid snapping moved to the CPU and one when
the flock work was reverted in favour of the lighthouse beam being the real cause. The
declarations were left behind, so the uniforms went on being uploaded every frame to locations the
compiler had removed. Held frames on the three published scenes that draw water or birds: **zero
pixels of 750,080** changed by removing them.

**Three are the plume, and they are correct.** `PlumeRenderer` compiles a _caller's_ vertex and
fragment source, and writes `uCameraRight`, `uCameraUp` and `uTint` unconditionally so that any
supplied shader may use them. A shader that does not is not a fault; it is the option not taken.
This is exactly the case the strict-mode note calls a deliberate optional lookup.

**One is the sky, and it is also correct.** `bindAtmosphere` uploads the whole atmosphere block to
whatever program is bound, and the sky does not declare `uUnderwaterFogDensity`. It does not need
it: fog is density times distance, and the sky has no distance, so `sky.ts` replaces itself with
`uUnderwaterColor` at `uUnderwaterFactor` instead of fogging. The two members it does need, it
declares.

**And one thing found while sorting them, which is not a strict-mode report but belongs here.**
Water declares `uLightPos`, `uLightColor`, `uLightRadius` and `uLightWeight` and does _not_
declare `uLightSourceRadius`, so a light's physical size widens its highlight on painted metal and
not on the water beside it. That is 0.20.0's representative-point lobe having landed in `flat.ts`
only. It is a real inconsistency, it changes a shipped picture on every scene with water in it,
and it is **not** being changed on the way past: it wants its own before-and-after. It is an
open entry in IMPROVEMENTS.md.

---

## 4c. What a tile-based GPU charges for, which this machine cannot show you

**Every rule here was a real defect in this engine, and not one of them could be caught by
looking at the picture.** They come out of a phone at 15–20 fps where a desktop part measured
the same frames at 120: a Galaxy S23 Ultra moving **388.7 MB of render-target traffic a frame**
at 824x1830, of which 161 MB went to textures nothing is able to read.

The asymmetry is the whole problem. A desktop GPU is immediate-mode with hundreds of gigabytes a
second; a mobile GPU renders in tiles, keeps the tile in fast on-chip memory, and writes it out
once at the end of the pass. So _attachment traffic_ is nearly free on one and is the entire
budget on the other — and the operations that control it are **no-ops on the machine you are
developing on**. `npm run shots` cannot see any of this: it answers "did the picture move", never
"is this sound on a tiler".

`node scripts/frame-audit.mjs` is the instrument. It counts passes and attachment bytes off the
real WebGPU command stream, and those counts are identical on every device.

**1. A colour attachment with a `resolveTarget` must use `storeOp: 'discard'`.** The resolve
happens either way; `store` _additionally_ writes the multisampled texture back to memory, and
nothing can read it — the engine's are created with `RENDER_ATTACHMENT` and no
`TEXTURE_BINDING`. Measured: five of these a frame at 23 MB each. On WebGL2 the same statement is
`gl.invalidateFramebuffer(gl.READ_FRAMEBUFFER, …)` after the resolve blit, and it must come
_before_ the unbind or it discards the default framebuffer, which is the frame.

**2. A depth attachment nothing samples must use `depthStoreOp: 'discard'`.** Check the usage
flags rather than the intention. The shadow maps are sampled and must store; `reflection.depth`
and `overlay.depth` sort one pass each and were being kept.

**3. Discard only from a pass nothing loads back.** This is the trap inside rules 1 and 2. Ending
a pass and reopening the same attachment with `loadOp: 'load'` reads contents the specification
calls undefined after a discard — and an immediate-mode GPU _has nowhere else to put them_, so it
returns the right pixels anyway. Held against the shot harness with every attachment discarding,
all seven scenes came back inside the readout's own 130-pixel noise. That is not permission; it
is the failure being invisible here and total on the device the change was made for.

**4. Count pass boundaries the way you count draw calls.** Ending and reopening a pass costs a
full read of the attachment into tile memory and a full write out of it. The frame's own pass was
being reopened per planar reflection: 92 MB a frame of pure reload, and removing it was worth
155.5 MB a frame on a scene with one mirror.

**5. Acquire the swap chain as late as possible.** `getCurrentTexture` does not read the swap
chain, it _takes_ it — whatever is in the returned texture is presented when the task ends,
drawn into or not. A frame that acquires and then fails to submit presents an untouched texture,
which is a black flash indistinguishable from a rendering fault.

**6. Scale a device down with dials, never with switches.** Turning passes off is the obvious
saving and usually the wrong one, especially anywhere without a settings screen: density, area,
sample count, reflection scale and shadow sizes are the terms the frame is actually bound on. The
demos went from 8.09 MP and 809.6 MB a frame to 1.60 MP and 49.7 MB with every pass still drawn.

## 4d. Instanced mesh draws, and the ring that was never a limit

**Shipped 2026-09-01.** A mesh already on the device can be given a per-instance placement and
colour: `createInstanced`, `uploadInstanced`, `drawInstanced`, `drawTranslucentInstanced`,
`disposeInstanced`. Thirty copies of one model are one draw call and **one slot of the frame's
material ring**, where thirty individual draws spend one each.

**The material ring is the scarce resource, and it took a consumer to make that visible.** A game
importing car models was rationing how many vehicles wore a real model — a modelled car is 45 to 89
material binds and `MAX_MATERIALS_PER_FRAME` was 256 — and four passes had moved that ration by one
car each. The question nobody had asked was what the ceiling cost. `UniformRing.flush` uploads
`used * slotSize`, so a ring's capacity costs **no per-frame bandwidth**: it is one-time
allocation, 1,540 bytes a draw slot and 7,168 to 13,312 a material slot, and the command pool and
the node arena already grew on demand. Both ceilings went to 4,096 and 1,024 for 10 to 14 MB.

That alone unblocks a consumer. What instancing adds is that the cost stops scaling with the
_count_: a street of thirty cars over six models is six draws and six material changes, not thirty.

**Three constraints, each a refusal rather than a silent degrade.**

- **No skinning.** Eleven of WebGL2's guaranteed sixteen attribute locations are the base mesh and
  the five that remain are exactly the matrix and the tint, so the joint indices and weights have
  nowhere to go. The instanced pipeline _reclaims_ locations 11 and 12 from them, which is free for
  an unskinned mesh — it carries both as constants — and impossible for a skinned one, which
  interleaves them, so dropping them would shift the stride under every other attribute.
- **No morphing.** It compiles, which is what makes it the worse of the two: a morph weight is per
  draw, so every instance would wear one expression between them.
- ~~**One batch per mesh.**~~ **Lifted 2026-09-30.** WebGL2 bound the instance attributes to the
  mesh's own vertex array, of which a mesh has one. A mesh now records each attribute's buffer,
  location and size, and each batch builds a vertex array of its own from that record plus its
  instance columns, so a prop has one batch a region. The mesh's own array never carries instance
  columns, which is also why `Mesh.draw` stopped disabling them.

**What would make the layout wrong** is a twelfth base attribute. The escape hatch, written into
the shader's own comment, is to carry the tint in the `w` lanes of the four matrix columns, which
an affine matrix leaves unused — at the cost of narrowing the API to affine transforms and making
a projective one silently wrong, which is why it was not taken first.

**The trap that cost the most, and it was not the shader.** `uModel` and `uTint` were declared
second and fourth in the vertex uniform block. A block is packed in declaration order and the
renderer writes it _by offset_, so a variant omitting them moved everything after: measured from
the generated bindings, `uHasTangents` came out at 64 against the plain variant's 128. Declared
last, every shared field keeps its offset and the instanced block is simply shorter. `flatPass`
asserts the honest invariant now — a variant may omit a field, but every field it declares sits
where the plain variant has it.

**Driven on hardware, both backends.** `demo/instancing.ts` draws two ranks of thirty, thirty draws
against one, both casting into one shadow pass through their own verb. The control worth copying:
swapping _which rank is instanced_ and changing nothing else produced a frame identical in **0 of
704,000 pixels**, which is a stronger statement than any two pictures side by side — the eye sees a
difference between the ranks that is only the light coming from one side, and it stays put when the
verbs swap.

## 4e. Surface effects, and the two versions that were wrong about bytes and alpha

**Per layer, not per material, because a city region is one mesh.** Its facades are told apart by
the layer each vertex carries, so a per-draw uniform cannot vary between two facades of one draw.
The effects live in a table beside the texture array — six texels a layer, read with `texelFetch`
at the vertex's layer — and bind whenever the array is a material's albedo. See `surfaceEffects.ts`.

**The first version was right in the shader and wrong in the bundle: 72 KB gzipped.** It was
written as code inside `main`, and the WebGPU backend ships every lit permutation as generated
WGSL — so each line was paid sixteen times, and naga, passing every argument through a pointer and
a copy, made each line long. Pricing it found the larger fault underneath: the generator stored
every permutation whole, so every _shared_ line of the lit shader was paid sixteen times too. The
generator now stores each shared item once (`scripts/wgsl/share.mjs`), which took **239 KB** off
`core-only` on its own; and the effects are functions over private globals, each stored once:
**15 KB**. The rule it leaves: **code in a helper costs once, code in `main` costs per permutation.**

**The second version put glass where the albedo's alpha is 1.** Reasonable on paper, and it would
have drawn every wall black: a wall pixel at alpha 0 loses its colour on the way through the
browser's premultiplied upload. A window is a _hole_ in a facade's picture — glass where alpha is 0
— which is also how a facade is drawn.

**Interior mapping from one image.** A room is a one-point perspective picture, back wall in its
centre half. The view ray meets the room's box, and a point on any wall at depth s maps into the
picture at `0.5 + (xy − 0.5) / (1 + s)`, so one formula serves every wall and the picture carries its
own shading. It needs a tangent frame, and a hand-built quad whose v runs down the wall has its
bitangent pointing down — tangent `w` of −1 — or the room turns upside down.

**What a zero costs.** Every effect is `mix(x, y, 0)` or a multiply by exactly 1 where its numbers
are zero, so a scene naming no effect draws bit for bit what it drew: **0 px** on every published
scene, both backends.

## 4f. DriftLight at world scale, and the level that was not built

**The spec asked for a two-level clipmap, and the fine level could not be paid for.** At the
reference city's street lamps — 26 to 40 m of reach, 40 to 60 m apart along every road — light fills
nearly the whole street volume, so a 256 m window of 1 m bricks is about two million bricks at 1 KB
each. The exact lights already are a per-pixel fine level: the frame shades up to 320 of them, found
through a grid. So the world is one **dense** volume baked offline at 4–8 m, read past the exact
radius; a brick's index and shared faces buy nothing where light is nearly everywhere.

**No new sampler and no new uniform row.** The dense volume binds in the courtyard field's two
slots, light below direction along y, and a negative spacing is the mode — because the WebGL2
eight-light rung stands at 255 of 256 rows. **What would change it**: the band between the exact
radius and the volume's resolution reading wrong on a real city.

## 4g. Crossfading levels of detail with one uniform

**A screen-door dither, and the pair that makes it exact.** `setDitherFade(t)` keeps `t` of an 8×8
Bayer pattern's cells and `setDitherFade(−t)` the complement, so the level arriving and the one
leaving cover every pixel exactly once — measured, red plus blue is the whole box at every `t`, on
WebGPU, WebGL2 over Vulkan and ANGLE-GL. It shares one uniform row with the order-independent
weight, `uWriteMode`, because a second scalar would have spent the last row of the Adreno 740 rung.
**What it gives up**: a crossfade reads as grain while it lasts, mirrored between backends because
WebGPU counts framebuffer y downward; and a held clock never finishes one, so a capture asks
`fadeSec: 0`.

## 4h. Skin spread in the picture, and the version that blurred the brows

**4.8.4 spread the coloured diffuse, and every mark painted on a face went with it.** Burley's blur
is right about light: it crosses a shadow's edge and fills a nostril's rim. It is wrong about
colour, which lives at the surface and does not travel. Spreading `albedo * light` smeared a brow,
a freckle and a lip line into the skin around them, and on a face seen from under a metre the whole
face read as out of focus. **Since 4.8.6 the diffuse half shades a white surface**, so it is light
alone, and a third half writes the albedo into a target of its own, depth-tested for equality
against the frame's half; the blur's second axis multiplies what it spread by that albedo. A skin of
one colour draws exactly as before. **What it costs**: one more draw of each skin and one more
half-float target the size of the frame (two under multisampling). See `shaders/skinBlur.ts`.

## 4i. Lightmaps, and the lanes they borrow

**Every attribute, inter-stage value and sampler a second texture coordinate would want was spent.**
WebGPU allows sixteen inter-stage values and the lit stage uses sixteen; WebGL2's sixteen texture
units are all bound in the widest lit build. So a lightmap borrows: the coordinates ride the grain
and relief attributes and their varyings, the page binds in a shading model's map slot, and an
instance's region rides its tint. A lightmapped material is a shading model kind, `MODEL_LIGHTMAP`,
so the read is a pipeline constant and the standard lit pipeline is unchanged: **0 px** on every
published scene.

**The first version stored the coordinates as they are, and the same mesh drawn without its page
was mottled and bumped by them**, because grain applies above zero and relief scales by its lane:
every lightmap coordinate was a grain amount between 0 and 1. They are stored as `-1 - uv` now,
grain only applies above zero and relief is read through `max(relief, 0)`, so a lightmapped mesh
drawn with an ordinary material is a mesh with no grain and no relief. **The control that found
it** was the one meant to prove the units: a page of one value against the same ambient raised by
`setAmbientSH`, which came back 7 levels apart until the lane was moved, and 0 after.

## 4j. Bloom that answers, and the subtraction that washed a stage

**Subtracting the threshold is fine at a threshold of 1 and wrong at 0.1.** A stage authored for
Unreal's bloom sets a low threshold because Unreal brings a colour in over a ramp,
`saturate((L - t) / 2)`, and weights six bands by tints that sum below one. Subtracting 0.1 keeps
nearly every light in the frame at full strength, and one band at the scale given washed the stage
white. `BloomResponse` states both differences as numbers: a `ramp` in place of the subtraction, and
a tint for each level. **Both are blend constants**, applied as each level is added onto the one
above it, so neither costs a pass, a texture or a uniform row; with no response named every weight
is one and the frame is the frame it was.

## 4k. A spot is a cone, and binning it as a sphere was the cost

**The froxel binner tested a light's sphere and never its cone**, so a 10° spot with a reach of
tens of metres filled every froxel its sphere touched. A rig of a few hundred narrow spots then cost
the clustered pass about 0.035 ms a light at 1600×900, which is what made a consumer shade 32 of 313. Both binners now test a froxel's bounding sphere against the cone exactly, with the apex as a
case of its own, because the plain bound keeps froxels behind a spot whose sphere reaches back
past its apex. The CPU and GPU tables stay byte-identical, and the picture cannot change: a froxel
the cone misses received nothing from it.

## 4l. A lightmap page in eight bytes, and the filter the shader does itself

**A page was two half-float layers, sixteen bytes a texel**, and a stage's 49 pages took 348 MB. The
irradiance is an rgb9e5 word now, three 9-bit mantissas over a shared exponent, beside the
direction's four bytes, in one array of two `rgba8` layers: eight bytes a texel. **Not a format of
its own**, though WebGPU samples and filters `rgb9e5ufloat`: the two layers must be one array,
because WebGL2 has no unit left for a second sampler, and an array has one format. So the lit stage
fetches the four texels around a sample, decodes each and filters them itself. A bake that arrives
packed, as Unreal's does, uploads where it lies. Measured: a page of one value is still 0 pixels from
the same ambient raised by `setAmbientSH`, and the room within one level of the half-float page.

## 4m. A light's own falloff, in a lane it had already paid for

**The fixed arm's cone was a `vec2` array, and a GLSL ES array spends a whole uniform row an element
whatever its type**, so widening it to a `vec4` to carry `falloffExponent` in its third lane cost the
eight-light build no row. The froxel record grows one texel instead, to six, the table to 222 rows. A
light with an exponent takes `(1 - (d/R)^2)^n` and no distance term, and every reader of a light's
falloff takes it: the two arms, water, DriftLight's volume and DriftRay's bounce, so the summed far
field and the shaded near field still meet without a seam. One light drawn by either arm is 0 pixels
apart on both backends.

## 4n. Barn doors are a smaller rectangle

**A door hides the part of the rectangle behind the line from the fragment through its tip**, so each
fragment shades the rectangle that line leaves, clipped one axis at a time, and the form factor and
the integrated highlight are those of that smaller rectangle. Taking each door as endless along its
hinge is what makes the axes separable; the corner two doors meet at is then square where real flaps
would mitre it. The fixed arm reads the doors in the size uniform's spare lanes, as 4m read the
exponent in the cone's. **The check was the geometry rather than a picture**: from straight above,
nothing changes inside the box the tips leave whole and nothing is lit past where they hide all of it.

## 4o. A physical highlight behind a switch

**The engine's highlight is a look: a peak of one times the specular attribute.** GGX's own
`pi * D * Vis * F * N.L` peaks at `1 / (4 alpha^2)` and reads the attribute as F0, which is what a
model authored in Unreal expects. It is an opt-in a material makes, `physicalSpecular`, carried in a
lane of the model's uniforms the standard, lightmap and anisotropic models leave free, and its code is
a lit switch declared after the models' so every shipped override keeps its id: compiled into the lit
programs the first time a material asks, absent before. What every pipeline does compile this release,
the exponent and the doors, was measured on RADV at a phone's viewport: 2.8 to 6.4% more instructions
and the same registers, where 4.8.2's regression was the registers.

## 4p. A skin's radius, measured before it was changed

**Screen-space skin smeared a face at arm's length over tens of pixels, and the first question was
whether the kernel was wrong.** It was not: a step of light at 0.75 m came back with its edges at the
taps' predicted offsets and its levels at the profile's own tail masses, to within a level. What was
wrong was the distance handed to it. `radius` was documented as how far light travels, and was given
to Burley's profile as its `d`, which carries light 2.5 `d` on average and the taps out to 9 `d`. The
profile is at `radius / 2.5` now, in the blur and the pre-integrated fit alike, so the two still agree;
the step's reach fell from 65 pixels to 26.

## 4q. An instance's cell, in the row a placement leaves free

**Every vertex attribute an instanced draw can have is spent**, so a texture cell an instance had no
attribute to ride. An instance's placement is a turn, a scale and a move, whose matrix's bottom row is
`[0, 0, 0, 1]`, so the cell rides that row and every stage drawing an instance, the lit, depth and
motion stages, rebuilds it. The cost is that an instanced placement must be affine, which every
placement of a solid object is. One instanced draw of eight cards on eight cells is 0 pixels from
eight draws with the cell in their materials.

## 4r. A scene capture is a probe bake with one face

**The arrangement already existed**: a probe bake sets the frame's pass aside, draws the caller's
scene from another camera into a target at the world's format and sample count, holds the output
transform off so it stores radiance, and gives everything back. A capture is that, once, into a
texture a material binds, with the frame's camera, jitter, motion, refraction copy and skin spread
left alone while it draws. **WebGL2 flips its rows**, as it flips a probe face's, because a GL
framebuffer's first row is its bottom and an image's is its top. The control is exact: a second
camera's view shown unlit on a quad filling the frame is 0 pixels from that view drawn directly. At
four samples WebGL2's capture equals WebGPU's frame and differs from WebGL2's own direct frame on 392
edge pixels, its rows being flipped against the same sample pattern.

## 5. What must stay true

- **Defaults do not move.** Every item here lands as a quality option or a pass property whose
  default reproduces today's output.
- **Measured, not assumed.** The MSAA decision above is documented with the numbers that
  justified it, and anything replacing it is expected to arrive with its own. A screenshot
  before and after, on the machine's real GPU, is the minimum.
- **60 fps on a mid-range Android phone is a hard gate**, and every effect here is one a weak
  device should be able to decline.
