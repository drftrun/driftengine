---
title: Terrain
description: A heightfield whose queries answer the ground that is drawn, a clipmap with matched seams, blended materials, colliders, and heights kept as textures.
packages: ['@driftengine/terrain', '@driftengine/script']
covers: ['Terrain that is GPU-driven', 'Terrain heights as a texture']
areas: ['terrain']
---

# Terrain

`@driftengine/terrain` is a heightfield and the geometry it draws, for 1.4 KB gzipped on top of
core. It imports no renderer: a patch of terrain comes back as `MeshData`, which goes to
`createMesh` like any other geometry and is drawn by the pass that already exists.

The rule the package is built around is that every question about the ground answers the surface
that is drawn. A query, the mesh, a collider and a script asking how steep a hillside is all read
the same triangles, so a character stands on the ground you can see.

The example is a river valley two kilometres across, flown over. Paint the levels to see the
clipmap, and change how many cells a patch has and how many levels reach out.

<!-- run: terrain -->

## A field

```ts sample=terrain/main.ts#field
/** Samples across each side, two metres apart: a field 2,048 metres square, centred on the origin. */
const SAMPLES = 1025;
const SPACING = 2;
const HALF = ((SAMPLES - 1) * SPACING) / 2;

/** Smooth noise on a unit lattice, from a hash of each corner. */
function lattice(x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx);
  const sz = fz * fz * (3 - 2 * fz);
  const a = hashToUnit(Math.imul(ix, 73856093) ^ Math.imul(iz, 19349663));
  const b = hashToUnit(Math.imul(ix + 1, 73856093) ^ Math.imul(iz, 19349663));
  const c = hashToUnit(Math.imul(ix, 73856093) ^ Math.imul(iz + 1, 19349663));
  const d = hashToUnit(Math.imul(ix + 1, 73856093) ^ Math.imul(iz + 1, 19349663));
  return (a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz) * 2 - 1;
}

/** Height in metres: a river winding along z, valley walls rising either side, hills over all. */
function valley(x: number, z: number): number {
  const river = Math.sin(z / 260) * 120 + Math.sin(z / 97) * 25;
  const fromRiver = Math.abs(x - river);
  const wall = Math.min(1, Math.max(0, (fromRiver - 30) / 700));
  const rise = 230 * wall * wall * (3 - 2 * wall);
  let hills = 0;
  let amplitude = 1;
  let frequency = 1 / 220;
  for (let octave = 0; octave < 4; octave += 1) {
    hills += lattice(x * frequency, z * frequency) * amplitude;
    amplitude *= 0.5;
    frequency *= 2.1;
  }
  const bed = 5 * Math.max(0, 1 - fromRiver / 22);
  return rise + hills * (4 + rise * 0.35) - bed + 3;
}

const heights = new Float32Array(SAMPLES * SAMPLES);
for (let row = 0; row < SAMPLES; row += 1)
  for (let column = 0; column < SAMPLES; column += 1)
    heights[row * SAMPLES + column] = valley(column * SPACING - HALF, row * SPACING - HALF);

const terrain = new Terrain({
  width: SAMPLES,
  depth: SAMPLES,
  spacingM: SPACING,
  heights,
  origin: [-HALF, 0, -HALF],
});
```

`new Terrain(options)` takes:

- `width` and `depth`, the samples along x and z, at least two each.
- `spacingM`, the metres between samples, the same both ways.
- `heights`, `width * depth` heights in metres, row-major with x running fastest.
- `origin`, the world position of sample `(0, 0)`. Its y is added to every height.

The field reaches `extentX` and `extentZ` metres, one cell fewer than it has samples. The heights
are copied, so a caller may reuse its array.

```ts sample=snippets/terrain.ts#field
/** A gentle slope 64 metres square, rising toward +x, with sample (0, 0) at the origin. */
const SIDE = 65;
const heights = new Float32Array(SIDE * SIDE);
for (let row = 0; row < SIDE; row += 1)
  for (let column = 0; column < SIDE; column += 1)
    heights[row * SIDE + column] = column * 0.1 + Math.sin(row * 0.3) * 0.5;
export const field = new Terrain({ width: SIDE, depth: SIDE, spacingM: 1, heights });

/** How high the ground is, and which way it faces, at a place on it. */
export const groundY = field.heightAt(10.5, 20.25);
export const up = field.normalAt(10.5, 20.25, new Float32Array(3));
```

