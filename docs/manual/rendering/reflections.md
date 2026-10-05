---
title: Reflections
description: What shiny surfaces show: the sky gradient, a captured room, a grid of probes baked a little at a time, bounced light and an HDR sky.
packages: ['@driftengine/core', '@driftengine/assets']
---

# Reflections

A metal shows almost nothing but what it reflects, and a glossy floor half of it, so what the
environment looks like decides how those surfaces read. The engine reflects one of three things,
from cheapest to best:

1. **The sky gradient.** With no probe, a reflective surface mirrors the environment's `ambient`
   above and `ambientGround` below, mixed by the reflected direction. It still varies with the view,
   and nothing renders black.
2. **A captured room.** A probe photographs the scene around a point once, and surfaces reflect that.
3. **A grid of probes**, so a reflection near the door shows the door and one by the window shows
   the window.

Every probe also lights: its diffuse convolution is the ambient light at that point, so a probe grid
is also the scene's bounced light. [DriftRay](driftray.md) traces that grid every frame on WebGPU.

## Turning probes on

`reflectionProbeSize` sets each probe's resolution and is 0, off, by default; set it to allocate the
probe array. `environmentReflections`, on by default, is the switch a settings screen turns off.
Every probe call returns `false` and does nothing when no probe was allowed, on a profile without a
size or a device without a texture unit to spare, so a scene may issue them unconditionally.

## A captured room

```ts sample=snippets/reflections.ts#room
/** One probe in the middle of a finished room, baked once the room exists. */
export function captureRoom(
  renderer: RendererApi,
  drawRoom: (camera: Camera) => void,
  clear: Vec3,
): boolean {
  return renderer.bakeReflectionProbe([0, 1.6, 0], clear, drawRoom);
}
```

`bakeReflectionProbe(origin, clear, drawFace)` hands `drawFace` a camera aimed at each of the six
faces in turn, and the callback draws the scene exactly as it does for the screen: `bindMeshPass`,
the world's draws, the sky. Then the six faces are convolved into the levels a rough or a smooth
surface samples. Six draws of the scene, once; after that one texture fetch per reflective pixel.

**Bake after the world exists.** A probe baked in a constructor captures a room that has not been
built yet. Shadow maps baked before the probe are fine and are the normal order. The callback
re-enters the mesh pass only, so what a scene draws in a later pass, particles and light volumes,
is absent from the capture; draw the sky inside the callback.

## A grid of probes

```ts sample=snippets/reflections.ts#grid
/**
 * A grid of probes through a courtyard, baked two faces a frame so no frame pays for a whole
 * probe. The grid is not used until every probe has landed.
 */
export function pacedGrid(
  renderer: RendererApi,
  drawScene: (camera: Camera) => void,
  clear: Vec3,
): () => boolean {
  renderer.setProbeGrid({ origin: [-12, 1.5, -12], spacing: [8, 4, 8], counts: [4, 2, 4] });
  const probes = 4 * 2 * 4;
  let probe = 0;
  let face = 0;
  return function step(): boolean {
    if (probe === probes) return true;
    renderer.bakeProbe(probe, clear, drawScene, { faces: [face, 2] });
    face += 2;
    if (face === 6) {
      face = 0;
      probe += 1;
    }
    return probe === probes;
  };
}
```

`setProbeGrid({ origin, spacing, counts })` places probes on a lattice, and a surface blends the
eight around it. `bakeProbeGrid` bakes them all in one call, for a scene that can afford
a stall at load. `bakeProbe(index, clear, drawFace, options)` bakes one, and its `faces` option draws
only some of its six faces, so the cost spreads over frames: a probe of a scene with millions of
triangles is otherwise the most expensive thing in its frame. Finish one probe before starting the
next. The grid is not sampled until every probe has been baked, so a paced grid keeps the old light
until the last one lands.

`crossfade: true` on the grid blends each sweep of bakes into the next, for a grid re-baked
continuously under a moving light. It costs three times the layers and a sweep of lag.

## Light that bounces

```ts sample=snippets/reflections.ts#bounce
/**
 * Each bake lit by the last, so light bounces deeper into an enclosed space with every sweep. A
 * scene that holds one moment bakes the grid two or three times.
 */
export function bounceInto(
  renderer: RendererApi,
  drawScene: (camera: Camera) => void,
  clear: Vec3,
): void {
  for (let sweep = 0; sweep < 3; sweep += 1)
    renderer.bakeProbeGrid(clear, drawScene, { bounce: true });
}
```

