import type { RenderBackend } from './api.ts';
import { probeDevice } from './probe.ts';
import { TIMED_OUT, withDeadline } from './deadline.ts';
import { adapterRendererName } from '../gpuCapability.ts';

/** What was chosen, what it was chosen with, and why. */
export interface BackendChoice {
  readonly backend: RenderBackend;
  /**
   * A live device, held only when `backend` is `webgpu`.
   *
   * Returned rather than re-requested by the caller, because an adapter request is the
   * expensive part and asking twice can legitimately give a different answer.
   */
  readonly device: GPUDevice | null;
  /**
   * What the adapter calls this part, or null where nothing was asked.
   *
   * The WebGPU counterpart of `UNMASKED_RENDERER_WEBGL`, and the reason the capability clamp
   * can fire on this backend at all: `isWeakGpuFamily` matches on a part number, and this
   * backend used to hand it the literal string `WebGPU`.
   */
  readonly rendererName: string | null;
  /** Why this backend, in words a bug report can carry. */
  readonly reason: string;
}

/**
 * A backend named in the address, or null.
 *
 * **Honoured in every build rather than behind a development flag.** A fallback that can
 * only be reached by owning the wrong device is a fallback nobody tests, and the failure
 * that produces is a black screen for somebody who cannot be asked to help diagnose it.
 *
 * An unrecognised value is *no request* rather than a default, and the strictness is the
 * point: `?backend=WebGPU` silently selecting WebGL2 is somebody testing the path they
 * meant to avoid and drawing a confident conclusion from it.
 */
export function forcedBackend(search: string): RenderBackend | null {
  const value = new URLSearchParams(search).get('backend');
  return value === 'webgl2' || value === 'webgpu' ? value : null;
}

/**
 * Decide which backend to build, and prove it by holding a device.
 *
 * **The probe is the whole of the decision.** The presence of `navigator.gpu` is not proof
 * of a working device: a supported browser refuses adapters for blocklisted drivers,
 * headless contexts and low-power states, and a device request can fail after an adapter
 * succeeds. So nothing is reported as WebGPU until an adapter *and* a device have both been
 * handed over, and every other path falls back with a reason attached.
 *
 * Nothing here throws. A failure to get WebGPU is an ordinary outcome on most devices in
 * the world, not an error, and treating it as one would put a try/catch in every consumer's
 * boot for a case that is expected.
 */
/**
 * How long the whole WebGPU acquisition may take before this answers WebGL2 instead.
 *
 * **Because a preference that cannot fall back is not a preference.** Every refusal below is a
 * refusal somebody receives: an adapter that answers null, a device request that throws, a device
 * that cannot draw. A request that simply never settles is none of those, and it has no floor under
 * it — the boot stops at the `await`, nothing throws, nothing is logged, and what a player gets is
 * the window the game was going to be drawn in. Reported from outside exactly that way, on a driver
 * and compositor where the adapter is offered and the acquisition never returns.
 *
 * **Eight seconds, against 153 ms measured.** On this repository's machine the whole acquisition —
 * adapter, device at the adapter's own ceilings, and the one-pixel draw and readback that proves it
 * works — takes 153 ms warm, against 36 ms for the WebGL2 path it would fall back to. Eight seconds
 * is fifty times that, which leaves room for a cold shader cache on a slower part while still being
 * inside what a person will wait through. Past it, WebGL2 is not a downgrade so much as the only
 * backend that is going to draw anything.
 */
export const BACKEND_TIMEOUT_MS = 8_000;

/**
 * @param timeoutMs How long the WebGPU path may take before WebGL2 is answered instead.
 *   `Infinity` waits forever, which is what this did before the deadline existed.
 */
