# Voxel Sandbox — port notes

## Textures

Kenney Voxel Pack, CC0, fetched at runtime into `demo/dev/public/voxelpack/`, which is gitignored:
the tiles are not committed, not bundled, and absent from the package. CC0 asks for no
attribution; this note exists so the next reader of `atlas.ts` does not have to work out where the
pixels came from.

Source: `https://kenney.nl/assets/voxel-pack`, `PNG/Tiles/`, 85 tiles at 128×128. The reference
names its tiles by Kenney's own filenames, so all 27 it references resolve without renaming.

## Amendments to the spec

Two, both from the engine census in the plan's §2, and both in the engine's favour.

- ~~**The water surface is not a `registerPass` reach.**~~ **Withdrawn — see "The water sheet was
  the wrong shape" below.** `WaterRenderer` is real and good, and it is a _bounded pool_, which a
  voxel sea is not. The water surface is the mesher's, as the reference has it. The sky, however,
  really is the engine's.
- **Particles are not a DriftScript module.** Spec §6 put them there. `ParticlePool` already
  integrates position, velocity, drag, gravity and both ramps, so a script version would be a
  worse one. Falling blocks and mobs stay in DriftScript, where entity behaviour is the subject.

## Deviations from the reference

Not gaps — choices, recorded so a comparison shot is read against what was actually built.

### The atlas holds 128-pixel tiles, where the reference holds 64

The reference sets `TILE_PX = 64` and downsamples Kenney's 128×128 source. This port keeps the
native 128, because the sampler cannot be asked for nearest magnification (below) and the only
lever left against that blur is starting from more texels. It is the same pixels at their authored
resolution, so it costs nothing in fidelity and four times the atlas memory — 768×640 rather than
384×320, which is nothing at this scale.

If the gap below is ever closed, drop this back to 64 to match the reference exactly.

## Gaps

Every point where the public barrel could not reach what the reference reached. One entry each:
what was wanted, what was done instead, what it cost, and the smallest engine change that would
remove the need.

### ~~`SurfaceTexture` cannot be asked for nearest filtering~~ — closed, 3.43.0

**Closed exactly as this entry specified.** `filter?: 'linear' | 'nearest'` on
`SurfaceTextureOptions`, defaulting to `linear`, threaded to the two `texParameteri` calls and to
the WebGPU sampler. Drop the atlas back to the reference's 64-pixel tiles and ask for `nearest`.

**Minification still blends between mip levels**, which is not the request being half-honoured: the
option is about magnification, and taking the nearest mip _level_ as well would trade a smear for a
visible pop as the camera pulls back.

One thing the entry could not have known: WebGPU refuses `maxAnisotropy` above 1 unless every filter
is `linear`, so a nearest sampler gets 1 there and an ignored anisotropy request on WebGL2 — the
same picture by two routes.

The original entry follows.

**Wanted.** `NEAREST` magnification for the block atlas. The reference asks for it explicitly, and
pixel-art tiles magnified across a block face are the textbook case: linear magnification turns a
tile into a smear as the camera approaches.

**Done instead.** Tiles are composed into the atlas canvas with `imageSmoothingEnabled = false` and
`mipmap: false`, so the atlas holds hard pixel edges and no mip chain softens it further, and the
tiles are kept at their native 128 rather than the reference's 64.

**Cost.** Magnification is still linear, so a block face close to the camera is softer than the
reference's. Measured at the comparison shot in the stage that ships it.

**Smallest change that removes it.** `filter?: 'linear' | 'nearest'` on `SurfaceTextureOptions`,
defaulting to `linear`, threaded to the two `texParameteri` calls in
`packages/core/src/render/surfaceTexture.ts` and to the WebGPU sampler.

## Stage 1 — what running it established

Seed 1337, WebGL2, 1264×1144, on the demo harness.

**Working.** Terrain generates and streams as the camera moves (169 chunks at the spawn, 182 after
flying). Blocks are textured from the atlas. Ambient occlusion darkens the corners under trees and
where blocks meet. The linear fog ramp fades terrain and ocean into the sky colour, and from above
the far ground disappears into it exactly as `fogFar = 91.2` says.

