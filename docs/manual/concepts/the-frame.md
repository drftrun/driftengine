---
title: The frame
description: What happens between beginFrame and endFrame, in what order a game issues its work, where custom passes and compute fit, and how the GPU-driven path differs.
packages: ['@driftengine/core']
---

# The frame

DriftEngine draws in immediate mode. Each frame, your `render` callback issues verbs to the
renderer in the order they should happen: shadows, the frame, the scene, the effects, the interface.
The engine has no scene it walks on its own, and no list of objects it keeps between frames; what you
issue is the frame. That keeps the order of every draw yours, and it is why the same engine draws a
breakout game and a streamed city.

## A frame, in order

The first game's frame is typical:

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

1. **Shadow passes come first**, before the frame opens: `beginShadowPass`, `drawShadowCasters`,
   `endShadowPass` for the sun, and the point-light bakes the renderer budgets per frame.
2. **`beginFrame(clear)`** opens the frame. With `screenEffects` on, it opens the off-screen scene
   target the effects read from.
3. **`bindMeshPass(camera, environment)`** sets the camera and the light for the meshes that follow.
   Material state set before a pass does not carry into it.
4. **Opaque geometry**: `drawMesh`, `drawInstanced`, terrain, skinned meshes.
5. **The sky, water and effects**: `drawSky`, `drawWater`, particles and plumes, translucent meshes
   after the opaque ones they show through.
6. **Your own passes**, at the point you call `drawPass`.
7. **Overlays**: text and panels over the scene.
8. **`endFrame()`** resolves the scene target through the post stage, ambient occlusion, bloom,
   the tone curve and the grade, and presents.

## One list for two passes

The same things usually need to be drawn into the shadow map and into the picture. A
`ShadowCasters` function names them once, and both passes call it:
`renderer.drawShadowCasters(casters)` for depth, and `renderer.drawSceneCasters(casters)` for colour
with materials. A reflection or a probe face can call it a third time from another viewpoint.

## Custom passes

A package or a game can add a pass of its own with `registerPass`, giving it a label, the frame
attachments it reads, such as depth, and up to four callbacks:

- `init` builds pipelines and buffers once, when the pass is registered;
- `prepare` fills a target the pass owns, each frame, before the frame's own pass opens;
- `draw` runs where you call `renderer.drawPass(handle)`;
- `dispose` releases what `init` built.

That is how the engine's own optional packages draw: the splat package's pass composes Gaussian
splats into the scene through it. On WebGPU a pass may also dispatch compute: `registerCompute` takes
a definition whose `dispatch` sets a pipeline and calls `dispatchWorkgroups`, and
`renderer.computeSupported` says whether the backend has compute at all.
[Custom passes and compute](../rendering/custom-passes.md) works through an example.

## The frame graph

Inside the renderer, a frame's passes are scheduled from what each one declares it reads and writes.
The `frameGraph` quality option routes the migrated verbs through that graph instead of issuing them
directly, so a pass and its resources are ordered by data instead of by call position; it is opt-in
while the migration completes. You keep issuing verbs in order either way.

## The GPU-driven path

`createRenderer(canvas, quality, { pipeline: 'gpu-driven' })` builds a different renderer for
very large scenes, on WebGPU only. Each frame the GPU culls instances against the view, chooses the
level of detail each one has earned, culls clusters against a depth pyramid built that frame, compacts
what survives into one indirect draw into a visibility buffer, and shades it with one dispatch per
material. Draw-call counts stop being a cost. [The GPU-driven pipeline](../rendering/gpu-driven.md)
covers it.
