# Handbook — using the engine, and getting a model into it

The thing to have open while you work. `FORMAT.md` is the container specification,
`RENDERING.md` is the pass chain, and `CAPABILITIES.md` says what exists at all.

Everything below has been run. Where a number appears it was measured rather than estimated.

---

## The one-minute version

```sh
npm run bake -- <file-or-folder> -o demo/dev/public/thing.drft   # source → .drft
npm run demo                                                     # look at it
```

then in a browser, `?scene=6&model=thing` loads `demo/dev/public/thing.drft`.

If it comes out on its side, add `--up z`. If it comes out upside down, add `--up -y`. The
baker prints what it did, always; read that line before changing anything else.

---

## Quick reference

The whole of it on one screen. Everything below this section is the same material at length.

### Commands

```sh
npm run demo                       # scene picker at localhost:5173, ?scene=N opens one
npm run bake -- <file|folder> -o out.drft
npm run typecheck                  # strict tsc over src/ and demo/, then over scripts/
npm test                           # vitest
npx vitest run src/asset           # just the files you touched
npx tsx scripts/drft-diff.ts a.drft b.drft
npm run changelog                  # release notes for the current version
```

`?scene=6&model=NAME` loads `demo/dev/public/NAME.drft`.
`&paint=black|red|silver|matte` picks the showroom body finish. Black is the default.
`&fill=1` closes a hollow model, `&outline=0` refuses the coarse version a file carries.

The switches a consumer reaches for on a bought model, and §7 below for the order to
meet them in:

```ts
new DrftLoader(renderer, {
  textureWrap: 'clamp', // stops a sample at a UV island border wrapping to the far side
  outline: false, // for a container already in memory rather than streaming
  transform: (mesh) => ({ ...mesh, emissive: new Float32Array(mesh.emissive.length) }),
});
```

**`load` places the model, and `{ fit: 'none' }` tells it not to.** The usual call scales the larger
of the model's footprint and height to a size, centres it in X and Z and stands it on `baseY`, which
is what a showroom or a picker wants:

```ts
await loader.load('/car.drft', { footprint: 4, height: 2, baseY: 0 });
await loader.load('/car.drft', { fit: 'none' }); // metres already, and already placed
```

The second is for a game whose importer has put the model in its own frame. **Do not reach for a
very large footprint to mean "no scaling"**: `Number.MAX_SAFE_INTEGER` is a scale of 2.3e15, not an
identity, and a car drawn nine quadrillion metres wide looks from inside exactly like a model that
failed to load. `loader.placement` reports what was decided either way.

`npm run bake -- <model> --no-lod` writes no coarse version. `--up -y` stands up a model whose
file declares the wrong axis, which the baker now warns about rather than detects.

`npm run bake:check` bakes `scripts/fixtures/tetra.obj` twice and diffs the two, which is the
baker's end-to-end check and the only one that catches what a type cannot: it runs on every
push. `scripts/` has its own `tsconfig.scripts.json` because those files need `@types/node` and
`src/` must never see them.

### Bake flags

| Flag                  | Does                                                                                    |
| --------------------- | --------------------------------------------------------------------------------------- |
| `-o <path>`           | Output. Defaults to the input name with `.drft`.                                        |
| `--up x -x y -y z -z` | Which axis the _file_ thinks is up. Beats what the file declared, and both are printed. |
| `--from <ext>`        | Force a reader when handing over a folder.                                              |

### Formats

Tier 1: `.glb` `.gltf` `.obj` `.stl` `.usdz` `.usda` `.3mf` · Tier 2: `.fbx` · Tier 4
(refused with instructions): `.mb` `.max`

STL is almost always Z-up. USD and 3MF state their own units. glTF is Y-up by specification.

### Building geometry

```ts
const b = new MeshBuilder();
b.setRoughness(0.88); // highlight width, 0–1, or null for the engine default
b.setGrain(0.9); // visible mineral structure, 0–1. absent means none
b.setEmissiveColor([1, 0.6, 0.2]); // or null for "this surface's own colour"
b.addBox(centre, halfExtents, colour, emissive, specular);
b.addQuad(a, b, c, d, colour, emissive, specular); // normal comes from the winding
b.addGroundQuad(a, b, c, d, colour, emissive, specular); // guaranteed to face up
b.addWallQuad(a, b, c, d, awayFrom, colour, emissive, specular); // guaranteed to face outward
b.addOrientedBox(centre, halfExtents, forward, colour, emissive, specular);
b.addCapsule(centre, radius, halfLength, colour, emissive, segments, rings, specular);
b.addSphere(centre, radius, colour, emissive, segments, rings);
b.addCylinder(centre, radius, halfLength, 'y', colour, emissive, segments, specular);
b.addTube(path, radii, colour, emissive, sides); // parallel-transported frame
b.addMesh(mesh, x, y, z, scale); // uniform scale only
b.addOrientedMesh(mesh, origin, right, up, forward, scale); // must be orthonormal, right-handed
const data = b.build({ planarUvs: true });
```

An optional attribute is emitted only if something asked for it, so a world that never
mentions grain uploads no grain buffer.

**Reach for `addGroundQuad` and `addWallQuad` before `addQuad`.** `addQuad` takes its normal from
`(b − a) × (d − a)`, which is not the order a person walks around a rectangle: the obvious winding
for a horizontal quad gives a face that lights from below. That has cost two separate consumers
several scenes each — in one of them every building in a village was lit inside out — and neither
was found by reading, because a flipped normal near a lamp is a dimmer surface rather than an absent
one and only a directional light makes it obvious. The two wrappers take the corners in any order
and turn the face the way you meant: up, or away from a point you name.

### Material properties, in one line each

- `specular` — how much light comes back
- `roughness` — over how wide an angle
- `reflectivity` — how much of the environment is mirrored
- `grain` — whether the surface is mineral. **Independent of roughness.** Painted plaster is
  rough with none; polished granite is smooth with plenty.
- `emissive` / `emissiveColor` — self-illumination, and its colour if not the albedo
- `opacity` — 1 is opaque; below 1 draws after the solids

### Pass state on the renderer

Set once per material group, not per mesh.

```ts
renderer.setMaterial({ albedo, normal, uScale, vScale, cutout, normalStrength } | null);
renderer.setSurfaceGrain(0..1);          // scales what the geometry declared. default 1
renderer.setSurfaceReflectivity(0..1);   // default 0
renderer.drawMesh(mesh, model, depthLayer);
renderer.drawTranslucentMesh(mesh, model, opacity, { lit, fog, toneMapped, depthWrite, depthLayer });
```

Every field is optional and independent. `normalStrength` defaults to 1 when a `normal` is given
and 0 when it is not, so binding a map and saying nothing means "use it". A material with a
`normal` and no `albedo` is a legitimate one — vertex colour with authored normals.