**The hierarchy earns its place.** 140 of 169 chunks pruned looking one way, 152 of 182 after
turning and moving. The engine's `visitVisible` is doing what the reference's per-chunk draw loop
does not, and `VisitResult` is what let that be counted rather than assumed.

**A thing that looked like a bug and was not.** The leaf canopy shows white and dark-red speckles.
That is the cutout working: `leaves_transparent.png` carries 3,199 fully transparent pixels of
16,384, all with RGB (0,0,0), and what shows through the holes is sky and tree trunk. Measured by
decoding the tile rather than by reasoning about the picture.

**Not established here, and not claimed.**

- **No side-by-side against the reference yet.** The two demos share a seed, a fog ramp and a
  render radius, and this port has been verified against its own gate — but the reference has not
  been built and run beside it. Spec §10's comparison is owed and outstanding.
- **WebGPU is unverified.** The browser driving this offered no adapter, so every frame measured
  was WebGL2. The shot harness runs both, and the first thing to check there is whether the
  chunk draw survives the backend it has never run on.

### ~~`TouchControls` asks for two elements it only writes style to~~ — closed, 3.43.0

**Closed as this entry specified**: `TouchControls(input, options)` with `stickBase` and `stickNub`
in `TouchControlsOptions`, beside the positional form, which keeps working. `new TouchControls(input)`
is a working scheme with no visible stick, so the two `div`s that were never appended anywhere can
go.

**The entry's diagnosis was right and worth keeping**: the elements are an output channel dressed as
a dependency, and a reader of the signature reasonably concluded the opposite — which is what
happened here and what the options form now says plainly.

The original entry follows.

**Not a blocker, and it was logged as one first.** The first reading of
`new TouchControls(input, stickBase, stickNub)` was that a `DemoScene` cannot supply the two
`HTMLElement`s, since it is handed a canvas and forbidden the page. That was wrong, and reading
the class rather than its signature settles it: `stickBase` and `stickNub` are only ever assigned
`.hidden` and `.style`, never measured, and every touch comes from `input.target` — the canvas.

**Done.** Two `document.createElement('div')` nodes that are never appended anywhere. The input
maths runs, nothing reaches the page, and the port is playable on a phone where the reference is
desktop-only. The stick has no visible representation, which is the HUD's job if it ever needs one.

**What it costs.** A reader of the signature reasonably concludes the opposite, which is what
happened here. The elements are an output channel dressed as a dependency.

**Smallest change that removes it.** Make them optional — `TouchControls(input, options)` with
`stickBase`/`stickNub` in `TouchControlsOptions` — so a consumer that draws its own stick, or none,
does not have to construct two nodes to throw away. Existing callers keep working if the options
form is added beside the current one.

### ~~Nothing on the public surface draws a textured screen-space quad~~ — answered by `@driftengine/ui2d`, 3.41.0

**Closed by a package rather than by the verb this entry asked for, and the substitution is worth
reading.** The ask was `drawPanelTexture(rect, texture, uv, alpha)` beside `fillPanel`: a sampler and
a branch in the panel shader. What shipped is `@driftengine/ui2d`, which draws sprites through
`registerPass` with a screen-space coordinate system that counts y downward and a `UvRect`
sub-rectangle per placement — which is exactly what an atlas tile is, and what this entry named as
the thing any inventory, minimap or button would want next.

**It is a batch rather than a verb**, so a hotbar of ten slots over one atlas is one draw rather than
ten, and a tilemap over one sheet is one draw however many thousand tiles it is. The port can drop
the world-space quads, the `hotbarLayout.ts` shared with the HUD, and all three costs below: the bar
leaves the depth buffer, nothing is rebuilt on a viewport change, and the slot numbers stop needing a
second pass.

**What it costs against the original ask** is an import: a consumer that wanted one textured
rectangle now takes a package rather than a verb on the renderer. That was the trade — 8.7 KB
gzipped, and nothing at all for a consumer who never draws a sprite, against 19.8 KB for a branch in
the shader every draw already uses.

