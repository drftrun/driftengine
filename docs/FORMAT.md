# Asset pipeline and the `.drft` format

**The specification. True against container format 1.4**, shipped by engine 1.4.2. Seven formats
read directly; the container carries geometry, materials, textures, opacity and reflectivity, and
parity between readers is measured rather than asserted. `HANDBOOK.md` is the handbook for using
it; this file is the reasoning behind it.

**The format is frozen and no longer at 0.x semantics.** It was held unfrozen until textures had
exercised the layout, on the principle that a design which has never carried the thing it was
built for is a guess. Textures shipped, `DRFT_VERSION_MAJOR` is 1 and `DRFT_VERSION_MINOR` is 3,
and the compatibility machinery in §4.4 has been exercised across four minor versions. **A
breaking change is no longer allowed.** Everything from here is additive under rule 4 of §4.4: a
new chunk, a new optional attribute, a new minor version, and an older reader opening the file as
though the addition were absent.

---

## 1. The problem

Every scene in this engine is currently authored in TypeScript, vertex by vertex, through
`MeshBuilder`. That has real virtues — nothing to load, nothing to cache, nothing to 404,
and a world that is generated rather than shipped — and it is why the demos can honestly
claim zero image assets. It is also why a sarcophagus took three passes to stop looking
like a baguette, and why the answer to "make it more detailed" is always "write more
code".

A game beyond a certain size cannot be modelled in a text editor. The engine needs to
accept geometry made in the tools artists actually use, without giving up what makes it
worth using.

---

## 2. Support tiers, and what each one honestly means

The request named `.blend`, `.max`, `.ma`/`.mb`. All four are _authoring_ formats, and the
engineering reality differs enormously between them:

| Format     | Tractability                                                                                                                                                                                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.blend`   | **Genuinely readable.** The file carries a `DNA1` block describing its own structs, so a reader can be _generic_ — it learns the layout from the file rather than hard-coding a Blender release. Struct names drift between versions, but a mesh has looked broadly the same for a decade.  |
| `.ma`      | **Partly readable.** ASCII MEL. A subset parser can lift `createNode mesh` plus the `.vt` / `.ed` / `.fc` attributes and reconstruct polygons. It is a program, so anything procedural is out of reach, but a plain exported mesh is not.                                                   |
| `.mb`      | **Barely.** Proprietary binary, no public specification. An IFF-like container can be walked and chunks identified, but reconstructing a scene is guesswork.                                                                                                                                |
| `.max`     | **Barely.** Proprietary OLE compound document, no public specification. Same conclusion.                                                                                                                                                                                                    |
| FBX        | **Readable, and an earlier draft of this document was wrong to write it off.** The licence problem is Autodesk's _SDK_, not the format: the binary container is well understood and permissively licensed readers exist. The baker runs offline in Node, where parsing it is ordinary work. |
| OBJ        | **Trivial, and the cheapest win here.** ASCII, specified since the eighties, unchanged since, with a `.mtl` companion for materials. A complete reader is a couple of hundred lines and cannot rot.                                                                                         |
| STL        | **Trivial.** Binary or ASCII, triangles and a facet normal, nothing else — no colour, no UVs, no hierarchy. Needs vertex welding to shade smoothly, which is the only interesting part.                                                                                                     |
| 3MF        | **Open.** A zip of XML from the 3MF Consortium, with a published specification. Wants a zip reader, which `.usdz` needs too, so the two share the work.                                                                                                                                     |
| DXF        | **Documented but a poor fit.** Autodesk publishes the reference, so it is readable — but it is a CAD interchange format that is mostly 2D entities, and its mesh entities are an afterthought. Readable, rarely worth reading for a game asset.                                             |
| USD / USDZ | **Open.** Pixar's USD is Apache-2.0 with a published specification, and `.usdz` is an uncompressed zip holding a `.usda` (ASCII, straightforward) or `.usdc` (binary crate, specified). Not a proprietary format at all, and it was filed too harshly.                                      |

So rather than one yes-or-no, support is **tiered, and the tier is stated everywhere the
format is named** — in the CLI, in the error messages, and on the website.

| Tier                    | Formats                                         | Promise                                                                                                                                                                                                                                                                 |
| ----------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1 — Supported**       | glTF 2.0 / `.glb`, `.drft`                      | Specified, conformance-tested, covered by the compatibility rules in §4.4. Breakage is a bug.                                                                                                                                                                           |
| **1 — Supported**       | `.obj` + `.mtl`, `.stl`                         | Fully specified, stable for decades, and small enough to read completely rather than partly.                                                                                                                                                                            |
| **1 — Supported**       | `.usdz` / `.usda`, `.3mf`                       | Open specifications. Held to the same standard once their phases land.                                                                                                                                                                                                  |
| **2 — Experimental**    | `.fbx`, `.kn5`                                  | Read directly, best effort. The formats an asset store, or a mod community, hands you as the source.                                                                                                                                                                    |
| **2 — Experimental**    | `.dxf`                                          | Documented, but a CAD format whose mesh entities are an afterthought. Read what is there, refuse the rest.                                                                                                                                                              |
| **2 — Experimental**    | `.blend`, `.ma`                                 | Read directly, best effort. Works for meshes, materials and transforms. May fail on a file this project has never seen, and may break when the vendor changes their software. Failure is always a clear refusal naming what was not understood, never a partial import. |
| **3 — Delegated**       | anything the user's own installation can export | The CLI drives `blender --background --python` or `mayapy` to emit glTF. As reliable as tier 1, but requires the software to be installed.                                                                                                                              |
| **4 — Recognised only** | `.mb`, `.max`                                   | The CLI identifies the file, explains that no reader exists, and names the export that will work. It does not pretend to try.                                                                                                                                           |

**Tier 2 is deliberately a real attempt and deliberately not a promise.** It is worth
having because it removes a round trip through an export dialog for the common case, and
it costs nothing when it fails, because it fails by saying so. What it must never do is
half-import a scene and leave somebody wondering why their model has holes in it.

**Why tier 3 is legally clean.** Invoking a separate process is not linking. Blender is
GPL, and driving `blender --background` from another program creates no derived work. The
Autodesk tools are the user's own licensed installation doing what it is licensed to do.
The engine ships no vendor code.

**Tier 2 is legally clean too**, which is worth stating because it looks riskier than it
is: reading a file format is not copyright infringement, `.blend`'s layout is public by
construction, and MEL is a documented scripting language. What would be a problem —
shipping Autodesk's SDK, or redistributing GPL code inside a permissively licensed engine — neither tier
does.

## 3. The shape of the pipeline

```
Blender / 3ds Max / Maya          (author, licensed by the user)
        │  export or CLI convert
        ▼
   glTF 2.0 / .glb                (open standard, Khronos, royalty free)
        │  drft bake  ← the engine's CLI
        ▼
      .drft                       (baked, versioned, load-fast)
        │  fetch + zero-copy views
        ▼
   MeshData / Mesh / colliders    (what the engine already consumes)
```

Tier 2 readers enter the same pipeline one step earlier, producing the intermediate
representation directly instead of going through an export:

```
   .blend / .ma  ──[ tier 2 reader, best effort ]──▶  intermediate  ──▶  .drft