`setSurfaceTexture(tex, uScale, vScale, cutout)` still works and is a wrapper over this. It is
deprecated: ORM and emissive are coming, and four maps through four setters is four chances to
forget one.

### Normal maps

The image is sampled **linear, not sRGB** — its bytes are a direction, not a colour, and decoding
them as display values bends every normal toward the surface and reads as a green tint over
everything. `linear` is `createSurfaceTexture`'s default, so this is only a trap if you override it.

The frame comes from the mesh's tangents where it has them, and from screen-space derivatives where
it does not — so a map works on procedural geometry that never went through `generateTangents`.
`MeshBuilder` supplies none, and `generateTangents(positions, normals, uvs, indices)` is exported
if you want them.

**An importer supplies a frame where the file carries one, and derives one only where a material
declares a normal map.** A tangent frame is four floats a vertex and this engine reads one in a
single place — inside the lit pass's `if (uNormalStrength > 0.0)` — so a frame derived for a
material with no map is a buffer no draw can fetch. It was derived for every mesh with a UV until
3.27.0, which on a 253-mesh CAD export whose materials declare no normal map at all was **11.0 MB
of a 62.7 MB bake**. If you attach a normal map to a material the source file did not have one on,
call `generateTangents` yourself, or bake with the map declared.

A normal map **composes** with `setSurfaceTextureRelief` and the geometry's own `relief` rather
than replacing them: the map is applied first and relief perturbs its result.

### Loading a .drft

```ts
const asset = readDrft(buffer); // zero-copy; throws DrftError on anything malformed
asset.head; // name, generator, unitScale, bounds
asset.meshes; // MeshData[], ready for new Mesh(gl, data)
asset.materials; // one per mesh, by ordinal
asset.textures; // { name, codec, width, height, bytes }
asset.skipped; // optional chunks this reader did not know
```

Decode an embedded image with `createImageBitmap(new Blob([bytes.slice()], { type }))`. The
`.slice()` matters: the view keeps the whole file alive otherwise.

Address textures by name through `TextureSet`, never by ordinal. An unknown name throws and
lists what the asset has.

### Quality options worth knowing

```ts
new Renderer(canvas, {
  sceneSamples: 4, // multisampling. default 1. needs screenEffects
  screenEffects: true, // the off-screen target the post chain needs
  outputTransform: 'aces',
  outputExposure: 1,
  ambientOcclusion: 0.5, // contact shading. default 0. needs screenEffects
  ambientOcclusionRadius: 0.35, // metres. the scale of the gaps that matter
  hdrScene: true, // keep the range to the composite. default off
  bloom: 0.35, // how far a bright thing spreads. default 0. wants hdrScene
  bloomThreshold: 1, // scene units. 1 is "brighter than white"
});
```

`sceneSamples` is clamped to `MAX_SAMPLES` and says so once if it was.

Four per-frame dials sit beside these and scale or replace them:
`setCameraMotionBlur(0..1)`, `setBloom(0..1)`, `setOutputExposure(e)` and
`setDepthOfField(distance, range, scale)`. The first two **scale** their construction-time
ceiling; exposure **replaces** its grade, because a grade has no full value to take a fraction
of; depth of field does both, since its `scale` is a fraction of the `depthOfField` ceiling while
its distance and range are metres of the world and are a fraction of nothing.

`depthOfField` without `setDepthOfField` defocuses the whole frame, and that is the pair to know
about: the focus distance starts at zero metres, which is behind the camera, so every pixel is at
full blur. Set the plane in the same place you set the camera.

`bloom` without `hdrScene` finds nothing at a threshold of 1 and warns once saying so.

### Looking at a rendering change

```sh
npm run demo                                   # terminal one
npm run shots -- capture before                # every published scene, held
# change one thing, restart the dev server
npm run shots -- capture after
npm run shots -- diff before after --region=0,92,1280,678 --speckle
```

Works against any page, not only this harness: `--base=` and `--scenes=0`. The modules under it
(`browser.mjs`, `cdp.mjs`, `png.mjs`, `frames.mjs`) are importable by path from a consuming
project and have no dependencies.

**Headless Chrome picks SwiftShader unless told not to**, which makes every capture worthless and
overheats the CPU. `launch()` passes the flags that reach the real card and
`requireHardwareGpu()` refuses to continue without one. Prefer this to a browser MCP, which has
been unreliable here.

### Hard rules that bite

- Attributes must cover **every** vertex. A short array draws on one driver and vanishes on
  another, with no GL error.
- `texture()` inside a non-uniform branch must be `textureLod(..., 0.0)`. This cost 13 ms a
  frame for six weeks. See `AGENTS.md`, 2026-08-07.
- **A sampler needs its own precision qualifier.** `precision highp float` sets the default
  for `float`, not for a sampler, and GLSL ES defaults a fragment shader's samplers to `lowp`
  — eight bits. Write `uniform highp sampler2D` / `highp samplerCube` for anything carrying
  depth or a normal, and qualify the _function parameter_ too where one is passed on. Colour
  in an 8-bit texture is the one case that does not care. This has now been found in three
  places in this renderer, so assume a new sampler has it wrong until it says otherwise.
- Never `import '@driftengine/core'` inside `packages/core`. Relative imports there; across
  packages, import the package.
- No raw WebGL and no `GPUDevice` outside `packages/core/src/render/`. Every other package
  draws through `registerPass`.
- The barrel is the contract: not exported from a package's `src/index.ts` means private.
- Nothing under any package's `src/` may touch `Date.now()`, `performance.now()` or
  `Math.random()` on a path a consumer might simulate.

### Debugging something visual

1. **Identify the object before explaining it.** Switch draws off one at a time until the
   thing disappears. Make a system draw a small countable number and count them.
2. Hold the frame before diffing two screenshots. Change one thing.
3. If a fix changes every instance and leaves the artefact alone, it is not that geometry.
4. Then measure the thing itself, not a proxy. Then look at it, on the real GPU.

`AGENTS.md`, 2026-08-10 has what happens when steps 1 to 3 are skipped.

---

## 1. What the baker accepts