`heightAt(x, z)` is the height of the drawn surface at a world position. A cell is drawn as two
triangles, and the query reads the triangle under the point. Interpolating the four corners
bilinearly would describe a different surface, one that floats over half of every cell and sinks
into the other half. Outside the field the query answers the nearest edge.

`normalAt(x, z, out)` is a central difference over the samples, so it is continuous across every
cell and every patch boundary. It is what the mesh carries as its vertex normals; a face normal
would jump at every edge, and two patches would shade differently along the edge they share. To
find the plane a wheel rests on, take three `heightAt` samples.

## Patches and levels of detail

`heightfieldPatch(terrain, options)` builds one square of the field as `MeshData`:

- `x` and `z`, the grid index of the patch's first sample.
- `cells`, how many field cells it spans.
- `step`, how many field cells one drawn cell spans: 1 is full detail, 4 a quarter. It must divide
  `cells`.
- `neighbours`, the step of each neighbour that is coarser than this patch, as `minusX`, `plusX`,
  `minusZ` and `plusZ`.
- `color` and `emissive` for one colour over the whole patch, or `materials` for several blended
  across the field.

```ts sample=snippets/terrain.ts#seam
/** A full-detail patch whose +x neighbour is drawn at a quarter of the detail. */
export const fine = heightfieldPatch(field, {
  x: 0,
  z: 0,
  cells: 32,
  step: 1,
  neighbours: { plusX: 4 },
});
export const coarse = heightfieldPatch(field, { x: 32, z: 0, cells: 32, step: 4 });
```

Where a fine patch meets a coarse one, the fine edge has vertices the coarse edge does not, and
they sit on the field while the coarse edge cuts a straight chord beneath them. The gap between the
two is a crack through to the sky. Naming the coarser neighbour moves the fine edge's extra vertices
onto that chord, so the two edges are one polyline and there is nothing to fill. Only the coarser
side is named, because the finer patch is the one that moves; a neighbour at the same step or a
finer one changes nothing, so pass what you know.

Matching has a cost, stated so it is not discovered later: along a matched edge the drawn surface
is the coarse chord, so `heightAt` and the picture differ there by up to the sag of one coarse cell.
That is the error the coarse patch carries over its whole area anyway, arriving one cell early.

## The clipmap

```ts sample=terrain/main.ts#clipmap
/** The ground the camera is over, as one mesh rebuilt only when a level's block moves. */
let groundMesh: MeshHandle | null = null;
let shown: ClipmapFrame | null = null;
let shownPatchX = Number.NaN;
let shownPatchZ = Number.NaN;

/** One selected patch, painted by its level or by the ground's materials. */
function patchFor(options: HeightfieldPatchOptions, level: number): HeightfieldPatchOptions {
  return paint === 'levels'
    ? { ...options, color: LEVEL_COLOURS[level] ?? [1, 1, 1] }
    : { ...options, materials };
}

function chooseGround(cameraX: number, cameraZ: number): void {
  /* A block snaps to whole patches, so nothing can move until the camera crosses one. */
  const patchX = Math.floor(cameraX / (cells * SPACING));
  const patchZ = Math.floor(cameraZ / (cells * SPACING));
  if (!stale && patchX === shownPatchX && patchZ === shownPatchZ) return;
  shownPatchX = patchX;
  shownPatchZ = patchZ;

  const frame = clipmapFrame(terrain, cameraX, cameraZ, { levels, patchCells: cells });
  const moved = shown === null || frame.origins.some((origin, i) => origin !== shown?.origins[i]);
  if (!stale && !moved) return;
  shown = frame;
  stale = false;

  const patches = selectClipmap(frame).map((patch) =>
    heightfieldPatch(terrain, patchFor(clipmapPatchOptions(patch), patch.level)),
  );
  const next = renderer.createMesh(concatMeshes(patches));
  if (groundMesh !== null) renderer.disposeMesh(groundMesh);
  groundMesh = next;
}
```

A clipmap draws the field as rings of patches whose step doubles outward, so the ground under the
camera is drawn at full detail and the horizon at a fraction of it, and the vertex count stays the
same however large the world is.

