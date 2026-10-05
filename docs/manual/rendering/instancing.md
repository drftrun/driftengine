---
title: Instancing
description: Thousands of copies of one mesh in one call, batches and single instances culled, instances moved every frame, and foliage in the wind.
packages: ['@driftengine/core']
covers: ['Instancing that culls', 'Draws']
---

# Instancing

Drawing a mesh a thousand times with `drawMesh` costs a thousand draws and, if the material changes
between them, a thousand material changes. An instanced batch draws every copy in one call, with one
material, from an array of model matrices and tints.

<!-- run: instancing -->

## A batch

```ts sample=instancing/main.ts#rocks
/** A lumpy rock: a sphere whose radius varies by a hash of where on it you are. */
const rock = renderer.createMesh(
  new MeshBuilder()
    .addBlob(
      [0, 0.35, 0],
      (u, v) => 0.5 + hashToUnit(Math.floor(u * 7) * 31 + Math.floor(v * 5)) * 0.18,
      [0.55, 0.52, 0.48],
    )
    .build(),
);

const REGIONS = 4;
const PER_REGION = 625;
const SPAN = 120;
const random = mulberry32(7);

/** One batch per region, so a region out of view is skipped in one test. */
const fields: { batch: InstancedHandle; data: MeshInstances }[] = [];
for (let rx = 0; rx < REGIONS; rx += 1) {
  for (let rz = 0; rz < REGIONS; rz += 1) {
    const data = createMeshInstances(PER_REGION);
    for (let i = 0; i < PER_REGION; i += 1) {
      const x = (rx + random()) * (SPAN / REGIONS) - SPAN / 2;
      const z = (rz + random()) * (SPAN / REGIONS) - SPAN / 2;
      place(data.models, i, x, 0, z, random() * Math.PI * 2, 0.2 + random() * 0.8);
      const shade = 0.42 + random() * 0.3;
      data.tints.set([shade, shade * (0.95 + random() * 0.1), shade * 0.95], i * 3);
    }
    data.count = PER_REGION;
    const batch = renderer.createInstanced(rock, PER_REGION, { cull: true });
    renderer.uploadInstanced(batch, data);
    fields.push({ batch, data });
  }
}
```

`createMeshInstances(capacity)` allocates the per-instance arrays once: `models`, sixteen floats per
instance, and `tints`, three, multiplied into the mesh's colour as a `drawMesh` tint is. `count` says
how many are live. `createInstanced(mesh, capacity, options)` attaches a batch to a mesh you already
uploaded, so a model with tens of thousands of triangles is not copied again. `uploadInstanced` sends
the arrays to the device.

```ts sample=instancing/main.ts#matrix
/** Write a model matrix that scales, turns about Y and moves, into slot `i` of a batch. */
function place(
  out: Float32Array,
  i: number,
  x: number,
  y: number,
  z: number,
  yaw: number,
  s: number,
): void {
  const o = i * 16;
  const c = Math.cos(yaw) * s;
  const n = Math.sin(yaw) * s;
  out[o] = c;
  out[o + 1] = 0;
  out[o + 2] = -n;
  out[o + 3] = 0;
  out[o + 4] = 0;
  out[o + 5] = s;
  out[o + 6] = 0;
  out[o + 7] = 0;
  out[o + 8] = n;
  out[o + 9] = 0;
  out[o + 10] = c;
  out[o + 11] = 0;
  out[o + 12] = x;
  out[o + 13] = y;
  out[o + 14] = z;
  out[o + 15] = 1;
}
```

A model matrix is sixteen floats, column-major. This helper writes one that scales, turns about Y
and translates, which is most of what scattered props need.

## Culling a batch

`{ cull: true }` tests the whole batch first, its enclosing box against the view and against any
declared occluders, and skips it in one test when it is out of sight. Then it tests each instance
by its bounding sphere. On WebGL2 the survivors are compacted on the CPU; on WebGPU a compute pass
writes an indirect draw, and the two are held to the same result.

**One batch per region**, as in the example, is what makes the first test pay: a region behind the
camera costs one box test for all of its rocks. A mesh may have as many batches as you have regions.

