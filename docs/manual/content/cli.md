---
title: Command-line tools
description: The baker and its options, comparing two containers, building a distance-field font, the visual gate, the frame audit and the dev servers.
covers: ['Tooling']
---

# Command-line tools

The engine's tools run from a checkout of its repository, in Node, and none of them ships inside a
package a game installs. They are what produces the files a game loads, a baked `.drft` or a font
atlas, and what checks a change to the engine did what it says. The one exception is
`drift-package`, the packager, which is published as a command of its own with
`@driftengine/package`.

## The baker

```sh
npm run bake -- path/to/model.glb -o public/model.drft
npm run bake -- ./a-bought-bundle -o public/model.drft
npm run bake -- ./a-bought-bundle --from obj -o public/model.drft
```

`bake` reads a model in any format [the importers](importing-models.md) read and writes a
[`.drft` container](drft.md). Given a folder, it looks through it for every model, picks the
best-supported format present, and prints what it chose and what it passed over, because a bought
asset usually ships the same model several times over and the reader used should never be a
surprise. `--from` names the format to take from a folder instead.

On the way it welds the mesh to one vertex per distinct corner, drops attributes every vertex holds
the same value of, derives tangents where a material has a normal map, finds copies an export merged
into one mesh and writes them as one mesh drawn many times, quantises the geometry, embeds the
pictures the model names, and builds the coarse outline a loader draws while the rest arrives. Every
step it took and every warning is printed.

| Option                        | What it does                                                                                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-o file`                     | Where to write the container.                                                                                                                                                   |
| `--from ext`                  | Take this format from a folder, `obj` or `fbx` for example, instead of the best-supported one.                                                                                  |
| `--up axis`                   | Which way is up in the source, one of `+x`, `-x`, `+y`, `-y`, `+z`, `-z`, over what the file declares. It is never guessed; the baker warns when a model sits below its origin. |
| `--lod cells`                 | The outline's grid resolution, 40 cells by default.                                                                                                                             |
| `--no-lod`                    | Write no outline, for a model where the printed triangle count comes out absurd.                                                                                                |
| `--no-levels`                 | Skip the separate level-of-detail files a bundle ships beside its model, each otherwise baked whole with its own pictures.                                                      |
| `--max-texture px`            | Halve every picture until its longer side fits in `px`.                                                                                                                         |
| `--texture-codec jpeg`        | Re-encode opaque PNGs as JPEG, normal maps excepted. `jpeg-all` takes the normal maps too.                                                                                      |
| `--normals-directx`           | The normal maps point green down, as DirectX tools write them; turn each over on the way in.                                                                                    |
| `--blend-as-cutout`           | Bake every blended material as a cutout at 0.5. Foliage is often exported blended; each conversion is printed so a pane of glass is caught.                                     |
| `--simplify m`                | Reduce every mesh to the triangles its shape needs, the surface moving no more than `m` metres.                                                                                 |
| `--sdf m`                     | Write a signed distance field over the static geometry at `m` metres a voxel, for [traced light](../rendering/driftray.md).                                                     |
| `--no-instances`              | Write merged copies as they came, without finding the repeats.                                                                                                                  |
| `--no-quantise`               | Write full-precision geometry. Quantised geometry is about a third of the size, within stated bounds.                                                                           |
| `--collider none`             | The default: write no collision shape, since a bake should not invent one.                                                                                                      |
| `--collider box`              | One box around the model.                                                                                                                                                       |
| `--collider hull` or `hull:N` | Convex hulls decomposed from the model, 16 at most or `N`, up to 32, for [rigid bodies](../simulation/rigid-bodies.md).                                                         |
| `--direct`                    | Read a `.blend` with the engine's own reader, whatever it has to approximate.                                                                                                   |
| `--via-blender`               | Export a `.blend` through an installed Blender, found on the path or named by the `BLENDER` environment variable.                                                               |

A `.blend` is read directly first. When it holds something only Blender can evaluate, a rig, a
constraint or a modifier, the baker hands it to Blender's own glTF exporter, and says which route it
took and why. Without Blender installed, the direct read stands and the approximations are listed.

## Comparing two containers

```sh
npx tsx scripts/drft-diff.ts a.drft b.drft
```

`drft-diff` compares what two containers mean, the geometry totals, the materials and the
pictures, and ignores how their bytes are laid out, since two readers of one model can
legitimately group its meshes differently. It is how a `.glb` and an `.fbx` of the same asset are
shown to bake to the same thing, and `npm run bake:check` uses it to prove two bakes of one file
agree.

## A distance-field font

```sh
npm run sdf-font -- --font ./Display.ttf --out ./public/fonts --glyphs ./glyphs.txt
```

`sdf-font` turns a TrueType font and a list of characters into the atlas and metrics that
[distance-field text](../rendering/text-and-overlays.md) draws: `atlas.png`, and `metrics.json`,
which `parseSdfFont` reads. It draws each glyph large through headless Chrome's own text stack and runs a
distance transform over it, so it needs no font parser, and measures kerning by setting each pair.
More `--font` arguments are fallbacks in order, `--runs` adds whole strings drawn as one entry, and
`--size`, `--padding`, `--distance-range`, `--texels-per-em` and `--supersample` (4 by default) tune
the atlas.

## The visual gate

A test cannot see a picture, so a change to rendering is checked by photographing held frames
before and after it:

```sh
npm run demo                               # in one terminal
node scripts/shots.mjs capture before
node scripts/shots.mjs capture after       # after the change, with the server restarted
node scripts/shots.mjs diff before after
```

`?hold=N` freezes every scene at the same frame, so two captures of one build differ in no pixel
and any difference is the change. `--backend=webgl2` photographs the other backend under its own
name, so a comparison never compares a backend with itself. `--delta` is how far a pixel must move
to count, and a faint effect needs it lower than the default. `--islands` sorts the changed pixels
into regions so a defect stands out from noise, and `--base` with `--scenes=0` points the gate at a
page of your own. The capture refuses a software renderer, whose pictures would compare nothing
real.

`probe-check.mjs` drives the backend acceptance probe and prints what it costs to compile every
shader the engine ships on this machine.

## The frame audit

```sh
node scripts/frame-audit.mjs                       # a phone viewport
node scripts/frame-audit.mjs --desktop
node scripts/frame-audit.mjs --url=https://example.com/your-game/
```

A clock on a desktop cannot say why a frame is slow on a phone: a phone's GPU is bound by memory
traffic a desktop's hides. `frame-audit` counts what a frame moves instead, the passes, which
attachments are stored and loaded and how many bytes that is, by wrapping the page's own WebGPU
calls before its scripts run. Those numbers are the same on every device, so they can be read here
and trusted there.

## The dev servers

| Command            | What it serves                                                                                           |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| `npm run examples` | The examples this manual runs, every one at its own address; `?backend=webgl2` forces the other backend. |
| `npm run demo`     | The engine's own scenes, the pages the visual gate photographs.                                          |
| `npm run editor`   | The editor.                                                                                              |
