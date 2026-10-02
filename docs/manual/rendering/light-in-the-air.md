---
title: Light in the air
description: Shafts of light with dust in them, cut to shape by a window's shadow, fire and smoke plumes, and a medium that fills a room with light.
packages: ['@driftengine/core', '@driftengine/script']
---

# Light in the air

Light is seen on surfaces, and in the air only where something in the air catches it. The engine
draws that three ways: a volume of light inside a hull you place, plumes of fire and smoke, and a
medium that fills the whole frame. Haze over distance is fog, in [Fog and weather](fog-and-weather.md).

<!-- run: air -->

## Shafts and beams

```ts sample=air/main.ts#shaft
/**
 * A shaft through a window is a slice of a very wide cone whose apex is far out toward the sun.
 * The hull is round and wider than the window; the window's own shadow cuts it square.
 */
const REACH = 30;
const shaftHull = buildLightVolume({
  nearM: REACH,
  lengthM: REACH + 10,
  spread: 2.2 / REACH,
  color: [1, 0.86, 0.62],
});
const shaft = renderer.createMesh(shaftHull);

/** The hull opens along its own +Z, so its matrix turns +Z to the way sunlight travels. */
function aimAlong(out: Float32Array, at: Vec3, travel: Vec3): void {
  const [zx, zy, zz] = travel;
  const side = Math.hypot(zz, zx);
  const xx = zz / side;
  const xz = -zx / side;
  out.set([xx, 0, xz, 0, zy * xz, zz * xx - zx * xz, -zy * xx, 0, zx, zy, zz, 0, ...at, 1]);
}
const length = Math.hypot(...SUN);
const travel: Vec3 = [-SUN[0] / length, -SUN[1] / length, -SUN[2] / length];
const shaftModel = new Float32Array(16);
aimAlong(
  shaftModel,
  [6.1 - travel[0] * REACH, 2.3 - travel[1] * REACH, -travel[2] * REACH],
  travel,
);
```

A light volume is a beam from a lamp, a cone under a street light, or a shaft of sun through a
window. `buildLightVolume` builds its hull, a closed cone frustum opening along its own +Z:
`lengthM` is how far the light reaches, `spread` is the cone's half-width over distance, and `nearM`
is where the drawn part starts. A shaft through a window is a slice taken far down a very wide cone
whose apex is out toward the sun, which is what `nearM` is for. `sides` sets how round the outline
is, twelve by default; the light inside is round whatever the hull.

```ts sample=air/main.ts#draw
renderer.drawLightVolume(shaft, shaftModel, camera, 0.8, REACH + 10, 2.2 / REACH, {
  nearM: REACH,
  dust: 0.35,
  dustScaleM: 0.8,
  driftM: [time * 0.05, 0, time * 0.02],
  sunShadow: 1,
  env,
});
renderer.drawPlumes(smoke, camera, time, env, 0.2, 0);
renderer.drawPlumes(fire, camera, time, env, 0.2, 0);
```

`drawLightVolume(mesh, model, camera, strength, length, spread, options)` walks each pixel's line of
sight through the hull and adds what the air there would scatter. **Pass the same `length`, `spread`
and `nearM` the hull was built with.** They are read in the hull's own units, and a draw that
disagrees with its hull either ends at a hard edge or disappears. `strength` fades the whole volume,
for a lamp coming up at dusk, and is clamped to 1.

The options:

- `dust`, 0 to 1, gives the air structure: 0.2 to 0.5 reads as motes in sunlight, more as smoke.
  `dustScaleM` is the size of a cell of the dust field and `driftM` where the field has drifted to,
  a position so the same instant always draws the same frame.
- `sunShadow`, 0 to 1, cuts the volume by the sun's shadow map at every step of the walk. That is
  what makes the round hull in the example square: the window frame shadows the air as well as the
  floor. It needs `env` and a renderer built with `directionalShadows`.
- `medium` ties the volume to the weather: `{ atmosphere, fullAtDensity }` draws it as authored at
  that fog density, dimmer in clearer air and no brighter in thicker. A headlight in fog then reads
  differently from the same headlight on a clear night.

A volume is depth tested, so a beam passes behind whatever stands in front of it, and it occludes
nothing. The `lightVolumeSamples` quality option, 32 by default, is how many steps each ray takes;
the walk is dithered per pixel, which turns banding into grain. A frame that draws no volume pays
nothing.

