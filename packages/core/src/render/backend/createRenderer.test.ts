import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_PIPELINE, createRenderer, pipelineRefusal } from './createRenderer.ts';

/*
 * No GL context exists in this environment, so what is checked here is the contract around
 * construction rather than a drawn frame: that the factory is asynchronous, that it reports
 * which backend it chose, and that a canvas which cannot give a context fails loudly at init
 * rather than returning something half-built. The drawn frame is `shots.mjs`'s job and
 * cannot be done here.
 */
describe('createRenderer', () => {
  it('fails at init when the canvas cannot give a context at all', async () => {
    const canvas = { getContext: vi.fn(() => null) } as unknown as HTMLCanvasElement;
    await expect(createRenderer(canvas)).rejects.toThrow(/webgl2/i);
    expect(canvas.getContext).toHaveBeenCalled();
  });

  /*
   * `AGENTS.md` requires failing fast at init. A rejected promise is that, and it matters
   * that it rejects rather than resolving with a renderer that throws on the first frame:
   * the frame loop is the one place this engine may not throw.
   */
  it('rejects rather than resolving with something unusable', async () => {
    const canvas = { getContext: vi.fn(() => null) } as unknown as HTMLCanvasElement;
    const settled = await createRenderer(canvas).then(
      () => 'resolved',
      () => 'rejected',
    );
    expect(settled).toBe('rejected');
  });

  /*
   * The default asks. It did not for as long as the second backend was being built, and the
   * comment holding that in place pointed at a numbered task in a plan — which is exactly how
   * a default outlives its reason: every consumer that exists was already passing
   * `preferWebGpu: true`, so the conservative default was overridden everywhere and described
   * nowhere.
   *
   * A consumer who wants the old boot still has it, and it is one word: `preferWebGpu: false`.
   */
  it('asks for an adapter by default', async () => {
    const requestAdapter = vi.fn(async () => null);
    vi.stubGlobal('navigator', { gpu: { requestAdapter } });
    const canvas = { getContext: vi.fn(() => null) } as unknown as HTMLCanvasElement;
    await createRenderer(canvas, {}, { search: '' }).catch(() => undefined);
    expect(requestAdapter).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  /*
   * And the opt-out is real rather than nominal, because it is what a consumer boots on when
   * an adapter request is slow enough to be felt.
   */
  it('does not ask for an adapter when the caller declines it', async () => {
    const requestAdapter = vi.fn();
    vi.stubGlobal('navigator', { gpu: { requestAdapter } });
    const canvas = { getContext: vi.fn(() => null) } as unknown as HTMLCanvasElement;
    await createRenderer(canvas, {}, { search: '', preferWebGpu: false }).catch(() => undefined);
    expect(requestAdapter).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  /*
   * The device the probe acquires is released again, because nothing reads it yet and an
   * unread device costs memory and can keep a discrete GPU awake.
   */
  it('destroys a device it acquired but cannot use yet', async () => {
    const destroy = vi.fn();
    vi.stubGlobal('navigator', {
      gpu: {
        requestAdapter: async () => ({
          limits: { maxSampledTexturesPerShaderStage: 48 },
          requestDevice: async () => ({ destroy }),
        }),
      },
    });
    const canvas = { getContext: vi.fn(() => null) } as unknown as HTMLCanvasElement;
    await createRenderer(canvas, {}, { search: '?backend=webgpu' }).catch(() => undefined);
    expect(destroy).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});

/**
 * **The deadline is a public option, and an option that is not passed on is not an option.**
 *
 * `selectBackend` defaults it, so a factory that quietly dropped the argument would still bound the
 * wait and every test of the bound would still pass — the only thing lost is the caller's ability
 * to choose, which nothing else here would notice. It was lost exactly that way once, by a revert
 * that took the threading and left the deadline.
 */
it('passes its deadline through to the backend choice', async () => {
  vi.stubGlobal('navigator', {
    gpu: {
      requestAdapter: async () => ({
        limits: { maxSampledTexturesPerShaderStage: 48 },
        /* Never settles, so whichever deadline arrives is the one that answers. */
        requestDevice: () => new Promise<never>(() => {}),
      }),
    },
  });
  const canvas = { getContext: vi.fn(() => null) } as unknown as HTMLCanvasElement;
  const started = Date.now();
  /* WebGL2 is unavailable here too, so the rejection is the WebGL2 path being reached at all. */
  /* Third argument: the second is render quality, and an option in the wrong one is silently
     ignored — which is how the first version of this test waited the full default out. */
  await expect(createRenderer(canvas, {}, { backendTimeoutMs: 30 })).rejects.toThrow(/webgl2/i);
  const took = Date.now() - started;
  expect(took, 'it waited for the deadline it was given').toBeLessThan(2_000);
  vi.unstubAllGlobals();
});

/**
 * **And the second half of the branch, which had no bound at all.**
 *
 * Acquisition is bounded inside `selectBackend`, and that bound was reported as present, visible
 * and never firing: every GPU call in a hung page completed by hand in milliseconds while the
 * engine's boot never returned. What that leaves is everything after the device — a dynamically
 * imported backend, a surface, a renderer — which in a packaged artifact means chunks fetched
 * through the application's own protocol handler. A request that never answers is a boot that never
 * finishes, and none of it is a GPU fault.
 *
 * Faked at the import, because that is the await in question: a loader that never resolves is what
 * a protocol handler that does not answer looks like from inside `await import(...)`.
 */
describe('a WebGPU backend that never finishes loading', () => {
  /**
   * A device that passes the acceptance probe.
   *
   * It has to: the probe runs before the import, so a stub that cannot draw falls back one step too
   * early and the test would pass with the deadline deleted — which is what the first version of it
   * did.
   */
  function drawableDevice(): GPUDevice {
    const magenta = new Uint8Array([255, 0, 255, 255]);
    return {
      label: 'fake',
      destroy: vi.fn(),
      pushErrorScope: vi.fn(),
      popErrorScope: async () => null,
      createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
      createRenderPipeline: () => ({}),
      createTexture: () => ({ createView: () => ({}), destroy: vi.fn() }),
      createBuffer: () => ({
        mapAsync: async () => undefined,
        getMappedRange: () => magenta.buffer,
        unmap: vi.fn(),
        destroy: vi.fn(),
      }),
      createCommandEncoder: () => ({
        beginRenderPass: () => ({ setPipeline: vi.fn(), draw: vi.fn(), end: vi.fn() }),
        copyTextureToBuffer: vi.fn(),
        finish: () => ({}),
      }),
      queue: { submit: vi.fn(), onSubmittedWorkDone: async () => undefined },
    } as unknown as GPUDevice;
  }

  it('falls back rather than waiting, and says which step it was in', async () => {
    vi.doMock('./webgpu/device.ts', () => new Promise<never>(() => {}));
    const device = drawableDevice();
    vi.stubGlobal('navigator', {
      gpu: {
        requestAdapter: async () => ({
          limits: { maxSampledTexturesPerShaderStage: 48 },
          requestDevice: async () => device,
        }),
      },
    });
    const canvas = {
      width: 8,
      height: 8,
      getContext: vi.fn(() => null),
    } as unknown as HTMLCanvasElement;
    const { createRenderer: fresh } = await import('./createRenderer.ts');
    /* WebGL2 is unavailable here, so reaching its constructor at all is the observable. */
    const outcome = await fresh(canvas, {}, { backendTimeoutMs: 60 }).then(
      (created) => `resolved:${created.backend}`,
      (error: unknown) => `rejected:${String(error)}`,
    );
    expect(outcome).toMatch(/webgl2/i);
    /*
     * The device is destroyed on that path too, and this environment cannot witness it: WebGL2 is
     * unavailable here, so the fallback renderer throws and the enclosing catch frees the device
     * anyway. An assertion on it would pass with the timeout deleted, which is worth less than
     * nothing. What this test holds is that the wait ends.
     */
    vi.doUnmock('./webgpu/device.ts');
    vi.unstubAllGlobals();
  }, 20_000);
});

/**
 * The pipeline request, which is the one decision in this factory that refuses rather than falls
 * back.
 *
 * **Nothing in this environment can resolve a renderer** — there is no GL context and no adapter,
 * so every test above ends in a rejection — which is why the decision is a function rather than an
 * expression buried in the factory. `built` is its only caller and every return passes through
 * `built`, including the three that arrive having fallen back from WebGPU.
 */
describe('the pipeline a caller asks for', () => {
  it('IS CHECKED AGAINST THE BACKEND THAT WILL DRAW, not the one that was asked for', () => {
    /* The reason string is the fallback's own, which is exactly the case a check written against
       the request would pass: WebGPU was asked for and WebGL2 is drawing. */
    const refused = pipelineRefusal('gpu-driven', 'webgl2', 'WebGPU stalled, fell back');
    expect(refused).not.toBeNull();
    expect(refused).toContain('indirect');
    expect(refused).toContain('WebGPU stalled');
  });

  it('is allowed where the backend can run it', () => {
    expect(pipelineRefusal('gpu-driven', 'webgpu', 'WebGPU requested')).toBeNull();
  });

  it('and the forward path is allowed everywhere, which is why it is the default', () => {
    expect(pipelineRefusal('forward', 'webgl2', 'no adapter')).toBeNull();
    expect(pipelineRefusal('forward', 'webgpu', 'WebGPU requested')).toBeNull();
  });

  it('DEFAULTS TO FORWARD, which is the constraint this whole wave is built around', () => {
    /* A literal inside the `??` was unreachable from here and flipping it changed no test. The
       constant is where the decision lives, so the constant is what is asserted. */
    expect(DEFAULT_PIPELINE).toBe('forward');
  });

  it('SAYS WHY IN WORDS, because a consumer cannot read a stack out of a packaged build', () => {
    const refused = pipelineRefusal('gpu-driven', 'webgl2', 'no adapter') ?? '';
    expect(refused).toContain('driftengine');
    expect(refused).toContain('readback');
  });
});
