---
title: Meshes and geometry
description: Build geometry in code with MeshBuilder or from raw arrays, upload it, rewrite it every frame, and stream big meshes in pieces.
packages: ['@driftengine/core']
covers: ['Streaming']
areas: ['geometry']
---

# Meshes and geometry

A mesh is vertex data on the GPU. You describe it as `MeshData`, plain typed arrays, hand it to
`renderer.createMesh`, and get back a handle you draw with a world matrix as many times a frame as
you like. Colour is a vertex attribute, so most meshes need no texture at all.

## Building from shapes

```ts sample=snippets/meshes.ts#builder
/** A lamp post: every shape added to one builder becomes one mesh and one draw. */
export function lampPost(): MeshData {
  return (
    new MeshBuilder()
      .addBox([0, 0.1, 0], [0.4, 0.1, 0.4], [0.3, 0.3, 0.32])
      .addCylinder([0, 2, 0], 0.08, 1.9, 'y', [0.22, 0.23, 0.25], 0, 10)
      .addOrientedBox([0.35, 3.85, 0], [0.4, 0.05, 0.06], [1, 0, 0], [0.22, 0.23, 0.25])
      // The fourth argument is emissive: this glows, where the environment lets emissive through.
      .addSphere([0.7, 3.7, 0], 0.16, [1, 0.85, 0.6], 2.5)
      .build()
  );
}
```

`MeshBuilder` collects shapes into one mesh. Everything added to one builder is one mesh and one
draw, which is how a whole grey-box level becomes a single draw call. The shapes:

| Method                         | What it adds                                                                 |
| ------------------------------ | ---------------------------------------------------------------------------- |
| `addBox`                       | An axis-aligned box, from a centre and **half** extents                      |
| `addOrientedBox`               | A box turned to lie along a direction                                        |
| `addQuad`                      | A flat quad; its normal follows the corner order                             |
| `addGroundQuad`, `addWallQuad` | A quad that faces up, or away from a point, whatever the corner order        |
| `addSphere`, `addCapsule`      | Round solids; a capsule stands along Y                                       |
| `addCylinder`                  | A faceted cylinder along X, Y or Z                                           |
| `addTube`                      | A round tube of varying radius swept along a path                            |
| `addBlob`                      | An irregular solid: a sphere whose radius and colour are asked for per point |
| `addMesh`, `addOrientedMesh`   | Another mesh merged in, placed, scaled or turned                             |

Most take a colour, then optional `emissive` and `specular`. Builder state applies to what is added
after it: `setRoughness`, `setGrain` (mineral texture, 0 to 1), `setRelief` (microscopic bumps),
`setEmissiveColor`, and `setJoint`, which binds geometry to one bone of a skeleton.
`build({ planarUvs: true })` also emits box-projected texture coordinates in metres, for a material
that tiles across the world.

For solids with holes, bevels and booleans, see [Procedural solids](../worlds/procedural-solids.md).

## Writing the data yourself

```ts sample=snippets/meshes.ts#raw
/** A single triangle from raw arrays: every attribute covers every vertex. */
export function triangle(): MeshData {
  const data: MeshData = {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    colors: new Float32Array([1, 0.2, 0.2, 0.2, 1, 0.2, 0.2, 0.2, 1]),
    emissive: new Float32Array([0, 0, 0]),
    indices: new Uint32Array([0, 1, 2]),
  };
  validateMeshData(data); // throws, naming the attribute, if anything does not line up
  return data;
}
```

`positions`, `normals` and `colors` are three floats a vertex, `emissive` one, and `indices` three a
triangle. Everything else is optional and named for what it does:

- `specular` and `roughness`, one float each: how strongly a surface takes a highlight, and its
  shape.
- `uvs` and `tangents`: texture coordinates, and the tangent frame normal maps need.
  `generateTangents` derives the second from the first.