A probe sees the scene lit by the sun and the ambient, so a grid holds one bounce of light. An
enclosed space is lit mostly by the second bounce and later; a courtyard's arcades came out about
two stops darker than a reference render with one. `bounce: true` lights what each probe sees with
the grid's previous bake, so every sweep adds a bounce, and two or three sweeps converge. It costs
nothing extra. Light that leaks through a wall into a probe is bounced again too, so a leak grows
with each sweep.

## A photographed sky

```ts sample=snippets/reflections.ts#sky
/** A photographed sky, from a Radiance `.hdr` file, as the environment everything reflects. */
export async function loadSky(renderer: RendererApi, url: string): Promise<boolean> {
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
  return renderer.setEnvironmentImage(readRadianceHdr(bytes));
}
```

`readRadianceHdr(bytes)` from `@driftengine/assets` reads a Radiance `.hdr` file into linear
radiance, and `setEnvironmentImage(image)` makes it the environment: the faces go into the same cube
a bake fills and the same convolution runs, so a loaded sky lights and reflects exactly as a baked
one would. It is a grid of one at the origin, since a sky is the same everywhere.

## Captures from another tool

```ts sample=snippets/reflections.ts#capture
/**
 * A reflection capture baked in another tool, into one layer of the grid `setProbeGrid` declared:
 * prefiltered as the environment is, the other layers left as they are.
 */
export async function loadCapture(
  renderer: RendererApi,
  layer: number,
  url: string,
): Promise<boolean> {
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
  return renderer.setProbeLayerImage(layer, readRadianceHdr(bytes));
}
```

A stage made in another engine reflects its own captures, each an image taken where it stands.
Fit them to a grid: declare one with `setProbeGrid`, and for each point hand
`setProbeLayerImage(layer, image)` the image of the capture whose reach holds it. Each image is
projected and prefiltered into its layer exactly as `setEnvironmentImage` treats the environment,
and the other layers keep what they hold.

## A draw's own ambient

```ts sample=snippets/reflections.ts#ambient
/**
 * A character lit by where it stands: nine coefficients of the light around it, red, green and
 * blue of each, sampled from a baked volume every frame and set around its draws alone.
 */
export function drawLitWhereItStands(
  renderer: RendererApi,
  character: MeshHandle,
  placement: Float32Array,
  coefficients: Float32Array,
): void {
  renderer.setAmbientSH(coefficients);
  renderer.drawMesh(character, placement);
  renderer.setAmbientSH(null);
}
```

`setAmbientSH(coefficients)` gives the draws that follow an ambient of their own: nine
second-order spherical-harmonic coefficients of the light arriving from every side, red, green and
blue of each, 27 numbers. A character walking through a stage whose indirect light was baked into a
volume samples the volume where it stands every frame and sets the result around its own draws, so
it takes the light of its spot rather than the frame's. It replaces the diffuse ambient only; a
glossy surface still reflects the probes. `null`, or the next `bindMeshPass`, gives the frame's
ambient back.

## Prefiltered reflections

By default each level of a probe is a smaller picture of the room. With `environmentPrefilter` on,
each level is the room convolved with the reflection lobe of the roughness that level stands for,
which is the physically correct answer and much blurrier at the same roughness. Turn it on for
materials authored for it; surfaces authored against the default read as a wash. `environmentPrefilterSamples` sets the convolution's cost, 32 by default, 16 and 128 for
the low and high tiers.

## Per-draw dials

```ts sample=snippets/reflections.ts#dials
/** A polished floor in a dim hall: reflect fully, and lift what is reflected. */
export function polishedFloor(renderer: RendererApi, env: Environment, camera: Camera): void {
  renderer.bindMeshPass(camera, env);
  renderer.setSurfaceReflectivity(1);
  renderer.setEnvironmentGain(1.6);
}
```

`setSurfaceReflectivity(amount)` says how much of the environment the next surfaces mirror, and
`setEnvironmentGain(gain)` how bright that environment is, for a hall whose captured probe is
dimmer than the light a polished floor should show. `bindMeshPass` resets both. See
[Materials](materials.md) for the rest of a surface.

Water reflects through its own planar mirror; see [Water](water.md). For a wet street, see
[Wet surfaces](wet-surfaces.md).