| You have         | Pass it    | Tier | Notes                                                                                                                                                                                               |
| ---------------- | ---------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.glb`, `.gltf`  | the file   | 1    | The best thing to hand it. Y-up is mandated by the specification, so there is no axis to guess. Both material models are read, the core one and the archived `KHR_materials_pbrSpecularGlossiness`. |
| `.obj` + `.mtl`  | the `.obj` | 1    | The `.mtl` is named inside the file and found beside it. A bare `.obj` still imports.                                                                                                               |
| `.stl`           | the file   | 1    | Triangles and nothing else. Almost always Z-up: expect to pass `--up z`.                                                                                                                            |
| `.usdz`, `.usda` | the file   | 1    | A `.usdz` carries its own textures, so nothing needs resolving.                                                                                                                                     |
| `.3mf`           | the file   | 1    | A printing format: geometry and colour, no UVs.                                                                                                                                                     |
| `.fbx`           | the file   | 2    | Experimental, and says so on every import. The format most stores hand you, and the one characters are sold in: it carries skins and clips.                                                         |
| `.mb`, `.max`    | the file   | 4    | Identified and refused, with the export that works named.                                                                                                                                           |
| a **folder**     | the folder | —    | It inventories what is inside, picks the highest tier, and prints the choice.                                                                                                                       |

**Hand it the folder when you have one.** A store download is usually the source plus three
conversions, and exactly one of them is the best thing to read:

```sh
npm run bake -- ./tomb-props -o tomb-props.drft
#   tomb-props/ — found glb, gltf, fbx, usdz
#   Using glb (tier 1). fbx would have been tier 2.
```

`--from fbx` overrides the choice, which is how you compare what two readers make of one
asset.

---

## 2. The five questions a bad import raises, and how to answer each

### It is on its side, or upside down

Use `--up`. Six values: `x -x y -y z -z`, naming which axis the _file_ thinks is up.

Do not reach for a matrix. There is one turn, in `orient.ts`, applied to the shared
intermediate, six signed axes, each an exact integer matrix with determinant +1. A reader
_reports_ what the file declared and applies nothing.

**How to check it, and what not to use.** Do not use a half-width heuristic: it gave a false
positive twice on the same asset. Use something the model itself decides. A car's tyres are
at the bottom and its roof is at the top, so print the y range of the wheel material and the
roof material and compare them. Then look at it.

The trap worth knowing about: a file can declare an axis and _contain_ something else. The
test car says `UpAxis = 1, UpAxisSign = 1` and its contents sit a half turn about X from
that. Nothing in the file records it, so no reader can derive it. That is what `--up` is for.

### It is enormous, or a speck

`metersPerUnit` in USD and `unit` in 3MF are read and carried into `HEAD` rather than
multiplied into the vertices. Nothing else states a unit at all. If a model is a thousand
times too big, it was probably authored in millimetres by a format with no way to say so.

### It is white, or grey, and should not be

Three things to check, in this order, because they fail differently:

1. **Does the file actually carry the colour?** Frequently it does not. The test car stores
   `body` as `0.800, 0.800, 0.800` and names no texture, and every one of its 175 vertex
   colour layers is white. The vendor's thumbnail shows a red car because the red was
   assigned in the store's own viewer and never exported. **A grey body is the honest import
   of that asset.** Painting it is then a feature on our side, not a fix.
2. **Did the material read impossibly?** Some exporters write `0.815686` as the integer
   `815686`. The baker divides a triple by its own largest component when it sees that, and
   the tell it was doing the wrong thing was a caliper colour of `8, 564706, 160784` — that
   `8` is `000008` with its leading zeros lost.
3. **Is the texture bound but not sampled?** Compare the two `.drft` file sizes. Two bakes of
   one asset that differ by tens of megabytes means one embedded maps and the other did not.
4. **Is it a glTF written in the archived specular-glossiness model?** It imports — but a bake
   from before 3.33.0 does not, and the symptom is exact: every texture in the file read, embedded
   and bound to nothing, and every surface painted in one flat colour. A 1995 Fiat Punto GT read
   that way loaded **20 textures and bound 0**, reporting 144 of 144 meshes as carrying no albedo
   map. `KHR_materials_pbrSpecularGlossiness` is what a store still serves for anything exported
   from a specular workflow, and a material using it carries **no `pbrMetallicRoughness` object at
   all**, so a reader that knows only the core model finds no base colour map to bind. Re-bake and
   it is fixed; see §4 for the half of such a file that is still not carried.

### It has holes in it, or parts are missing

A tier 2 reader refuses rather than half-imports, so a missing part is not the reader giving
up quietly. Check the warnings the baker printed. Then check whether the welder collapsed
something it should not have: `weldMesh` merges two corners only when position, normal,
colour, emissive, UV, specular, roughness _and_ grain all match, so a hard edge stays hard.

### It renders on your machine and vanishes on someone else's

Almost always a short attribute array. Every optional attribute must cover every vertex; a
short one is read as zeroes by some drivers and drops the draw entirely on others, with no
GL error either way. `validateMeshData` catches it at construction and the writer catches it
before anything reaches a file — so if you are seeing this, something bypassed both.

---

## 3. Textures

### When a model is read

`readModel` fetches the images a model names, through the `beside` hook the caller supplies and
in the order `assetCandidates` gives: the declared path with any drive letter and root stripped,
the bare filename, then `textures/`, `Textures/`, `tex/`, `maps/`, `images/`. Most specific
first, so an asset carrying two `wheel.jpg` in different folders resolves each to its own.

**Supply a `beside` and the textures arrive with bytes; supply none and they arrive as names.**
A caller with no way to fetch anything is unchanged, and so is a `.glb`, which carries its images
inside itself and is never asked about. A reference that resolves to nothing is _left in the
list_ rather than dropped, because `DrftMaterial.albedo` is an ordinal into it and removing an
entry renumbers every texture after it, which silently repaints the model. What was found
somewhere other than where the model looked is reported in `notes`.

This is the engine's half of the split `assetPath.ts` describes: it decides **what to look for**,
which is the same wherever the model came from, and the caller's `beside` decides **where**,
which only the caller can know. It moved here in 2026-08-16 after two hosts had written the same
walk, one against a folder and one against a zip's entry list.

### At bake time

The baker resolves anything still unresolved against a second root, its search root, using the
same candidates. It prints what it embedded, so a substitution is visible rather than assumed.

Replacing an image in the model's own `textures/` folder and rebaking swaps it. A `.usdz`
needs none of this: its images travel inside the archive and come out with the bytes
attached.

Only images a material actually reaches are embedded — **true as of 3.33.0, and this line had
promised it for longer than that.** Every earlier bake carried the source's whole texture list,
because the four ordinals in `MATL` index it and compacting it without rewriting them repaints the
model. Both halves happen together now: the unreachable entries go and the surviving ordinals are
renumbered. It was worth a whole model — a car in the archived specular-glossiness material model
embedded 20 textures and reached none of them — and it is worth the leftovers of a normal one, a
specular-glossiness map being the map this reader still cannot repack. An image that goes is never
opened either, so a dropped DDS costs no decode.

**The cost**: an image no material samples is not in the asset, so `TextureSet.get` throws for its
name the way it throws for any name the file does not have. If you want an unsampled image out of a
container, say so — the current answer is that nothing does, and the alternative is every asset
carrying its source's whole folder.

`TEXS` stores each one **exactly as it arrived**, since a JPEG the artist exported is already the
size it is going to be. Width and height are read from the image's own header rather than by
decoding.

**The one exception is a block-compressed DDS**, which no browser decodes, so the baker decodes
it and writes a PNG. That is lossless at both ends, so the pixels are the source's. It once
write the decoded RGBA uncompressed, and the file paid for it: 21 textures of one shipped car
were 3.6 MB of DDS and 11.6 MB in the container. If you have a bake from before 3.30.0 with a
DDS-textured model in it, rebaking is worth doing on file size alone.

### At runtime

```ts
const asset = readDrft(buffer); // zero-copy views over the fetched bytes
const bitmap = await createImageBitmap(
  new Blob([asset.textures[0].bytes.slice()], { type: 'image/jpeg' }),
);
const tex = createSurfaceTexture(gl, bitmap);
renderer.setMaterial({ albedo: tex }); // pass state: bind once per group
renderer.drawMesh(mesh, model);
```

Two things about that snippet are load-bearing:

- **`.slice()`**, because `bytes` is a view over the whole asset and a `Blob` over the view
  would otherwise keep the entire file alive.
- **`setMaterial` is pass state**, so bind it per _material group_, not per mesh. The showroom
  draws 187 meshes in 8 draws that way.

### Addressing a texture by name

Never hold an ordinal. An index that has gone stale still resolves — to the wrong surface,
silently.

```ts
renderer.updateSurfaceTexture(set.get('Tire_05_DM.jpg'), bitmap);
```

`TextureSet` resolves both the bare filename and the declared path, since a material may say
`textures\Tire_05_DM.jpg` while a person says `Tire_05_DM.jpg`. An unknown name **throws**,
listing what the asset does have. That is the point of it rather than an accident: a lookup
that quietly returned nothing would put the stale-index failure back in a new spelling.

`updateSurfaceTexture` re-uploads into the existing GPU object, so a binding a draw loop
already holds stays valid.

---

## 4. Materials, and which knob does what

A `.drft` material carries: `color`, `specular`, `roughness`, `emissive`, `emissiveColor`,
`opacity`, `albedo` (a texture index, or -1), and `reflectivity`.

The four that get confused with each other:

| Property       | Question it answers                                                                                                                | Wrong answer looks like                                 |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `specular`     | How much light comes back from a highlight.                                                                                        | Plastic, if everything has it.                          |
| `roughness`    | Over how wide an angle. A polished floor smears a lamp into a streak; a tight lobe can only make a small dot brighter.             | A mirror that will not smear.                           |
| `reflectivity` | How much of the _environment_ the surface mirrors. Distinct from `specular`: plastic takes a sharp highlight and reflects nothing. | Paint that reads as opaque however tight the highlight. |
| `grain`        | Whether the surface has visible mineral structure.                                                                                 | See below.                                              |

**Grain is independent of roughness and this cost the project real time.** Painted plaster is
rough and has no grain. Polished granite is smooth and has a great deal. Grain was derived
from `specular`, then from `roughness`, and both are proxies: a painted masonry tower at
roughness 0.55 took 55% grain and read as marble. It is now its own attribute:

```ts
builder.setRoughness(0.88).setGrain(0.9); // sandstone: rough and mineral
builder.setRoughness(0.16).setGrain(0); // gold: smooth and not
builder.setRoughness(0.55).setGrain(0); // painted masonry: rough and not
builder.setRoughness(0.3).setGrain(0.8); // polished marble: smooth and very
```

Absent means **zero**. A surface that never says it is mineral is not mineral.

`renderer.setSurfaceGrain(amount)` remains as the pass-level scale over whatever the geometry
declared, which is what an imported model that declares nothing needs.

### The two glTF material models, and the half of the old one that does not survive

glTF has had two. The core one is metallic-roughness; `KHR_materials_pbrSpecularGlossiness` is
Khronos' first, archived in 2020 and still what a specular workflow exports. **Both import.**

A specular-glossiness material states a diffuse colour and map, a specular _colour_, and a
glossiness. The reader solves that pair into a metalness and a roughness — the extension's own
Appendix B conversion, which is what makes chrome, whose diffuse is black and whose colour is
entirely in its specular, arrive as chrome rather than as a black mirror.

**What does not survive is a `specularGlossinessTexture`.** It packs the specular colour in RGB and
the glossiness in A, and an ORM map wants roughness in G and metallic in B — so carrying it means
decoding and re-encoding every image to move one channel, which the reader does not do. The diffuse
map still binds; the pair is left absent, and such a surface draws as a dielectric at the engine's
default roughness. **The baker names every material this applies to**, so it is a line in the
import output and not something to deduce from the picture:

```
material 3 "body": its specular and glossiness are in a map whose channels no rearrangement
fits into an ORM one, so it draws as a dielectric at the default roughness. Its diffuse map
is bound.
```

A file that carries _both_ blocks — some exporters write a metallic-roughness fallback beside the
extension — is read as the core one, because that exporter did the conversion with the texels in
hand and could produce the `metallicRoughnessTexture` this reader cannot.

---

## 5. Proving two bakes agree

This is the tool to reach for whenever a reader changes.

```sh
npm run bake -- "models/Sigma Girl/Sigma girl .obj" -o /tmp/a.drft
npm run bake -- "models/Sigma Girl/Sigma girl .fbx" -o /tmp/b.drft
npx tsx scripts/drft-diff.ts /tmp/a.drft /tmp/b.drft
```

Known-good figures, so a regression is obvious:

- **Sigma Girl**, as OBJ and as FBX: **111,668 vertices, 154,543 triangles** either way, with
  the same seven colour maps embedded.
- **`models/varied`**, one model as glb, obj, stl and fbx: **1,994,358 triangles**, all four.

Mesh counts may legitimately differ between readers, because grouping follows how a format
stores its materials rather than what the model is. **Triangle counts may not**, and the tool
fails on that. It earned its place on its first run by catching a 401 MB FBX bake of a model
that OBJ baked to 94 MB.

---

## 6. The container, briefly

Read `FORMAT.md` §4 for the bytes. What matters day to day:

- **Zero-copy.** Vertex data is viewed in place, so loading costs the bounds checks and
  nothing else. Do not add a copy.
- **Old files open forever.** A file written today opens in every future reader. Unknown
  optional chunks are skipped in silence; an unknown _required_ chunk is a refusal naming
  the FourCC.
- **Read a `MATL` entry by the stride the file declares**, never your own. A newer writer
  appends a field and lengthens the stride; stepping by a hard-coded size shifts every entry
  after the first and repaints the whole model with no error raised.
- **Attributes are stored separately, not interleaved**, because that is exactly how `Mesh`
  uploads them.

Adding an attribute or a chunk is a **minor** version and costs nothing: take the next free
bit, append to the end of the payload. Grain did exactly that in 1.1 — it belongs beside
roughness conceptually and it is written last, because inserting it where it reads best would
have shifted every array after it.

### If you weld a model yourself, derive its tangents afterwards

`readModel` derives a tangent frame where a material declares a normal map and the file supplies
none. That is right for a model going straight into a renderer and wrong if you are going to weld
it, because the derivation accumulates per index: on a file storing one vertex per triangle
corner, every corner gets its own frame and the weld can merge none of them. A normal-mapped soup
that should weld to 169 vertices comes out at 830.

```ts
const model = await readModel({ ...source, deriveTangents: false });
const mesh = deriveTangentsFor(weldMesh(model.meshes[0]));
```

The frame is better that way as well as cheaper — averaged over every triangle at the vertex,
which is the smoothing the derivation exists for. The baker does exactly this, so a `.drft` needs
none of it.

### Counting the draws a bake will cost, before you ship it

`DrftLoader` merges parts whose material would set the same GPU state, so the number of draw calls
a model costs is the number of _distinct_ materials in it and not the number of parts. If your
baker reports that number, ask the loader for it instead of working it out:

```ts
import { drawKeyOf } from '@driftengine/assets';

