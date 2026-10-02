---
title: DriftCapture
description: A video of a place turned into a surface, a collider, materials and proposed entities on the player's own device, and each stage's measured limits.
packages: ['@driftengine/capture']
covers:
  [
    'DriftCapture stage one: geometry',
    'DriftCapture stage two: colliders',
    'DriftCapture stage three: materials',
    'DriftCapture stage four: entities',
  ]
areas: ['capture']
---

# DriftCapture

`@driftengine/capture` turns a video of a place into a scene: a surface, a collider a character can
stand on, the surface's colours separated from the light they were filmed under, and the scene cut
into regions proposed as entities. It runs on the player's own device, in a browser or on the
native host, and never fetches: the models' weights are files a game ships. It costs 72,615 bytes
gzipped, and nothing in core imports it.

Each stage states its maturity, measured on real handheld clips, and this chapter repeats those
statements: DriftCapture reconstructs what a clip saw from where the clip saw it, and nothing more.

The example runs the geometry stages on a clip it synthesises: a ring of frames ray cast from a
room of four boxes, each with its true depth, so the page needs no model and no download. The
surface it fuses is proposed as floor and scenery, and balls drop onto it as a collider. Use fewer
frames to see the holes where nothing looked.

<!-- run: capture -->

## Stage one: a surface

### Frames

```ts sample=snippets/capture.ts#frames
/** Six frames of a clip, spaced by equal motion, decoded to pixels. */
export async function framesOf(clip: Blob): Promise<RawFrame[]> {
  const source = await browserFrameSource(clip);
  const kept = await selectFrames(source, { budget: 6 });
  const frames: RawFrame[] = [];
  for (const index of kept) {
    const probe = await source.frameAt(index, new Uint8Array(0));
    const pixels = new Uint8Array(probe.width * probe.height * 4);
    const size = await source.frameAt(index, pixels);
    frames.push({ pixels, width: size.width, height: size.height });
  }
  return frames;
}
```

A `FrameSource` is the host's own decoder, one frame at a time: `browserFrameSource(clip)` puts a
browser's video element behind one, and the native host puts ffmpeg behind another.
`eachFrame(source, visit)` walks a clip, and `selectFrames(source, { budget, every })` chooses the
frames a capture keeps, spaced by equal motion. Choosing by motion decodes the whole clip, which
through a browser's seek took 445 seconds for 1,401 frames; `every` takes every nth frame instead,
under the same budget, for a caller that knows its clip.

### Depth and cameras

```ts sample=snippets/capture.ts#model
/** A converted model file's weights, by tensor name, as a definition reads them. */
export function weightsOf(file: ArrayBuffer): WeightSource {
  const stored = readDrft(file).graphs[0];
  if (stored === undefined) throw new Error('the model file holds no graph');
  const tensors = graphFromStored(stored).tensors;
  return { get: (name) => tensors.get(name), names: () => tensors.keys() };
}

/** Each graph run on the device, its runner built once a size and reused. */
export function onDevice(device: GPUDevice, half: boolean): GraphRun {
  const runners = new Map<NetworkGraph, Awaited<ReturnType<typeof createGraphRunner>>>();
  return async (graph, inputs) => {
    let runner = runners.get(graph);
    if (runner === undefined) {
      runner = await createGraphRunner({ device, half }, graphForDevice(graph));
      runners.set(graph, runner);
    }
    return runner.run(inputs);
  };
}

/** Depth, a confidence and a camera for every frame, from Depth Anything 3 Small. */
export function estimate(
  frames: RawFrame[],
  weights: WeightSource,
  run: GraphRun,
): Promise<DepthEstimate> {
  return createDepthEstimator(DEPTH_ANYTHING_3.small, weights, run).estimate(frames);
}
```

`createDepthEstimator(config, weights, run)` runs Depth Anything 3 over the frames together and
answers a depth, a confidence and a camera for each: `DEPTH_ANYTHING_3.small` and `.base` are the
two accepted sizes. `depthAnything2` with `DEPTH_ANYTHING_2_SMALL` is a lighter fallback, relative
depth from one view at a time. A `GraphRun` runs a model's graph wherever the caller likes: on the
device through core's `createGraphRunner`, or on the CPU as the reference.