- `clipmapFrame(terrain, cameraX, cameraZ, options)` snaps each level's block to the camera once
  for a frame. The options are `levels` (4 by default), `patchCells`, the drawn cells along a
  patch's edge (8), and `patchesAcross`, the patches along a block's edge (8, and a multiple of
  four).
- `selectClipmap(frame)` lists every patch to draw, each with its level, position, `cells`, `step`
  and `neighbours`.
- `clipmapPatchOptions(patch)` turns one into the options `heightfieldPatch` takes, with nothing
  added or renamed.

The outermost block spans `patchesAcross × patchCells × 2^(levels − 1)` field cells: 512 with the
defaults, which is a kilometre across at two metres a cell. That is what the switches change.

Two failures decide the design. A field cell drawn by two patches is z-fighting on the ground, and
one drawn by none is a hole. Each level's block snaps to an even patch index, which makes a finer
block's edge fall on a coarser patch boundary, so a coarse patch is either covered by the level
inside it or not at all, and is culled when it is covered. The finer block is therefore not always
centred in the coarser one, and that is harmless. The tests count every cell of the footprint at
thirty-three camera positions across a coarse patch and find each one drawn exactly once.

The clipmap builds no geometry and the blocks only move when the camera crosses a patch, which is
why the example compares the frame's `origins` with the last one before rebuilding anything.

### The selection, one patch at a time

`clipmapPatchAt(frame, index, out)` decides one patch by its index and writes it into `out`, which
`emptyClipmapPatch()` makes once so a loop allocates nothing. It returns whether that patch is
drawn. `clipmapPatchCount(frame)` is how many indices there are, and `clipmapLevelAt(frame, cellX,
cellZ)` says which level draws a field cell, or `-1`.

The decision reads the frame and the index and nothing else. A `ClipmapFrame` is an `Int32Array`
of origins and four numbers, which a uniform block can hold, so the selection is the body of a
compute shader: it is written to move into a compute pass beside the [GPU-driven](../rendering/gpu-driven.md)
cluster cut without being rewritten. Today it runs on the CPU, and the test that asks for the
patches in a scrambled order is what keeps it free of any loop-carried state.

## Materials across the field

```ts sample=terrain/main.ts#paint
/** Grass, rock and snow, weighted across the field by what the script says each place is. */
const WEIGHTS_ACROSS = 513;
const GRASS: Vec3 = [0.25, 0.38, 0.16];
const ROCK: Vec3 = [0.4, 0.38, 0.35];
const SNOW: Vec3 = [0.86, 0.88, 0.92];

function paintGround(): TerrainMaterials {
  const rockiness = exported<Rule<number>>(ground, 'rockiness');
  const snowiness = exported<Rule<number>>(ground, 'snowiness');
  const weights = new Float32Array(WEIGHTS_ACROSS * WEIGHTS_ACROSS * 3);
  const step = (2 * HALF) / (WEIGHTS_ACROSS - 1);
  for (let row = 0; row < WEIGHTS_ACROSS; row += 1) {
    for (let column = 0; column < WEIGHTS_ACROSS; column += 1) {
      const x = column * step - HALF;
      const z = row * step - HALF;
      const rock = rockiness(terrain, x, z);
      const snow = snowiness(terrain, x, z);
      const at = (row * WEIGHTS_ACROSS + column) * 3;
      weights[at] = Math.max(0, 1 - rock - snow);
      weights[at + 1] = rock;
      weights[at + 2] = snow;
    }
  }
  return new TerrainMaterials({
    materials: [{ color: GRASS }, { color: ROCK, specular: 0.15 }, { color: SNOW, specular: 0.4 }],
    width: WEIGHTS_ACROSS,
    depth: WEIGHTS_ACROSS,
    weights,
  });
}
```

`new TerrainMaterials({ materials, width, depth, weights })` blends several materials across the
field. Each material has a `color`, and optionally `emissive` and `specular`. The weight map is
`width * depth * materials.length` numbers, row-major with the material running fastest, at any
resolution: the example paints a 2,048-metre field from a 513-square map.

The blend is baked into vertex colour when the patch is built, so it costs nothing per frame and
binds no texture. The price is that it is only as sharp as the mesh: a boundary inside a cell is a
gradient across that cell, and a coarse patch blends as coarsely as it is drawn. Draw a patch at
full detail where a line must be sharp.

