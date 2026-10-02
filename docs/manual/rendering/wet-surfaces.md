---
title: Wet surfaces
description: A world that gets wet in the rain and dries after, puddles that fade at their rims and mirror the street, and the sheen of an oil slick.
packages: ['@driftengine/core']
---

# Wet surfaces

Rain changes the ground in two ways. Everything that faces up darkens and turns glossy, and water
gathers in the low places, where it mirrors the street. The engine draws the first with one number
on the environment and the second with films: thin transparent surfaces laid over the world. The
example's rain and storm both wet the street; the clear weather leaves it dry.

<!-- run: weather -->

## The world gets wet

`env.wetness`, from 0 to 1, darkens and polishes every upward surface. It is a dial: raise it as rain
starts, and lower it slowly after the rain stops, so the street dries over a minute and not in a
frame. Surfaces that rain cannot reach, a covered walkway or an interior floor, stay dry when their
texture-array layer is marked `dry`; see [Texture arrays](texture-arrays.md).

## Puddles

```ts sample=weather/main.ts#puddles
/** Puddles down the middle of the road: feathered patches lying a centimetre above it. */
const roadLine = new Spline(
  [8, -20, -50, -80].map((z) => ({ x: 0, y: 0, z, bankRad: 0, widthM: 8 })),
);
const puddles = [
  { fromM: 4, toM: 16, centreM: -1.2, halfWidthM: 1.6, seed: 3 },
  { fromM: 22, toM: 40, centreM: 1.4, halfWidthM: 2.2, seed: 8 },
  { fromM: 48, toM: 60, centreM: -0.4, halfWidthM: 1.8, seed: 13 },
  { fromM: 66, toM: 84, centreM: 0.8, halfWidthM: 2.4, seed: 21 },
].map((patch) =>
  renderer.createMesh(
    buildFilmPatch(roadLine, { ...patch, liftM: 0.012, color: [0.012, 0.014, 0.018] }),
  ),
);
/** They mirror across the road's own plane, a little roughened by the stone under them. */
const wet = { reflectionStrength: 0.7, reflectionPlaneY: 0, roughness: 0.25 };
```

`buildFilmPatch(spline, options)` builds the shape a spill has: an irregular patch that follows a
surface's curve and bank and dissolves at its rim. A patch with a hard edge reads as a sticker
whatever it is made of, because a real puddle is thinnest where it ends, so the patch carries a
coverage value per vertex, 1 in the middle and 0 at the edge, which the film shader turns into
transparency. Its options:

- `fromM` and `toM`, the stretch of the spline it covers, in metres along it.
- `centreM` and `halfWidthM`, where it sits across the spline and how wide it is.
- `liftM`, its height above the surface: about a centimetre, so it never fights the road for the
  depth buffer.
- `color`, and a `seed` for its outline. The same seed and window give the same puddle on every
  device.

Any mesh can be drawn as a film; the patch builder is for the common case of water lying on a road.

## Drawing a film

```ts sample=weather/main.ts#reflect
/* The street mirrored across the road, for the puddles to show. */
const wetEnough = sky.wetness > 0.02;
const mirrored = wetEnough ? renderer.beginPlanarReflection(camera, 0, heavens.horizon) : null;
if (mirrored !== null) {
  drawWorld(mirrored);
  renderer.endPlanarReflection();
}
drawWorld(camera);
if (wetEnough)
  for (const puddle of puddles) renderer.drawFilm(puddle, camera, time, env, 0.16, wet);
```

`drawFilm(mesh, camera, time, env, sheen, options)` draws a film after the world, blended and without
writing depth, so it lies on the surface it was built against. Its options:

- `reflectionStrength`, 0 to 1, how much of the mirrored street shows. It is weighted by the viewing
  angle on top, as a reflection is: a puddle underfoot shows almost nothing, one down the street
  shows everything. It needs a planar reflection drawn this frame for the film's plane, which is the
  road's own height, named by `reflectionPlaneY` even though the patch is lifted a centimetre above
  it. A film on any other plane gets no reflection, never the wrong one.
- `roughness`, 0 to 1. Zero is a mirror. A wet road is water lying in stone, which scatters what it
  reflects into streaks, so a little roughness makes a puddle meet the dry road around it without a
  hard rim. `roughnessCyclesPerMetre`, 60 by default, is how coarse that roughness is; match it to
  the `setSurfaceRelief` scale of the surface beside it, and the wet and the dry read as one material.

The planar reflection is the one water uses; [Water](water.md) describes it. Its target exists when
the `water` and `waterReflections` quality options are on, as they are by default, so a street that
has turned water off asks for it with `planarReflections: true`. Draw the same world into it that
the frame draws, from a function both passes call.

## Sheen

`sheen` is iridescence, the green-to-magenta bands of fuel on water, and **not a wetness dial**.
Raising it to make a road look wetter makes it look oily. For wet tarmac at night, 0.15 to 0.18 is
the range a game found by testing; the example uses 0.16. An oil slick wants much more.