The original entry follows.

### Nothing on the public surface draws a textured screen-space quad

**Wanted.** Hotbar slots showing the block's own tile, as the reference's CSS HUD does.

**Blocked, and re-checked.** `fillPanel(rect, color, alpha)` is the only screen-space fill and it
takes a colour: the panel shader declares `uColor` and `uAlpha` and binds no sampler on either
backend. `drawText` and `drawSdfText` cover glyphs. There is no verb that puts an arbitrary
`SurfaceTextureHandle` into a screen rectangle, and the atlas is uploaded and sitting there.

**Done instead.** The tiles are world geometry: ten quads in the camera's own basis, a fixed
distance in front of the eye, projected onto the very rectangles the HUD fills. `hotbarLayout.ts`
states those rectangles once and both consumers read it, because while each computed its own the
two agreed at no viewport size and the tiles sat in a row above the bar. A CSS pixel becomes a
point on the view plane through the half-extents at that distance, taken off the projection matrix
so the aspect is the drawing buffer's — deriving it from `fovYDeg` and the CSS aspect put the row
a slot off centre, growing with distance from the middle.

They are drawn _after_ the HUD so the backing panel and the slot border sit behind them, and
unlit through `drawTranslucentMesh(mesh, m, 1, { lit: false, fog: false })`. An earlier note here
claimed the standard path had no unlit draw, and that was a misreading of the same kind as
`WaterRenderer`: `TranslucentMeshOptions` carries `lit` and `fog`, and `lit: false` is documented
as the mesh's own vertex colour times its own texture and nothing else. Drawn lit, the bar took
the world's lighting — far darker than the atlas it was cut from, and changing with the time of
day and with which way the player faced, because the quads turn with the camera.

**Cost.** Three that a real overlay would not have. The bar is in the depth buffer, so standing
with a wall closer than 0.62 m puts terrain through it. The quads are rebuilt whenever the
viewport or the selection changes. And the slot numbers have to be drawn in a second pass after
the tiles, since anything drawn with the rest of the overlay is underneath its own tile.

**Smallest change that removes it.** A `drawPanelTexture(rect, texture, uv, alpha)` beside
`fillPanel`, taking the same `InsetRect` and a `SurfaceTextureHandle` with a UV sub-rectangle —
which is exactly what an atlas tile is, and what any inventory, minimap or button in any consumer
would want next. The panel shader would gain a sampler and a branch; nothing else moves.

### ~~The flat shader has no per-vertex animation~~ — closed by the per-vertex channel, 3.42.0

**Closed 2026-09-03, and it closed two entries below it as well.** `MeshData.channel` is one
optional `vec4` a vertex whose `.x` is the sway the vertex stage reads. The displacement is the
engine's shared wind rather than a `uTime`: `setWind` once a frame, the same numbers
`resolveScatterDeform` gives the grass, bound to the depth pass too so a canopy keeps its own
shadow. Drop the flag into `.x` where the reference gates on `color.a` and the leaves move.

**The smallest change asked for here was one float and it could not be had.** Locations, not
payload, are the scarce resource: eleven of WebGL2's sixteen were spent and an instanced draw
spends all sixteen, so three separate one-float attributes did not fit and one `vec4` carrying
three lanes does. A mesh drawn instanced still cannot have it, and `InstancedMesh` now throws
saying so rather than drawing leaves that never move.

**One thing this entry got wrong, recorded because the correction is the useful part.** It priced
the row as a shader-permutation cost. That is the fragment stage's economics: `flatFrag` is sixteen
permutations at 283.4 KB gzipped, where `flatVert` is five at 5.2 KB. A vertex channel is priced on
the second, and the whole feature came in at 5.8 KB over core.

The original entry follows.

### The flat shader has no per-vertex animation, so leaves do not sway and water does not ripple

**Wanted.** Three of the seven things `voxel-material.ts` does, and the three that are missing.
The reference displaces leaf vertices on a wind function, gated by a per-vertex flag so a cactus
stays rigid; it drops and ripples the water surface on a second function gated by a fluid flag;
and it reads an animated ripple normal in the fragment stage for a moving sun sparkle and a
Fresnel sky reflection at grazing angles.