const draws = new Set(parts.map((part) => drawKeyOf(part.material))).size;
```

**Do not rebuild the key yourself.** It is ten fields today — four texture indices, opacity,
reflectivity, three scales and the cutout — and it has grown twice. A consumer who copied it
field for field was one field short from the day `cutout` joined it in 3.26.0, and a short key
does not throw: it merges two surfaces that the loader will keep apart, and under-counts.

`resolveDrawGrouping` is the same answer with the fields separate, if you need to know _which_
state a group sets rather than only whether two parts share it. Both take the override your
`surface` callback returns, because that is applied before the grouping and can split a group
your materials alone would not.

---

## 7. Consuming an arbitrary model, in the order you meet the traps

**Written from a second consumer's notes**, after somebody outside this repository built an app
around an arbitrary model and wrote down what cost them time. Everything below is documented
individually elsewhere in this file; what was missing was the order to meet it in.

**1. Which way is up, before anything else.** A container's declared axis can simply be wrong: the
car this pipeline was built against declares `+y` and is a half turn about X inside it, so it bakes
roof down and nothing in the file records that. The baker now warns when a model ends up spanning
almost entirely below its own origin and names `--up -y`, but the warning is a hint rather than a
detection. Check the sign of the y range, not a half-width heuristic, which gave a false positive
twice here.

**2. Material names are the only handle you have.** A bought model states `0.8` grey for almost
everything, which is an exporter's default rather than a statement, so an honest import is a white
object. What it _does_ state exactly is what each surface is called. Match on what a name contains
rather than on the whole string, put the specific rules first, and leave anything you do not
recognise alone so the asset is dressed rather than hidden. `DrftLoader.transform` and
`DrftLoader.surface` are the two seams for it.

**3. Emissive is the asset's, and a dark scene is where you find out.** A material may carry
emissive the exporter set and nobody looked at, and it is added on top of the lighting, so it is
invisible against a bright background and obvious against a dark one. Measured on the car here:
**one material of 187**, its rear lights, at 0.639 red over 9,500 of 1,030,720 vertices. So this is
usually a small glow in one place rather than a spray over the whole model, and the check is one
line rather than a theory:

```ts
const hot = asset.materials?.filter((m) => m.emissive > 0) ?? [];
console.log(hot.map((m) => `${m.name} ${m.emissive}`));
```

Neutralising it needs no new API. `transform` sees every mesh before it is uploaded:

```ts
new DrftLoader(renderer, {
  transform: (mesh) => ({ ...mesh, emissive: new Float32Array(mesh.emissive.length) }),
});
```

**It is not gated by day and night the way it looks.** `nightFactor` multiplies the emissive term,
and the showroom runs at `nightFactor: 1`, which is fully open. What hides an asset's emissive
there is that the room is brightly lit, not the clock.

**4. Textures repeat past their own edge unless you say otherwise.** A `SurfaceTexture` is created
with `REPEAT`, mips and anisotropy, which is right for a tiling map and is a trap at the border of
a UV island: a sample whose footprint crosses the edge wraps to the far side of the image, and a
high enough mip averages across islands that have nothing to do with each other. Combined with the
`0.8` grey underneath an untextured surface, that shows up as single bright pixels tracing the seams
of every textured part, invisible against a light background and obvious against black paint.
`DrftLoader`'s `textureWrap: 'clamp'` is the switch. Try `anisotropy: 1` alongside it to find out
whether the footprint is the mechanism, since the two are separable.

**5. An archive is an archive.** A bought asset arrives as a zip holding the mesh in three formats,
a `textures/` folder and a licence. `readZip`, `readerFor`, `MODEL_FORMATS`, `assetCandidates` and
`ModelSource.beside` are all exported, and so is the one subtle piece: `prepareZipInflate` with
`browserInflateRaw`. A zip stores **raw** deflate where FBX stores zlib-wrapped, and the inflate
callback has to be primed in one pass and answered in the next, because the only decompressor a
browser has is asynchronous.

**6. Three settings that are silently zero.** `createEnvironment` defaults `shadowStrength` to 0, so
a scene can enable `directionalShadows`, run the shadow pass, offer casters and see nothing, with
no diagnostic anywhere. And `outputExposure` only means something with an `outputTransform`, since
exposure is how far a scene is scaled into a curve.

**6a. `Camera.far` is 500 metres and clips on view depth rather than on distance.** Reported from
outside and worth knowing because of the _shape_ of the failure rather than the number. A consumer
built a world with a star at 900 m and planets out to 1270 and never set the far plane. What made
it cost four rounds is that the clip is on depth along the view axis: the star was 900 m away and
65 degrees off axis, so its depth was 405 and it drew perfectly, and turning the camera toward it
carried the depth up to the distance and it vanished at exactly the moment it would have been in
shot. Measured against the live matrices, `ndcZ` went 0.9996 to 1.0006. So the object was reported
as wrong four times, from four pictures it was not in. Set `camera.far` from the size of the world
rather than from what is currently on screen.

The third silent zero is the newest and it does warn, once, at construction: **`bloom` needs
`hdrScene`.** Its
threshold is in scene units, and without the range the scene is clipped to 0..1 before the
composite sees it, so a lamp and a white wall arrive as the same colour. Measured on the engine's
own night rig, `bloom: 0.35` at the default threshold with `hdrScene` off changed **zero pixels**
against the same frame with no bloom at all. Turn both on together, or lower the threshold below 1
and accept that it is selecting whiteness rather than brightness.

**7. The coarse outline is aimed at a load that streams.** It draws until the real geometry is
complete, which is the point when bytes are arriving over a network. Where the container is already
in memory, fetched whole or converted in a worker, it is on screen for a frame or two and has been
reported z-fighting the bodywork it stands in for. `outline: false` on the loader is the answer for
that case.

**8. If you would rather wait and show the model whole, the loader is already built for it.** The
progressive reveal is what the loader _offers_, not what it imposes: a hull first, then parts
fading in as they arrive, then a merge. That is right for a showroom, where watching an object
assemble is the point. It is wrong for a beat-synced edit, where a part appearing mid-shot is a
flaw, and wrong again for a game holding a plate over the whole load. **Which of those a caller
wants is a decision about the product rather than about the model, so the engine supplies the
pieces and does not choose.**

The whole of it, and nothing here reaches for anything private:

```ts
const loader = new DrftLoader(renderer, { outline: false, revealSec: 0 });
// ...
if (loader.progress.phase !== 'ready') return; // draw nothing until the picture is right
fade = Math.min(1, fade + dtSec / 0.4);
for (const part of loader.parts) {
  renderer.setSurfaceTexture(part.albedo >= 0 ? (loader.textures?.at(part.albedo) ?? null) : null);
  renderer.setSurfaceReflectivity(part.reflectivity);
  const opacity = part.opacity * fade;
  if (opacity < 1) renderer.drawTranslucentMesh(part.mesh, model, opacity);
  else renderer.drawMesh(part.mesh, model);
}
```

Three things in that are load-bearing. **`outline: false` and `revealSec: 0`** switch off the two
halves of the progressive behaviour, the second because `reveal` then reads 1 the moment a part
exists instead of ramping, which leaves the fade entirely yours. **`phase === 'ready'`** is the
gate and the counters are not: see `DrftLoadProgress`, where the difference was measured at one
and three quarter seconds of a model that every number called finished. And **the branch at
`opacity < 1`** matters more here than in the showroom, because you are fading every part at once
rather than a few at a time: the translucent path is a blended pass with no interior sorting, so
on a model with a cabin the far side shows through the near side for the length of the fade.
Nobody notices over 400 ms. Everybody notices over three seconds.

### A model whose own materials blend, which is most bought vehicles

The paragraph above is about a fade, where the wrongness lasts 400 ms. **The same arithmetic is
permanent on a model that declares blended materials of its own**, and a consumer measured how
common that is: across six shipped cars, between 6% and 23% of materials declare a blend, and on
the worst of them 96 of 212 meshes are interior surfaces sitting inside the shell. Drawn with the
default, the first of each overlapping pair claims the depth buffer and the rest are discarded —
a car of interpenetrating shards, with its dashboard through its bonnet.

Two options answer two different halves of it, and a model like that needs both:

```ts
/* Surfaces that overlap in view: stop them claiming depth, and submit them far to near. */
for (const part of farToNear(blendedParts, camera)) {
  renderer.drawTranslucentMesh(part.mesh, model, part.opacity, { depthWrite: false });
}
/* A surface coplanar with what it decorates: declare which one wins. */
renderer.drawTranslucentMesh(decal.mesh, model, decal.opacity, { depthLayer: 1 });
```

**`depthWrite: false` hands you the order.** Nothing in the depth buffer means nothing to sort by,
so a set drawn in the wrong order now blends in the wrong order instead of hiding itself — a
different wrong picture, not a fixed one. Sort by view depth, and note that a _material group_
spanning a whole model has no meaningful centroid to sort by: if your parts are grouped by image,
the group is the wrong unit and the sort wants finer pieces.

**`depthLayer` is for the case no ordering can fix.** Two coplanar surfaces have equal depth in
exact arithmetic, so which one survives is decided per pixel by which way the rounding fell. A
higher layer wins wherever they coincide, up to `MAX_DEPTH_LAYER`.

**Before reaching for either, check whether the surface is a mask.** A great many surfaces that
declare a blend are decals whose shape lives in their image's alpha, with no partial transparency
anywhere in them. Those want `cutout` and the opaque path: the fragment stage runs
`if (texel.a < cutout) discard` on **both** paths, so an opaque draw reads a texture's per-texel
alpha exactly as a blended one does — what it cannot do is a soft edge. A masked surface on the
opaque path is sorted by the depth buffer for free, needs neither option here, and is the right
answer for a grille, a vent, a logo or a foliage card. Blending is for glass.

`demo/dev/blended.html` is the page all of this was measured on; its query flags turn each half on
and off separately.

**9. A model that is only a surface can be closed, and a great many bought ones are.** A car with
no cabin, a building with no rooms, a figure that is skin and nothing under it. Drawn on their own
they are correct, and the moment a viewer can see through an opening — a grille, a vent, a window
aperture, a doorway — they look straight through the object and out the far side. It reads as a
rendering fault and is not one, which is why it is worth knowing the name of before meeting it.

**Two pieces, and neither replaces the other.** That is the whole design and it is the part that
saves a consumer from building the wrong half:

- **`shellSkin(mesh, color)`** is a copy of the model drawn just inside itself. It follows every
  curve exactly, because it _is_ every curve, so it backs each panel with no tuning and no
  knowledge of what the subject is. It cannot help with an opening, because a copy of a shell has
  the same hole in the same place. Both windings are emitted, since it is looked at from inside as
  often as out, and it is flattened to one colour or an opening shows the model's own brightwork
  through the thing meant to hide it.
- **`buildShellFill(size, baseY, options)`** is a generated solid behind that. It has no holes, so
  it is what a viewer sees through one. It cannot follow a surface, so it is held well inside and
  never asked to.

`shellFillMatrix(scale, centreY, out)` is the third piece and it is what draws the skin _inside_
the original rather than coincident with it. The showroom shrinks by **0.985**, which is enough to
stop the two fighting for the depth buffer and small enough that no panel is visibly hollow.

Everything takes sizes and fractions. `ShellFillOptions.profile` is where a caller says what the
subject looks like from the side, as fractions of its own bounds, so the same profile fits a model
of any dimensions and the module knows nothing about cars. `inset` defaults to 0.78 and holding it
well inside is deliberate: a stack of boxes is a bounding volume, and one pushed out toward the
real surface shows its corners through the model it is hiding behind.

**It is opt-in, and the reason is a bug this repository shipped.** The showroom had the fill on for
everything, which puts a black box behind the glass of any model that _does_ have a cabin: the
solid is correct, the model was never hollow, and the result is a car with an opaque interior. So
turn it on for a shell and leave it off for anything modelled inside. `?fill=1` is the switch in
the demo, `DemoSceneOptions.fill` is the same answer from a host that knows its own model, and the
cost is two extra draws — measured at 13 to 15 on the car.

## 8. Things that have gone wrong here, so they need not go wrong again

Every one of these was a plausible wrong answer that passed a check.

- **A transposed matrix** left the bounding box unchanged to three decimal places. Transposing
  `compose`, `multiply4` and the position indexing together is a _no-op_, because
  `(A·B)ᵀ = Bᵀ·Aᵀ`.
- **NaN lights** still reported four selected lights. `flicker` was absent, `undefined <= 0`
  is false, so the steady path computed `1 + undefined * wobble` and propagated NaN into
  every term it touched. A scene lit by nothing still shows its ambient — that was the tell.
- **Green brake calipers** were a perfectly ordinary colour, and wrong.
- **A white character** had a texture correctly bound to it.
- **A giant malformed bird** was the lighthouse beam. Five measured, internally sound
  explanations of the _flock_ were produced before anyone established which draw call was
  putting those pixels on the screen. See `AGENTS.md`, 2026-08-10.

The rule that covers all of them: **measure the thing itself, and identify the object before
explaining it.** A proxy measurement will agree with the bug. And then look at it — a
rendering change is not verified until it has been looked at, on the machine's real GPU.

---

## 9. Shipping it as an application

The engine runs in a browser and a game built on it can also be an installable application: Windows,
macOS and Linux in a bundled Chromium, Android around the system WebView, iOS around WKWebView. One
manifest, one command per target.

```sh
npx drift-package bootstrap        # fetch whatever those targets need, once per machine
npx drift-package doctor           # what is missing, and how each target would be signed
npx drift-package build --target=linux-x64
```

[`packages/package/README.md`](../packages/package/README.md) is the whole of it — the manifest,
the three signing modes, which machine builds which target, Steam, and the two things that will
bite. What belongs _here_ is the part that changes how you write the game:

**Take your capabilities from `createHost`, once, at boot.**

```ts
import { createHost } from '@driftengine/package';