- `emissiveColor`: the colour a vertex emits, independent of its albedo.
- `grain` and `relief`: procedural surface detail, so a stone wall looks like stone up close without
  a texture.
- `layers`: which image of a texture array each face wears.
- `channel`: four lanes for wind sway, a sky factor, per-vertex alpha and glass thickness.
- `joints` and `weights` for skinning, four bones a vertex, and `joints2` and `weights2` for the
  next four where a vertex follows up to eight — the imported models that carry them keep all
  eight, heaviest first, and a mesh without the second four draws exactly as it did.
  `morphTargets` for blend shapes.

`validateMeshData` checks that every attribute covers every vertex and every index names one that
exists, and throws naming what is wrong. Mesh data is the same type the `.drft` container stores, so
a model you import and a mesh you build are interchangeable.

## Drawing

`renderer.drawMesh(mesh, model)` draws a mesh with a model matrix, usually a `SceneNode`'s
`worldMatrix`, between `bindMeshPass` and `endFrame`. Two optional arguments follow: a depth layer,
and a **tint**, a colour multiplied into the mesh for that one draw and reset after it. A tint is how
one white mesh becomes four rows of different-coloured bricks without four meshes.

`mesh.bounds` is measured at upload, ready for culling and level of detail.
`renderer.disposeMesh(mesh)` frees it.

## Rewriting a mesh every frame

```ts sample=snippets/meshes.ts#dynamic
/** A flag whose vertices move every frame: created dynamic once, rewritten in place. */
export function waveFlag(renderer: RendererApi) {
  const data = new MeshBuilder()
    .addQuad([0, 0, 0], [2, 0, 0], [2, 1, 0], [0, 1, 0], [0.8, 0.2, 0.2])
    .build();
  const mesh = renderer.createMesh(data, { dynamic: true });
  const positions = new Float32Array(data.positions);
  return (time: number) => {
    for (let i = 0; i < positions.length; i += 3) {
      positions[i + 2] = Math.sin(time * 3 + data.positions[i] * 2) * 0.15 * data.positions[i];
    }
    renderer.updateMesh(mesh, positions);
    return mesh;
  };
}
```

A mesh is immutable unless it was created `dynamic`. A dynamic one takes new positions, and normals
if you have them, through `updateMesh`, without a new GPU buffer per frame, and only those two are
uploaded: the colours, texture coordinates and the rest stay where they are. The vertex count is
fixed for its life. Cloth hanging in the world is drawn this way; cloth on a character is placed in
the vertex stage instead, see [Ragdolls and cloth](../simulation/ragdolls-and-cloth.md).

## Uploading a large mesh across frames

```ts sample=snippets/meshes.ts#incremental
/** A large mesh uploaded over several frames, never more than two milliseconds of each. */
const budget = new StepBudget();
let pending: IncrementalMeshHandle | null = null;

export function startUpload(renderer: RendererApi, data: MeshData): void {
  pending = renderer.createMeshIncremental(data);
}

/** Call once a frame. The mesh may be held and measured at once, and drawn once `complete`. */
export function continueUpload(): void {
  if (pending === null) return;
  const upload = pending.upload;
  budget.spend(2, () => (upload.next().done === true ? null : 'mesh'));
  if (pending.mesh.complete) pending = null;
}
```

Creating a mesh copies all of it to the GPU at once, and a large one can take longer than a frame.
`createMeshIncremental` returns a handle at once, which can be held and measured but not drawn, and
an iterator that advances the upload in bounded steps. `StepBudget` spends a slice of each frame on
it and reports its worst single step, so a streamed world never drops a frame to an upload.
`mesh.complete` says when it has all arrived.

## Performance

- Merge static geometry. One mesh drawn once beats a hundred drawn once each.
- Repeat a mesh many times with [instancing](instancing.md), not with a loop of `drawMesh` calls,
  when the copies differ only in their transforms.
- Build in loading, never in the frame. `createMesh` allocates GPU memory.