**Blocked.** Every one of those is a shader term keyed on a per-vertex flag and the clock, and the
engine's flat shader has neither. `MeshData` carries `specular`, `roughness`, `grain` and `relief`
as one float per vertex, so the _format_ has room; what is missing is a channel the vertex stage
consumes and a `uTime` beside it. The reference gates both on `color.a`, which this port cannot
use for a third reason: `MeshData.colors` is three floats per vertex with no alpha channel, which
is also what stops deep water being drawn more opaque than shallow.

**Not done, and not approximated.** The port has the static half — the surface dropped below the
cell top, and depth darkening baked into the vertex colour — and nothing that moves. A CPU
animation was considered and refused: the meshes would have to be created `dynamic` and every
chunk's positions rewritten every frame, which at the spawn is 169 buffers of vertex data a frame
to do what one line of a vertex shader does.

**What it costs.** Water reads as a tinted solid rather than a surface, which is most of what
tells a sea from a floor. A canopy is still. Both are visible in any comparison shot, and neither
is subtle.

**Not a contributed pass.** `registerPass` is real and `demo/contributedPass.ts` proves it on both
backends, but a pass owns its whole shader — so taking this route means reimplementing the lit,
fogged, ambient-occluded, shadowed, cutout and blended material this port gets for nothing, to add
three terms to it. That is the wrong trade at this size and it is why the gap is logged instead.

**Smallest change that removes it.** One optional per-vertex float on `MeshData` that the _vertex_
stage reads — call it `sway` — and `uTime` in the vertex block, with the displacement written once
in `flat/` and gated on the attribute being present. That is the same shape `grain` and `relief`
already have, and it would serve grass, foliage, cloth and flags in any consumer, none of which
can move a vertex today either. Per-vertex alpha is a second and larger question, because widening
`colors` to four floats moves every mesh in the engine.

**Closed 2026-09-03, and it did not need `colors` widened.** That framing assumed alpha had to sit
beside the albedo. It does not: the flat shader ends at `float alpha = uOpacity * coverage`, so a
per-vertex alpha is a third factor on that line. It is `.z` of `MeshData.channel`, defaulting to
1.0, and no mesh producer, container field or baked asset moved. Deep water can be drawn more
opaque than shallow.

### ~~Sky light attenuates the ambient term as well as the sun~~ — closed, 3.42.0

**Closed by the same attribute.** `.y` of `MeshData.channel` is `skyDirect`, and it multiplies
`sunShade` — so it takes the sun and leaves the ambient exactly as this entry asked. Drop
`SKY_FLOOR` back to what the reference uses and carry the sky factor in the lane.

**It multiplies `sunShade` rather than `direct`**, which this entry could not have known: the sun's
specular lobe reads `sunShade` on its own, so scaling the diffuse term alone would have left an
enclosed face with no sunlight and a sun highlight anyway.

The engine's check puts this entry's own defect in the scene as a control: a face at `skyDirect = 0`
measures 38.00 luminance where the same face with the factor folded into its vertex colour measures
0.00, against 176.00 in full sun.

The original entry follows.

### Sky light attenuates the ambient term as well as the sun

**Wanted.** The reference's lighting model: a cell's sky exposure scales the _directional_ term
only, and ambient is added on top. A cave face is then lit by ambient at full strength and by the
sun not at all.

**What the standard path allows.** The only per-vertex channel that reaches shading is `colors`,
and the flat shader does `albedo = vColor; albedo *= texel.rgb`, then `lit = albedo * (ambient +
sun · direct)`. So a sky factor carried in the vertex colour multiplies _both_ terms, and an
enclosed face is darkened twice — once by having no sky, once by the ambient it should still have
received.

**Done instead.** `SKY_FLOOR` in `mesher.ts` is raised to 0.45, so an unlit cell keeps enough of
the albedo that a cave reads as a dark cave rather than as a hole in the picture. Found by looking
at it from altitude and then measuring the vertex colours: 55% of a chunk's vertices sat between
0.10 and 0.20 with the floor at 0.22.