const host = createHost(canvas);
const { renderer } = await createRenderer(canvas, quality);
```

`host.store` is a `KeyValueStore` — `localStorage` in a tab, a file in a shell, Steam Cloud when the
manifest names an app, and the game cannot tell which. `host.display` is a video settings screen:
window mode, surface size, the display list and the refresh rate. `host.lifecycle.canQuit` says
whether an Exit button belongs on screen at all. `host.services` is achievements and presence, or
null. `host.screen` is what a phone has instead of a window.

**Every call a platform cannot perform answers `false` or `null`** rather than doing nothing
quietly. That is the contract worth writing against: a settings screen greys the control it cannot
offer instead of shipping one that appears to work.

**The engine still names no shell.** Everything above is an interface the engine declares and
something else supplies, exactly as `KeyValueStore` always was. A game that runs only in a browser
passes nothing and loses nothing.

---

## 10. Animating an imported vehicle

A racing game needs wheels that spin and steer, suspension that travels, a steering wheel that
turns, doors that open and lamps that light. All of it is in the model already, as a **named node
hierarchy** — and every reader before this one flattened that hierarchy away.

### 10.1 What you get, and the one call that makes it usable

A bake writes `NODE` beside the meshes. `MESH` stays **world space**, which is what keeps older
files and older readers working, so the geometry you load is the whole car welded into place.
`localiseNodes` is what turns it into parts:

```ts
import { localiseNodes } from '@driftengine/assets';

