---
title: Importing models
description: Reading glTF, OBJ, STL, USD, 3MF, FBX and Blender files, at build time with the baker or in a worker when a player brings a file.
packages: ['@driftengine/assets']
covers: ['Assets']
areas: ['assets']
---

# Importing models

`@driftengine/assets` reads models made elsewhere. There are two places to do it. A model you ship
is baked ahead of time into a `.drft` container, which loads fast and streams onto the screen. A
model someone brings at run time, a file dropped on a page or an asset a player picks, is read in
a worker, written into the same container in memory, and streamed by the same loader. Either way it
reaches the screen by one path.

The example is a turntable with three models made for it, a lantern as glTF, a vase as OBJ with its
material file, and a gear as STL, and it takes any model you drop on the page, with the files it
names dropped beside it. It is 22.5 KB gzipped on top of core.

<!-- run: models -->

## What it reads

Every format is read by a reader that runs anywhere, with no filesystem and no native code, and is
given what it needs as arguments. Support is tiered, and the tier is stated wherever the format is:

- **Supported**: glTF 2.0, `.gltf` and `.glb`, which is the one to export when you can choose;
  Wavefront `.obj` with its `.mtl`; `.stl`; USD as `.usdz` or `.usda`; and `.3mf`.
- **Experimental**: `.fbx`, `.kn5`, and Blender's own `.blend`, from 2.79 to 5.x, read from the
  file's description of itself: meshes, normals, UVs, colour attributes, shape keys, Principled
  materials with their packed pictures, lights, cameras, the hierarchy and keyed animation. What only
  Blender can evaluate, a modifier other than the smoothing ones, a constraint, a rig or geometry
  nodes, is refused by name and never half imported.

`MODEL_FORMATS` lists every extension with its tier, `readerFor(extension)` answers whether one is
read, and `recognise(bytes)` identifies by its contents a file there is no reader for, a Maya `.mb`
or a 3ds Max `.max`, and says which export would work, so it is not fed to a reader that would fail
on it.

## Reading one

```ts sample=models/convert.ts#convert
async function convert({ name, bytes, folder, dropped }: ConvertRequest): Promise<ConvertReply> {
  const started = performance.now();
  const file = new Uint8Array(bytes);
  /* A file the model names, by the places it could be: the engine says what to look for. */
  const beside = async (named: string): Promise<Uint8Array | null> => {
    for (const candidate of assetCandidates(named)) {
      const own = dropped?.[basenameOf(candidate)];
      if (own !== undefined) return new Uint8Array(own);
      if (folder === undefined) continue;
      const found = await fetch(new URL(candidate, folder));
      if (found.ok) return new Uint8Array(await found.arrayBuffer());
    }
    return null;
  };
  /* The two zipped or deflated formats need their decompressor ready before the parse. */
  const ext = extensionOf(name);
  const inflate = ext === '.fbx' ? await prepareFbxInflate(bytes, browserInflate) : undefined;
  const inflateRaw = ext === '.3mf' ? await prepareZipInflate(bytes, browserInflateRaw) : undefined;
  const imported = await readModel({
    name,
    bytes: file,
    beside,
    decompress: unpack,
    ...(inflate === undefined ? {} : { inflate }),
    ...(inflateRaw === undefined ? {} : { inflateRaw }),
  });

  /* Y up, one vertex per distinct corner, and no attribute every vertex holds the same value of. */
  const up = imported.declaredUp;
  const oriented = up === undefined ? imported.meshes : orientMeshes(imported.meshes, up);
  const meshes = oriented.map((mesh) => dropDefaultAttributes(weldMesh(mesh)));

  /* The pictures the model carries or names, by what their own bytes say they are. A picture
     that cannot be found is left out, and the surfaces that wear it draw untextured. */
  const textures = [];
  for (const reference of imported.textures ?? []) {
    const image = reference.bytes ?? (await beside(reference.name));
    if (image === null) continue;
    const info = describeImage(image);
    textures.push({
      name: reference.name,
      codec: info.codec,
      width: info.width,
      height: info.height,
      bytes: image,
    });
  }

  /* A coarse outline of the whole model, drawn while the rest arrives, where one is worth it. */
  const outline = buildCoarseLevel(meshes, { cells: DEFAULT_COARSE_CELLS });
  const drft = writeDrft({
    meshes,
    ...(outline !== null && isOutlineWorthWriting(outline, meshes) ? { lods: [outline] } : {}),
    ...(imported.materials === undefined
      ? {}
      : { materials: imported.materials as DrftMaterial[] }),
    ...(textures.length === 0 ? {} : { textures }),
  });
  return { ok: true, drft, meshes: meshes.length, ms: performance.now() - started };
}
```

`readModel({ name, bytes, ... })` is the one entry point from a file to meshes. What a format needs
beyond its own bytes is passed in:

- `beside(name)`, for a file the model names: a `.gltf`'s buffers and pictures, an `.obj`'s `.mtl`.
  Models rarely state a path that is still true, so `assetCandidates(name)` lists where it could
  be, the stated path without its drive, the bare file name, and the usual texture folders, and you
  look in those places.
- `inflate` and `inflateRaw`, decompressors for `.fbx` and `.3mf`, which `prepareFbxInflate` and
  `prepareZipInflate` make ready from the browser's own, since the parse that uses them cannot wait.
- `decompress`, for a compressed `.blend`. Blender wrote gzip until 2.9, which a browser has, and
  zstd from 3.0, which a browser does not, so the example refuses such a file with what to do.