**Cost.** Contrast between open ground and enclosed space is compressed relative to the reference.
Caves are darker than daylight, but not as much darker as they should be.

**Smallest change that removes it.** A per-vertex scalar the _directional_ term alone consumes.
`MeshData` already carries `specular`, `roughness`, `grain` and `relief` as one float per vertex,
so the format has room; what it lacks is a channel with this meaning and a shader line that
applies it to `direct` rather than to `albedo`.

### The sky was the last predicted reach, and the engine has it too

**Spec §5 predicted two places this port would need a contributed pass.** The water surface was
the first and turned out to be `WaterRenderer`. The sky dome was the second, and it is
`drawSky`.

The reference spends 121 lines of WGSL on a gradient dome with a star field, a moon disc with
mare shading and a three-tier sun glow, plus a further 127-line module on a scrolling cloud quad.
`SkyColors` carries `top`, `horizon`, `deep`, `sunDir`, `sunColor`, `sunAngularRadius`, `moonDir`,
`moonColor`, `moonAngularRadius`, `moonPhase`, `nightFactor` and a cloud offset, and the shader
behind it draws all of the above — with a moon _phase_ the reference does not have.

**248 lines of the reference become a 90-line adapter that maps a `LightingSnapshot` onto that
struct.** No shader was written for the whole port, which is what spec §5 set out to establish.

**What it costs.** The engine's clouds are banded noise in the sky shader rather than a quad at a
declared altitude, so they cannot be flown through or occluded by terrain. The reference's cannot
either, so nothing is lost against it — but a consumer wanting volumetric cloud would still be
writing a pass.

### ~~`drawLines` is flat and fogged~~ — it takes a blend now, 3.43.0

**Closed as this entry specified**: a blend argument on `drawLines`, so the twelve edges can be one
additive pass instead of two alpha-blended ones at different softness. The tint-toward-the-glow
this entry measured against a bright surface goes away.

**It is a blend and not a bolt mode**, which `AGENTS.md` forbids: what separates a line from a bolt
is the _path_ — a bolt jitters because it is lightning — and an additive line still follows the path
it was given, keeps its clean edge and is still fogged. The caller states what the stroke is.

Blending is pipeline state on WebGPU, so the additive arm is a second pipeline under its own cache
key rather than a branch.

The original entry follows.

**Wanted.** The reference's block outline: an additively blended cyan-white wireframe with a crisp
core, a soft falloff halo and a slow pulse, so it reads clearly against both a bright sand face
and a dark cave wall.

**What the standard path allows.** `drawLines` is documented as "a flat fogged colour with a clean
edge", and `drawBolts` beside it is the additive one — but a bolt jitters along its own path,
because it is lightning. There is no additive, unjittered stroke.

**Done instead.** Two passes of `drawLines` over the same twelve edges: a wide stroke at
`softness: 0.9` for the halo and a narrow one over it for the core, both pulsing on the
reference's own 4.5 rad/s. Cyan-white, at the reference's colour.

**Cost.** It is alpha-blended rather than additive, so against a bright surface it tints toward
the glow colour instead of adding light to it. Visible on sand at noon; indistinguishable in a
cave. The first version of this was worse in a way worth recording: flat black hairlines, which
looked like a different feature rather than a dimmer one.

**Smallest change that removes it.** A blend argument on `drawLines` — the pipeline already has
an additive variant for bolts, and the two verbs are documented as sharing a vertex expansion and
nothing else.

### ~~DriftScript has no maths~~ — it does, under `std/`, and the diagnostic now says so

**Not a gap, and the misdiagnosis is the interesting part.** `std/math` has `abs`, `min`, `max`,
`clamp`, `lerp`, `floor`, `ceil`, `round`, `sqrt`, `sin`, `cos`, `atan2` and `exp`, and `%` is an
operator. Every host has it unconditionally — the language's `STD_MODULES` are _provided_ rather
than claimed, and a manifest may not even list one. Compiled against this engine's own registry, the
expression this entry was written about returns **zero errors**:

