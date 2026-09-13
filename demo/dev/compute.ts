/**
 * Does a dispatch run, and is what it wrote visible afterwards?
 *
 * **This page exists because a compute seam has no picture.** Every other feature in the engine is
 * checked by photographing it; a stage that writes a buffer and draws nothing cannot be. So the
 * evidence is a readback compared against hand-written numbers, and this is the page that produces
 * it for `scripts/compute-check.mjs`.
 *
 *     /compute.html?backend=webgpu   dispatches, reads back, and reports the values
 *     /compute.html?backend=webgl2   reports that the backend refused, which is also a result
 *
 * **The shader lives here rather than under `packages/`, on purpose.** It is a throwaway probe of
 * the seam and not a capability the engine offers, and a `createComputePipeline` under `packages/`
 * would fire the `compute-pipelines` sentinel in `CAPABILITIES.md` for a feature that does not
 * exist yet. The first one that belongs there arrives with the light binner.
 *
 * **What a failure looks like**, so it is recognised rather than explained away:
 *
 *   - **Every value zero** — the dispatch did not run, or its buffer was never written. Read the
 *     device console *first*: a WebGPU validation failure reports at `submit` naming the resource,
 *     not at the call that caused it, and every resource here is labelled so that message is
 *     readable. It is never a reason to start editing the shader.
 *   - **The first 64 correct and the rest zero** — one workgroup ran. The dispatch count is wrong.
 *   - **Values present but shifted** — the staging copy read the wrong offset, not the shader.
 *
 * Nothing here is engine API, and nothing under `packages/*​/src` may import it.
 */
import { createRenderer } from '../../packages/core/src/index';
import type { ComputeContext, ComputeDevice, RendererApi } from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

/** How many values the probe computes. Two workgroups at 64, so a wrong count shows as a half. */
const COUNT = 128;
const WORKGROUP = 64;

/**
 * Squares an index into a storage buffer.
 *
 * Squares rather than a copy, because a buffer that comes back holding its own indices is
 * indistinguishable from one the CPU filled and the GPU never touched.
 */
const SHADER = `
@group(0) @binding(0) var<storage, read_write> out: array<u32>;

@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= arrayLength(&out)) { return; }
  out[id.x] = id.x * id.x;
}
`;

/** What the page reports, and what the checker reads. */
interface Result {
  backend: string;
  supported: boolean;
  values: number[];
  error: string | null;
  /**
   * The handle a backend without compute hands back, or null where the question did not arise.
   *
   * Reported because **the refusal is the WebGL2 half of the contract** and a page that simply
   * declined to ask would leave it unexercised. Zero is the handle that names nothing.
   */
  refusedHandle: number | null;
}

/*
 * WebGPU's buffer usage flags, named rather than read off the global.
 *
 * `buffers.ts` gives the reason and it applies here too: the values are normative in the
 * specification, and the global does not exist outside a browser.
 */
const USAGE = {
  MAP_READ: 0x0001,
  COPY_SRC: 0x0004,
  COPY_DST: 0x0008,
  STORAGE: 0x0080,
} as const;

/** WebGPU's `GPUMapMode.READ`, named for the same reason. */
const MAP_MODE_READ = 0x0001;

async function probe(renderer: RendererApi, backend: string): Promise<Result> {
  if (!renderer.computeSupported) {
    /*
     * **Registered anyway, on purpose, and this is the one place that is right.**
     *
     * A consumer should read `computeSupported` and never register — which is exactly why the
     * refusal would otherwise ship untested. The 2026-08-13 rule's whole point is that the absence
     * is *spoken* rather than silent, and an unspoken refusal looks identical to a working one
     * from outside. So this page asks the question a well-behaved consumer would not, and the
     * checker asserts the answer arrives on the console naming the definition.
     */
    const refusedHandle = renderer.registerCompute({ label: 'probe.squares', dispatch: () => {} });
    return { backend, supported: false, values: [], error: null, refusedHandle };
  }

  /*
   * The resources `init` builds, held on an object rather than in four captured `let`s.
   *
   * Not a style choice: TypeScript's flow analysis cannot see an assignment made inside a callback,
   * so a `let` whose only visible assignment is `null` narrows to `never` at every later use. A
   * property is re-widened by the intervening calls, which is what makes the null checks below
   * mean anything.
   */
  const built: {
    device: GPUDevice | null;
    storage: GPUBuffer | null;
    pipeline: GPUComputePipeline | null;
    group: GPUBindGroup | null;
  } = { device: null, storage: null, pipeline: null, group: null };

  const handle = renderer.registerCompute({
    label: 'probe.squares',
    init(d: ComputeDevice) {
      built.device = d.device;
      built.storage = d.device.createBuffer({
        label: 'probe.squares.storage',
        size: COUNT * 4,
        usage: USAGE.STORAGE | USAGE.COPY_SRC,
      });
      built.pipeline = d.device.createComputePipeline({
        label: 'probe.squares',
        layout: 'auto',
        compute: {
          module: d.device.createShaderModule({ label: 'probe.squares', code: SHADER }),
          entryPoint: 'main',
        },
      });
      built.group = d.device.createBindGroup({
        label: 'probe.squares',
        layout: built.pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: built.storage } }],
      });
    },
    dispatch(ctx: ComputeContext) {
      if (built.pipeline === null || built.group === null) return;
      ctx.pass.setPipeline(built.pipeline);
      ctx.pass.setBindGroup(0, built.group);
      /* The count is the definition's, which is why it does not cross the surface. */
      ctx.pass.dispatchWorkgroups(Math.ceil(COUNT / WORKGROUP));
    },
  });

  renderer.dispatchCompute(handle);

  const { device, storage } = built;
  if (device === null || storage === null) {
    return { backend, supported: true, values: [], error: 'init never ran', refusedHandle: null };
  }

  /*
   * The readback, on an encoder of the page's own.
   *
   * **Nothing was added to the seam for this.** A definition holds the device from `init`, so it
   * can encode a copy itself, and submission order is execution order — this copy is submitted
   * after the dispatch and therefore sees it. That was checked before the surface was designed,
   * because a readback that needed the renderer's encoder would have grown the API.
   */
  const staging = device.createBuffer({
    label: 'probe.squares.staging',
    size: COUNT * 4,
    usage: USAGE.MAP_READ | USAGE.COPY_DST,
  });
  const encoder = device.createCommandEncoder({ label: 'probe.readback' });
  encoder.copyBufferToBuffer(storage, 0, staging, 0, COUNT * 4);
  device.queue.submit([encoder.finish()]);

  await staging.mapAsync(MAP_MODE_READ);
  const values = Array.from(new Uint32Array(staging.getMappedRange().slice(0)));
  staging.unmap();
  staging.destroy();
  renderer.unregisterCompute(handle);

  return { backend, supported: true, values, error: null, refusedHandle: null };
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const out = document.getElementById('out') as HTMLElement;
  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  const renderer: RendererApi = created.renderer;

  let result: Result;
  try {
    result = await probe(renderer, created.backend);
  } catch (error) {
    result = {
      backend: created.backend,
      supported: renderer.computeSupported,
      values: [],
      error: error instanceof Error ? error.message : String(error),
      refusedHandle: null,
    };
  }

  (globalThis as unknown as { __computeCheck: Result }).__computeCheck = result;
  out.textContent =
    `backend ${result.backend}\ncomputeSupported ${result.supported}\n` +
    (result.error !== null ? `error ${result.error}\n` : '') +
    `first eight ${result.values.slice(0, 8).join(' ')}`;
}

void main();