The models are written as definitions, functions of a model's weights that the texture package's
`graphFromWeights` builds into a graph the engine's one neural runtime runs. Each is held by its
tests to numbers the upstream project's own code wrote for a miniature of it, within a few parts
in a million, and `miniatureCheckpoint` and its siblings are those miniatures, for checking a port
of your own. **No weights ship with the engine.** A converter pins each accepted model to a commit
and a SHA-256, and a game ships the converted file with the model's licence and attribution.

Without a model, `estimatePoses(frames, options, out)` places the cameras the classical way:
features tracked between frames (`detectFeatures`, `describeFeatures`, `matchFeatures`), a
two-view start (`relativePose`, `triangulate`), every frame placed by what it sees, and a bundle
adjustment. Each pose carries a confidence and reports `parallax: false` where the clip only turned,
and the scale is metric only when a length is given. The decompositions underneath, `svd3`, `svdN`,
`symmetricEigen`, `cholesky`, `levenbergMarquardt` and `schurSolve`, are exported, in double
precision.

### Fusing the views

```ts sample=capture/main.ts#clip
/** The room the clip is of: a floor, a table, two crates stacked, and a cabinet. */
const ROOM: TestScene = {
  boxes: [
    { min: [-1.6, 0, -0.8], max: [-0.4, 0.8, 0.4], seed: 1 },
    { min: [0.3, 0, -1.2], max: [1.5, 0.5, 0.2], seed: 2 },
    { min: [0.5, 0.5, -0.9], max: [1.1, 1.1, -0.3], seed: 5 },
    { min: [-0.5, 0, 0.9], max: [0.5, 1.4, 1.5], seed: 7 },
  ],
  planes: [{ normal: [0, 1, 0], offset: 0, seed: 3 }],
};

/** Frames from a ring of positions round the room, each with the depth along the camera's axis. */
const WIDTH = 96;
const HEIGHT = 72;
function clip(frames: number): SurfaceView[] {
  const views: SurfaceView[] = [];
  for (let i = 0; i < frames; i += 1) {
    const angle = (i / frames) * Math.PI * 2;
    const eye: [number, number, number] = [Math.cos(angle) * 4.5, 2.2, Math.sin(angle) * 4.5];
    const view = {
      width: WIDTH,
      height: HEIGHT,
      intrinsics: [80, 80, WIDTH / 2, HEIGHT / 2] as [number, number, number, number],
      worldToCamera: lookAt(eye, [0, 0.4, 0]),
    };
    const pixels = new Uint8Array(WIDTH * HEIGHT * 4);
    const depth = new Float32Array(WIDTH * HEIGHT);
    renderTestScene(ROOM, view, pixels, depth);
    views.push({ depth, coverage: depth.map((d) => (d > 0 ? 1 : 0)), camera: view });
  }
  return views;
}
```

```ts sample=capture/main.ts#surface
/** Every frame fused into one volume, its surface marched out, and brought to a budget. */
function surfaceOf(views: readonly SurfaceView[], budget: number): MeshData {
  const volume = createVolume([72, 30, 72], [-2.5, -0.3, -2.5], 0.07);
  fuseDepth(views, volume);
  const marched = marchVolume(volume);
  return budget > 0 ? decimate(marched, budget) : marched;
}
```

`createVolume(dims, origin, spacing)` is a grid of samples over a box of the world, and
`fuseDepth(views, volume)` writes every view's depth into it as a truncated signed distance,
weighted by how squarely each view saw the surface. Space in front of a surface is carved out,
space behind it is left alone, and a surface one view saw is kept at the weight one view is worth.
Fusing twice with two halves of the views is fusing once with all of them, so a clip can be fused
as it arrives. A `SurfaceView` is a depth along the camera's axis, a coverage from 0 to 1 and the
camera; from a model, the confidence stands in for coverage:

