---
title: Custom passes and compute
description: Add a draw pass of your own, fill targets it owns before the frame opens, dispatch compute on WebGPU, and keep a pass right on both backends.
packages: ['@driftengine/core']
covers: ['A compute shader can be tested']
---

# Custom passes and compute

The renderer's verbs cover what most games draw, and a pass of your own covers the rest: a shader
written for one effect, a package's own renderer, a compute kernel that sorts, bins or simulates on
the device. The engine's optional packages draw through the same door, so the Gaussian splats and
the GPU-driven pipeline are passes registered exactly as yours would be.

## A pass

```ts sample=snippets/passes.ts#pass
/** A full-screen wash of colour over the frame, on WebGPU, as the smallest pass that draws. */
const WASH_WGSL = /* wgsl */ `
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let corner = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(corner * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs() -> @location(0) vec4f { return vec4f(0.1, 0.0, 0.2, 0.15); }
`;

export function washPass(): PassDefinition {
  let pipeline: GPURenderPipeline | null = null;
  return {
    label: 'wash',
    init(device) {
      if (device.backend !== 'webgpu') return;
      const module = device.device.createShaderModule({ code: WASH_WGSL });
      pipeline = device.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: {
          module,
          entryPoint: 'fs',
          targets: [
            {
              format: device.format,
              blend: {
                color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
                alpha: SCENE_ALPHA_COVERS,
              },
            },
          ],
        },
        depthStencil: {
          format: device.depthFormat,
          depthWriteEnabled: false,
          depthCompare: 'always',
        },
        multisample: { count: device.samples },
      });
    },
    draw(ctx) {
      if (ctx.backend !== 'webgpu' || pipeline === null) return;
      ctx.pass.setPipeline(pipeline);
      ctx.pass.draw(3);
    },
  };
}
```

A `PassDefinition` has a `label` and up to four callbacks:

- `init(device)` builds pipelines, buffers and textures, once, when the pass is registered.
- `prepare(ctx)` fills a target the pass owns, each frame, before the frame's own target opens: a
  shadow map of its own, a blur pyramid, a picking buffer.
- `draw(ctx)` draws into the frame, at the point the frame calls `drawPass`.
- `dispose(device)` releases what `init` built.

`reads` declares the frame attachments the pass samples, such as depth, so the frame keeps them for
it. What a pass writes is wherever the frame is drawing; a pass cannot declare other writes into the
frame, which is why `prepare` exists for targets it owns.

The device and both contexts are tagged by backend, because a pass that draws on both has a
different shader and a different buffer layout on each and branches either way. On WebGPU the
device carries the frame's colour `format`, `depthFormat` and `samples`, which a pipeline cannot be
built without, and whether the frame is reconstructed. On WebGL2 it carries the context.

```ts sample=snippets/passes.ts#register
/** Registered once; drawn wherever the frame calls `drawPass`; let go when done. */
export function useWash(renderer: RendererApi): { draw(): void; release(): void } {
  const handle = renderer.registerPass(washPass());
  return {
    draw: () => renderer.drawPass(handle),
    release: () => renderer.unregisterPass(handle),
  };
}
```

`registerPass(definition)` returns a handle, `drawPass(handle)` draws it inside the frame, and
`unregisterPass(handle)` calls `dispose`. A handle kept after it is unregistered draws nothing; it
never draws whatever took its slot.

## The rules a pass keeps

- **It allocates nothing in `prepare` or `draw`.** They run every frame, and the engine's own rule
  about per-frame code binds them.
- **It leaves the context as it found it.** On WebGL2: the program, the vertex array, blend and depth
  state and the viewport; `prepare` also leaves the default framebuffer bound. On WebGPU only the
  viewport and scissor carry over between draws.
- **It corrects its projection.** A pass takes its camera from you, so it never sees the corrected
  matrix the renderer builds. Pre-multiply by `device.clipCorrection` if your WGSL was generated from
  GLSL with the engine's generator, and by `device.depthCorrection` if you wrote it by hand. The
  wrong one mirrors the world vertically, and mirrors the triangle winding with it, so it looks like
  a culling problem.
- **It grades only when the frame does not.** `ctx.outputTransform` is 0 when the end of the frame
  applies the tone curve, and otherwise says which curve this pass must apply itself, with
  `ctx.outputExposure`. `OUTPUT_TRANSFORM_GLSL` is the engine's own curve, so a pass applies the
  same one.
- **It jitters with a reconstructed frame.** With DriftTR on, a pass drawing the world applies the
  frame's jitter, `ctx.jitter`, with `jitterClip`, and writes its depth into the frame's attachment;
  see [DriftTR](drifttr.md).
- **It says what its blending does to the scene's alpha.** The scene's alpha holds how much of each
  pixel is still the opaque surface, and the composite darkens only that share with ambient
  occlusion, so a translucent draw is not darkened by a corner it hides. A pass drawing something
  blended over the world gives its alpha `SCENE_ALPHA_COVERS` (it hides what is behind by its
  alpha), `SCENE_ALPHA_TRANSMITS` (its alpha is what gets through) or `SCENE_ALPHA_KEEPS` (it adds
  light to the surface); on WebGL2, `blendCovering`, `blendTransmitting` or `blendKeeping` set the
  same thing beside the colour factors. An opaque draw writes 1.
- **It sizes its targets from the scene.** `renderer.sceneWidth` and `sceneHeight` are what the
  frame is drawn at, which is smaller than the canvas under reconstruction.

On WebGPU, `prepare` is also handed the frame's environment probe and, with DriftRay on, the world's
composed distance field, one frame behind, for a pass that wants to light or trace its own work the
way the frame does.

## Reading the frame

A pass cannot sample the frame it is drawing into, so it reads copies, and declares which:

- `reads: ['depthSnapshot']` hands it the frame's depth as it stands, one copy a frame, as
  `sceneDepth`: on WebGPU in the `PrepareContext`, a single-sample `r32float` texture to read with
  `textureLoad` or a non-filtering sampler, and on WebGL2 in the `PassContext`. It holds the depth
  buffer's own values, reversed as the buffer is: 1 at the near plane, 0 at the far one.
- `reads: ['colorSnapshot']` hands it the frame's colour with everything drawn before it, copied
  afresh at each such pass's draw, as `sceneColor`: on WebGPU in the `PrepareContext`, at the scene's
  size and format, and on WebGL2 in the `PassContext`. A distortion samples the scene behind it with
  it; a full-screen pass drawn last reads the whole frame and writes over it, in scene light, before
  the tone curve: a radial blur, a flash, a filter over the finished picture.

The views on WebGPU arrive in `prepare`, since a bind group is built before the frame's pass opens,
and are filled at the draw. Both copies are `null` without `screenEffects`, which is what keeps a
scene target to copy from.

**Under DriftTR a pass that reads the colour draws after the upscale**, over the reconstructed
picture and after every blended draw, whatever order it was asked in: otherwise it would read a frame
without the blended draws and then be covered by them. It draws at the output's size and the
reconstruction's format, which `ctx.format` names there, so it keeps a pipeline for that target. Its
`sceneDepth` stays the render's opaque depth: coarser by the ratio above a ratio of 1, and a blended
draw is in no depth either way.

## Compute

```ts sample=snippets/passes.ts#compute
/** A buffer of counters cleared on the device every frame, as the smallest compute definition. */
const CLEAR_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> counts: array<u32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x < arrayLength(&counts)) { counts[id.x] = 0u; }
}
`;

/** `GPUBufferUsage.STORAGE`, spelled as its value: the global exists only in a browser. */
const STORAGE = 0x0080;

export function clearCounters(size: number): ComputeDefinition {
  let pipeline: GPUComputePipeline | null = null;
  let group: GPUBindGroup | null = null;
  return {
    label: 'clear counters',
    init({ device }) {
      const buffer = device.createBuffer({ size: size * 4, usage: STORAGE });
      pipeline = device.createComputePipeline({
        layout: 'auto',
        compute: { module: device.createShaderModule({ code: CLEAR_WGSL }), entryPoint: 'main' },
      });
      group = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer } }],
      });
    },
    dispatch({ pass }) {
      if (pipeline === null || group === null) return;
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil(size / 64));
    },
  };
}

