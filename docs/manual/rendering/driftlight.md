---
title: DriftLight
description: Every fixed light in a scene lights the world, near or far: the lights the frame does not shade summed into an occluded volume.
packages: ['@driftengine/core', '@driftengine/assets', '@driftengine/drft']
covers: ['Many lights', 'DriftLight at world scale']
---

# DriftLight

A frame shades a limited number of lights exactly: sixteen on the plain path, a few hundred with
clustered shading. A gallery of seven hundred candles therefore leaves every wall past the nearest
few dark, until the camera walks up to it. DriftLight sums every fixed light once into a volume of
light and direction, occluded by the scene's own walls, and the shader reads that volume wherever
the frame's exact choice does not reach. Near the camera lights are shaded exactly; past them the
summed light stands in, and a two-metre band crossfades between the two so nothing pops.

<!-- run: driftlight -->

## A field for a scene

```ts sample=driftlight/main.ts#candles
/** Three rows of candles along each wall, thirty centimetres apart. None of them casts. */
const candles: PointLightSource[] = [];
for (const side of [-1, 1])
  for (const y of [1, 1.6, 2.2])
    for (let x = -LENGTH + 2; x <= LENGTH - 2; x += 0.3)
      candles.push({
        x,
        y,
        z: side * (WIDTH - 0.4),
        r: 0.5,
        g: 0.27,
        b: 0.08,
        radius: 1.2,
        flicker: 0,
        shadowNear: 0.05,
        sourceRadius: 0.005,
        castsShadow: false,
      });
```

The lights are ordinary `PointLightSource` records. None of them casts a shadow here: seven hundred
shadow maps are not what a candle needs, and the field brings its own occlusion.

```ts sample=driftlight/main.ts#field
/** Each slab baked into a distance field, which is what stops summed light passing through it. */
const walls: GlobalFieldInstance[] = slabs.map((slab) => ({
  source: bakeObjectSdf(new MeshBuilder().addBox(slab.centre, slab.half, [1, 1, 1]).build(), 96),
  transform: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
}));

const field = renderer.createLightField(candles, { fields: walls });
field.scale = flag('driftlight', 'on') === 'on' ? 1 : 0;
```

`createLightField(lights, options)` makes the field and marks each light `inLightField`, which tells
the selection that the light is also summed, so no pixel counts it twice. `fields` are the distance
fields that occlude the summed light: here each slab of the gallery is baked with `bakeObjectSdf`
from `@driftengine/assets`, so light from the candles beyond the partition does not reach the near
face of it. A field made without them is unoccluded.

The other options:

- `spacing`, a third of a metre by default: the distance between samples. A brick of samples spans
  a metre.
- `band`, two metres by default: how wide the crossfade between exact and summed light is.
- `fadeSec`, half a second by default: how long the summed light takes to fade in once the field is
  whole. Zero for a field baked behind a loading screen.

## Baking and following

```ts sample=driftlight/main.ts#frame
/* Bricks until four milliseconds of this frame are spent, so the walk stays smooth on a slow
   machine too; once the field is whole it fades in over half a second. */
const until = performance.now() + 4;
while (!field.ready && performance.now() < until) field.bake(4);

const [x, y, z] = camera.position;
selectPointLights(candles, x, y, z, chosen, time, DEFAULT_POINT_LIGHT_VIEW_RANGE);
env.lightCount = chosen.count;
env.lightPositions = chosen.positions;
env.lightColors = chosen.colors;
env.lightRadii = chosen.radii;
env.lightSourceRadii = chosen.sourceRadii;
env.lightWeights = chosen.weights;
/* Where the exact choice is complete, so the shader knows where the field takes over. */
field.follow(chosen.complete, x, y, z, time - shadedAt);
shadedAt = time;
```

`bake(bricks)` bakes that many bricks and no more, and reads no clock, so the build is
deterministic and pacing it is the scene's. The example bakes four at a time until four
milliseconds of the frame are gone, so the walk stays smooth while the field fills, on a slow
machine too; a fixed count per frame costs a fast machine nothing and stalls a slow one. `progress`
is how much is done, for a loading screen, and `ready` says the field is whole. The volume is not
used until every brick has landed, then fades in.

`follow(complete, x, y, z, dt)` tells the field where the frame's exact choice is complete. The
selection's `complete` is a distance from its centre: a point nearer than that is reached only by
lights the frame shades exactly, at full strength, so the field can leave it alone. The field
shrinks its radius at once when the choice shrinks, and grows it back slowly.

A scene has one field at a time; creating another replaces it, and `disposeLightField` lets it go.
`scale` dims everything the field summed at once, for dawn or a power cut.

## What it gives up

- **Highlights.** Summed light lights surfaces; it puts no specular highlight on them. The exact
  lights near the camera do.
- **Flicker past the choice.** The volume holds each light's steady colour.
- **Occlusion by anything that moves.** Only the fields given at construction shadow it.
- **The lights as they change.** The field sums the lights as they stood when it was made, from a
  copy, so a scene that dims its lamps later uses `scale`.

## A whole city

A street lamp reaches thirty metres and stands every forty, so a city is lit almost everywhere and a
sparse volume of bricks buys nothing. For a world, `bakeDenseField` sums every fixed light offline
into one dense grid: at eight metres a sample, a city two kilometres across and 128 metres tall is
256 × 16 × 256 samples, 16 MB on the GPU. The grid may be at most 256 samples along x and z and 128
along y.

```ts sample=snippets/driftlight.ts#bake
/** Offline, in a build script: sum every lamp over two kilometres at eight metres a sample. */
export function bakeCityLight(lamps: readonly PointLightSource[]): DenseLightVolume {
  return bakeDenseField(lamps, 'smooth', null, [-1000, 0, -1000, 1000, 128, 1000], 8);
}

/** And store it in the world's file, as one `LVOL` chunk. */
export function writeWorld(world: DrftSource, lamps: readonly PointLightSource[]): ArrayBuffer {
  return writeDrft({ ...world, lightVolume: bakeCityLight(lamps) });
}
```

The bake buckets lights before it sums them, so each sample considers only the lamps that can reach
it, and it may take seconds, which is why it belongs in a build script. Its `distance` argument
occludes, as the scene field's distance fields do, or is `null` for none. The `.drft` format carries
the result as one `LVOL` chunk.

```ts sample=snippets/driftlight.ts#load
/** In the game: the volume arrives with the file, and the lamps it summed are marked as summed. */
export async function openCity(
  renderer: RendererApi,
  url: string,
  lamps: PointLightSource[],
): Promise<void> {
  for (const lamp of lamps) lamp.inLightField = true;
  await streamDrft(await fetch(url), {
    onLightVolume: (volume) => renderer.createWorldLightField(volume, { fadeSec: 0 }),
  });
}
```

`createWorldLightField(volume)` hands the volume to the renderer whole. It carries no list of the
lights it came from, so the scene marks them `inLightField` itself. The exact lights near the eye
are found with the light grid from [Lights](lights.md), which makes the same choice as the full scan
over twenty thousand lamps, measured 20 to 30% faster.

At eight metres a lamp's pool is a few samples across, which is why the volume only stands in past
the exact lights, where a pool is a few dozen pixels on screen.