A format that needs one of these and is not given it fails with the name of what to pass.
`readModel` answers with `meshes`, `materials` paired to them by position, the `textures` the model
carries or names, `warnings` and `notes` about what it met, and, where the format has them, `nodes`,
`lights`, `skins`, `clips`, a `unitScale`, and the up axis and handedness it was authored with. `orientMeshes` turns a model to y up, `weldMesh` merges the vertices
a reader emits one per triangle corner, about six times what the model has, and
`dropDefaultAttributes` removes an attribute every vertex holds the same value of.

Reading at run time has costs a bake does not. A large model takes seconds to parse and weld, so it
never runs on the page's own thread or inside a frame: the example posts the bytes to a worker and
gets back one transferred buffer. And the arrays it makes are fresh, so it holds more memory than a
baked file would.

## Onto the screen

```ts sample=models/main.ts#load
/** Every model is fitted to the turntable: this wide, this tall, standing on it. */
const FIT: DrftFit = { footprint: 1.8, height: 1.6, baseY: 0.1 };
const worker = new Worker(new URL('./convert.ts', import.meta.url), { type: 'module' });
let loader: DrftLoader | null = null;

/** Send a file's bytes to the worker, and stream the container it answers with. */
function open(request: ConvertRequest): void {
  status = { label: request.name, line: 'READING' };
  worker.postMessage(request, [request.bytes]);
}
worker.onmessage = (event: MessageEvent<ConvertReply>) => {
  const reply = event.data;
  if (!reply.ok) {
    status = { label: status.label, line: reply.reason };
    return;
  }
  loader?.dispose();
  loader = new DrftLoader(renderer, { uploadsPerFrame: 4 });
  status = {
    label: status.label,
    line: `${reply.meshes} ${reply.meshes === 1 ? 'MESH' : 'MESHES'} CONVERTED IN ${reply.ms.toFixed(0)} MS`,
  };
  /* The loader streams from a response; a container from a worker is wrapped in one. */
  void loader.consume(new Response(reply.drft), FIT);
};
```

```ts sample=models/main.ts#samples
/** Three formats: glTF with its pictures inside it, OBJ with a material beside it, and STL. */
const SAMPLES: Record<string, string> = {
  lantern: 'lantern.glb',
  vase: 'vase.obj',
  gear: 'gear.stl',
};
/* Beside this page: a bundler rewrites `new URL(..., import.meta.url)` for a file, not a folder. */
const folder = new URL('assets/', location.href).href;
async function sample(label: string): Promise<void> {
  const name = SAMPLES[label] ?? 'lantern.glb';
  const response = await fetch(new URL(name, folder));
  open({ name, bytes: await response.arrayBuffer(), folder });
}
/* Any model dropped on the page, and the files dropped with it, such as its `.mtl` or textures. */
addEventListener('dragover', (event) => event.preventDefault());
addEventListener('drop', (event) => {
  event.preventDefault();
  const files = [...(event.dataTransfer?.files ?? [])];
  const model = files.find((file) => readerFor(extensionOf(file.name)) !== undefined);
  if (model === undefined) return;
  void Promise.all(files.map(async (file) => [file.name, await file.arrayBuffer()] as const)).then(
    (read) => {
      const dropped = Object.fromEntries(read);
      const bytes = dropped[model.name] as ArrayBuffer;
      delete dropped[model.name];
      open({ name: model.name, bytes, dropped });
    },
  );
});
```

The worker writes a `.drft` with `writeDrft`, and `DrftLoader.consume(response, fit)` streams it
exactly as `load(url, fit)` streams one from a server. The fit is the one thing a loader cannot
guess, since a model arrives in its author's units: `footprint` and `height` are what its larger
side is scaled to, and `baseY` is where its lowest point sits; `{ fit: 'none' }` keeps it as it is.
Dropped files come with the files beside them, so dropping an `.obj` together with its `.mtl` and
pictures finds them by name.

```ts sample=models/main.ts#draw
/* Each part with the images its material names: colour, the packed occlusion, roughness and
   metal map, normals and emission, each -1 where the file had none. */
const textures = loader?.textures ?? null;
const image = (index: number) => (index >= 0 ? (textures?.at(index) ?? null) : null);
for (const part of parts) {
  renderer.setMaterial({
    albedo: image(part.albedo),
    orm: image(part.orm),
    normal: image(part.normal),
    emissive: image(part.emissive),
    roughnessScale: part.roughnessScale,
    metallicScale: part.metallicScale,
    occlusionStrength: part.occlusionStrength,
  });
  if (part.opacity >= 1) renderer.drawMesh(part.mesh, IDENTITY);
  else renderer.drawTranslucentMesh(part.mesh, IDENTITY, part.opacity);
}
renderer.setMaterial(null);
```

The loader hands back `parts`, each a mesh and the indices of the images its material wears, its
colour, its packed occlusion, roughness and metal map, its normals and its emission, or -1, plus
the scales and the opacity the material carried. `textures` resolves an index to an uploaded image.
The [`.drft` chapter](drft.md) covers what else a container holds and how a loader streams it.

## Baking for a release

What ships should be baked: a `.drft` is laid out to be uploaded as it arrives, carries a coarse
outline to draw while the rest streams, and needs none of the work above at load. The baker runs
from a checkout of the engine:

```sh
npm run bake -- path/to/model.glb -o public/model.drft
npm run bake -- ./a-bought-bundle -o public/model.drft
```

Given a folder, it takes the best-supported format in it and says what it passed over. It welds,
quantises, builds the outline and the levels of detail, and can cap or re-encode textures, build
colliders, and hand a `.blend` it cannot read to an installed Blender, saying which route each file
took. [Command-line tools](cli.md) lists its options.