```ts sample=snippets/capture.ts#fuse
/** The estimate as views the fusion reads: the model's confidence stands in for coverage. */
export function surfaceOf(estimate: DepthEstimate, volumeSide: number): MeshData {
  const views: SurfaceView[] = estimate.views.map((view) => ({
    depth: view.depth,
    coverage: view.confidence,
    camera: {
      width: estimate.width,
      height: estimate.height,
      intrinsics: [
        view.intrinsics[0] ?? 0,
        view.intrinsics[4] ?? 0,
        view.intrinsics[2] ?? 0,
        view.intrinsics[5] ?? 0,
      ],
      worldToCamera: Float64Array.from(view.worldToCamera),
    },
  }));
  /* A box round the room; a clip has no scale of its own until a length in it is known. */
  const spacing = volumeSide / 96;
  const half = volumeSide / 2;
  const volume = createVolume([96, 96, 96], [-half, -half, -half], spacing);
  fuseDepth(views, volume);
  const marched = marchVolume(volume);
  return decimate(marched, Math.max(512, Math.floor(marched.indices.length / 6)));
}
```

`marchVolume(volume)` extracts the surface as a mesh, by tetrahedra so it is closed by construction
and faces outward. Where the clip never looked it is left open: a cap there would be a surface
nobody measured. `decimate(mesh, budget)` brings it to a triangle budget by quadric-error collapse: a wall
flattens, a corner keeps its detail, the border of an open capture is held, and a collapse that
would turn a face inside out is refused.

**Maturity.** Measured on an RX 9070 XT, six frames of a 1,401-frame 1080p handheld clip took 7.2
seconds in a browser and 9.05 on the native host, of which 3.6 and 5.5 were loading the weights,
and a room came back as 33,060 triangles. Six frames is the ceiling on that device: ten are refused.
The metric scale is not verified, since no capture measured contained an object of known size, so
the metres are the model's claim.

### As Gaussians

`optimiseGaussians(targets, poses, options)` fits the frames and their cameras into Gaussians,
answered as the [splats](splats.md) package's own `SplatSource`, with the first band of
view-dependent colour on request. It descends a reference rasteriser, `rasteriseGaussians`, the
same projection the splat shader performs with every analytic gradient checked against a central
difference, and is judged by `structuralSimilarity`. `renderDepth` reads a cloud's depth back with
the coverage beside it, and `splatColour`, `sh1Basis` and `SH_C1` shade a band exactly as the shader
does.

## Stage two: a collider

```ts sample=capture/main.ts#collide
/** The same surface as a static body, and balls dropped onto it. */
let world = new PhysicsWorld();
const BALLS = 24;
let balls: number[] = [];
function collide(mesh: MeshData): void {
  world = new PhysicsWorld();
  const { positions, indices } = collisionMesh(mesh);
  world.addBody({ type: BODY_STATIC, shape: meshShape(positions, indices), friction: 0.6 });
  balls = Array.from({ length: BALLS }, (_, i) =>
    world.addBody({
      type: BODY_DYNAMIC,
      shape: sphereShape(0.12),
      x: (hashToUnit(i * 7) - 0.5) * 3,
      y: 2 + i * 0.25,
      z: (hashToUnit(i * 7 + 1) - 0.5) * 3,
      restitution: 0.4,
    }),
  );
}
```

`collisionMesh(mesh)` cleans a captured surface for collision, taking out triangles with no area
and the vertices nothing uses after, and answers the positions and indices `meshShape` takes.
`propHulls(mesh, options)` turns a prop into convex hulls instead, inside the container's own caps,
since a room is one mesh body and a prop is something that can be thrown.

**Maturity.** A collider holds where the capture has a surface, and a capture does not have one
everywhere. A character controller dropped from a metre above a three-by-three grid of a real
reconstruction landed on it three times of nine and fell through six, which is the reconstruction
being patchy: a controller started inside the geometry is pushed out, not trapped.

## Stage three: materials

`delight(views, mesh, options, out)` separates what a surface reflects from the light it was filmed
under: what stays the same across views is the material, what moves is the light, and an intensity
change the colour does not follow is a shadow. Every vertex carries a confidence. `renderLit` and
`nearestHit` are the lit fixture it is measured against.

