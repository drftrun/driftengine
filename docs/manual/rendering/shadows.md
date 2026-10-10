---
title: Shadows
description: The sun's shadow map focused around the player, its static, peeled and moving layers, one caster list for every pass, and the quality dials.
packages: ['@driftengine/core']
---

# Shadows

The directional light, the sun or the moon, casts through one shadow map that covers a sphere
around a point you choose, usually the player. Point lights, spots and rectangles cast through their
own maps, described in [Lights](lights.md). Both read the same list of casters.

## A shadow in three calls

```ts sample=first-game/main.ts#casters
/**
 * Everything in the world, said once. The shadow pass and the colour pass both draw from this,
 * so nothing can cast a shadow without being seen, or be seen without casting one.
 */
const casters: ShadowCasters = (sink) => {
  sink.mesh(levelMesh, still.worldMatrix);
  sink.mesh(playerMesh, playerNode.worldMatrix);
  for (let i = 0; i < crateNodes.length; i += 1) sink.mesh(crateMesh, crateNodes[i].worldMatrix);
  for (let i = 0; i < orbs.length; i += 1) {
    if (!orbs[i].taken) sink.mesh(orbMesh, orbNodes[i].worldMatrix);
  }
};

const lightMatrix = new Float32Array(16);
ENV.lightViewProj = lightMatrix;
ENV.shadowStrength = 0.8;
```

A `ShadowCasters` function names everything that casts by calling the sink it is handed. It is
called once per shadow layer and once per cube face, so it allocates nothing: it closes over the
meshes and reads them. The same function draws the colour pass with `drawSceneCasters`, so nothing
can be seen without casting or cast without being seen.

```ts sample=first-game/main.ts#render
function render(alpha: number, frameDt: number): void {
  // Input is sampled here, at the edge of the simulation: a step reads what this left behind.
  touch.tick(performance.now());
  // Read here, not in simulate: while paused, simulate is not called at all.
  if (actions.consumePress('pause')) paused = !paused;
  if (!paused) clock += frameDt;
  placeEverything(alpha);
  const at = playerNode.position;
  follow(at[0], at[1], at[2], frameDt);

  // The shadow map covers 16 metres around the player, which is everything the camera sees.
  ENV.shadowDepthSpan = computeLightMatrix(
    ENV.directionalDir,
    at[0],
    at[1],
    at[2],
    16,
    renderer.shadowMapSize,
    lightMatrix,
  );
  renderer.beginShadowPass(lightMatrix, 'static');
  renderer.drawShadowCasters(casters);
  renderer.endShadowPass();

  renderer.beginFrame(SKY);
  renderer.bindMeshPass(camera, ENV);
  renderer.drawSceneCasters(casters);
  drawHud();
  renderer.endFrame();
}
```

Every frame the first game:

1. Computes the light's matrix with `computeLightMatrix(direction, x, y, z, radius, size, out)`.
   It covers a sphere of `radius` metres around the focus and returns the depth span, which the
   environment needs as `shadowDepthSpan`.
2. Draws the casters into the map between `beginShadowPass` and `endShadowPass`.
3. Binds the mesh pass with an environment whose `lightViewProj` is that matrix and whose
   `shadowStrength` is above zero.

Focusing the map on the player is what buys resolution: fitting the whole world spends most of the
map on geometry nobody is looking at. The matrix is snapped to whole texels, so edges do not swim as
the focus moves. Near the edge of the covered sphere shadows fade out instead of being cut.

Set `shadowStrength` to 0 whenever the map is not drawn, at night for instance: a stale map is
never sampled then.

## Static, peeled and moving layers

The map has three layers, drawn one at a time and read together, and each is cleared only when its
pass begins:

- `'static'`, for the world that does not move.
- `'static-peel'`, the same casters again. A single depth map keeps only the first surface the sun
  meets; the peel keeps the second. Each caster's shadow fades with its own distance from what it
  falls on, so without the peel a tall caster far above would hide the shadow of a nearer one.
- `'dynamic'`, for whatever moves.

```ts sample=snippets/shadows.ts#layers
/**
 * The still world is drawn into its layers only when the light's matrix moves, which it does in
 * whole texels; whatever moves is drawn into the dynamic layer every frame.
 */
export function sunShadows(
  renderer: RendererApi,
  env: Environment,
  still: ShadowCasters,
  moving: ShadowCasters,
): (x: number, y: number, z: number) => void {
  const matrix = new Float32Array(16);
  const drawnWith = new Float32Array(16);
  env.lightViewProj = matrix;
  env.shadowStrength = 0.85;

  return (x, y, z) => {
    env.shadowDepthSpan = computeLightMatrix(
      env.directionalDir,
      x,
      y,
      z,
      40,
      renderer.shadowMapSize,
      matrix,
    );
    if (matrix.some((value, i) => value !== drawnWith[i])) {
      renderer.beginShadowPass(matrix, 'static');
      renderer.drawShadowCasters(still);
      renderer.endShadowPass();
      renderer.beginShadowPass(matrix, 'static-peel');
      renderer.drawShadowCasters(still);
      renderer.endShadowPass();
      drawnWith.set(matrix);
    }
    renderer.beginShadowPass(matrix, 'dynamic');
    renderer.drawShadowCasters(moving);
    renderer.endShadowPass();
  };
}
```

