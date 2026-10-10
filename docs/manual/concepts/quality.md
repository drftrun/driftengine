---
title: Render quality
description: The quality profile a renderer is built with, what each group of options does and costs, the defaults that surprise people, and the dials that move per frame.
packages: ['@driftengine/core']
---

# Render quality

Everything that decides how good a frame looks, and how much it costs, is in the quality profile
passed to `createRenderer`. A profile is fixed for the renderer's life, because most options size
GPU memory or decide which shader is compiled. To change one, build a new renderer; a settings
screen does exactly that when the player presses apply.

```ts sample=snippets/quality.ts#profiles
/** A desktop profile: a filmic tone curve, real brightness through the composite, and post effects. */
export const DESKTOP: RenderQualityOptions = {
  maxDevicePixelRatio: 2,
  outputTransform: 'aces',
  outputExposure: 1.4,
  screenEffects: true,
  hdrScene: true,
  sceneSamples: 4,
  bloom: 0.5,
  bloomThreshold: 1,
  ambientOcclusion: 0.6,
  directionalShadows: true,
  directionalShadowMapSize: 2048,
  pointShadows: true,
};

/** A phone profile: fewer pixels, a smaller shadow map, and no full-frame post pass. */
export const PHONE: RenderQualityOptions = {
  maxDevicePixelRatio: 1.25,
  maxDrawingBufferPixels: 1280 * 720,
  outputTransform: 'aces',
  outputExposure: 1.4,
  screenEffects: false,
  directionalShadows: true,
  directionalShadowMapSize: 1024,
  pointShadows: false,
};

export async function build(canvas: HTMLCanvasElement, phone: boolean) {
  return createRenderer(canvas, phone ? PHONE : DESKTOP);
}
```

Every option has a default that means "off" or "the smallest correct thing", so a profile only names
what it changes. The full list, with what each option costs, is in the reference under
`RenderQuality`. This page groups them.

## The tone curve, first

The default output transform is `'none'`: values above 1 clip flat. A scene with bright lamps in dark
surroundings then reads as dark, muddy and desaturated, which sounds like a lighting problem, so
lighting is where people look. **Try `outputTransform: 'aces'` with an `outputExposure` before you
touch a single light.** `'srgb'` is the third choice, a plain transfer with no tone curve. The
default stays `'none'` only so that no existing game changes.

## Resolution

- `maxDevicePixelRatio` caps how many pixels the drawing buffer gets per CSS pixel. On a phone it
  is the single largest cost in most frames.
- `maxDrawingBufferPixels` caps the area, so a large window doesn't multiply the cost of every
  frame. The renderer is mostly fragment-bound, and on a display with vsync a frame that misses by a
  little runs at half the rate.
- `ResolutionGovernor` adjusts the drawing-buffer scale from measured frame times while the game
  runs; `setMaxDrawingBufferPixels` is the dial it turns.

## Post-processing

- `screenEffects` resolves the scene through an off-screen target, which every screen-space effect
  needs. Off, there is no post stage at all, and that is the honest low-end setting.
- `sceneSamples: 4` multisamples that target. With `screenEffects` on and this at 1, there is no
  antialiasing at all.
- `hdrScene` keeps brightness above 1 through to the end of the frame, in half floats, and grades
  once there. Bloom needs it, or something brighter than its threshold to find.
- `bloom` and `bloomThreshold`: the threshold is in scene units, and 1 means "brighter than white".
  **The two only work as a pair**: without `hdrScene`, nothing is above 1, so lower the threshold.
- `ambientOcclusion` and `ambientOcclusionRadius`: contact shading where surfaces meet. Needs
  `screenEffects`.
- `cameraMotionBlur`, `depthOfField`, `temporalAa` and `orderIndependent`, each off by default.

[Post-processing](../rendering/post-processing.md) covers them in depth.

## Shadows and lights