/** Only where the backend has compute at all; WebGL2 does not. */
export function startCounters(renderer: RendererApi): (() => void) | null {
  if (!renderer.computeSupported) return null;
  const handle = renderer.registerCompute(clearCounters(4096));
  return () => renderer.dispatchCompute(handle);
}
```

A `ComputeDefinition` is the same idea for the stage before drawing: `init` builds pipelines and
buffers from the device, and `dispatch(ctx)` sets a pipeline and bind groups and calls
`dispatchWorkgroups` on the compute pass the engine opened for it. The workgroup count is yours,
since it comes from data the definition owns. `registerCompute(definition)` returns a handle,
`dispatchCompute(handle)` runs it, and `unregisterCompute` releases it.

Compute is WebGPU only: WebGL2 has no compute stage. `renderer.computeSupported` says which you
have, and `registerCompute` refuses in words where it is false. A dispatch is submitted at once, so
its result is visible to everything recorded after it, including a draw pass in the same frame.

## Testing a compute shader

WGSL arithmetic can be wrong in ways no picture shows. The engine tests its own kernels by running
them on a real device and reading the buffers back against a TypeScript reference, with
`openGpuCompute` from `@driftengine/core/scripts/gpuCompute.mjs`. The same harness works for a game's own kernels;
it serves its page from a loopback server, since `navigator.gpu` needs a secure context.
