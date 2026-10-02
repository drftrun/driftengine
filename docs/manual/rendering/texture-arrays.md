---
title: Texture arrays and surface effects
description: Many images as one texture, chosen per vertex, so a merged mesh of many materials is one draw, with lit windows, rooms, wear and rain.
packages: ['@driftengine/core']
covers: ['Texture arrays', 'Surface effects']
---

# Texture arrays and surface effects

A material binds one albedo, so a mesh that wears forty different facades would normally be forty
meshes, forty draws and forty material changes. A texture array holds many images of one size as a
single texture, and each vertex names the layer its face wears. One merged mesh, one draw, one
material change.

## Building an array

```ts sample=snippets/texture-arrays.ts#array
/**
 * Three images of one size: a facade whose windows are holes in its alpha, a sign, and the room a
 * window looks into. Each layer's effects are given beside it; a layer with none is `undefined`.
 */
export function facadeArray(renderer: RendererApi, images: readonly HTMLImageElement[]) {
  return renderer.createSurfaceTextureArray(images, {
    colorSpace: 'srgb',
    effects: [
      {
        windows: { cells: [6, 12], glass: true, glow: 1.2, seed: 3 },
        interior: { roomLayer: 2, depth: 0.5, lit: 0.7 },
        wear: { grime: 0.35, streaks: 0.25, fade: 120 },
      },
      { animation: { scroll: [0.15, 0], pulse: [0.5, 0.3] } },
      undefined,
    ],
  });
}
```

`createSurfaceTextureArray` returns the same kind of handle a single image does; every surface
texture is an array, and a plain image is an array of one. So an array goes wherever a texture goes,
into any map of a material, and every map of the material is read at the vertex's layer. An albedo
array and an emissive array built in the same order pair each image with its glow by index.

Every layer shares one size, because the device allocates one size for all of them. A small sign in
an array of large facades pays for the large size.

## Choosing a layer per vertex

```ts sample=snippets/texture-arrays.ts#layers
/**
 * A builder has no layer channel, so each piece is built, given its layer, then joined. Rooms behind
 * windows are drawn through the mesh's tangent frame, so the pieces get tangents as well.
 */
function onLayer(mesh: MeshData, layer: number): MeshData {
  const uvs = mesh.uvs ?? new Float32Array((mesh.positions.length / 3) * 2);
  return {
    ...mesh,
    tangents: generateTangents(mesh.positions, mesh.normals, uvs, mesh.indices),
    layers: new Float32Array(mesh.positions.length / 3).fill(layer),
  };
}

export function building(): MeshData {
  const tower = new MeshBuilder()
    .addBox([0, 20, 0], [8, 20, 8], [1, 1, 1])
    .build({ planarUvs: true });
  const sign = new MeshBuilder()
    .addQuad([-4, 3, 8.05], [4, 3, 8.05], [4, 5, 8.05], [-4, 5, 8.05], [1, 1, 1], 1)
    .build({ planarUvs: true });
  return concatMeshes([onLayer(tower, 0), onLayer(sign, 1)]);
}
```

`MeshData.layers` is one whole number per vertex, 0 for the first image. `MeshBuilder` has no layer
channel, and merging a layered mesh into a builder is refused instead of silently putting every face
on layer 0, so build each piece, give it its layer, and join them with `concatMeshes`. A facade with
rooms behind its windows also needs a tangent frame, which `generateTangents` supplies; without one,
the windows still light but the rooms are not drawn.

The `.drft` container carries layers, so a baked model keeps them.

## What a layer can do

Each layer may carry an effect, given in `effects` when the array is built. A layer with no effect
draws exactly as an image would.

**Windows.** `windows.cells` divides one repeat of the layer into a grid of windows. With `glass`,
the albedo's alpha says where the glass is: 0 is a window, 1 is wall. A window can glow, by
`glow` and `colour`; a vertex that names an emissive colour overrides it, so many buildings sharing
one layer each keep their own window light. `seed` varies which windows do what between facades.

**Rooms behind windows.** `interior` draws a room seen in parallax behind each window, from another
layer of the same array: one image of a room in one-point perspective. `depth` is how deep the room
is, and `lit` the share of rooms with a light on.

**Wear.** `wear` adds procedural dust, grime and rain streaks, each 0 to 1, fading out past `fade`
metres so a distant facade stays clean.

**Animation.** `animation` scrolls the layer, pulses or flickers its emission, or plays successive
layers as a flipbook, on the caller's clock.

**Staying dry.** `dry` marks a layer that rain leaves alone: a covered walkway, an indoor floor.

## The scene's half

```ts sample=snippets/texture-arrays.ts#scene
/** The scene's half: how wet it is, how many windows are lit, and the clock the animations run on. */
export const NIGHT = createEnvironment({
  directionalDir: [0.2, 0.9, 0.3],
  directionalColor: [0.2, 0.24, 0.35],
  ambient: [0.05, 0.06, 0.09],
  nightFactor: 1,
  emissiveGain: 1,
  litWindows: 0.45,
  lateWindows: 0.08,
  wetness: 0.3,
  surfaceTime: 0,
});
```

The environment carries the values effects read across the whole scene:

- `litWindows`, the share of windows lit, which a scene sets from its time of day. Windows switch on
  one at a time, by a hash per window, so a rising share lights more windows instead of brightening
  the ones already lit.
- `lateWindows`, the share that stays lit however late it gets.
- `wetness`, from 0 to 1: upward surfaces darken and polish, except layers marked `dry`.
- `surfaceTime`, the clock animations run on. It is yours, so a paused or replayed game holds every
  sign still or replays it exactly.

Window light comes from the window effect itself, not from the emissive term, so it does not wait
for the environment's `nightFactor`.

## Cost

A scene that names no effect draws exactly what it drew before. The effects table is one small
texture beside the array, bound whenever the array is a material's albedo.