const { parts, world, warnings } = localiseNodes(asset.meshes, asset.nodes);
```

- `parts[n]` is mesh _n_ expressed **about its own node's origin**, so rotating it rotates it in place.
- `world[i]` is node _i_'s accumulated matrix, column major. Draw `parts[node.mesh]` under it.
- Animating a node means editing its TRS and recomputing `world` for it and its descendants.

Measured on a 44.6 MB car: 221,077 vertices, one pass, worst round-trip error 1.57e-7 m. It is
load-time work and does not belong in a frame — put it behind the frame budget for a large model.

### 10.2 The hierarchy a car actually has

Read from a shipped car. The names are the format's own convention, and the suffix is the corner:
`LF`, `RF`, `LR`, `RR`.

```
root
├── HUB_RF                 steering, and suspension travel
│   ├── WHEEL_RF           wheel spin, and nothing else
│   │   ├── TYRE_RF
│   │   ├── RIM_RF
│   │   └── RIM_BLUR_RF    the blurred rim, shown instead of RIM at speed
│   └── SUSP_RF            the arm, a sibling of the wheel
├── STEER_HR               the steering wheel in the cockpit
└── the lamps, the doors, the panels — all at the root
```

**`HUB_*` steers and `WHEEL_*` spins, and getting that backwards is the mistake to avoid.** They
are parent and child on purpose. Yaw the hub and the wheel and the suspension arm both follow, which
is what steering does. Roll the wheel and only the wheel turns, which is what a rolling tyre does.
Put the steering on `WHEEL_*` and the suspension arm swings round with the tyre.

```ts
const hub = byName.get('HUB_RF')!; // steer: yaw about the vertical axis
const wheel = byName.get('WHEEL_RF')!; // spin: roll about the lateral axis