Weights are read bilinearly, unlike heights. A weight decides a vertex colour and is not drawn as
triangles, so reading it as triangles would only put a crease along every cell diagonal. Weights
are normalised as they are read, and a place where every weight is zero takes the first material,
so an unpainted corner of a map is never black. `terrainMaterialWeights(map, u, v, out)` returns
the normalised weights at a point given in the field's own `0..1` extent.

## From DriftScript

`drift/terrain` gives a script the same answers:

| Capability                      | Answers                                   |
| ------------------------------- | ----------------------------------------- |
| `heightAt(terrain, x, z)`       | How high the drawn ground is, in metres.  |
| `normalX`, `normalY`, `normalZ` | Which way it faces, one component a call. |
| `slopeAt(terrain, x, z)`        | How steep it is, in radians from flat.    |
| `covers(terrain, x, z)`         | Whether a place is over the field at all. |
| `extentX(terrain)`, `extentZ`   | How far the field reaches, in metres.     |

Every one is a read of static data and deterministic, so a `@deterministic` system may ask where
the ground is. The module needs no host service: the field reaches a script as a `Terrain`
argument, the way a navigation graph does.

The example's rules are a DriftScript module. Rock, snow and trees each ask the slope and the
height:

```drs sample=terrain/ground.drs#paint
// How much of the ground at a place is bare rock, 0 to 1: none below a slope of 0.45 radians
// (about 26 degrees), all of it from 0.7.
fn rockiness(ground: Terrain, x: f32, z: f32) -> f32 {
    return math.clamp((terrain.slopeAt(ground, x, z) - 0.45) / 0.25, 0, 1)
}

// How much is snow: it lies above 140 metres, fully by 170, and slides off the steepest faces.
fn snowiness(ground: Terrain, x: f32, z: f32) -> f32 {
    let high = math.clamp((terrain.heightAt(ground, x, z) - 140) / 30, 0, 1)
    return high * (1 - rockiness(ground, x, z) * 0.8)
}

// Whether a tree can grow here: on gentle ground, above the river and below the tree line.
fn grows(ground: Terrain, x: f32, z: f32) -> bool {
    let height = terrain.heightAt(ground, x, z)
    return terrain.slopeAt(ground, x, z) < 0.35 && height > 6 && height < 115
}
```

and the camera holds its height above the ground ahead of it as well as beneath it:

```drs sample=terrain/ground.drs#glide
// One frame of flight round the valley. The camera holds its height above the ground ahead of it as
// well as the ground beneath, so it climbs before a ridge arrives instead of on it.
fn glide(flight: mut Flight, ground: Terrain, dt: f32) {
    flight.angle = flight.angle + dt * 0.045
    let radius = 300
    flight.x = math.cos(flight.angle) * radius
    flight.z = math.sin(flight.angle) * radius
    let aheadX = math.cos(flight.angle + 0.25) * radius
    let aheadZ = math.sin(flight.angle + 0.25) * radius
    let floor = math.max(terrain.heightAt(ground, flight.x, flight.z),
                         terrain.heightAt(ground, aheadX, aheadZ))
    let wanted = floor + 45
    // Ease toward it, so the flight rises and settles instead of following every bump.
    flight.y = flight.y + (wanted - flight.y) * math.clamp(dt * 0.6, 0, 1)
    // Look further along the loop, at the ground there.
    flight.lookX = math.cos(flight.angle + 0.6) * radius
    flight.lookZ = math.sin(flight.angle + 0.6) * radius
    flight.lookY = terrain.heightAt(ground, flight.lookX, flight.lookZ)
}
```

The page hosts the module and calls those rules, and when the file changes under `npm run
examples` it repaints the ground and replants the forest with the new rules while the flight
carries on:

```ts sample=terrain/main.ts#script
/** The valley's rules, hosted. The flight is a record the page holds, so an edit keeps it flying. */
const ground = hostScript(groundScript);
interface Flight {
  angle: number;
  x: number;
  y: number;
  z: number;
  lookX: number;
  lookY: number;
  lookZ: number;
}
const flight = exported<() => Flight>(ground, 'createFlight')();
type Rule<T> = (field: Terrain, x: number, z: number) => T;
type Glide = (flight: Flight, field: Terrain, dt: number) => void;
```

## Colliding with it

