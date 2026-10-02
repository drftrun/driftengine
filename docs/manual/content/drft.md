---
title: The .drft container
description: The engine's own file: loaded without parsing, streamed onto the screen as it arrives, and opened by every future reader.
packages: ['@driftengine/drft', '@driftengine/assets']
areas: ['drft']
---

# The .drft container

A `.drft` file is a model, a level or a world, baked into the layout the engine uploads. Its vertex
and index arrays sit in the file at the alignment a GPU takes, so reading one is building views
over the bytes, with nothing parsed and nothing copied. Its pictures are inside it, so a level is
one fetch and cannot half load. And a file written today opens in every reader to come.

`@driftengine/drft` reads and writes the container and depends on nothing; it is 14.0 KB gzipped.
`DrftLoader`, in `@driftengine/assets`, streams one onto the screen. The
[models example](importing-models.md) writes a container in a worker and streams it with that
loader.

## Writing and reading one

```ts sample=snippets/drft.ts#write
/** Two meshes and a name: everything else a container can carry is optional. */
const crate = new MeshBuilder().addBox([0, 0.5, 0], [0.5, 0.5, 0.5], [0.6, 0.45, 0.3]).build();
const lid = new MeshBuilder().addBox([0, 1.05, 0], [0.55, 0.05, 0.55], [0.4, 0.3, 0.2]).build();
export const file: ArrayBuffer = writeDrft({ head: { name: 'crate' }, meshes: [crate, lid] });
```

```ts sample=snippets/drft.ts#read
/** Read whole: each array is a view over the file's own bytes, with nothing parsed or copied. */
export function describe(bytes: ArrayBuffer): string {
  const asset = readDrft(bytes);
  const vertices = asset.meshes.reduce((sum, mesh) => sum + mesh.positions.length / 3, 0);
  return `${asset.head.name}: ${asset.meshes.length} meshes, ${vertices} vertices`;
}
```

`writeDrft(source)` takes meshes and, optionally, a `head` with a name and units, materials,
textures, levels of detail, a hierarchy, skins, clips, lights, colliders, a navigation mesh, an
entity scene and more, and answers one `ArrayBuffer`. `readDrft(bytes)` reads it back whole, as a
`DrftAsset`: its `head`, `meshes`, `lods`, `materials` and `textures`, `nodes`, `instances`,
`lights`, `skins` and `clips`, `navigation`, `entities` and the rest, each empty where the file had
none. For something you ship, the [baker](cli.md) writes it from a model.

## What a file holds

A header, a table of chunks, and the chunks. Each chunk is named by four characters and is either
optional or required. Most of what a container can carry is optional:

- Geometry: `MESH`, one mesh, its attributes stored separately and in the order a mesh uploads
  them; `MSHQ`, the same in as few bytes as its data needs; `LODM`, a coarse version of the whole
  asset to show while the rest arrives; `MSHL`, a mesh's cluster levels for the
  [GPU-driven pipeline](../rendering/gpu-driven.md); `INST`, meshes drawn many times; and `KITS`
  and `MSHC`, a world built from [a kit of pieces](../worlds/worlds-from-a-kit.md).
- Surfaces: `MATL`, a material per mesh with the pictures it wears; `TEXS`, the pictures;
  `DTEX`, a material as a [decode program](../worlds/drifttexture.md); `SUBS`, which
  [substance](../simulation/chemistry.md) each material is made of; `SDFV`, signed distance fields.
- A scene: `NODE`, the hierarchy; `LITE`, its lights; `LVOL`, fixed light summed into a volume;
  `COLL`, the hulls it collides as; `NAVM`, a [navigation mesh](../simulation/navigation.md);
  `ENTS`, its [entities](../simulation/entities.md).
- Motion: `SKIN`, `ANIM` and `MORP`, a rig, its clips and its morph targets.
- A streamed world's `REGN` regions, a [splat capture](../worlds/splats.md)'s `SPLT` blocks, and
  the weights of small networks the engine evaluates.

## Compatibility

The rules are the contract, and they are strict:

1. An old file always opens. A reader loads any file whose required reader version is its own or
   older, with no expiry and no migration.
2. An optional chunk a reader does not know is skipped, which is what makes adding one free.
3. A required chunk a reader does not know is a refusal naming it, never a partial asset.
4. A minor version only adds; it never changes the meaning of a byte already written.
5. A major version means the layout changed, and a newer file refuses to open in an older reader
   with both versions named.

A test opens a fixture written by each released minor version's own writer, so the old bytes
really are old.

## Streaming it onto the screen

`DrftLoader` exists so a model builds up on screen instead of appearing after a wait. Its bytes
stream, and what arrives is queued and uploaded a few pieces a frame, each fading in:

- An outline first, where the file carries one: a coarse whole model drawn until the real geometry
  is complete, so the picture is an object sharpening, not parts appearing in empty space.
- Then the parts, `uploadsPerFrame` and `uploadMsPerFrame` bounding the work in any one frame, and
  `revealSec` the fade.
- Then, after the last byte, the parts merged into one mesh for each image and blend they share,
  so a model of 187 parts draws in seven calls once it has arrived.

`load(url, fit)` fetches and streams, `consume(response, fit)` streams a response from anywhere, and
`update(dt)` advances the uploads each frame. `progress` reports the phase, from connecting through
the outline, materials, geometry and textures to `ready`, or `absent` for a missing file and
`failed` with a `message`. A load never throws: a scene is usually still worth drawing without its
model.

Once loaded, a loader answers what the file held: `parts` and `textures` to draw, `nodes`, `lights`,
`skins`, `clips` and `morphs`, `colliders` and `navigation`, `entities`, a streamed world's
`regions`, `modelBounds` and the `placement` it was fitted with. `transform` and `surface` let a
consumer decide a material's look by its name as parts arrive, `onMesh` takes a mesh for drawing its
own way, `onImage` takes each picture instead of uploading it, and `dispose()` releases everything.

## Waiting for more than one thing

```ts sample=snippets/drft.ts#tracker
/** Everything a loading screen waits on, weighted, so its bar means something. */
const loading = new LoadTracker();
loading.add('level', 4_000_000);
loading.add('music', 900_000);
loading.add('settings', 2_000);

/** Each part reports as it goes; the summary is the weighted whole and the one to talk about. */
export function loadingLine(levelFraction: number): string {
  loading.report('level', levelFraction);
  const { fraction, activeId } = loading.summary;
  return `${Math.round(fraction * 100)}%, waiting on the ${activeId}`;
}
```

A loading screen usually waits on several things at once, a level, its music, a settings file, and a
bar that gives each the same share spends most of its life at a half. `LoadTracker` weighs them:
`add(id, weight)` registers one, in bytes or any unit that is the same across them, `report(id,
fraction)` and `finish(id)` move it, and `summary` gives the weighted `fraction`, whether it is
`done`, and `activeId`, the heaviest thing still unfinished, which is the one a person is actually
waiting for. A weight can be raised once its real size is known without losing the progress made.