Compaction does not keep instance order. That is invisible for opaque geometry, and it is why blended
batches are not culled on the GPU.

## Moving instances

```ts sample=instancing/main.ts#crystals
/** Crystals circling the middle: the same batch, rewritten in place every frame. */
const CRYSTALS = 240;
const crystal = renderer.createMesh(
  new MeshBuilder().addCylinder([0, 0.6, 0], 0.18, 0.6, 'y', [0.55, 0.85, 1], 1.2, 6).build(),
);
const ring = createMeshInstances(CRYSTALS);
ring.count = CRYSTALS;
for (let i = 0; i < CRYSTALS; i += 1) ring.tints.set([1, 1, 1], i * 3);
const ringBatch = renderer.createInstanced(crystal, CRYSTALS);

function moveCrystals(time: number): void {
  for (let i = 0; i < CRYSTALS; i += 1) {
    const a = (i / CRYSTALS) * Math.PI * 2 + time * 0.2;
    const r = 14 + Math.sin(i * 1.7 + time) * 2;
    place(
      ring.models,
      i,
      Math.cos(a) * r,
      1 + Math.sin(time * 1.5 + i) * 0.8,
      Math.sin(a) * r,
      time + i,
      1,
    );
  }
  renderer.uploadInstanced(ringBatch, ring);
}
```

A batch whose instances move is rewritten in place and uploaded every frame. Nothing is allocated,
because the arrays were sized at creation and only `count` instances are written.

## Drawing

```ts sample=instancing/main.ts#draw
render() {
  camera.position[0] = Math.sin(time * 0.05) * 40;
  camera.position[1] = 9;
  camera.position[2] = Math.cos(time * 0.05) * 40;
  camera.lookAt(0, 1, 0);
  moveCrystals(time);

  renderer.beginFrame([0.6, 0.66, 0.74]);
  renderer.bindMeshPass(camera, ENV);
  renderer.drawMesh(ground, still.worldMatrix);
  for (let i = 0; i < fields.length; i += 1)
    renderer.drawInstanced(fields[i].batch, fields[i].data);
  renderer.drawInstanced(ringBatch, ring);
  renderer.endFrame();
},
```

`drawInstanced` draws with whatever material is set, exactly as `drawMesh` does, and spends one slot
of the frame's material ring for the whole batch. `drawTranslucentInstanced` is the blended twin, for
glass and other see-through instances; see [Translucent and additive meshes](translucency.md).

### Each instance its own opacity

```ts sample=snippets/instancing.ts#opacity
/** Panes pulsing out of step: an opacity an instance, uploaded with the rest of the batch. */
export function fadingPanes(
  renderer: RendererApi,
  batch: InstancedHandle,
  panes: MeshInstances,
  time: number,
): void {
  const alphas = panes.alphas;
  if (alphas !== undefined) {
    for (let i = 0; i < panes.count; i += 1) alphas[i] = 0.5 + 0.5 * Math.sin(time + i);
  }
  renderer.uploadInstanced(batch, panes);
  renderer.drawTranslucentInstanced(batch, panes, 1);
}
```

`MeshInstances.alphas` holds one opacity an instance, 1 by default, which a translucent draw
multiplies into the batch's own. So particles fading at different rates, or panes at different
clarity, are one draw rather than a batch for each opacity. An opaque draw ignores it.

An instanced batch can cast shadows: the shadow caster sink accepts instanced batches as well as
meshes.

Instancing gives up skinning and morph targets on the instanced mesh, because every instance would
share one pose. An animated crowd draws each character.

## Foliage: scatter batches

`createScatter(base, data)` is a different kind of batch, for grass, flowers and small plants. It
owns its own base geometry, sways with the wind you pass to `drawScatter`, and is uploaded once at
creation, since foliage never moves. Call `uploadScatter` only for a scatter that does.

A scatter is lit by the sun and the ambient only, never by point lights: a field of grass shaded by
every lamp in the scene is a cost nobody wants. Anything a lamp must reach belongs in a mesh or an
instanced batch instead.