hub.rotation = quatFromAxis([0, 1, 0], steerAngle);
wheel.rotation = quatFromAxis([1, 0, 0], wheelAngle); // += speed / radius * dt
```

`RIM_BLUR_*` is the trick that makes a wheel read as fast: draw `RIM_*` below roughly 40 rad/s and
`RIM_BLUR_*` above it, crossfading over a small band. The model ships both because no amount of
rotation per frame will blur a rim that the rasteriser samples once.

### 10.3 Doors, and where the hinge really is

**The node's origin is not the hinge.** On a shipped car the door's transform sits near the middle
of the panel, so rotating about it swings the door around its own centre and half of it goes through
the body. There is no hinge in the file: base Assetto Corsa does not open doors, so nobody authored
one.

So derive it, from the geometry you already have. The hinge is a **vertical axis through the door's
forward edge**, and forward is `+z`:

```ts
/* World-space bounds of the part, which is where a hinge is a fact. */
const box = boundsOf(asset.meshes[door.mesh]);
const hinge: [number, number, number] = [
  (box.min[0] + box.max[0]) / 2, // the door's own side of the car
  (box.min[1] + box.max[1]) / 2,
  box.max[2], // its forward edge
];
```

Then rotate about that axis rather than about the node origin: translate the part so the hinge is at
the origin, rotate about `+y`, translate back. A front-hinged door opens to about 1.1 rad.

The same reasoning gives the other panels, and the axis differs for each:

| part           | hinge lives at                 | axis           |
| -------------- | ------------------------------ | -------------- |
| a side door    | its forward edge, `box.max[2]` | vertical, `+y` |
| the bonnet     | its rear edge, `box.min[2]`    | lateral, `+x`  |
| the rear hatch | its top edge, `box.max[1]`     | lateral, `+x`  |

**Check it by opening the part fully and looking at it**, once, per model. A hinge derived from a
bounding box is right for a panel whose edge is straight and wrong for one that is not, and the
failure is obvious on screen and invisible in any number.

### 10.4 Suspension, steering and the rest

The source ships keyframed clips beside the model for suspension travel, steering, wipers and gear
shifts. **This reader does not read them, and for the first four you do not want them**: suspension
travel and steering angle are outputs of your own physics, and a canned clip replayed over a
simulated car is a car whose wheels disagree with the road under them. Write the physics onto the
nodes.

```ts
/* Suspension: the hub rides, the arm follows because it is a child. */
hub.translation = [rest[0], rest[1] + travel, rest[2]];