```ts sample=snippets/terrain.ts#collide
/** The field as a collider: one static body holding the heights, and a ball dropped onto it. */
export const world = new PhysicsWorld();
world.addBody({ type: BODY_STATIC, shape: heightfieldShape(field), friction: 0.8 });
export const ball = world.addBody({
  type: BODY_DYNAMIC,
  shape: sphereShape(0.5),
  x: 20,
  y: field.heightAt(20, 20) + 3,
  z: 20,
});

/** Or the patch that is drawn, chords and all, so a coarse patch collides as coarse as it looks. */
export const drawnWorld = new PhysicsWorld();
drawnWorld.addBody({ type: BODY_STATIC, shape: meshShape(coarse.positions, coarse.indices) });
```

A `Terrain` is a `Heightfield` to `@driftengine/physics`, with the same names and meanings, so
`heightfieldShape(terrain)` makes a collider straight from it. That collider holds the heights it
was handed and finds the cell under a body from its x and z, with no vertex buffer and no tree; at a
129-square field a mesh collider's positions and indices alone are more than five times the bytes
of the heights. Contacts against it are the same as against the triangles, and a test walks a box
across both and compares every normal, count and separation.

`meshShape(patch.positions, patch.indices)` takes the arrays a patch hands back, so the geometry you
draw is the geometry you collide with. Use it when the collider must be the patch as drawn: a
coarse patch then collides as coarsely as it looks. Use the heightfield when the field is the truth
and patches are only how it is drawn, which is the usual case for a large world. The world those
colliders live in, its bodies and its step, is [Rigid bodies](../simulation/rigid-bodies.md).

## Heights kept as a texture

```ts sample=snippets/terrain.ts#layer
/** The heights as a texture layer, and the terrain everything should read, built from it. */
const layer = encodeTerrainHeights(field);
export const stored = terrainFromHeightLayer(layer);
/** How far a decoded height may sit from the source: half a 16-bit step of the field's range. */
export const tolerance = terrainHeightTolerance(layer);
```

`encodeTerrainHeights(terrain)` stores a field as a `DTEX` layer from `@driftengine/texture`: a
decode program over a 16-bit latent image (`TERRAIN_HEIGHT_LEVELS`, 65,536 levels) and the
field's own range in metres, its spacing and its origin. Terrain then has the texture format's
residency, streaming and determinism without an image path of its own. The range is the field's
own because a shallow valley quantised against a whole world's range would be drawn as a
staircase.

Build the terrain everything reads with `terrainFromHeightLayer(layer)`. It decodes the samples
and builds a `Terrain` from the decoded numbers, so the query, the mesh and the collider all read
one set of heights. A renderer reading the layer while collision reads the source heights would
disagree by the format's tolerance everywhere, which shows up as a character floating a fraction of
a millimetre above every surface. `terrainHeightTolerance(layer)` is that tolerance: half a
quantisation step plus one float32 step of the range. `decodeTerrainHeights(layer, out)` decodes
into an array of your own.

```ts sample=snippets/terrain.ts#splat
/** Four materials per sample, summing to one: grass that turns to rock up the slope. */
const weights = new Float32Array(SIDE * SIDE * TERRAIN_SPLAT_CHANNELS);
for (let at = 0; at < SIDE * SIDE; at += 1) {
  const rock = (at % SIDE) / (SIDE - 1);
  weights[at * TERRAIN_SPLAT_CHANNELS] = 1 - rock;
  weights[at * TERRAIN_SPLAT_CHANNELS + 1] = rock;
}
const splat = encodeTerrainSplat(SIDE, SIDE, weights);
/** The four weights halfway across, renormalised so they sum to one again. */
export const blend = new Float32Array(TERRAIN_SPLAT_CHANNELS);
decodeTerrainSplat(splat, 0.5, 0.5, blend);
```

`encodeTerrainSplat(width, depth, weights)` stores four material weights a sample
(`TERRAIN_SPLAT_CHANNELS`) at eight bits each (`TERRAIN_SPLAT_LEVELS`). It refuses weights that do
not sum to one, because a map nobody filled in would otherwise ship as one material everywhere.
`decodeTerrainSplat(layer, u, v, out)` samples them and renormalises, since four weights rounded to
eight bits sum to anywhere from 0.994 to 1.006, and a shader that trusts the sum shades a hillside
slightly wrong.

None of this is imported unless named, so a game that never stores its terrain as a texture pays
nothing for `@driftengine/texture`.