export async function selectBackend(
  search: string,
  preferWebGpu: boolean,
  wantsGpuTiming = false,
  shaders: readonly string[] = [],
  timeoutMs: number = BACKEND_TIMEOUT_MS,
): Promise<BackendChoice> {
  const forced = forcedBackend(search);
  if (forced === 'webgl2') {
    return {
      backend: 'webgl2',
      device: null,
      rendererName: null,
      reason: 'forced by ?backend=webgl2',
    };
  }

  const wanted = forced === 'webgpu' || preferWebGpu;
  if (!wanted)
    return { backend: 'webgl2', device: null, rendererName: null, reason: 'WebGPU not requested' };

  const gpu = (globalThis.navigator as Navigator | undefined)?.gpu;
  if (gpu === undefined || gpu === null) {
    return {
      backend: 'webgl2',
      device: null,
      rendererName: null,
      reason: 'WebGPU not supported here',
    };
  }

  /*
   * **What it was doing when it stopped, kept as a word.** A stalled boot in a packaged artifact has
   * no developer tools behind it and no stack anybody can quote, and the only question worth
   * answering is which of the three awaits it is sitting in. The reason string carries that instead
   * of asking for a reproduction under a debugger.
   */
  const stage = { at: 'requesting an adapter' };
  const acquisition = acquireWebGpu(gpu, wantsGpuTiming, shaders, stage);
  const settled = await withDeadline(acquisition, timeoutMs);
  if (settled !== TIMED_OUT) return settled;

  /*
   * **The abandoned request is still running, and it may still produce a device.** Nothing else
   * will free one that arrives after this point, so it is destroyed on arrival rather than left to
   * hold a GPU allocation for the life of the process. The rejection is swallowed for the same
   * reason it is swallowed below: this path has already answered.
   */
  void acquisition.then((late) => late.device?.destroy()).catch(() => {});
  return {
    backend: 'webgl2',
    device: null,
    rendererName: null,
    reason: `WebGPU stalled while ${stage.at}, fell back after ${timeoutMs} ms`,
  };
}

