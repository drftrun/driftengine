---
title: Gaussian splats
description: Captured places drawn as hundreds of thousands of soft ellipsoids, composed into a scene of meshes, sorted off the frame and streamed in blocks.
packages: ['@driftengine/splats', '@driftengine/drft']
covers: ['Splats']
areas: ['splats']
---

# Gaussian splats

A splat capture is a photographed place drawn as several hundred thousand oriented, soft-edged
ellipsoids. `@driftengine/splats` reads the files capture tools write, sorts the splats off the
frame, and draws them as a pass that composes into a scene of ordinary meshes, so a lamp post you
model stands among splats someone photographed. It costs 17.3 KB gzipped on top of core.

The example is a rock garden synthesised from about sixty-six thousand flat splats, so the page
needs no download, with a post of ordinary geometry standing in it. Switch the sort off to see
what drawing in file order looks like, and the pool's view-dependent colour to see it flatten.

<!-- run: splats -->

## A capture

```ts sample=splats/main.ts#capture
/**
 * Splats gathered for one capture: where, how big along each axis, which way, what colour. A colour
 * is a display value, as a capture trained on photographs stores it, and the pass decodes it.
 */
const positions: number[] = [];
const scales: number[] = [];
const rotations: number[] = [];
const colors: number[] = [];
const opacities: number[] = [];
const shine: number[] = [];

/** The quaternion, xyzw, that turns +z onto a unit normal: a flat splat lies along the surface. */
function facing(nx: number, ny: number, nz: number): [number, number, number, number] {
  const w = 1 + nz;
  if (w < 1e-6) return [1, 0, 0, 0];
  const length = Math.hypot(-ny, nx, 0, w);
  return [-ny / length, nx / length, 0, w / length];
}

/** One flat splat on a surface: wide along it, thin across it. */
function lay(at: Vec3, normal: Vec3, size: number, colour: Vec3, opacity: number, sheen = 0): void {
  positions.push(...at);
  scales.push(size, size, size * 0.12);
  rotations.push(...facing(normal[0], normal[1], normal[2]));
  colors.push(...colour);
  opacities.push(opacity);
  shine.push(sheen);
}

/** A rock: points spread evenly over a lumpy ellipsoid, stone below and moss where it faces up. */
function rock(cx: number, cz: number, rx: number, ry: number, rz: number, seed: number): void {
  const count = Math.round(6000 * rx * rz);
  for (let i = 0; i < count; i += 1) {
    const y = 1 - (2 * (i + 0.5)) / count;
    const ring = Math.sqrt(1 - y * y);
    const a = i * 2.399963;
    const nx = Math.cos(a) * ring;
    const nz = Math.sin(a) * ring;
    const lump = 1 + (hashToUnit(seed + Math.floor(a * 3) * 17 + Math.floor(y * 6)) - 0.5) * 0.18;
    if (y < -0.2) continue;
    const grey = 0.63 + hashToUnit(seed * 7 + i) * 0.1;
    const moss = Math.max(0, y - 0.55) * 2.2 * hashToUnit(seed * 13 + i);
    const colour: Vec3 = [grey - moss * 0.15, grey + moss * 0.12, grey - moss * 0.17];
    lay([cx + nx * rx * lump, y * ry * lump, cz + nz * rz * lump], [nx, y, nz], 0.07, colour, 0.9);
  }
}

/** The ground: a disc of soil and grass, and a pool in it whose colour changes with the view. */
for (let i = 0; i < 52000; i += 1) {
  const r = Math.sqrt((i + 0.5) / 52000) * 9;
  const a = i * 2.399963;
  const x = Math.cos(a) * r;
  const z = Math.sin(a) * r;
  const pool = Math.hypot(x - 2.2, z + 1.2) < 1.8;
  const tone = hashToUnit(i * 3);
  const colour: Vec3 = pool
    ? [0.25, 0.38 + tone * 0.04, 0.44]
    : [0.44 + tone * 0.09, 0.48 + tone * 0.17, 0.31 + tone * 0.07];
  lay(
    [x, pool ? -0.05 : tone * 0.04, z],
    [0, 1, 0],
    0.075,
    colour,
    pool ? 0.85 : 0.95,
    pool ? 1 : 0,
  );
}
rock(-2.2, -1.5, 1.4, 1.1, 1.2, 11);
rock(-0.4, 1.6, 0.9, 0.7, 0.8, 23);
rock(-3.6, 1.8, 0.7, 1.3, 0.6, 37);
rock(3.4, 2.4, 1, 0.6, 1.1, 41);
```