- `directionalShadows` with `directionalShadowMapSize`, and the reach and slope limits beside them.
- `pointShadows` with `pointShadowFaceSize` and the per-frame bake budgets.
- `shadowFilterTaps`, the softening budget shared by both kinds.
- `maxLights` and `maxAreaLights` size the lit shader. They are ceilings, and the renderer lowers
  them on its own when a device cannot link a shader that large.
- `clusteredLights` lights each part of the view from the lights near it, instead of one set for the
  whole frame. Off by default.
- `pointLightFalloff`: `'smooth'` ends exactly at a light's radius; `'inverseSquare'` is the physical
  law, windowed by the radius.

## Water, reflections and air

`water`, `waterResolution` and `waterReflections` for the wave-simulated water; `planarReflections`
and `reflectionProbeSize` for mirrors and baked reflections; `globalMediumSteps` and
`lightVolumeSamples` for light in fog and dust. Each has a chapter in the Rendering section.

## What only WebGPU does

`reconstruction` (DriftTR) and `indirectLight` (DriftRay) are quality options too, and the GPU-driven
pipeline is a renderer option. All three are off by default and explained in
[WebGPU and WebGL2](backends.md).

## Culling and the frame's work

- `cullDraws` skips a draw whose bounds are out of view. Off by default, because a mesh whose vertex
  shader displaces it, such as foliage in wind, is bigger than its bounds say, and culling it would
  remove something visible.
- `occlusionCulling` sizes the occlusion buffer; see [The scene graph](scene-graph.md).
- `capabilityClamp` lets the renderer clamp a known-weak GPU; pass `false` when a player chose their
  settings.

## Shaders first needed mid-game

A draw can need a shader the renderer has not compiled yet: a material that is two-sided, cut out or
shades by a surface model asks for a variant that creating the mesh did not prepare. With
`pipelineCompile: 'wait'`, the default, it is compiled where the draw asks, and the frame waits for
it, from a few hundred milliseconds to several seconds on a phone. With `'skip'` the compile starts
off the frame and the draw is left out until it lands, a few frames later, so nothing waits.

Either way, a loading screen can prepare a scene: draw what the scene will use once, then
`await renderer.ready()`, which waits for every compile started. Or prepare it without drawing:
`prepareMesh(mesh, material)` and `prepareInstanced(batch, material)` compile every shader a draw of
that mesh in that material will ask for, its surface model, its two-sided and cut-out variants and
its lit switches, and `ready()` waits for those too. Under `'skip'` that is what keeps a figure
brought on screen from missing its skin and hair for the frames they take. `{ translucent: true }`
prepares the blended draws as well. Call them between frames. On WebGL2 only a surface model's
program compiles at a draw, and `'skip'` helps there only where the browser offers parallel shader
compiling, which ANGLE on OpenGL does and ANGLE on Vulkan does not.

## Three defaults that surprise people

- **A lamp that won't glow.** Emissive light is switched by the environment's `nightFactor`; at 0,
  nothing glows whatever its emissive value. It is a switch, despite its name.
- **Bloom that does nothing.** A threshold above anything the scene contains blooms nothing. See the
  pair above.
- **Jagged edges with every effect on.** `screenEffects` takes the canvas's own antialiasing away;
  set `sceneSamples`.

## Dials that move per frame

A few things are cheap to change while the game runs, and have setters on the renderer:

```ts sample=snippets/quality.ts#dials
/** The dials that may move every frame. Everything else is fixed when the renderer is built. */
export function cinematicMoment(renderer: RendererApi, intensity: number): void {
  renderer.setBloom(0.5 + intensity * 0.5);
  renderer.setOutputExposure(1.4 + intensity * 0.6);
  renderer.setCameraMotionBlur(intensity);
  renderer.setVignette(intensity * 0.4);
}
```

`setDepthOfField`, `setColourGrade`, `setAutoExposure`, `setLocalExposure`, `setSpeedRush` and
`setFrameVeil` are the others. Each only does something when the profile built the stage it drives.
