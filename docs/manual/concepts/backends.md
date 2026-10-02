---
title: WebGPU and WebGL2
description: How the engine chooses between WebGPU and WebGL2, what it reports about the choice, what only WebGPU can do, and how to tune quality per backend.
packages: ['@driftengine/core']
covers: ['Backends']
---

# WebGPU and WebGL2

The engine draws with WebGPU and falls back to WebGL2. Both backends implement one surface,
`RendererApi`, and a game draws through that surface without knowing which one is underneath. You
never write a shader, own a framebuffer or touch GPU state; you submit meshes, lights and passes.

## How the choice is made

`createRenderer` asks for WebGPU first. It falls back to WebGL2 when any of these happens:

- the browser has no WebGPU, or returns no adapter;
- the adapter or the device request fails;
- the device is created but cannot draw: the engine draws a known pixel with it and reads it back
  before accepting it, because some devices validate every call and rasterise nothing;
- the request takes longer than its timeout, eight seconds unless you set `backendTimeoutMs`,
  because an adapter request that never settles would otherwise leave the page blank forever.

The fallback is silent in the picture and loud in the result. `createRenderer` resolves to the
renderer and three facts about it: `backend`, which is `'webgpu'` or `'webgl2'`; `reason`, why, in
words; and `rendererName`, what the GPU calls itself. Put the first two somewhere a tester can see
them and all three in any report of a problem.

`?backend=webgl2` or `?backend=webgpu` on the page's address forces the choice, which is the
quickest way to compare a scene on both. `preferWebGpu: false` in the renderer's options skips
WebGPU entirely.

## Tuning per backend

The quality profile can be a function of the backend that was built. `createRenderer` calls it once,
with the answer:

```ts sample=snippets/backends.ts#profile
/** A quality profile per backend: the function is called once, with the backend that was built. */
export async function rendererFor(canvas: HTMLCanvasElement) {
  return createRenderer(canvas, (backend: RenderBackend) =>
    backend === 'webgpu'
      ? { maxDevicePixelRatio: 2, directionalShadows: true, sceneSamples: 4, bloom: 0.4 }
      : { maxDevicePixelRatio: 1.5, directionalShadows: true },
  );
}
```

A profile is chosen at construction because most options size GPU memory. To change one, build a
new renderer.

## Knowing the GPU before you build

`describeGpu` asks the browser what part it has, before any renderer exists, and whether that part
belongs to a family known to struggle with heavy profiles:

```ts sample=snippets/backends.ts#identify
/** Ask what part this is before building, so a known-weak family starts on the lighter profile. */
export async function rendererForThisMachine(canvas: HTMLCanvasElement) {
  const gpu = await describeGpu();
  const heavy = !gpu.weak;
  const created = await createRenderer(canvas, {
    maxDevicePixelRatio: heavy ? 2 : 1.25,
    directionalShadows: true,
    pointShadows: heavy,
  });
  console.info(
    `${created.backend} on ${created.rendererName || 'an unnamed GPU'}: ${created.reason}`,
  );
  return created;
}
```

`weak` is a starting point, never a verdict: an unknown part is not weak. `ResolutionGovernor`
corrects from measurement after that, lowering and raising the drawing-buffer scale against a frame
time.

The renderer also clamps the pixel-heavy settings of a known-weak family by itself, because most
players never open a settings screen. When a player has chosen their settings in yours, pass
`capabilityClamp: false`, so the numbers they picked are the numbers they get.

## What only WebGPU does

Some features need compute shaders or indirect draws, which WebGL2 doesn't have. They are off by
default and refuse in words on WebGL2, never silently:

- **The GPU-driven pipeline**, `pipeline: 'gpu-driven'`, which culls instances and clusters on the
  device. Asking for it on WebGL2 throws, with the reason.
- **DriftTR temporal reconstruction**, `reconstruction`, which renders below output resolution.
- **DriftRay indirect light**, `indirectLight`, which marches rays through a distance field.
- **Compute passes** of your own. `renderer.computeSupported` answers whether the backend can run
  them.

Everything else draws on both, and the engine holds them to each other: a feature added to one
backend reaches the other or states why it doesn't yet.

## What a frame asked for

WebGPU keeps fixed rings for per-draw data, so a frame has ceilings: how many draws, material
changes, shadow draws, water bodies and so on. `renderer.frameBudget` reports every one of them for
the frame just drawn, counting what was asked for, not just what fit:

```ts sample=snippets/backends.ts#budget
/** After `endFrame`: every ceiling the backend imposes, and what this frame asked of it. */
export function reportBudget(renderer: RendererApi): void {
  const budget = renderer.frameBudget;
  if (!budget.dropped) return;
  for (const line of budget.lines) {
    if (line.dropped > 0) {
      console.warn(
        `${line.name}: ${line.used} asked for, ${line.dropped} over the ceiling of ${line.ceiling}`,
      );
    }
  }
}
```

The draw and material rings grow on their own when a scene outgrows them, from the next frame. On
WebGL2 the same lines are reported with no ceiling, because it imposes none, and counted by the same
rules, so you can see a WebGPU ceiling coming while you develop on the fallback.

## Depth runs backwards

The engine renders scene depth reversed: the near plane is 1, the far plane is 0, and the depth test
is `greater`. It gives far better precision at a distance. It only matters if you write a custom
pass: a shader that writes `1.0` meaning "far" is writing the near plane. `REVERSED_DEPTH` is the
engine's intent and `reversedDepth` on the created renderer is what the device granted.

## Timing the GPU

`gpuTiming: true` measures GPU time with timestamp queries, where the adapter has the
`timestamp-query` feature. Leave it off in a shipped build: it adds a timestamp write to every pass
in the frame, and a driver that disagrees with any part of that invalidates the whole command buffer,
which is a black frame. Turn it on while you measure. Without the feature the timer reports that it
is unavailable instead of reporting zero.