Each splat is a Gaussian: a position, a standard deviation along each of its own three axes, a
rotation, a colour and an opacity. A `SplatSource` holds them as flat arrays: three numbers a splat
for `positions` and `scales`, four for `rotations` in **xyzw** order, three for `colors` from 0 to
1, and one for `opacities`, already through the logistic. A colour is a display value, as a capture
trained on photographs stores it, and the pass decodes it after the view-dependent band, so a capture
draws as it does in the tool that made it. Both common file formats store rotations as wxyz, and the
readers turn them round.

```ts sample=splats/main.ts#pack
/**
 * The same splats packed twice: once with flat colour, and once with the first band of
 * view-dependent colour on the pool, nine coefficients a splat, interleaved by basis function.
 */
const count = opacities.length;
const source = {
  count,
  positions: new Float32Array(positions),
  scales: new Float32Array(scales),
  rotations: new Float32Array(rotations),
  colors: new Float32Array(colors),
  opacities: new Float32Array(opacities),
};
const sh1 = new Float32Array(count * 9);
for (let i = 0; i < count; i += 1) {
  const sheen = shine[i] ?? 0;
  /* Brighter and bluer seen from one side of the pool, darker from the other. */
  sh1[i * 9 + 6] = 0.25 * sheen;
  sh1[i * 9 + 7] = 0.35 * sheen;
  sh1[i * 9 + 8] = 0.45 * sheen;
}
const flat = packSplats(source);
const glossy = packSplats({ ...source, sh1 });
```

`packSplats(source)` packs a source into `SplatData`, the record the GPU reads and the `SPLT` chunk
of a `.drft` carries: eight 32-bit words a splat (`SPLAT_WORDS`), as two texels. The first holds the
position and the colour; the second, the splat's covariance in half precision, computed once from
its scales and rotation since it cannot change. A sort reads the positions, so they stay full
precision. The splats of a capture cannot move: that is a scene the format does not express.

### Colour that changes with the view

A capture from a training run stores colour as a spherical-harmonic expansion: a constant term for
the colour from every angle, and bands above it for how that colour changes as you move past. The
first band is read and the rest are not. `sh1` takes nine numbers a splat
(`SPLAT_SH1_COEFFICIENTS`), interleaved by basis function and then by channel, and packs them into
one extra texel a splat (`SPLAT_WORDS_SH1`, twelve words).

That is a decision with numbers behind it. The first band is 288 bytes a splat a frame against 192,
which at a mobile budget of 400,000 splats is 115 MB a frame against 77; the second and third bands
would be 192 MB and 307 MB, on a phone already moving about 389 MB a frame for everything else. The
broad directional lobe that lets glass and a wet floor read as themselves ships; the sharp specular
bands do not. A capture without harmonics pays nothing.

## From files

```ts sample=snippets/splats.ts#files
/** A capture from a file: a `.ply` from training, a `.splat`, or a `.sog` bundle of WebP images. */
export async function readCapture(url: string): Promise<SplatData> {
  const bytes = await (await fetch(url)).arrayBuffer();
  if (url.endsWith('.ply')) return readSplatPly(bytes);
  if (url.endsWith('.splat')) return readSplat(bytes);
  return readSplatSog(await unbundleSog(bytes), browserWebpDecoder());
}
```

- `readSplatPly(buffer)` reads the `.ply` a training run writes, including its first harmonic
  band.