**Maturity.** It recovers colour and says how much it trusts it, and on ordinary footage that is not
much: a mean confidence of 0.276 on a wooden table and 0.249 on a room, a grey object on a grey
floor having no chromaticity to tell shading from paint. It cannot remove a cast shadow, since a
shadowed point is shadowed from every camera. It is the most expensive stage by thirty times, 44
seconds over 16,670 triangles, and colour is per vertex, so its detail is the mesh's.

## Stage four: entities

```ts sample=capture/main.ts#propose
/** Paint each triangle by the surface it belongs to, or by what the capture proposes it is. */
const WALKABLE: Vec3 = [0.35, 0.75, 0.4];
const SCENERY: Vec3 = [0.62, 0.6, 0.56];
function painted(mesh: MeshData, paint: string): MeshData {
  const regions = segmentGeometry(mesh, { creaseDegrees: 15 });
  const proposals = proposeEntities(regions);
  const colourOf = new Map<number, Vec3>();
  regions.forEach((region, index) => {
    const proposal = proposals[index];
    const colour: Vec3 =
      paint === 'regions'
        ? [
            0.3 + hashToUnit(index * 3) * 0.6,
            0.3 + hashToUnit(index * 3 + 1) * 0.6,
            0.3 + hashToUnit(index * 3 + 2) * 0.6,
          ]
        : paint === 'proposals' && proposal?.walkable === true
          ? WALKABLE
          : SCENERY;
    for (const triangle of region.triangles) colourOf.set(triangle, colour);
  });
  /* Three vertices a triangle, so neighbouring surfaces do not blend at their edges. */
  const count = mesh.indices.length / 3;
  const positions = new Float32Array(count * 9);
  const normals = new Float32Array(count * 9);
  const colors = new Float32Array(count * 9);
  for (let t = 0; t < count; t += 1) {
    const colour = paint === 'clay' ? SCENERY : (colourOf.get(t) ?? SCENERY);
    for (let k = 0; k < 3; k += 1) {
      const from = (mesh.indices[t * 3 + k] ?? 0) * 3;
      const to = (t * 3 + k) * 3;
      positions.set(mesh.positions.subarray(from, from + 3), to);
      normals.set(mesh.normals.subarray(from, from + 3), to);
      colors.set(colour, to);
    }
  }
  return {
    positions,
    normals,
    colors,
    emissive: new Float32Array(count * 3),
    indices: Uint32Array.from({ length: count * 3 }, (_, i) => i),
  };
}
```

`segmentGeometry(mesh, { creaseDegrees, minimumArea })` cuts the mesh into regions with no model
at all: runs of triangles that share an edge and whose normals agree within the crease angle,
largest first. A floor, its walls and a table top are findable without knowing what any of them is.
`planeOf` and `regionOf` read a region's plane and extent.

`proposeEntities(regions)` makes each region a proposal, and the word matters: **a region nobody
labelled becomes scenery**, drawn and solid and doing nothing (`SCENERY_COMPONENTS`). The largest
surface a character could stand on gets a navigation surface (`WALKABLE_COMPONENTS`), and a named
region small enough to move is offered as movable (`MOVABLE_COMPONENTS`).

A segmentation model names regions where one is loaded. MobileSAM, SAM 2.1 with a tracker across
frames, and OWLv2's text-prompted detector are definitions like the depth models.
`liftMasks(views, mesh, labels)` votes a segmenter's masks onto the mesh across every view that saw
a triangle, leaving a triangle no view claimed unassigned, `promptGrid` seeds the lattice of points
it is prompted on, and `labelMasks` puts a detector's names to the masks by how far each box and
mask agree; a mask that agrees with nothing stays unnamed, and unnamed is scenery.

**Maturity.** It proposes and does not decide. Every region arrives undecided, a person accepts or
rejects each in the editor, and the file records decisions, not guesses. A real room gave eight
proposals and a tabletop one.

## One file

`captureFile(scene)` writes every stage as one `.drft`: the mesh, its materials and decode program,
the cloud, a prop's hulls, the way across the scene and the proposals. The proposals travel under a
component this package declares, `PROPOSAL_COMPONENT`, so a capture proposes in its own words and an
editor decides what a scene ends up holding. `proposalScene` builds that scene and `readProposals`
reads it back.