/** Adapter, device and the draw that proves it works, or the reason none of that happened. */
async function acquireWebGpu(
  gpu: GPU,
  wantsGpuTiming: boolean,
  shaders: readonly string[],
  stage: { at: string },
): Promise<BackendChoice> {
  try {
    const adapter = await gpu.requestAdapter();
    if (adapter === null) {
      return {
        backend: 'webgl2',
        device: null,
        rendererName: null,
        reason: 'no WebGPU adapter offered',
      };
    }
    /*
     * **Ask for the sampled-texture limit the flat shader actually needs.**
     *
     * A device defaults to `maxSampledTexturesPerShaderStage: 16`, and the widest permutation
     * of the flat shader declares **seventeen**: one albedo, three directional shadow maps,
     * twelve point-shadow cubes and the environment probe. Creating the bind group layout for
     * it is rejected outright — *"The number of sampled textures (17) in the Fragment stage
     * exceeds the maximum per-stage limit (16)"* — and because that failure lands on a
     * *pipeline*, the frame goes on drawing everything else and says nothing beyond a device
     * warning.
     *
     * Clamped to what the adapter actually offers rather than demanded, and a request that
     * cannot be met is a fallback to WebGL2 rather than a throw: this machine's adapter reports
     * 48, and one that reports 16 is a machine whose widest profile genuinely will not fit.
     */
    /*
     * **Ask for as much binding room as the adapter will give, and never more.**
     *
     * A device defaults to 16 sampled textures and 16 samplers per stage, and the widest
     * permutation of the flat shader declares **seventeen** of each: one albedo, three
     * directional shadow maps, twelve point-shadow cubes and the environment probe. The default
     * rejects the bind group layout outright, and because that lands on a *pipeline* the frame
     * carries on drawing everything else and says nothing but a device warning.
     *
     * **Two limits, and the second only appears once the first is raised.** They are counted
     * separately: raising the textures alone moved the message from "the number of sampled
     * textures (17)" to "the number of samplers (17)" and changed nothing else.
     *
     * **Requested at the adapter's own ceiling rather than at a number chosen here**, because
     * asking for more than it supports is not a clamp, it is a rejected device — measured on
     * this machine, which offers 48 sampled textures and exactly 16 samplers, so a flat request
     * for 20 threw and lost WebGPU entirely. The renderer reads the same numbers back off the
     * device and drops the probe when the variant will not fit; see `WebGPURenderer`.
     */
    /*
     * **And the buffer ceiling, because a bought model is bigger than a default allows.**
     *
     * `maxBufferSize` defaults to 256 MiB while this machine's adapter offers 4 GiB, and a
     * merged mesh from an imported model passes the default easily: a reported one asked for
     * **298,273,296 bytes** for a single `mesh.vertices`. WebGL2 has no such ceiling, so the same
     * model loads on one backend and not the other — and the failure is not a refusal anybody
     * reads, it is an invalid buffer that then invalidates every command buffer that touches it,
     * so the console fills with a hundred repeats of *"is invalid due to a previous error"* from
     * the shadow pass and the frame, and the subject is simply absent.
     *
     * Asked for at the adapter's ceiling like the two above and for the same reason: more than
     * it offers is a rejected device rather than a clamp. A part whose adapter genuinely caps at
     * the default still refuses the model, and `WebGPURenderer.createMesh` says so in one line
     * rather than letting the driver say it a hundred times.
     */
    const required: Record<string, number> = {};
    for (const limit of [
      'maxSampledTexturesPerShaderStage',
      'maxSamplersPerShaderStage',
      'maxBufferSize',
    ] as const) {
      const ceiling = adapter.limits[limit];
      if (typeof ceiling === 'number' && ceiling > 0) required[limit] = ceiling;
    }
    /*
     * **Asked for only where the adapter offers it, and never demanded.** A `requiredFeatures`
     * naming something the adapter lacks does not clamp, it rejects the device outright — the
     * same trap the limits above carry — and losing WebGPU entirely in exchange for a
     * diagnostic would be a poor trade. Without it `GpuTimestamps` reports `available: false`,
     * which is the honest answer rather than a silent zero.
     */
    /*
     * **What part this is, in the same shape `UNMASKED_RENDERER_WEBGL` gives on the other
     * backend.** Without it `WebGPURenderer.rendererName` was the literal string `WebGPU`, so
     * `isWeakGpuFamily` had nothing to match and the capability clamp could not fire at all —
     * the clamp that rescued an Adreno 619 on WebGL2 was dead on the backend that replaced it.
     *
     * Every field is optional and browsers withhold them to differing degrees, so they are
     * joined rather than formatted: a string with a vendor and nothing else is still something
     * the table can recognise, and an empty one falls back to the old literal so nothing that
     * reads it gets an empty label.
     */
    const rendererName = adapterRendererName(adapter.info as GPUAdapterInfo | undefined);

    const features: GPUFeatureName[] = [];
    /*
     * Asked for only when a consumer wants to measure. A feature that is requested is a feature
     * the device carries, and this one exists to be attached to every render pass — see
     * `RenderQuality.gpuTiming` for why that was the wrong thing to hand everybody by default.
     */
    if (wantsGpuTiming && adapter.features?.has('timestamp-query') === true) {
      features.push('timestamp-query');
    }
    const descriptor: GPUDeviceDescriptor = {};
    if (Object.keys(required).length > 0) descriptor.requiredLimits = required;
    if (features.length > 0) descriptor.requiredFeatures = features;
    stage.at = 'requesting a device';
    const device = await adapter.requestDevice(descriptor);
    if (device === null || device === undefined) {
      return {
        backend: 'webgl2',
        device: null,
        rendererName: null,
        reason: 'WebGPU device request gave nothing',
      };
    }
    /*
     * **A device is not a backend until it has drawn.** Everything above this asks whether WebGPU
     * exists; this asks whether it works, which is a different question and the one the iOS black
     * screen turned on. A refusal here is an ordinary fallback and not an error: it lands on the
     * same WebGL2 path as a browser with no `navigator.gpu`, carrying a reason in the device's own
     * words.
     *
     * **Cost:** one pipeline and one 1x1 readback, once, before the first frame. Passing `shaders`
     * adds their compile — see `CreateRendererOptions.probeShaders` for what that was measured at
     * and why it is not the default.
     */
    stage.at = 'drawing the acceptance probe';
    const verdict = await probeDevice(device, shaders);
    if (!verdict.ok) {
      device.destroy();
      return { backend: 'webgl2', device: null, rendererName: null, reason: verdict.reason };
    }

    return {
      backend: 'webgpu',
      device,
      rendererName,
      reason: 'WebGPU adapter and device acquired',
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      backend: 'webgl2',
      device: null,
      rendererName: null,
      reason: `WebGPU device request failed: ${detail}`,
    };
  }
}