- `readSplat(buffer)` reads a `.splat`, a whole number of `SPLAT_RECORD_BYTES` records.
- `.sog` is a ZIP of lossless WebP images and a manifest. `unbundleSog(bundle)` unpacks it to
  files, `readSplatSog(files, decode)` decodes them, and `browserWebpDecoder()` is the decoder a
  browser provides; Node has none, so a tool passes its own. A capture already unbundled into a
  directory, a `meta.json` beside its images, starts at `readSplatSog`. `readSogMeta` and
  `readSogSource` are the two halves, for checking what was decoded before it was packed.
  `SOG_VERSION` is the manifest version the reader accepts.

## Composing into the scene

```ts sample=splats/main.ts#batch
/** Each packing as a pass registered with the renderer, and the version of the order it holds. */
interface Batch {
  readonly pass: SplatPass;
  readonly handle: PassHandle;
  uploaded: number;
}
function batch(data: SplatData, label: string): Batch {
  const pass = createSplatPass(data, label);
  return { pass, handle: renderer.registerPass(pass), uploaded: -1 };
}
const batches = { flat: batch(flat, 'garden.flat'), glossy: batch(glossy, 'garden.glossy') };
/** One sorter serves both, since their splats stand in the same places. It sorts in a worker. */
const sorter = new SplatSorter({ splats: flat });
/** File order, for the switch that turns the sort off. */
const unsorted = Uint32Array.from({ length: count }, (_, i) => i);
const local = createSplatViewLocal();
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
```

`createSplatPass(data, label)` makes a pass, and `renderer.registerPass(pass)` hands it to the
renderer, which calls its `init` and returns the handle `drawPass` takes. Splats reach the frame
through the renderer's pass seam, not a verb of its own, which is why they are a package.

```ts sample=splats/main.ts#frame
const shown = viewDependent ? batches.glossy : batches.flat;
/* The view first, because it decides whether the capture is in frame at all. */
shown.pass.setView({
  view: camera.view,
  projection: camera.projection,
  widthPx: stage.canvas.width,
  heightPx: stage.canvas.height,
});
if (!sorting) {
  if (shown.uploaded !== -2) shown.pass.setOrder(unsorted, count);
  shown.uploaded = -2;
} else if (shown.pass.visible) {
  /* The camera in the capture's own space; the sorter asks for a new order when it has moved. */
  resolveSplatView(camera.view, IDENTITY, local);
  sorter.frame(local);
  const order = sorter.order;
  if (order !== null && sorter.version !== shown.uploaded) {
    shown.pass.setOrder(order, sorter.drawCount);
    shown.uploaded = sorter.version;
  }
}

renderer.beginFrame(SKY);
renderer.bindMeshPass(camera, env);
renderer.drawMesh(post, IDENTITY);
/* After the meshes, so the post hides the splats behind it and not those in front. */
renderer.drawPass(shown.handle);
```

Each frame:

1. `pass.setView({ view, projection, widthPx, heightPx })` with the camera's matrices and the
   canvas size in pixels. It decides whether the capture is in frame at all, as `pass.visible`.
2. When it is visible, `resolveSplatView(camera.view, model, local)` puts the camera into the
   capture's own space, in a `SplatViewLocal` from `createSplatViewLocal()`, and the sorter's
   `frame(local)` asks for a new order if the view has moved enough.
3. When a new order has landed, which `sorter.version` says, `pass.setOrder(order, count)` uploads
   it. Four bytes a splat, so it is uploaded when it changes and not every frame.
4. `renderer.drawPass(handle)` after the meshes, so geometry in front of the splats hides them and
   geometry behind does not. Splats test depth and never write it: a Gaussian has no surface to
   hide anything with.

Until it has an order, a pass draws nothing, since a capture composited in the wrong order is
wrong at every edge. `pass.setModel(matrix)` places a capture in the world; a sorter sorts in the
capture's own space, so one transform on the camera replaces a million on the splats.
`splatBoundsVisible` is the frustum test `setView` uses.