```
import { sin, cos, floor, atan2, sqrt } from "std/math"
```

**How it was missed, and it is nobody's carelessness.** The entry below reasons from the `drift/*`
module list, which is the right list for a host's capabilities and the wrong one for the language's
own. Three bare `DS0205 is not defined` gave no reason to look at a second prefix, so the flag went
up, the host answered it, and the absence was filed — reaching two engine documents as a language
row before anybody compiled the counter-example.

**What was real is that the compiler said nothing.** It knew where `floor` lived at the moment it
reported the name undefined. DriftScript **1.12.0** makes `DS0205` name the module:

```
`floor` is not defined. `floor` is defined in `std/math`; import it to use it here.
```

So the mob can pick its own direction in the script, and `wantsHeading` can go. The original entry
follows, and its cost paragraph is what the fix is measured against.

### DriftScript has no maths, and no `drift/math` to import one from

**Wanted.** A mob that picks its own direction: an angle from a counter, then `cos` and `sin` of
it. Three lines in the script, and the sort of thing a behaviour module exists to hold.

**Blocked.** `floor`, `sin` and `cos` are all `DS0205 not defined`, and the module list —
`drift/ai`, `animation`, `audio`, `behavior`, `camera`, `chemistry`, `ecs`, `editor`, `events`,
`input`, `navigation`, `network`, `persistence`, `physics`, `prefab`, `random`, `scene`, `time`,
`ui` — has no maths in it. There is no modulo either, so even a hand-rolled hash is out.

**Done instead.** The script raises a `wantsHeading` flag and the host answers it with an angle
from `mulberry32`. **That flag can go**: the maths was always there, and 1.12.0's diagnostic is what
would have said so. The split that forces is defensible and arguably better — deciding _when_ to
turn is the interesting half and stays in the script — but it was forced rather than chosen, and
it means every script that needs a number reaches back through its host.

**Cost.** A behaviour module cannot be self-contained if it does any arithmetic beyond `+ - * /`
and comparison. For this port that is one flag; for a real consumer it is a host call per
decision.

**Smallest change that removes it.** A `drift/math` module with the constants and functions a
behaviour actually reaches for — `floor`, `abs`, `min`, `max`, `sqrt`, `sin`, `cos`, `atan2`, and
a modulo operator or `rem`. `drift/random` exists already, so the seam for this is established;
what is missing is the arithmetic beside it.

### ~~A DriftScript component cannot hold an enum~~ — closed in the engine, 3.43.0

**Closed as this entry specified**: a column for a fieldless enum, stored as the integer the
discriminant already is. `mood: Mood` on the `Mob` component compiles, registers and reads back, so
the `mood: i32` with three numbers in a comment can go — and with it the exact failure the language
advertises against, a state nobody wrote a branch for doing nothing silently.

**It was an engine row and it took an engine release**, which is the correction this entry carried
for half a day: `enum` is a keyword the language has, and what refused was
`packages/entities/src/store.ts` deciding which types get a column. No language release, no pin move.

**The width is `Int32Array` and that is the one decision this entry did not make for us.** A byte
would hold every enum anybody is likely to write, and `defineComponent` is handed `enum:Mood` — a
name, with the variant list belonging to the module that declared it. It cannot count them, and
guessing too small fails silently, so it spends three bytes it will usually not need.

The original entry and its diagnosis follow.

### A DriftScript component cannot hold an enum — and it is an _engine_ row, not a language one

**Refiled 2026-09-03, and the correction changes what it costs.** This entry sits among the
DriftScript gaps and reads as one, and two engine documents copied it that way. It is not: `enum` is
a keyword the language has, an `enum` declaration compiles, and a `match` over one is exhaustive
exactly as advertised. What refuses is `packages/entities/src/store.ts:155` — **the engine's own
component store**, deciding which types get a column.

So closing it needs no `driftscript` release and no pin move in three manifests. It is a column for a
fieldless enum, stored as the integer discriminant it already is, in a package this repository owns.

