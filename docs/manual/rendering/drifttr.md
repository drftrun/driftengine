---
title: DriftTR
description: Draw the scene at a fraction of the output size and rebuild the full picture from this frame and the ones before it, on WebGPU.
packages: ['@driftengine/core']
covers: ['Reconstruction']
---

# DriftTR

Most of a frame's cost is shading pixels. DriftTR, the engine's temporal reconstruction, shades
fewer: the scene is drawn smaller, jittered a fraction of a pixel differently each frame, and a
compute pass rebuilds the full-size picture from this frame and the history of the ones before. At a
ratio of 1.5 the scene draws 44% of the output's pixels and saves the rest of the fragment work; a
measured scene went from 3.1 milliseconds of GPU time to 2.45.

<!-- run: drifttr -->

## Turning it on

```ts sample=drifttr/main.ts#quality
/**
 * How many output pixels each drawn pixel stands for, on each axis; 0 is off. It decides how every
 * target is sized, so the switch builds a new renderer in place.
 */
const quality = (ratio: string) => (backend: string) => ({
  reconstruction: backend === 'webgpu' ? Number(ratio) : 0,
  outputTransform: 'aces' as const,
  directionalShadows: true,
});
const scene = await openScene(quality(flag('ratio', '1.5')), build);
```

`reconstruction` is how many output pixels each drawn pixel stands for, on each axis, from 1.3 to 2.
0, the default, is off and draws exactly what the renderer draws without it, as does a negative
number. A positive value outside the range is clamped to its nearer end: below 1.3 the saving is
eaten by the reconstruction's own cost, and above 2 no reconstruction holds an edge. It needs WebGPU, since the reconstruction is a compute pass; on
WebGL2 the scene draws at full size, which is why the example asks only WebGPU for it.

The example's readout shows what was drawn against what is shown. `renderer.sceneWidth` and
`sceneHeight` are the drawn size; a custom pass that sizes its own targets must read them, not the
canvas, or it draws a corner of the world into a target the size of the scene.

## What it needs from your draws

The reconstruction finds where every pixel was last frame. For the still world and a moving camera,
the depth says so. For something that moved, the draw has to say:

```ts sample=drifttr/main.ts#mover
/** One identity per moving object, passed with every draw of it, so its motion can be followed. */
const blockMover = createMover();
```

```ts sample=drifttr/main.ts#draw
renderer.drawMesh(block, blockNode.worldMatrix, 0, null, blockMover);
```

`createMover()` makes an identity for one moving object; pass it with every draw of that object, and
the renderer keeps last frame's model matrix and, for a skinned draw, last frame's pose. A mover
drawn twice in one frame is two objects wearing one identity, and the renderer warns once. Passing
last frame's model matrix in the same place works too.

Some draws need nothing:

- **Instanced batches** and meshes rewritten with `updateMesh` are their own identity.
- **Blended draws** (translucent meshes, particles, plumes, films, bolts, lines and text in the world)
  are drawn after the reconstruction, at the output size.
- **Light volumes** are marched inside the reconstructed picture and keep their own history.

**And call `renderer.cameraCut()` at every cut.** Nothing detects one: without it, the first frames
of a new shot blend in the last one.

## What it gives back, and what it does not

The history is read where each surface was, kept within the colour range of its neighbourhood, and
refused where depth, motion or normals say it is another surface, so a moving object leaves no
ghost. What it cannot give back is the resolution it did not draw: an edge that never moves is softer
than in a full-size frame at any ratio. Measured against a native frame with four samples, still
edges err by about 8 levels at 1.5, where a native frame with one sample errs by 3.

A multisampled frame is not reconstructed, and the renderer says so once: choose one or the other.
A custom pass is handed the frame's jitter on its contexts, `ctx.jitter`, to apply with `jitterClip`;
see [Custom passes](custom-passes.md).

Deterministic replays are unaffected: the same replay fingerprints the same with reconstruction on at
any ratio as with it off.