## Fire and smoke

```ts sample=air/main.ts#plumes
/** Fire adds light; smoke covers it. One batch each, placed once. */
const fire = renderer.createPlumes([{ x: -1, y: 0.8, z: 4.5, width: 0.35, height: 1.1 }], {
  material: 'fire',
  blend: 'additive',
  windResponse: 0.1,
});
const smoke = renderer.createPlumes(
  [
    { x: -1, y: 1.6, z: 4.5, width: 0.5, height: 1.4 },
    { x: -0.9, y: 2.6, z: 4.4, width: 0.8, height: 1.4 },
  ],
  { material: 'smoke', blend: 'alpha', windResponse: 1, tint: [0.35, 0.33, 0.32] },
);
```

`createPlumes(placements, options)` makes a batch of plumes, each a position, a half-width and a
height, animated on the GPU. A plume is two crossed blades fixed in the world, so walking around a
fire shows it from every side. The options:

- `material`: one the engine ships, `'fire'`, `'smoke'` or `'arcane'`.
- `blend`: `'additive'` for what emits light, `'alpha'` for what covers it.
- `windResponse`: how far the plume leans per metre a second of wind at its crown. Smoke is carried;
  a flame is anchored to its fuel.
- `sizePulse`: how much the quads swell and shrink. It is visual only, so a gameplay volume must keep
  its own fixed size.
- `tint`: the colour, white by default.

`drawPlumes(plumes, camera, time, env, windX, windZ)` draws a batch after the opaque scene; pass the
same wind the grass and the dust use. A batch is placed once, since fires do not move, and
`setPlumeScale(plumes, index, scale)` resizes one plume, 0 to hide it: an oil slick that burns on a
cycle. The `plumeNoiseOctaves` quality option sets how much detail the noise has, 3 by default.

A plume does not light anything. The brazier in the example has a flickering point light beside its
fire for that.

## The air itself

```drs sample=air/air.drs#breathe
fn breathe(air: mut Air, renderer: Renderer, dt: f32) {
    // Half of the change a second, either way.
    air.present = air.present + math.clamp(air.wanted - air.present, 0 - dt * 0.5, dt * 0.5)
    // Extinction per metre, how much of it comes back as light, how far forward it scatters, and
    // how far the march looks. A density of 0 is no air at all, and costs nothing.
    render.medium(renderer, 0.035 * air.present, 0.9, 0.6, 40)
}
```

The example's air is a DriftScript module. Its switch says whether the room should hold air, and
`breathe` eases toward that and sets the medium with `render.medium`, the script's form of
`setGlobalMedium(density, albedo, anisotropy, maxDistance)`. That call fills the frame with a
participating medium and marches every pixel's line of sight through it, adding the sunlight the air there scatters
toward the eye. Where the sun's shadow map says a point is in shade, it adds nothing, which is how a
window throws shafts across the whole room and a doorway its shape onto the floor.

- `density` is extinction per metre. 0.02 leaves a wall 50 metres away a third obscured, 0.1 is thick
  weather, and above about 0.5 nothing past a room is visible. **0 is off, and off is free**: nothing
  is allocated and no pass runs.
- `albedo`, 0 to 1, is how much of what the air takes out comes back as light: near 1 for fog, cloud
  and steam, lower for soot.
- `anisotropy`, -1 to 1, is how much the medium scatters forward. Haze is strongly forward, around
  0.6, which is why the air around a low sun glows and the air behind you does not.
- `maxDistance` is where the march stops looking for light to scatter; extinction still applies past
  it.

The medium is a dial and is held until changed, so weather can move every frame. What it may cost
is a quality option: `globalMediumSteps` is the march's step count, **0 by default, which turns the
medium off whatever the frame asks for**. 24 suits a room, 48 a landscape under a low sun, and 64 is
the most. `globalMediumHalfResolution`, on by default, marches a quarter of the pixels and upsamples
by depth. On parts the engine knows are weak, steps are capped at 16 unless `capabilityClamp` is off.
The example sets the ceiling once, at 48, and its switch only moves the density: at 0 nothing runs,
so the ceiling costs nothing until the air is there.

The medium is composited before the post chain, so bloom sees a lit fog bank as brightness. It reads
the sun's shadow map only on frames that drew it, with `shadowStrength` above zero.
