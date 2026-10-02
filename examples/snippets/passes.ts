/**
 * A pass of your own, drawn into the frame, and a compute definition dispatched before it.
 *
 * A snippet, typechecked with the examples and quoted by the manual's custom passes chapter.
 */
import type { ComputeDefinition, PassDefinition, RendererApi } from '@driftengine/core';

// #region pass
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
                alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
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
// #endregion

// #region register
/** Registered once; drawn wherever the frame calls `drawPass`; let go when done. */
export function useWash(renderer: RendererApi): { draw(): void; release(): void } {
  const handle = renderer.registerPass(washPass());
  return {
    draw: () => renderer.drawPass(handle),
    release: () => renderer.unregisterPass(handle),
  };
}
// #endregion

// #region compute
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
// #endregion