/* The cockpit wheel, geared to the same input as the front hubs. */
steer.rotation = quatFromAxis([0, 0, 1], -steerAngle * lockRatio);
```

Wipers and shift animation have no physical source, so those clips are the only place that motion
exists. Reading them is named as follow-up work in the import design; until then a wiper is a node
you sweep yourself.

### 10.4b Surfaces that are see-through, and surfaces with holes in them

Two different facts, and the container carries them in two different fields because reading one as
the other is a defect this handbook can name precisely.

- **`DrftMaterial.opacity`** is how much light passes through the surface. Below 1 the surface
  blends and the loader draws it after the solid ones. Glass.
- **`DrftMaterial.cutout`**, and `DrftPart.cutout` beside it, is the alpha **below which a fragment
  is discarded**. It is what `SurfaceMaterial.cutout` takes, and it is how a grille, a mesh vent,
  foliage or a decal gets its shape from its image rather than from its geometry. A surface with a
  cutout is fully opaque everywhere it is not discarded.

A source states these separately and this reader keeps them separate: glTF's `alphaMode` is `BLEND`
for the first and `MASK` for the second, and an Assetto Corsa material carries an `alphaBlendMode`
for the first and `ksAlphaRef` for the second. **Reading the second as the first is how nine
surfaces of a hundred and two on a real car came out invisible** — every material that said "test
nothing" was read as "opaque by nothing" — and it is why a consumer's importer should never repair
an opacity of 0 by name. If you find yourself writing `if (name.includes('glass'))`, the fact you
want is in the file.

### 10.5 Lamps

Lamps are ordinary nodes carrying ordinary meshes, named for what they are: a headlight, a brake
light, a tail light, a third brake light. They do not move, so they never need localising — what
they need is an emissive that changes.

Take the material each lamp node's mesh wears and raise its `emissive` when the lamp is on. The
engine gates emissive on `nightFactor`, which is the trap named in `AGENTS.md`: a brake light with
emissive set and `nightFactor` at zero shows nothing, and the material will look correct in every
value you print.

### 10.6 The traps, in the order you will meet them

- **Localised geometry is not in metres.** The measured car's door is about 210 units wide locally
  and 0.15 m wide in the world, because its node carries roughly a 1/140 scale. `world[i]` holds
  that scale. Compute distances, hinges and offsets in **world space**, always.
- **`+z` is forward, `+y` is up, and `+x` is the car's left**, which is the frame the source states
  and the frame it arrives in. **This paragraph once said the opposite** — that the reader mirrored
  the source and a part on the driver's side came out on the other side of `x` — and it was wrong
  from the day it was written: the `.kn5` reader declared the format left-handed on the strength of
  the simulator being a DirectX title and mirrored every car it read. The measurement that settles it
  is a badge: rendered from the file with no conversion it reads forwards, and through the mirror it
  reads backwards. **Nothing numeric catches this**, which is why it survived a release — a mirrored
  car has the same bounds, the same triangle count and the same consistent winding as an unmirrored
  one. Finding parts by name is still the better habit, because a name survives an asset that was
  genuinely authored mirrored; the sign is now meaningful rather than inverted.
- **A name is a convention, not a guarantee.** `WHEEL_*`, `HUB_*` and `STEER_HR` are reliable; a
  mod's panels and lamps are named in whatever language its author used. Build a `Map` from
  `node.name` once and fail loudly on a lookup that misses, so a model that does not follow the
  convention says so at load instead of quietly never opening its doors.
- **One node, one mesh.** A part is a dummy holding the transform with a mesh node beneath it, so
  the node you animate and the node holding the geometry are usually parent and child. Walk to the
  child for `mesh`, animate the parent.

### 10.7 Repainting the car

A racing game lets a player pick a colour, and the source format has a real answer for this that
survives the import intact.

**A skin is a set of texture overrides matched by name.** The model embeds its paint maps; a skin
folder beside it holds files with _exactly the same names_, and picking a skin means using those
bytes instead. Nothing about the geometry, the materials or the bindings changes. In the car
measured here the paint is three embedded textures, and every skin folder carries the same three:

```
in the model:   car_paint.png   car_paint_2.png   car_paint_int.png
in each skin:   car_paint.png   car_paint_2.png   car_paint_int.png   (+ a preview and a manifest)
```

So repainting is a texture swap, and the rule that makes it safe is already written into
`readModel.ts`: **`DrftMaterial.albedo` is an ordinal into the asset's texture list.**

```ts
/* Replace in place. Never insert, never remove. */
for (let i = 0; i < asset.textures.length; i++) {
  const override = skin.get(asset.textures[i]!.name);
  if (override !== undefined) asset.textures[i] = { ...asset.textures[i]!, bytes: override };
}
```

**Inserting or dropping a texture renumbers every ordinal after it, which silently repaints the
model** — the wrong panels take the wrong maps, every index is still in range, and nothing throws.
That failure is the reason the resolver leaves an unresolved reference in place instead of removing
it, and the same reasoning binds any consumer editing this list.

**The paint is more than one material.** In the car measured it is four materials over twelve
meshes: the shell and doors on one, the bolt-on panels on a second, the visible interior shell on
two more. A repaint that finds only the first leaves the bonnet the old colour. Select by the
texture the material points at, not by name:

```ts
const paintTextures = new Set(['car_paint.png', 'car_paint_2.png']);
const painted = asset.materials.filter((m) =>
  paintTextures.has(asset.textures[m.albedo]?.name ?? ''),
);
```

**Tinting is the other option, and it is not the same thing.** `DrftMaterial.color` multiplies the
albedo map, so tinting a car whose paint map is a mid-grey base gives clean arbitrary colours from
one skin, while tinting a car whose map already carries its colour gives you that colour darkened.
Which you have is a property of the model, so check the paint map before offering a colour picker:
a flat, unsaturated map is a base built for tinting.

For the finish rather than the colour, `reflectivity` is what separates a metallic flake from a matte
wrap, and `roughness` is the width of the highlight that sells it. Both come across from the source
material and both are per-material, so a repaint can change them alongside the map.