Two captures are two passes and two orders, with no order between them: each is drawn whole, one
after the other. Where they occupy different volumes, a statue and the room around it, nothing
shows. Where they interpenetrate, the seam is a plane at which one starts winning every blend.

### The sort, off the frame

Splats are transparent and draw back to front, and the order changes whenever the camera moves.
Sorting hundreds of thousands inside a frame is what makes a naive renderer stall, so a
`SplatSorter` sorts in a worker and the pass draws whatever order it last received. A fast camera
move draws a slightly stale order for a frame or two, which reads as a soft settle and never as a
stall.

`new SplatSorter({ splats })` builds its worker from a `Blob`, falling back to the main thread
where a worker cannot be made. `sort` replaces it with any `SplatSortFn`: one is handed a
`SplatSortRequest` and a `SplatSortScratch` it reuses, and answers a `SplatSortResult`.
`sortSplatsByDepth` is the sort itself, a counting sort over a sixteen-bit depth key
(`SPLAT_SORT_BUCKETS`, with `SPLAT_SIZE_BUCKETS` for ranking by size under a budget), and
`sortOnMainThread` and `createDefaultSplatSort` are the two ready-made functions. `sorter.sorting`
says whether a sort is in flight.

## A budget for weaker GPUs

```ts sample=snippets/splats.ts#budget
/** At most as many splats as this GPU family is known to hold, the largest on screen kept. */
export function budgetedSorter(renderer: RendererApi, splats: SplatData): SplatSorter {
  return new SplatSorter({ splats, budget: defaultSplatBudget(renderer.rendererName) });
}
```

`budget` caps how many splats a sorter hands the pass, keeping those largest on screen, and with a
budget the sorter also re-sorts only when the camera has moved a tenth of the capture's size,
which `moveFraction` overrides. `defaultSplatBudget(rendererName)` answers 400,000
(`SPLAT_BUDGET_DEFAULT`), or 120,000 (`SPLAT_BUDGET_WEAK`) on a GPU family measured to struggle.
Too low a budget draws a sparser cloud and nothing worse; a game holding a measurement of its own
should pass that.

## Streaming a capture

```ts sample=snippets/splats.ts#stream
/**
 * A capture that fills as its blocks arrive. The first block names the final count, so the
 * capture and its pass are sized once, and every block after is a sub-upload.
 */
export function streamCapture(
  renderer: RendererApi,
  onReady: (pass: SplatPass, sorter: SplatSorter) => void,
): DrftStream {
  let capture: SplatCapture | null = null;
  let pass: SplatPass | null = null;
  return new DrftStream({
    onSplats: (block: DrftSplatBlock) => {
      if (capture === null) {
        const filling = new SplatCapture({
          total: block.totalCount,
          boundsMin: block.boundsMin,
          boundsMax: block.boundsMax,
          sphericalHarmonics: block.sphericalHarmonics,
          wordsPerSplat: block.wordsPerSplat,
        });
        capture = filling;
        pass = createSplatPass(filling.data, 'streamed');
        renderer.registerPass(pass);
        /* The sorter orders what has arrived, and nothing of the zeroed tail still to come. */
        onReady(pass, new SplatSorter({ splats: filling.data, ready: () => filling.ready }));
      }
      const landed = capture.append(block.records, block.count);
      pass?.uploadSplats(landed.from, landed.count);
    },
  });
}
```

A `.drft` carries a capture in up to sixteen `SPLT` blocks, coarse-ordered so the first block draws
the whole place thinly and the rest fill it in. Measured on a 332 KB capture: the first block is 662
splats in 24 KB, and it draws the whole room, not a corner of it.

A `SplatCapture` is allocated at the final count the first block names and filled as blocks
arrive: `append(records, count)` says where a block landed, and `pass.uploadSplats(from, count)`
sends just those rows. The sorter is told `ready: () => capture.ready`, so it orders what has
arrived and never the zeroed tail still to come. `splatsFromRecords` assembles a capture from a
file that was read whole.