**That matters for the tension this entry names**, because it makes it cheaper to resolve than it
looked: the language advertises that `match` refuses to compile until every state is handled, the
corpus demonstrates it on a `data` record, and a `data` record is not what a system iterates. The
gap between the selling point and the usable shape is one engine change wide.

The original entry follows, and its diagnosis is unchanged.

### A DriftScript component cannot hold an enum, which is where behaviour state lives

**Wanted.** `mood: Mood` on the `Mob` component, and a `match` over it — which is precisely the
shape `driftscript/docs/corpus/GuardBehaviour.drs` is in the corpus to demonstrate, and whose
selling point is stated there: "`match` refuses to compile until every state is handled. The Lua
version would silently do nothing for a state nobody wrote a branch for."

**Refused, clearly.** At runtime: "`Mob.mood` is declared `enum:Mood`, which has no column. The
types with one are f32, f64, i8, i16, i32, i64, u8, u16, u32, u64, bool, Entity, String, and an
option of any of them. A type that has to be boxed is a decision about layout, so it is added here
rather than assumed." That is a good message and a defensible position about layout.

**The tension is that the two features are aimed at the same thing.** A state machine's state has
to persist between ticks, which means it has to be a component field; an `enum` is the type that
makes the state machine safe. `GuardBehaviour.drs` keeps its `Alertness` in a `data` record rather
than a `component`, so the corpus never hits this — but a `data` record is not what a system
iterates.

**Done instead.** `mood: i32`, with 0, 1 and 2 written out in a comment, and the host reading the
same three numbers. Exactly the "silently do nothing for a state nobody wrote a branch for" the
language advertises against.

**Smallest change that removes it.** A column for a fieldless enum, stored as the integer it
already is — the discriminant needs no boxing, and the message's own list already includes every
width it could want.

### The water sheet was the wrong shape, and shipping it broke the surface

**Claimed, wrongly, earlier in this file.** That `drawWater` replaced the reference's water and
closed one of spec §5's two predicted contributed passes.

**What went wrong.** `WaterBody` is one `level` and one rectangle of `bounds` — a pool, a tank, a
lake with a known edge. It is a good abstraction for that. A voxel sea is not that: water is
wherever the cells are, at whatever depth the terrain left them, including a flooded cave with
solid rock above it. Drawing a sheet at `SEA_LEVEL` following the camera put water across every
dry inland basin below y=30, and because the mesher had been changed to stop emitting fluid top
faces — to avoid z-fighting the sheet — every real water surface the sheet did not cover became a
hole. Reported from a real session as "all transparent on the surface", which is exactly what it
was.

**Done instead.** The mesher draws water faces again, all six, as blend-mode quads like every
other block. `UnderwaterAtmosphere` stays: that half was right, and a participating medium is a
better answer than the reference's fixed-position `div`.

**What is actually lost.** The reflection and the caustics, which the reference does not have
either — so nothing is lost _against it_. What was lost was half an hour and a confident sentence
in this file, which is why the sentence is struck through rather than deleted.

**The lesson, for the log's own sake.** The census in the plan's §2 was written by reading the
barrel, and a name that matches what you want is not the same as a shape that fits your world.
`WaterRenderer` was on the list because it draws water. It draws _a body of_ water.

### ~~WebGPU renders this scene wrongly~~ — the mesher wound every face backwards

**Resolved 2026-08-29, on an RX 9070 XT that offers WebGPU where the machine that built the
port did not.** Both backends now draw the same picture: 339,874 differing pixels of 672,000
before, 3,324 after, at the ledger's `--delta=16`, and the residue is silhouette rasterisation
spread evenly over the frame with no cluster anywhere.

**It was two defects, and neither was where the symptoms pointed.** The entry this replaces
guessed at `fillPanel` and at the fog, and the earlier handoff eliminated the sky, the HUD, the
atlas, the UVs, the clip planes and the draw count. All of that was correct and none of it was
the cause.

**The port's half.** `FACES` lists each face's corners in `(cu, cv)` order, and `cross(u, v)`
for those corners runs _against_ the face normal. Walking them in emission order made every
face in the world back-facing. The engine culls back faces on both backends, so the ground was
never geometry the renderer was willing to draw.