```

Three properties matter and all come from this split:

- **Everything converges on one intermediate**, so a `.blend` and a `.glb` reach the baker
  as the same structure. A tier 2 reader is a _front end_, not a second pipeline, and it
  cannot produce an asset the glTF path could not.
- **glTF remains the only tier 1 third-party format**, an open standard with a published
  specification and a conformance suite. Everything guaranteed rests on it; nothing
  guaranteed rests on a vendor's internal layout.
- **`.drft` is ours**, so it can be laid out for exactly how this engine uploads data,
  and versioned under rules we control.

All of this is the **baker**, which runs offline in Node. A third-party format is not parsed
at runtime _by default_, so an experimental reader meeting a file it does not understand
costs a failed build rather than a broken frame. See §3.3 for the deliberate exception.

### 3.3 Reading a source format at runtime, without baking

**Built in 0.16.0.** `src/asset/readModel.ts` is one dispatcher from a file to meshes, shared by
the baker and by a browser: every capability it may want is a parameter, so the filesystem, the two
decompressors and the resolution of a name a file states are all the caller's to supply. The rule
below is unchanged and is obeyed rather than relaxed — `demo/modelWorker.ts` runs the parse in a
worker and writes a container, which `DrftLoader` then streams exactly as it streams a fetched one,
so a `.glb`, an `.obj` and an `.fbx` all reach the screen by the path a `.drft` takes.

What follows was written before any of it existed and is left standing, because the reasoning held.

**Not built, and already possible.** Every reader in `src/asset/` is pure: no filesystem, no
Node built-in, no global state. `Inflate` is injected into the FBX reader and `assetPath.ts`
produces candidate paths without ever looking one up, both for exactly this reason. That
discipline was paid for up front and this is what it buys — the readers can run in a browser
today, unchanged.

What stops it being the default is cost, not capability, and the costs are worth stating
before anyone reaches for it:

- **Parse time on the main thread.** The 52 MB test car takes about 1.6 s to parse and
  several more to weld 4.5M corners. That is not a hitch, it is a freeze, so a runtime import
  belongs in a worker and the API has to be asynchronous from the first line rather than
  retrofitted.
- **No zero-copy.** `.drft` exists so vertex data lands at an alignment the GPU can take
  directly. A source format is parsed into fresh arrays, so a runtime import gives all of
  that up. It is the right trade for a user dropping a file onto a page and the wrong one for
  a level.
- **Memory.** The same car is 52 MB on disk and about 226 MB unwelded in memory. Baking is
  where that gets fixed, and skipping the bake means paying it.

**Textures are the interesting part, and the answer is already in place.** A runtime import
cannot look beside the model, because there is no "beside" — so the host supplies a resolver
that fetches, exactly as the baker supplies one that reads a directory. `assetCandidates`
does not change: the engine still says what to look for and the caller still says where. An
FBX that **embeds** its images needs no resolver at all, which the `Content` support makes
true today, and that is the case worth supporting first because it is the one that works with
no configuration.

So the honest rule is not "never at runtime" but: **not by default, never on the main thread,
and never inside a frame.** A malformed file must still cost a rejected import and not a
broken render, which is the same refusal the baker already makes, moved.

### 3.1 A bought asset is a _bundle_, and the tool should choose

A download from an asset store is rarely one file. It is typically the source plus
conversions:

```
tomb-props/
  source/tomb-props.fbx          ← what the artist worked in
  gltf/tomb-props.gltf + .bin    ← converted
  glb/tomb-props.glb             ← converted
  usdz/tomb-props.usdz           ← converted
  textures/*.png
```

Every one of those is the same asset, and exactly one of them is the best thing to read.
So the CLI takes the **folder or the archive**, not a file:

```
npx drft bake ./tomb-props -o tomb-props.drft
npx drft bake tomb-props.zip -o tomb-props.drft
```

It inventories what is present, picks the highest tier available, and says so:

```
  tomb-props/ — found glb, gltf, fbx, usdz
  Using glb (tier 1). fbx would have been tier 2; usdz is equivalent but larger here.
  8 meshes, 4 materials, 6 textures embedded → tomb-props.drft (12.4 MB)
```

**The preference order is by tier, then by fidelity, and it is always printed.** Choosing
silently would be the worst of both: a tool that picked the experimental reader when a
conformance-tested one was sitting in the next folder, and no way for anybody to notice.
`--from fbx` overrides it, for comparing what the readers make of the same asset.

This is the seamless case, and it is seamless precisely because the store already did the
conversion. The tiers are then a safety net for the assets that arrive as one file.

### 3.2 `drft bake` — the CLI

A Node tool in `scripts/`, shipped with the engine, no runtime dependency.

```
npx drft bake model.glb -o model.drft [--textures ktx2|source] [--quantize] [--collider hull[:N]|box|none]
```

It also accepts DCC files, trying the direct reader first and falling back to the user's
own installation:

```
npx drft bake scene.blend -o scene.drft      # tier 2 reader; --via-blender to delegate instead
npx drft bake scene.ma    -o scene.drft      # tier 2 reader; --via-maya to delegate instead
npx drft bake scene.max   -o scene.drft      # tier 4: identified, explained, refused
```

Every experimental import prints its tier, unprompted:

```
  scene.blend — experimental reader (tier 2). Blender 4.2, DNA 812 structs.
  Imported 14 meshes, 3 materials. Not covered by the compatibility promise;
  `--via-blender` uses your Blender installation instead if this looks wrong.
```

That line is not decoration. Somebody who reads it knows what they have, and somebody who
skips it still sees the word _experimental_ beside their own filename before anything goes
wrong. A tier 2 reader that cannot understand part of a file **refuses and names what it
did not understand** — it never returns the half of the scene it managed, because a model
with holes in it is a worse outcome than an error.

**Why both paths are legally clean.** Invoking a separate process is not linking: Blender
is GPL, and driving `blender --background` from another program creates no derived work.
Reading a file format is not infringement either — `.blend`'s layout is published by the
file itself, and MEL is a documented language. What would be a problem is shipping
Autodesk's SDK or redistributing GPL code inside a permissively licensed engine, and neither path does
either.

---

## 4. The `.drft` format

### 4.1 Goals

1. **Zero-copy load.** Vertex and index data land in the file at 4-byte alignment so the
   loader constructs `new Float32Array(buffer, offset, count)` over the fetched
   `ArrayBuffer` with no parsing and no copy. This is the whole reason for a custom format;
   glTF+JSON cannot do it without a parse step per attribute.
2. **Compatibility that never breaks backwards.** A file written today opens in every
   future reader. Forever. See §4.4.
3. **Self-contained.** Textures embedded, so a level is one fetch and cannot half-load.
4. **Matches `MeshData` exactly**, so the loader has nothing to translate.
5. **No dependencies** to read. A decoder in plain TypeScript, in `src/asset/`.

### 4.2 Layout

Little-endian throughout. A header, then a chunk table, then chunk payloads.

```
offset  size  field
0       4     magic            'D','R','F','T'
4       2     versionMajor     u16 — incompatible generations
6       2     versionMinor     u16 — additive revisions
8       2     minReaderMajor   u16 — refuse below this
10      2     flags            u16 — bit 0: little-endian (always 1 for now)
12      4     chunkCount       u32
16      4     totalBytes       u32 — checked against the buffer, cheaply catches truncation
20      12    reserved         zeroed, must be ignored by readers
32      ...   chunk table      chunkCount × 16 bytes
...           payloads         each 4-byte aligned
```

Chunk table entry:

```
0   4   fourCC       e.g. 'MESH'
4   4   offset       u32, absolute, 4-byte aligned
8    4  byteLength   u32
12   2  flags        u16 — bit 0: REQUIRED (see §4.4)
14   2  index        u16 — ordinal within this fourCC
```

### 4.3 Chunks in v1

| FourCC | Required | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `HEAD` | yes      | Asset name, generator string, unit scale, bounding box.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `MESH` | yes      | One mesh: vertex count, index count, and a bitmask of which attributes are present, then the raw arrays in `MeshData` order — positions, normals, colors, emissive, specular, uvs, emissiveColor, roughness, grain, relief, tangents, joints, weights, indices.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `LODM` | no       | A coarse level of detail for the **whole asset**, one chunk per level, coarsest first. Byte for byte a `MESH` payload; its `index` is the level. Added in 1.2.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `NODE` | no       | Scene graph: parent index, TRS, mesh index, name. Absent means one mesh at the origin. **Specified in v1 and implemented in 1.6** — the FourCC and this row existed from the start while no writer emitted one and no reader consumed one. Rigid TRS animation is the first thing to need a hierarchy.                                                                                                                                                                                                                                                                                                                                                                                     |
| `MATL` | no       | Per-submesh material: base colour, emissive, specular, roughness, texture indices.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `TEXS` | no       | Embedded textures. See §4.5.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `SPLT` | no       | One block of a Gaussian splat capture, several chunks per capture, interleaved across the whole thing so any prefix of the file is a sparse version of it. Its `index` is the block ordinal. Added in 1.5.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `SKIN` | no       | One skin: joint count, a parent index per joint, an inverse bind matrix per joint, and a name block. **Written parents-first and refused in any other order**, because a palette is resolved in index order and a joint read before its parent is a rig wrong in one limb. One chunk per skin. Added in 1.6.                                                                                                                                                                                                                                                                                                                                                                               |
| `COLL` | no       | The convex hulls the asset collides as: a hull count, a point total, a start table with its closing entry, then xyz points. **One chunk for the file**, pairing with nothing, because an asset's collision is a fact about the whole asset the way `SUBS` is a fact about all its materials. **Points rather than shapes**, because this package depends on nothing and a serialised shape would mean the format knowing what a face plane is; `hullShape` takes exactly what this carries. **Claimed in v1 and defined in 1.12** — the row and the FourCC existed from the start while no writer emitted one and no reader consumed one, which is the history `NODE` and `ANIM` also had. |
| `LITE` | no       | Point and directional lights authored in the scene.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `ANIM` | no       | One animation clip: name, duration, and per track a joint, a path and its keys. One chunk per clip; its `index` is the clip ordinal. Added in 1.6. **This row read "Reserved. Not in v1" until then**, and §4.4's own example of a free additive change was a file carrying it.                                                                                                                                                                                                                                                                                                                                                                                                            |
| `MORP` | no       | One mesh's morph target deltas: target count, the mesh ordinal they deform, then three floats a vertex per target, interleaved by vertex. **The mesh ordinal is in the payload rather than the table's `index`**, because `index` is the ordinal within a FourCC — for a file where only the second mesh has targets, the one `MORP` chunk carries 0 and a reader pairing by it would deform the first. A chunk of its own rather than attribute bits in `MESH`, because an attribute covers every vertex once and a delta covers it once _per target_. Added in 1.7.                                                                                                                      |
| `SUBS` | no       | Which substance each material is made of: a count, then per entry a material ordinal, a UTF-8 byte length and the id. **One chunk for the file**, pairing by the ordinal in the payload for the reason `MORP`'s row gives — a file labelling only its fourth material would otherwise carry a chunk at index 0 and a reader pairing by it would set the wrong material on fire. Byte length rather than character count, because an id is text: `chêne` is five characters and six bytes. Written by the baker from a glTF material's `extras.substance`, so an artist labels the oak in Blender and the log burns like oak. Added in 1.8.                                                 |

`MESH` stores attributes **contiguously and separately**, not interleaved, because that is
exactly how `Mesh` uploads them — one buffer per attribute. Interleaving would mean
de-interleaving at load, which is the copy this format exists to avoid.

Every attribute array must cover every vertex or the file is rejected at load. That rule
is not decorative: a short attribute buffer is drawn by some drivers and causes others to
drop the draw entirely, which cost this project a night of debugging in August 2026. See
`validateMeshData` — the loader reuses it rather than reimplementing the check.

### 4.3.1 Payloads, byte by byte

Written out so a second implementation can be built from this document alone. Little-endian
throughout, every chunk payload starts 4-byte aligned, and every offset below is **relative
to the chunk's own `offset`** from the table.

**Strings** are one shape everywhere: `u32` byte length, then that many UTF-8 bytes, then
zero padding to the next 4-byte boundary. A reader steps over the padding, never past it.

**`HEAD`** — required, exactly one.

```
0    28   f32 x 7    unitScale, then bounds: minX minY minZ maxX maxY maxZ
28   ..   string     asset name, diagnostic only
..   ..   string     generator, the tool and version that wrote the file
```

**`MESH`** — required, one per mesh. Its `index` in the chunk table is its ordinal.

```
0    4    u32        vertexCount
4    4    u32        indexCount
8    4    u32        attribute bitmask, see below
12   4    u32        reserved, zeroed, ignored by readers
16   ..   f32        arrays, contiguous and in the frozen order below
..   ..   u32        indices, indexCount of them, last
```

Attribute bits, and the order the optional arrays appear in the payload. The order is
**ascending bit** and it is frozen, which is what lets a reader stop at the bits it knows:

| Bit | Value   | Array         | Floats per vertex |
| --- | ------- | ------------- | ----------------- |
| —   | always  | positions     | 3                 |
| —   | always  | normals       | 3                 |
| —   | always  | colors        | 3                 |
| —   | always  | emissive      | 1                 |
| 0   | `0x1`   | specular      | 1                 |
| 1   | `0x2`   | uvs           | 2                 |
| 2   | `0x4`   | emissiveColor | 3                 |
| 3   | `0x8`   | roughness     | 1                 |
| 4   | `0x10`  | grain         | 1                 |
| 5   | `0x20`  | relief        | 1                 |
| 6   | `0x40`  | tangents      | 4                 |
| 7   | `0x80`  | joints        | 4                 |
| 8   | `0x100` | weights       | 4                 |

`joints` and `weights` arrived in **1.11**, together, and they are the entry in this section with
the largest gap between what the format validated and what it wrote. `MeshData` declared both from
the day skinning shipped, and `validateMeshData` checked both — four floats a vertex, and neither
present without the other — while `buildMesh` listed the optional arrays it had bits for and there
were no bits for these. So a baker handed the writer a correctly-validated skinned mesh, got **no
error and no warning**, and produced a file that nothing could skin: `SKIN` carried the joint
names, their parents and their inverse binds intact, pointing at vertices that recorded no
influence on any of them. The two halves of a skin disagreed about whether this format supported
skinning, and the half that was missing was the silent one. Consumers wrote their own binary
container for a single skinned body rather than use this.

Two bits rather than one, because the frozen order is a property of _arrays_ and these are two.
They remain both-or-neither: the writer refuses one without the other before it reaches the bits,
and the reader refuses again on the way in, so a file whose writer set one bit is rejected rather
than half-skinned. Next free bits and appended last, so a 1.10 reader meets the seven arrays it
knows in the seven places it expects them, stops before these, and draws the asset in bind pose —
which is what a reader that has never heard of skinning should produce.

`tangents` arrived in **1.4** and is the first optional attribute wider than three floats a
vertex: four, with the bitangent's handedness in `w`. Next free bit, appended last, so a 1.3
reader meets the six arrays it knows in the six places it expects them and draws the asset with
no tangent frame — which is what a reader that has never heard of tangents should produce, and is
exactly what the shaders of the release that added it do with one, because nothing samples it yet.

`relief` arrived in **1.3** and is the same story one bit along: `MeshData.relief` shipped in
engine 0.23.0 and this table was not updated, so a mesh carrying microscopic relief wrote and read
back without it. Nothing failed, because the round-trip test named each attribute and a new one
adds no line to a list of names. A consumer found it by enumerating the keys instead and reporting
every loss at once, which is now how the suite checks it.

`grain` arrived in **1.1** and is the worked example of the rule above. It belongs beside
`roughness` conceptually and it is written after everything else, because inserting it where
it reads best would have shifted every array following it and repainted the model with no
error raised anywhere. A 1.0 reader meets the arrays it knows in the places it expects them,
stops at the bit it does not, and draws the asset with no grain — which is what a reader that
has never heard of grain should produce.

Every present array covers **every** vertex. A short one is a refusal, not a repair: some
drivers read past the end as zeroes and others drop the draw outright, so a file like that
renders differently on different hardware with no error on either.

**`LODM`** — optional, one per level, **coarsest first**, added in 1.2. The payload is a `MESH`
payload and nothing else, so it takes the same writer and the same reader; what differs is the
FourCC, the flag and the meaning of `index`, which is the **level ordinal** rather than a mesh
ordinal. Each level stands in for the _entire_ asset rather than for one part of it.

**A chunk of its own rather than a level field inside `MESH`**, which is what §4.6 originally
proposed and is the one part of that design that could not stand. Three things break if a coarse
level arrives as a `MESH`, and each of them is silent:

- `MESH` is **required**, so rule 2 of §4.4 does not protect anybody: a 1.1 reader would draw the
  coarse level as a real part, inside the model it stands for.
- `MATL` pairs with `MESH` **by ordinal** and both sides refuse a count mismatch, so one extra
  `MESH` either fails to open or shifts every material by one and repaints the asset.
- The streaming manifest counts `MESH` chunks to say how many parts are coming, so a progress
  readout would promise a part that never arrives.

Optional and skipped in silence, a 1.2 file opens in a 1.1 reader as the model without its
outline — which is what a reader that has never heard of one should produce.

**Written by default since 1.2's second release, and refused with `--no-lod`.** It was off at every
level to begin with, because a level of detail is a _decimation_ and how good it looks belongs to
what was decimated: the hull of the time came back as ridges and facets, and somebody waiting for a
car got a crumpled white shape. An empty stage reads as a load in progress; a bad preview reads as
a broken import. The hull is the surface of an occupancy grid now and cannot produce geometry the
model never had, so the default moved and `DrftLoaderOptions.outline: false` is what refuses it.

**A level is dropped when it would cost more than it saves**, which is the rule that made a default
safe. The grid is a fixed number of cells across whatever it is given, so a model simpler than the
grid comes back as a hull with more triangles than itself: four hand-written triangles produced
9,840, which is 308 KB of outline ahead of a model measured in bytes. Anything not at least twice
as cheap as what it stands for is not written, and both the baker and the browser's converter apply
the same function so a file is the same whichever produced it.

**`SPLT`** — optional, several chunks per capture, in block order.

```
0    4    u32        splats in this block
4    4    u32        splats in the whole capture
8    4    u32        words per splat record
12   4    u32        spherical-harmonic coefficients the source carried and the packer did not read
16   12   f32 x3     the whole capture's minimum corner
28   12   f32 x3     the whole capture's maximum corner
40   ..   u32 x N    the records, `wordsPerSplat` each, in this block's own order
```

**The record is opaque to this format**, and that is deliberate. Its `wordsPerSplat` words mean
whatever the packer that produced them says they mean — for `@driftengine/splats` today, eight
words holding a position, a packed colour, six half-float covariance terms and the splat's extent.
Keeping the meaning out of the container does two things: this file never learns the shader's texel
layout, and a later minor version can widen the record — for view-dependent colour, say — by
raising `wordsPerSplat` and nothing else. A reader that meets a width it does not understand refuses
the capture rather than misreading it.

**Every block repeats the capture's count and bounds**, twenty-eight bytes each. That makes a block
self-describing: a consumer holding only the first one can allocate its final buffers and cull
against the final extent, rather than waiting for a manifest it has already gone past.

**Several chunks rather than one, and this is the whole reason splats are in this container.** A
chunk is reported when its last byte lands, so a single chunk holding a million splats arrives all
at once and streaming buys nothing at all. Split into blocks whose contents are interleaved across
the _whole_ capture, the first block that lands is a complete sparse capture and the load opens on
a recognisable place that densifies — the same argument §4.6 makes for `LODM`, reached by a
different mechanism because a capture has no coarse version to decimate into a separate chunk. The
interleave is `coarseFirstOrder`: sort by Morton code so index order becomes spatial order, then
walk that order bit-reversed so consecutive slots are maximally far apart. Both steps are needed —
without the spatial sort the sequence decimates whatever order the trainer left, which is a slab of
one axis when a capture was written out in scan order, and `demo/dev/splatstream.html?authored=1`
is that failure on screen beside the fixed version.

**A file may carry a capture and no geometry.** The rule that an asset needs at least one `MESH`
became "at least one `MESH` or a capture with splats in it" in 1.5, in the reader, the writer and
the stream together. A capture-only asset is an ordinary asset, and refusing one would be the
container telling a consumer what its scene is allowed to be made of.

**`TEXS`** — optional, one chunk per image, in index order.

```
0    4    u32        codec: 1 PNG, 2 JPEG, 3 WEBP, 4 RAW (uncompressed RGBA8)
4    4    u32        width in pixels
8    4    u32        height in pixels
12   4    u32        payload byte length
16   ..   bytes      the image, compressed exactly as it arrived
..   ..   string     what the source called it, at the next 4-byte boundary after the payload
```

Width and height are stored so a consumer can budget before it decodes. They are read from
the image's own header at bake time and are advisory: the decoder remains authoritative.

The name follows the payload rather than preceding it, so the image still begins at a fixed
offset and a reader that predates the name stops before it and is none the wiser. It exists
so a texture can be **addressed** rather than counted: an ordinal is a position in whatever
order a reader happened to meet its records, and asking a consumer to depend on that is
asking it to depend on an accident. A chunk with no room for a name reads as empty.

**`MATL`** — optional, at most one chunk, one entry per `MESH` **paired by ordinal**.

```
0    4    u32        count, which must equal the number of MESH chunks
4    4    u32        stride, bytes per entry
8    ..   entries    count x stride bytes, laid out as below
..   ..   strings    count material names, in the same order
```

Each entry, within its `stride` bytes:

```
0    12   f32 x 3    base colour, linear, 0 to 1
12   4    f32        specular, highlight strength 0 to 1
16   4    f32        roughness, highlight width 0 to 1
20   4    f32        emissive, self illumination 0 to 1
24   12   f32 x 3    emissive colour; a negative component means inherit the base colour
36   4    f32        opacity, 1 opaque
40   4    i32        albedo texture index, or -1 for none
44   4    f32        reflectivity, how much of the environment this surface mirrors, 0 to 1
48   4    i32        normal map texture index, or -1 for none
52   4    i32        ORM map texture index - occlusion R, roughness G, metallic B - or -1
56   4    i32        emissive map texture index, or -1 for none
60   4    f32        roughness scale over the ORM map's G channel, 1 where there is no map
64   4    f32        metallic scale over the ORM map's B channel, 1 where there is no map
68   4    f32        occlusion strength over the ORM map's R channel, 0 where R means nothing
72   4    f32        cutout, the alpha below which a fragment is discarded, 0 to discard nothing
```

So the stride a current writer declares is **76**. `reflectivity` is the worked example of why the
stride is written down: a reader that predates it steps by 48 anyway, takes the ten fields it knows
and defaults reflectivity to 0, which is what a surface that never claimed to mirror anything
should be. This line was missing from this table for a while and the writer was emitting the field
the whole time — a reader built from the document alone would have read 44-byte entries and shifted
every material after the first.

**48 is now the second worked example.** A file written between 2026-08-21 and 2026-08-22 declares
48, and a current reader takes the eleven floats and the albedo index it knows and defaults all
three map indices to -1 — which is what a material that never named a map should be. The three were
appended together rather than one per feature, so the format takes one minor version instead of
three for the same result; a glTF names all four of its maps as plainly as it names the first, so
none of them is speculative. **All four indices are bound**, in the order they
were built: albedo and ORM first, normal and emissive, each without a
further stride change, which is what writing the four together bought. A baker has written all
four since the stride moved to 72, so a file baked before any of those readers existed gains its
maps by being opened in a newer one rather than by being baked again.

**Between those dates the normal index was written, read, and dropped.** `DrftLoader` was the one
layer of three that did not pass it on, so a model wearing a normal map drew smoother than its
maker shipped it and nothing failed anywhere. Binding it moved 47% of an imported figure's pixels.
That is the shape to watch for in this table: an index the container carries and a layer forgets is
invisible from both ends.

**The three scales at 60, 64 and 68 are what glTF's factors mean when a map is present.**
`roughnessFactor` and `metallicFactor` _multiply_ a `metallicRoughnessTexture` rather than standing
in for it, so a reader with nowhere to put them has to discard them — which this one did, and a
character whose base colour averages RGB 26, 27, 27 arrived blown to white because a discarded
factor read as 1. `specular` and `roughness` above remain the scalars a material states when it has
**no** map. **Their defaults are not symmetric and that is deliberate:** the two scales default to
1, the identity, because a file that never stated them meant its map as authored — and the strength
defaults to **0**, because nothing in an older file establishes that its ORM map carries occlusion
in R at all, and defaulting it to 1 would read whatever the exporter left there as a shadow.

**Read entries by the stride the file declares, not by your own.** A newer writer appends a
field and lengthens the stride; stepping by a hard-coded size would shift every entry after
the first and repaint the whole model with no error raised. Take the fields you know, skip to
the next entry, and a file from a later minor version opens correctly.

**All four map indices are checked against the texture count at load**, and a material naming a
texture the file does not carry is refused by name — an index that resolves to the wrong image
fails silently at some later frame, and one that resolves to nothing fails at none. Names are
matched to entries by position, and an absent or short name block reads as empty rather than
failing.

### 4.4 Compatibility rules

These are the contract, and they are deliberately strict.

1. **Old files always open.** A reader must load any file whose `minReaderMajor` is less
   than or equal to its own major version. There is no expiry and no migration step.
2. **Unknown optional chunks are skipped in silence.** That is what makes additive change
   free: a v1.6 file carrying `ANIM` opens in a v1.0 reader as a v1.0 file would. **That example
   stopped being hypothetical in 1.6**, when `ANIM` was finally defined — and it held: the chunk is
   optional, so a reader that predates it opens the file as the geometry it also carries.
3. **Unknown REQUIRED chunks are a refusal.** If a writer marks a chunk required, it is
   saying the asset is wrong without it. A reader that does not know it must refuse to
   load and say which FourCC it did not understand — never load a partial asset and let
   the wrongness show up as a rendering artefact.
4. **`versionMinor` is additive only.** New optional chunks, new attribute bits, new
   enum values with a defined fallback. It never changes the meaning of an existing byte.
5. **`versionMajor` is the escape hatch, used almost never.** It means the layout is
   incompatible. A newer major file refuses to open in an older reader — with a message
   naming both versions — which is exactly the behaviour asked for: upgrades may be
   unopenable, downgrades never are.
6. **`reserved` must be ignored**, so it can become fields later without a major bump.

A test asserts rule 1 against checked-in fixture files, one per released minor version. **The
practice failed once and is worth knowing about**: 1.3 shipped without one, and the gap was found
while adding 1.4 rather than by anything failing. It was closed by checking out the 1.3 writer and
running it, so those bytes are genuinely that writer's — fabricating them from today's writer with
a version number patched in would have looked like evidence and proved nothing. A
fixture is never regenerated — the point is that the _old bytes_ still load.

### 4.5 Textures

The engine ships no images and the demos will continue not to, but a game will have them.

`TEXS` holds one entry per texture: width, height, a codec enum, and the payload.

| Codec                    | v1       | Notes                                                                                                                                                                                                                                |
| ------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PNG` / `JPEG` / `WEBP`  | yes      | Decoded with `createImageBitmap`, which every target browser has. Zero dependencies. High resolution is a matter of what is embedded; nothing here caps it.                                                                          |
| `KTX2` (Basis Universal) | reserved | The right long-term answer — one file transcodes to the compressed format each GPU wants, saving 4–8× of VRAM. Needs a ~200 KB transcoder, so it is a v1.x additive chunk once there is a game that needs it, not a v1.0 dependency. |
| `RAW`                    | yes      | Uncompressed RGBA8, for generated data and tests.                                                                                                                                                                                    |

Mip levels are stored explicitly when present, because generating them at load costs a
frame hitch on a large atlas and the baker has time the runtime does not.

### 4.6 Streaming: an asset that arrives progressively rather than all at once

**Built, in engine 0.15.0 and 0.17.0.** `DrftStream` and `streamDrft` in `src/asset/drftStream.ts`
read a container while it is arriving, `writeDrft` lays the payloads out in the order a viewer
needs them, and 0.17.0 added the coarse level of point 2 below as the `LODM` chunk: the reveal can
now open on an outline rather than on an empty stage. Everything in this section was written before
any of it existed and is left standing, because the design held — with **one correction, made
after building it**, recorded in point 2 and in §4.3.1: the level is a chunk of its own rather than
a level field inside `MESH`. Progressive textures, point 3, are still not built.

The goal is that a large model appears coarse and completes, the way a progressive image
does, instead of switching from nothing to everything. A car should show as a recognisable
car early and sharpen, and no frame should ever wait on the last byte.

**The chunk table is already a manifest.** It sits immediately after a fixed 32-byte header,
it is `chunkCount x 16` bytes, and it names every chunk's kind, offset and length. For a
187-mesh car that is about 3 KB. So a reader that has the first few kilobytes knows the
entire layout of a 74 MB file without parsing a single payload. Nothing else in the format
has to change for a consumer to fetch chunks selectively over HTTP range requests.

Three things do have to be added, and the order matters.

**1. Order the file by what a viewer needs first. Done.** `writeDrft` emits `HEAD`, then `MATL`,
then the meshes, then the textures, which is the priority order argued for at the end of this
section. `drftStream.test.ts` asserts that paint arrives before the geometry it paints. Offsets are absolute, so chunk order in
the table is free, and payload order in the file is a bake-time choice with no reader cost.
Laying the file out in priority order means a **plain sequential fetch** refines the model as
bytes arrive, with no range requests and no server support beyond serving a file. That is the
property worth designing for: range requests are an optimisation, not a dependency.

**2. Levels of detail, which is what "an outline first" actually requires. Built in 0.17.0.** A
coarse whole model has to exist as geometry before it can be drawn, so it is baked, not derived at
load. `buildCoarseLevel` clusters every mesh onto one grid and returns a single mesh, the baker
writes it as `LODM` ahead of everything else, and `DrftLoader` draws the best level it has until
the real geometry is complete.

The two notes below were right and both were needed. The swap is atomic in both directions: a finer
level takes the coarser one's place in the same call, and the outline leaves in the same frame the
merged model arrives, because a frame drawing both draws one car twice. And a merged silhouette is
what the first chunk is, for the reason given.

**Where this section was wrong: the level is not a field inside `MESH`.** `MESH` is a required
chunk, `MATL` pairs with it by ordinal, and the manifest counts it to say how many parts are
coming — so a coarse level carried as a `MESH` breaks a 1.1 reader in three silent ways. §4.3.1 has
all three. It is `LODM`, optional, and rule 2 then does exactly its job.

**What building it taught, and it is a fact about clustering rather than about this code.** A
coarse level has to be pushed _behind_ the surface it stands for, or it shows through the finished
model wherever the decimation put it in front — measured at four centimetres through the body
panels of a five-metre car. How far back is not a constant: a smooth panel needs almost nothing, a
crease needs most of a cell, and a constant big enough for the crease pulls a wing mirror off the
mirror. So each cluster is pushed until it is behind the plane of every corner that formed it, and
the demands are then smoothed across neighbours because applying each in isolation folds the hull
into spikes. Some folding survives on an asset whose interior parts share cells with its shell,
which was the honest reason **an outline is asked for rather than assumed**: it is a preview
whose quality belongs to the model, and a bad one reads as a broken import where an empty stage
reads as a load in progress. The occupancy hull removed that risk and the default moved with it;
see §4.3.1 for the budget that a default made necessary.

**3. Progressive textures. Half built in 0.17.0, and the half that is missing is a dependency
decision rather than an implementation.** §4.5 stores mip levels explicitly, and ordering them
smallest first as separate chunks would give blur-to-sharp arrival and let a consumer on a
metered connection stop early and keep a smaller texture rather than having none.

**What that needs is for the baker to resize an image, and the baker runs in Node, where there is
no decoder for a JPEG.** The engine embeds compressed bytes untouched and decodes them through
`createImageBitmap`, which is a browser API; producing a smaller version offline means either a
new dependency or shelling out to a tool that happens to be installed, and a bake whose output
depends on what is installed is a bake two machines disagree about. So it is written down here
rather than guessed at.

**What was available without it, and is built:** `DrftLoaderOptions.texturePreview`.
`createImageBitmap` resizes while it decodes, so the loader asks for a small version of each image
first and the full one after, replacing it in the same GPU object through `updateSurfaceTexture`.
A 256 pixel version of a 2048 square is a fraction of the full decode, so a tyre reads as tread
about a second earlier on a real model. It costs a second decode per image, off the main thread,
and nothing at all in the file — which is also why it does not help a metered connection, since
every byte still arrives. That is the part still owed.

#### Open decision, left for the owner: how the baker gets a smaller image

**The question is one sentence.** Mip levels inside the container need the baker to resize a JPEG
or a PNG, and the baker runs in Node, which has no decoder for either. Everything else about the
feature is ordinary work. Three ways to answer it, and the third is a real answer rather than a
placeholder:

1. **A dependency in `scripts/` only.** `sharp` (Apache-2.0, native, fast) or `jimp` (MIT, pure
   JavaScript, slower and no build step). **The bar is lower here than it looks**, and the reason is
   worth stating rather than assumed: the dependency rule in `AGENTS.md` is about what a _game_
   ships, and the baker ships nothing to a player. `src/` would not import it, the payload budget
   would not move, and a consumer without the tool installed can still open every file it wrote.
   It also keeps a bake **reproducible**, which is the property the next option gives up.
2. **Shell out to a tool if one is installed**, the way tier 3 already drives `blender
--background`: `magick` or `ffmpeg` when present, no mips when absent. Legally and structurally
   clean, and it makes the output of a bake depend on what is installed on the machine that ran it
   — so two honest bakes of one asset differ, and `scripts/drft-diff.ts` is right to call that a
   difference. That is the cost, and it is not small for a format whose whole promise is that a
   file is a file.
3. **Leave it.** `texturePreview` already buys the visual half from the bytes in the file, and the
   half that stays unbuilt is specifically _the metered connection_: stopping a download early and
   keeping a smaller texture rather than none. If nobody is loading these over a metered
   connection, this is a feature with no reader.

**If it is built**, the shape is already decided by §4.5 and by rule 4 of §4.4: mips are separate
`TEXS` chunks in level order, smallest first, so a reader that predates them sees the levels it
knows and a stream gets blur-to-sharp for free. It is a **minor** version, nothing already written
changes meaning, and `texturePreview` then becomes redundant for any file that carries them and
stays useful for every file that does not.

**Zero-copy survives this, and that is not obvious.** The header carries `totalBytes`, so a
streaming reader allocates one `ArrayBuffer` of the final size up front and writes arriving
bytes into it at their stated offsets. Every completed chunk is then viewed in place exactly
as it is today. The alternative, accumulating chunks into their own buffers, costs a copy per
chunk and gives up the one property this format exists for.

**What the reader needs that it does not have. Done.** `readDrft` takes a whole buffer, requires
`HEAD` and at least one `MESH`, and refuses anything partial. That is right for a file on disk and
wrong for a stream, so streaming got its own entry point rather than a flag on this one:
`DrftStream` takes bytes and reports each chunk as that chunk completes. The strictness did not
relax, it moved — a chunk is validated when its last byte arrives, the table's rules fire the
moment the table is readable, and the two rules that are about the asset as a whole (a `HEAD`
exists, at least one `MESH` exists, the material count pairs) fire at `end`. Zero-copy survived:
`totalBytes` sizes one buffer up front and every chunk is viewed in place, which
`drftStream.test.ts` pins by asserting every mesh shares one `ArrayBuffer`.

**The reveal is a sequence of stages, and it is opt-in.** The point is not only that a model
sharpens: it is that somebody can _watch it build_ — an outline, then its elements, then paint,
then texture — and that this is a thing a scene chooses rather than a thing the loader imposes.
A menu backdrop wants it; a car already on screen being swapped for a better one does not.

The stages are not invented for this. **They are the chunk kinds already in the format**, which
is the strongest argument that the layout was right:

| Stage    | What arrives                                                                                   | Roughly                                 |
| -------- | ---------------------------------------------------------------------------------------------- | --------------------------------------- |
| Outline  | a coarse merged `LODM`, where one was asked for                                                | 140 KB on the 187-mesh car, at 32 cells |
| Elements | the individual `MESH` chunks                                                                   | most of the file                        |
| Paint    | `MATL` gives every surface its colour, specular, roughness, opacity and the four maps it wears | ~13 KB                                  |
| Texture  | `TEXS`, smallest mip first                                                                     | megabytes                               |

The sizes are the interesting part. `MATL` for the 187-mesh car is 187 entries of the current
72-byte stride plus its names, on the order of **13 KB** against 74 MB of file. So "fully modelled and correctly
painted, textures still arriving" is not a contrived intermediate state — it is reachable almost
the instant the geometry is there, and it looks like a finished clay render rather than like
something broken. That is what makes the staged reveal worth building instead of merely
describable.

It also means the priority ordering has a natural answer rather than a tuned one: coarse mesh,
then `MATL`, then the fine meshes, then textures smallest first. Paint costs almost nothing and
buys the largest single jump in how finished the thing looks.

**One rule that must not be lost.** A partially arrived asset is a _visible_ state, not a
half-loaded one. It renders as a complete coarse model, never as a model with holes in it,
which is the same principle as §2's refusal to half-import: something incomplete but honest,
never something wrong that looks finished.

### 4.6.1 Runtime API

**This section described an API that was never built under these names, and it was corrected on
2026-09-03 by the row that defined `COLL`.** `loadDrft` does not exist: reading a whole file is
`readDrft`, and the streaming loader is `DrftLoader` in `@driftengine/assets`. And `colliders` was
promised as _"a `ColliderSet`, or empty"_, which `@driftengine/drft` cannot produce — the package
depends on nothing, which `boundaries.test.mjs` asserts and `drft-only` measures. Both sentences
predate the split that made it independent.

```ts
const asset = readDrft(bytes); // one decode, no device
const mesh = asset.meshes[0]; // MeshData, ready to upload
asset.colliders; // convex hulls as points, or empty
const shapes = asset.colliders.map((points) => hullShape(points));
```

Turning points into shapes is one line and belongs to whoever has a physics package, which is why
the format carries points. See `drftColliders.ts`.

Rules it inherits from the rest of the engine:

- **Fails loudly at load, never in a frame.** A malformed file throws from `readDrft` with
  a message naming the chunk and the byte offset. Nothing partial is returned.
- **Zero allocation after load.** Drawing an asset allocates nothing.
- **No global state.** Two assets in one context cannot interfere.

---

## 5. Plan

Each phase is independently shippable and leaves the engine working.

| Phase   | Deliverable                                                                                                                                                  | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1**   | ~~`.drft` reader + writer + fixtures~~ **done**                                                                                                              | `src/asset/`. Round trips, the four compatibility rules, malformed-input refusals, and a checked-in v1.0 fixture that is never regenerated. 17 tests.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **2**   | ~~`drft bake` for glTF 2.0 / `.glb`~~ **reader done**                                                                                                        | `src/asset/gltf.ts`. Geometry, materials, the node graph flattened to world space, normals through the inverse transpose. 15 tests. The CLI that wraps it is phase 2b.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **2b**  | ~~`.obj` + `.mtl`, `.stl`, and the CLI~~ **done**                                                                                                            | `src/asset/obj.ts`, `src/asset/stl.ts`, `scripts/bake.ts`. `npm run bake -- <file-or-folder>`. Bundle inventory and the printed choice landed here rather than at phase 11 — three formats is the point at which choosing between them matters.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **2c**  | Welding and constant-attribute elision                                                                                                                       | **Named by the first real asset.** A 52 MB FBX baked to 226 MB, because every triangle corner became its own vertex and every constant attribute was written per vertex. Two fixes, both mechanical: weld vertices that share a position, normal and UV, and leave an attribute out of the file when it never varies — the engine already reads an absent array as its constant. On the car that is roughly 4.5M corners against perhaps 600k real vertices, and 55 MB of arrays holding one repeated number.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **3**   | Embedded textures                                                                                                                                            | `PNG`/`JPEG`/`WEBP`/`RAW`, `SurfaceTexture` integration, mips.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **4**   | DCC delegation                                                                                                                                               | Blender via `--background --python`; Maya via `mayapy` if present; 3ds Max documented as "export glTF" only, since it has no scriptable free path worth relying on.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **5**   | ~~Colliders~~ **done**; lights                                                                                                                               | `COLL` at 1.12: `drft bake --collider hull` decomposes the geometry with `decomposeConvex` and writes the hulls. `LITE` is still only a FourCC.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **6**   | Tier 2: `.blend` direct                                                                                                                                      | DNA-driven, so the reader learns the layout from the file. Meshes, materials, transforms. Refuses clearly on anything else.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **7**   | Tier 2: `.ma` direct                                                                                                                                         | MEL subset — `createNode mesh` and its `.vt` / `.ed` / `.fc` attributes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **8**   | ~~Tier 4: `.mb` / `.max` recognition~~ **done**                                                                                                              | `src/asset/recognise.ts`. Identified by magic bytes rather than by extension, so a renamed file reaches the reader it deserves in either direction.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **9**   | Website section                                                                                                                                              | §6. Written once phases 1–3 are real, so nothing on the site describes something that does not exist.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **10**  | A seventh demo scene, built from an imported asset                                                                                                           | The end of the arc and the proof of it. Every existing demo stays asset-free — that claim is a differentiator and is not being dropped — so this one is _additional_, and its point is the contrast: six scenes that generate everything, and one that loads a model, side by side in the same engine.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **11**  | ~~`.usdz` / `.usda`, `.3mf`~~ **done**; bundle selection                                                                                                     | `src/asset/usd.ts`, on the shared `zip.ts`. USD needs no inflate: the format requires its entries stored so they can be memory mapped. `.usdc`, the binary crate, is refused by name rather than half-read. 3MF is `src/asset/threemf.ts` on the same reader with the inflate supplied, since a zip stores raw deflate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ~~12~~  | ~~Tier 2: `.fbx` direct~~ **done early**                                                                                                                     | Permissively licensed readers exist and the container is well understood. Deliberately after glTF and USD: a store that ships those makes this the fallback rather than the path.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **12s** | ~~Streaming: priority layout and an incremental reader~~ **done in 0.15.0**; ~~mesh levels of detail~~ **done in 0.17.0** as `LODM`; progressive mips remain | §4.6. Needed no format break in either half: offsets are absolute, so ordering is a bake choice, `totalBytes` lets a stream keep zero-copy, and a level of detail is a new optional chunk under §4.4 rule 4.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **13**  | `.dxf`                                                                                                                                                       | Last on purpose. Documented, but a CAD format that rarely carries a game asset worth importing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 1.6     | `NODE` finally written, `SKIN` and `ANIM`                                                                                                                    | Additive, as this table predicted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 1.7     | `MORP`                                                                                                                                                       | Additive.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 1.8     | `SUBS`                                                                                                                                                       | Additive.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| later   | `KTX2`, `.usdc` binary crate                                                                                                                                 | Additive. Each a minor version.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 1.9     | `LODF`, discrete levels of detail                                                                                                                            | Additive. A hand-authored level is a whole model with its own materials and hierarchy, which `LODM` — one merged, material-less outline for a progressive load — cannot hold without discarding them. **A level is a complete nested `.drft`**, because `MATL` is parallel to `MESH` by ordinal and `NODE.mesh` indexes `MESH`, so appending a level's meshes to the same arrays would leave an older reader drawing every level on top of itself. Nesting means an older reader skips one unknown chunk under rule 2 and opens the file as the full-detail model. Read as bytes and not parsed, so a consumer pays only for the level it picks. Measured on a four-level vehicle: 172, 102, 67 and 38 meshes, each level carrying its own textures because a level whose materials point at another file's images is not a valid asset — which `readDrft` refused, correctly, on the first attempt.                                                                                                                                                                                                                                                                                                                                                     |
| **14**  | ~~`.kn5`~~ **done**                                                                                                                                          | `packages/assets/src/kn5.ts`. A container with no published specification, verified against three files from a shipped car mod that each parse to _exact EOF_ — a walk that consumes a 44.6 MB file to its last byte has no field misread anywhere in it. Geometry, tangents, materials, inline textures, and **the node hierarchy**, which is what the format is worth reading for. **Right-handed, and it took a second file to learn that**: this row said left-handed for two releases, on the strength of the simulator being a DirectX title, and `readModel` mirrored every car it read. A shipped car's rear badge, rasterised out of the file with no conversion, reads forwards; through the mirror it reads backwards. Nothing numeric could catch it — a mirrored car has the same bounds, the same triangle count and the same consistent winding — and the file agrees with itself everywhere else: nose at `+z`, and the steering wheel, the driver's seat, the door named _sinistra_ and the driver's eye position in the car's own configuration all at `+x`, which is the car's left in a right-handed frame. `convertHandedness` stays in `orient.ts` for a format that genuinely is one, and gained the hierarchy half it never had. |
| 1.10    | `MATL` carries a cutout                                                                                                                                      | Additive, behind the stride the chunk already declares: an entry written at 72 opens and defaults the field to 0, which is what every file before it meant. **A cutout is a test and not an opacity**, and the format had only the second, so the two source formats that state an alpha test had nowhere to put it — glTF's `alphaMode: 'MASK'` was dropped outright, and a `.kn5` material's `ksAlphaRef` was being spent on `opacity`, which drew **nine surfaces of a hundred and two invisible** on a shipped car: four tyres, four rims and the side windows. `SurfaceMaterial.cutout` has existed in the renderer since decals landed; this is the wire between them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 1.11    | `ATTR_JOINTS` and `ATTR_WEIGHTS`                                                                                                                             | Additive, the next two free bits appended last. **The container has validated this pair since skinning shipped and wrote neither of them**: `MeshData` declared `joints` and `weights`, `validateMeshData` checked that both are four floats a vertex and that neither appears without the other, and `buildMesh` had no bit to list them under — so `SKIN` round-tripped a skeleton, its bind pose and its clips while the vertices they act on recorded no influence at all. **The write succeeded in silence**, which is what made it worth a version rather than a warning: a baker got a valid-looking file that nothing could skin, and `Mesh.isSkinned` reads `data.joints`, so what came back drew in bind pose for ever. Consumers wrote a private binary for one skinned body rather than use this — about seventy lines across a baker and a loader, and everything `.drft` would have brought with them: shard splitting, coarse-first ordering, the streaming reader. A 1.10 reader meets the seven arrays it knows in the seven places it expects them and draws the asset in bind pose.                                                                                                                                                   |
| **15**  | `NODE` written by every reader that can see a graph                                                                                                          | **Done 2026-08-31 and additive by construction.** `MESH` keeps world-space positions, so no existing byte changes meaning under §4.4 rule 4 and a reader that skips `NODE` still draws the model — the degradation rule 2 promises. `localiseNodes` inverts a node's world matrix at load for a consumer that wants parts it can move. The alternative, node-local geometry with `NODE` marked required, was rejected: it would have made every re-baked file unopenable in an older reader to save a load-time matrix inverse.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

**Not in scope, deliberately:** skeletal animation and skinning (a large subsystem that
deserves its own document), and runtime import of a DCC file — tier 2 readers are part of
the _baker_, which runs offline in Node, so a malformed `.blend` can never reach a frame.

---

## 6. How the website says this

A dedicated section, and the wording matters more than usual because it names other
companies' products.

**Where.** A new `Formats` section on `driftengine.dev`, linked from the capabilities nav,
plus a short paragraph on the demos page explaining why those scenes still load nothing —
that claim is a differentiator and must not be quietly dropped when this ships.

**What it must say.**

1. The engine imports **glTF 2.0**, an open Khronos standard, and its own **`.drft`**.
2. Files from Blender, 3ds Max and Maya are supported **through the user's own
   installation of those programs**, or through any glTF they export.
3. A plain, prominent disclaimer:

   > DriftEngine is not affiliated with, endorsed by, or partnered with the Blender
   > Foundation, Autodesk, Inc., or any other vendor named here. Blender is a trademark of
   > the Blender Foundation; 3ds Max and Maya are trademarks of Autodesk, Inc. Those names
   > are used only to describe which programs' exports this engine can read. Support for
   > any third-party format is provided on a best-effort basis, is not guaranteed, and may
   > stop working when the vendor changes their software.

4. The compatibility promise for `.drft`, stated as plainly as §4.4 states it, because it
   is a genuine reason to adopt the format.

**What it must not say.** No vendor logos. No "official", "certified", "partner",
"plugin for". Describe capability, never endorsement — naming a product to say truthfully
what your software reads is normal nominative use, and a logo or an implied partnership is
not.

I am not a lawyer and this is not legal advice; if the site ever earns revenue it is worth
twenty minutes of one's time.

---

## 7. Risks

| Risk                                                  | Handling                                                                                                                                                                                                     |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The format is designed once and lived with for years. | Freeze v1.0 only after phase 3 exercises it with textures. Until then it is `0.x` and may move.                                                                                                              |
| A `.drft` that loads but is subtly wrong.             | Every array length checked at load, via the same `validateMeshData` the runtime uses. Refuse, never approximate.                                                                                             |
| Tier 2 read as a guarantee.                           | The tier is printed by the CLI on every experimental import, appears beside the format everywhere the site names it, and is in the refusal message. A partial import is never produced — it refuses instead. |
| The zero-asset identity is diluted.                   | The six existing demos stay asset-free forever, and the site keeps saying so. Phase 10 adds a seventh that loads one, positioned as the contrast rather than as a replacement.                               |
| A DCC release breaks delegation.                      | It is a CLI invocation with a version check and a clear error, not a parser. It degrades to "please export glTF", which always works.                                                                        |
