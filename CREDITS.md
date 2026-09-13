# Credits

Everything in this repository is written for it, except where this file says otherwise. Each entry
below names what came from somewhere else, who made it, the licence it carries, and whether any of
it ships in this tree.

## The voxel sandbox demo

`demo/voxelSandbox/` is a port of the **Voxel Sandbox** demo from
[Babylon Lite](https://github.com/BabylonJS/Babylon-Lite), by the **Babylon.js team and the
Babylon Lite contributors**, licensed **Apache 2.0**.

**What was taken.** The design: which blocks exist, how terrain is generated and seeded, how faces
are culled and ambient occlusion is baked, the shape of the water simulation, the mob species and
their walk cycle, the hotbar and the two fog radii. The port follows it module for module and is
meant to be read beside it.

**What was not taken.** Any of their code. None of it is in this tree, none of it is bundled, and
none of it is published. The reference sources are fetched on demand into `.reference/`, which
`.gitignore` covers, and every file under `demo/voxelSandbox/` is written against this engine's own
public API.

This tree is now Apache-2.0 itself, so the licence mismatch that first forced the clean-room rule no
longer exists. The rule stands anyway, and the reason is worth keeping: a port that reads a reference
and writes its own code owes an acknowledgement, which this file is, while a port that copies one
owes a provenance trail through every file it touched. The second is a debt this repository has
never taken on and does not intend to.

**What is different.** The reference writes two GLSL materials; this port writes no shader at all
and draws the same world through the standard material, which is the whole of what it set out to
demonstrate. `demo/voxelSandbox/GAPS.md` records every point where that cost something, and what
the engine would need to close it.

This demo is not affiliated with, endorsed by, or connected to Mojang Studios or Microsoft.
_Minecraft_ is a trademark of Mojang Studios. The genre is the subject here, not the product.

## The block textures

The [Kenney Voxel Pack](https://kenney.nl/assets/voxel-pack) by **Kenney**, released into the
public domain under **CC0 1.0**. CC0 asks for no attribution; this entry is here because a reader
of `demo/voxelSandbox/atlas.ts` should not have to work out where the pixels came from.

The tiles are fetched at runtime into `demo/dev/public/voxelpack/`, which `.gitignore` covers. They
are not committed, not bundled, and absent from the published package.

## The SDF font atlases

**These are the only third-party-derived files actually committed to this tree**, which is why this
entry matters more than the two above it. `demo/dev/public/fonts/latin/atlas.png` and
`demo/dev/public/fonts/arabic-run/atlas.png` are signed-distance-field atlases baked by
`npm run sdf-font` from two system fonts. A rasterised, distance-transformed atlas is a derivative
of the original outlines, so each carries its original's licence.

- **DejaVu Sans** — `latin/`. **Bitstream Vera License**, with the DejaVu changes themselves in the
  public domain. Free to use, copy, modify and distribute; the licence text must travel with it.
- **Noto Sans Arabic** — `arabic-run/`. **SIL Open Font License 1.1**, which permits derivatives and
  requires the copyright notice and licence to accompany them.

Only the glyphs the demo draws are baked, which is why each atlas is tens of kilobytes rather than
megabytes. `demo/dev/public/fonts/README.md` names the exact source file, the Debian package it came
from, the glyph set, and the command that regenerates each one.

**Neither reaches a published package.** `demo/` is not inside any package, and every package ships
only its own `dist`, `src`, `README.md`, `LICENSE` and `NOTICE`.

## The proprietary model formats this engine reads

`packages/assets/` reads **`.kn5`** (Assetto Corsa, Kunos Simulazioni) and **`.fbx`** (Autodesk),
alongside the open formats. Both readers are independent implementations and neither takes anything
from its originator.

**What was not used.** No SDK, no header, no decompiled binary, no vendored code, and no copied
specification. `.kn5` has no published specification at all: what `packages/assets/src/kn5.ts`
implements was established by observing files, and the evidence it rests on is that three files from
a production car mod each parse to _exact EOF_ — a binary walk that consumes a 44 MB file to its
last byte has no field misread anywhere in it, because one wrong width desynchronises everything
after it.

**What is not distributed.** No `.kn5` or `.fbx` file is committed, bundled or published. The test
fixtures are authored byte by byte by the test itself rather than checked in, and
`npm run kn5:check` takes a path to a file the person running it already has.

Reading a file format is not copyright infringement: a format is a method rather than an expression,
and implementing one for interoperability is expressly permitted — Directive 2009/24/EC Articles 5(3)
and 6 in the EU, whose Article 8 voids contract terms to the contrary. What would be a problem is
shipping Autodesk's SDK or redistributing somebody's car, and neither happens here.

_Assetto Corsa_ and _Kunos Simulazioni_ are trademarks of Kunos Simulazioni S.r.l.; _FBX_ and
_Autodesk_ are trademarks of Autodesk, Inc. This engine is not affiliated with, endorsed by, or
connected to either. The formats are named descriptively, because naming what a reader reads is the
only way to say what it does.

## What is deliberately not listed here

**Dependencies are not credited here, because nothing is vendored.** `gl-matrix`, `mp4-muxer`,
`driftscript` and the packaging toolchain arrive through npm and carry their own licences with them
in `node_modules`. Copying their notices into this file would create a second copy to keep true.

**Published algorithms are not credited here either.** GGX, Smith's masking term, Schlick's
approximation, Hammersley sequences, Karis's mobile approximations and the ACES transform matrices
are methods and standard constants, not expression, and no implementation of any of them was copied
into this tree. Each is named at the point it is used, which is where a reader needs it.