Since the static layers keep what was drawn into them, a scene can redraw them only when the
matrix moves, and draw its movers every frame. The first game draws everything into `'static'`
every frame, which is simpler and right for a small level.

`directionalShadowDepthLayers: 1` drops the peel and its memory; the default is 2.

### The moving layer on a square of its own

The still world wants a wide square, so distant roofs keep their shadows; a character wants a tight
one, so its own shadow is sharp. Each layer can have its own. The moving layer is read through the
matrix its pass was drawn with, so draw it through a small square around what moves, and leave the
environment's `lightViewProj` the static layer's:

```ts sample=snippets/shadows.ts#moving
/**
 * Whatever moves on a square of its own, six metres around the character, so its shadow is as
 * sharp as the map allows while the still world keeps a square wide enough for distant roofs.
 */
export function tightMovers(
  renderer: RendererApi,
  env: Environment,
  moving: ShadowCasters,
  around: readonly [number, number, number],
): void {
  computeLightMatrix(
    env.directionalDir,
    around[0],
    around[1],
    around[2],
    3,
    renderer.shadowMapSize,
    movingMatrix,
  );
  renderer.beginShadowPass(movingMatrix, 'dynamic');
  renderer.drawShadowCasters(moving);
  renderer.endShadowPass();
}

const movingMatrix = new Float32Array(16);
```

Nothing else changes: a scene that draws both layers with one matrix draws exactly as it did, and the
moving layer's own matrix is compiled into the lit stage only the first time a frame draws that layer
with a different one. The tight square belongs inside the wide one, since a receiver outside the wide
square takes no sun shadow at all. On WebGL2 the moving matrix takes five fragment uniform vectors;
where a part has no room for them it is refused, said once, and the layer is read through the
environment's matrix, so draw both layers with that matrix there.

## Every kind of caster

```ts sample=snippets/shadows.ts#sink
/** One list for every kind of caster: a mesh, a cutout, a skinned figure and an instanced batch. */
export function townCasters(
  town: { house: MeshHandle; houseModel: Float32Array },
  hedge: { mesh: MeshHandle; model: Float32Array; leaves: SurfaceTextureHandle },
  hero: { mesh: MeshHandle; model: Float32Array; palette: Float32Array },
  trees: { batch: InstancedHandle; data: MeshInstances },
): ShadowCasters {
  return (sink) => {
    sink.mesh(town.house, town.houseModel);
    /* A cutout casts the leaves, not the card they are painted on. */
    sink.mesh(hedge.mesh, hedge.model, { albedo: hedge.leaves, cutout: 0.5 });
    /* The same palette the visible draw uses, or the shadow is the bind pose. */
    sink.skinnedMesh(hero.mesh, hero.model, hero.palette);
    sink.instanced?.(trees.batch, trees.data);
  };
}
```

The sink takes rigid meshes, skinned meshes with the palette the visible draw used, instanced
batches, and scatter batches with the same wind the visible draw used. A caster drawn one way and
shadowed another throws a shadow that has come loose from it: a skinned figure submitted as a plain
mesh casts its bind pose.

A material may ride along. A cutout material, one with an albedo map and a `cutout` threshold, casts
the shape its alpha leaves, so a leaf card casts a leaf. A glass material writes no depth; with
`glassShadows` on it casts coloured light instead, as [Translucent and additive
meshes](translucency.md) describes.

## Quality

| Option                         | Default  | What it does                                                                                            |
| ------------------------------ | -------- | ------------------------------------------------------------------------------------------------------- |
| `directionalShadows`           | `true`   | Whether the sun casts at all.                                                                           |
| `directionalShadowMapSize`     | 2048     | The map's side, in texels. `renderer.shadowMapSize` reports it.                                         |
| `shadowFilterTaps`             | 12       | Filter taps per shadow lookup, 4, 8 or 12, shared with point lights.                                    |
| `directionalShadowDepthLayers` | 2        | 2 keeps the peel, 1 drops it.                                                                           |
| `directionalShadowMaxDistance` | 6        | Metres of horizontal reach over which a shadow dissolves.                                               |
| `directionalShadowMaxSlope`    | 3        | How long a shadow may get, in horizontal metres per vertical metre, before shadows fade with a low sun. |
| `glassShadows`                 | `'full'` | Coloured light through glass: `'full'`, `'half'` or `'off'`.                                            |

Indoors, raise `directionalShadowMaxDistance`. Under a sun 30 degrees up, a ceiling four metres
high throws its shadow about seven metres from itself, past the default, and a room whose ceiling
shadow has dissolved is lit as if it had no roof.

There is no bias to tune. The filter follows the plane of the surface it lands on, so a grazing
surface does not stripe itself, and a small fixed tolerance keeps contact shadows attached.