**The engine's half, which is why nobody saw it.** `SceneTarget.resolve` switches off depth,
blend and culling to draw its one triangle over the canvas, and put back only the first two. It
runs at `endFrame`, so from the _second frame onwards_ every mesh in every scene was drawn with
`CULL_FACE` disabled. WebGL2 was therefore drawing the whole world double-sided and a backwards
face still showed. WebGPU sets `cullMode: 'back'` in pipeline state, which no pass can leak, and
drew nothing.

So the divergence read as a WebGPU bug for the length of the build and was a WebGL2 one: that
backend was not enforcing the rule the other one was. Ten of the thirteen scenes are
pixel-identical across the fix; night street changes because its planar reflection sets
`cullFace(FRONT)`, which had been doing nothing, and the road now carries the window
reflections it should always have had.

**How it was found**, because the method is the transferable part. Ablate until the defect is
alone — sky, water, mobs, particles and HUD off, one render mode at a time — then clear to
magenta so "no fragment written" is distinguishable from "fragment shaded black". The ground
came back as clear colour, which said the geometry was absent and not dark, and the boundary at
magnification followed block edges rather than curving. From there `cullMode: 'none'` restored
the frame in one capture. Every step was a picture compared against the other backend at one
held frame, never an opinion about a screenshot.

**What it cost.** The whole port was built and looked at on one backend, which is what
`--backend` and the shot harness exist to prevent, and every visual judgement made before this
rested on a world drawn double-sided.

### The reference has been run, and the comparison is owed no longer

**Running locally**, which spec §10 asked for and no session had done. `Babylon-Lite` cloned,
`pnpm install`, `pnpm fetch:voxelpack`, `pnpm build:bundle-demo minecraft`, then the lab's own
dev server; the demo is at `/lite/demo-minecraft.html`. Without the bundle step the page loads
and hangs on its splash, requesting `/lite/bundle/demos/minecraft.js` and getting a 404.

What one capture beside the port already shows, beyond the gaps logged above:

- **The block highlight is a filled glowing face, not an outline.** The reference fills the
  targeted face with a bright cyan-white plane and a crisp border. The port draws twelve edges
  in two passes of `drawLines`, which is a different feature at a distance.
- **The help line is a real overlay**, one wrapped line naming every binding including
  `Ctrl+S`/`Ctrl+O`, which the port binds to `O`/`L`.
- **The hotbar slots are numbered, bordered and carry their tile.** All three are done now, and
  the entry above records what it cost to reach them without a textured screen-space verb.
- **Mobs are articulated, and were not.** The reference builds each animal from parts on named
  joints — `legFL`, `legFR`, `legBL`, `legBR`, `legL`, `legR`, `wing` — and rotates them about
  their pivots for a walk cycle. This baked every box of a species into one mesh drawn with one
  matrix, so nothing could move without the whole animal moving with it: the chicken had a single
  stump where the reference gives it two legs, and every species slid rather than walked. Done
  now, to the reference's own gait: diagonal pairs half a cycle apart, a body rising twice a
  stride, a head nodding at half rate, wings beating about Z, and amplitude and yaw eased so a mob
  neither snaps into its stride nor onto a heading.

**Was owed, and the engine has since answered most of it.** Leaf sway, per-vertex alpha for deep
water and the sky-versus-ambient split all landed in **3.42.0**, as one four-lane per-vertex channel
on `MeshData` rather than as the three separate changes this file asked for — locations turned out to
be the scarce resource, not payload, so three one-float attributes did not fit and one `vec4` did.
The port can take them whenever it likes: fill `.x` where the reference gates on `color.a`, `.y` with
the sky factor and drop `SKY_FLOOR` back, `.z` with depth opacity.

**Still owed from the engine**: the water ripple's moving sparkle and its Fresnel, which are
_fragment_-stage terms and not vertex ones, so the channel does not reach them.

**Still owed from the port**: the loading screen — this port builds its atlas inside `mount`, before
the harness draws a frame, so there is nothing to show progress _on_ without restructuring the mount
to stream during frames as `showroom` does.
