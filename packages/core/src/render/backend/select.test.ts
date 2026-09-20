import { afterEach, describe, expect, it, vi } from 'vitest';

import { forcedBackend, selectBackend } from './select.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * A device that passes the acceptance probe.
 *
 * Full rather than `{ label: 'fake' }`, because selection now *draws* with what it is handed
 * before reporting WebGPU — so a stub that cannot draw is a stub that reaches the WebGL2
 * fallback, and a test asserting WebGPU against one would only ever be asserting that the
 * probe is broken.
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

describe('the backend override', () => {
  it('forces WebGL2 from the query string', () => {
    expect(forcedBackend('?backend=webgl2')).toBe('webgl2');
  });

  it('forces WebGPU from the query string', () => {
    expect(forcedBackend('?backend=webgpu')).toBe('webgpu');
  });

  it('is absent when nothing asked', () => {
    expect(forcedBackend('?day=9')).toBeNull();
    expect(forcedBackend('')).toBeNull();
  });

  /*
   * An unknown value is not a silent default: a typo in a forced backend is somebody
   * testing the wrong path and concluding the wrong thing about it.
   */
  it('treats an unrecognised value as no request', () => {
    expect(forcedBackend('?backend=vulkan')).toBeNull();
    expect(forcedBackend('?backend=')).toBeNull();
    expect(forcedBackend('?backend=WebGPU')).toBeNull();
  });
});

describe('selecting a backend', () => {
  it('falls back when the platform has no gpu at all', async () => {
    vi.stubGlobal('navigator', {});
    const choice = await selectBackend('', true);
    expect(choice.backend).toBe('webgl2');
    expect(choice.device).toBeNull();
    expect(choice.reason).toMatch(/not supported|unavailable/i);
  });

  /*
   * The case that is not obvious and is the one that bites in the field: the API is present
   * and the adapter is refused anyway. Browsers refuse them for blocklisted drivers,
   * headless contexts and low-power states, so `navigator.gpu` existing proves nothing.
   */
  it('falls back when an adapter is refused', async () => {
    vi.stubGlobal('navigator', { gpu: { requestAdapter: async () => null } });
    const choice = await selectBackend('', true);
    expect(choice.backend).toBe('webgl2');
    expect(choice.device).toBeNull();
    expect(choice.reason).toMatch(/adapter/i);
  });

  it('falls back when the device request throws', async () => {
    vi.stubGlobal('navigator', {
      gpu: {
        requestAdapter: async () => ({
          /* A real adapter always reports these; `selectBackend` reads one to size its request. */
          limits: { maxSampledTexturesPerShaderStage: 48 },
          requestDevice: async () => {
            throw new Error('nope');
          },
        }),
      },
    });
    const choice = await selectBackend('', true);
    expect(choice.backend).toBe('webgl2');
    expect(choice.device).toBeNull();
    expect(choice.reason).toMatch(/device/i);
  });

  /* A device request that resolves null is the same refusal in a different shape. */
  it('falls back when the device request resolves nothing', async () => {
    vi.stubGlobal('navigator', {
      gpu: {
        requestAdapter: async () => ({
          limits: { maxSampledTexturesPerShaderStage: 48 },
          requestDevice: async () => null,
        }),
      },
    });
    const choice = await selectBackend('', true);
    expect(choice.backend).toBe('webgl2');
    expect(choice.device).toBeNull();
  });

  /*
   * **The storage binding ceiling, at the adapter's own number.** It defaults to 128 MiB while this
   * machine's adapter offers 4 GiB, and the GPU-driven pipeline binds its whole vertex buffer as
   * one storage binding: the voxel sandbox's port at a radius of ten asked for 262,807,200 bytes,
   * and what came back was a hundred device warnings and a world with no terrain in it.
   */
  it('ASKS FOR THE ADAPTER\u2019S LARGEST STORAGE BINDING, as it asks for its largest buffer', async () => {
    const device = drawableDevice();
    let asked: GPUDeviceDescriptor | undefined;
    vi.stubGlobal('navigator', {
      gpu: {
        requestAdapter: async () => ({
          limits: {
            maxSampledTexturesPerShaderStage: 48,
            maxBufferSize: 4294967296,
            maxStorageBufferBindingSize: 4294967292,
          },
          requestDevice: async (descriptor: GPUDeviceDescriptor) => {
            asked = descriptor;
            return device;
          },
        }),
      },
    });
    await selectBackend('', true);
    expect(asked?.requiredLimits?.['maxStorageBufferBindingSize']).toBe(4294967292);
    expect(asked?.requiredLimits?.['maxBufferSize']).toBe(4294967296);
  });

  it('reports WebGPU only once it holds a device', async () => {
    const device = drawableDevice();
    vi.stubGlobal('navigator', {
      gpu: {
        requestAdapter: async () => ({
          limits: { maxSampledTexturesPerShaderStage: 48 },
          requestDevice: async () => device,
        }),
      },
    });
    const choice = await selectBackend('', true);
    expect(choice.backend).toBe('webgpu');
    expect(choice.device).toBe(device);
  });

  /*
   * The device is real, the adapter offered it, and it still cannot draw the game. This is the
   * iOS black screen reduced to one assertion: everything above this point passed there too.
   */
  it('falls back to WebGL2 when the device cannot draw, and says why', async () => {
    const destroy = vi.fn();
    vi.stubGlobal('navigator', {
      gpu: {
        requestAdapter: async () => ({
          limits: { maxSampledTexturesPerShaderStage: 48 },
          requestDevice: async () => ({
            destroy,
            pushErrorScope: () => undefined,
            popErrorScope: async () => null,
            createShaderModule: () => ({
              getCompilationInfo: async () => ({
                messages: [{ type: 'error', message: 'stride multiple of 16 bytes' }],
              }),
            }),
          }),
        }),
      },
    });

    const choice = await selectBackend('', true, false, ['@fragment fn f() {}']);

    expect(choice.backend).toBe('webgl2');
    expect(choice.reason).toMatch(/stride multiple of 16/);
    expect(destroy).toHaveBeenCalled();
  });

  it('does not probe at all when WebGL2 is forced', async () => {
    const requestAdapter = vi.fn();
    vi.stubGlobal('navigator', { gpu: { requestAdapter } });
    const choice = await selectBackend('?backend=webgl2', true);
    expect(choice.backend).toBe('webgl2');
    expect(requestAdapter).not.toHaveBeenCalled();
  });

  /* Forcing WebGPU probes even when the caller did not ask for it by preference. */
  it('probes when WebGPU is forced against the preference', async () => {
    const requestAdapter = vi.fn(async () => null);
    vi.stubGlobal('navigator', { gpu: { requestAdapter } });
    const choice = await selectBackend('?backend=webgpu', false);
    expect(requestAdapter).toHaveBeenCalled();
    expect(choice.backend).toBe('webgl2');
  });

  it('does not probe when WebGPU is neither preferred nor forced', async () => {
    const requestAdapter = vi.fn();
    vi.stubGlobal('navigator', { gpu: { requestAdapter } });
    const choice = await selectBackend('', false);
    expect(choice.backend).toBe('webgl2');
    expect(requestAdapter).not.toHaveBeenCalled();
  });
});

/**
 * **A request that never settles, which is the refusal with nothing under it.**
 *
 * Every other way WebGPU can fail arrives as an answer: a null adapter, a throw, a device that
 * cannot draw. Each of those lands on WebGL2 carrying a reason. A device request that simply does
 * not return is none of them — the boot stops at an `await`, nothing throws, nothing is logged, and
 * a player is left looking at the window the game was going to be drawn in. Reported from outside
 * on a driver and compositor where the adapter is offered and the acquisition never returns.
 */
describe('a WebGPU acquisition that does not settle', () => {
  /** An adapter whose device request is a promise nobody resolves. */
  function stalls(never: Promise<never>): void {
    vi.stubGlobal('navigator', {
      gpu: {
        requestAdapter: async () => ({
          limits: { maxSampledTexturesPerShaderStage: 48 },
          requestDevice: () => never,
        }),
      },
    });
  }

  it('falls back to WebGL2 rather than waiting for it', async () => {
    stalls(new Promise<never>(() => {}));
    const choice = await selectBackend('', true, false, [], 20);
    expect(choice.backend).toBe('webgl2');
    expect(choice.device).toBeNull();
    expect(choice.reason).toMatch(/stalled while requesting a device, fell back after 20 ms/);
  });

  /** A stalled adapter is the same failure one step earlier, and gets the same floor. */
  it('bounds the adapter request too, not only the device', async () => {
    vi.stubGlobal('navigator', { gpu: { requestAdapter: () => new Promise<never>(() => {}) } });
    const choice = await selectBackend('', true, false, [], 20);
    expect(choice.backend).toBe('webgl2');
    expect(choice.reason).toMatch(/stalled while requesting an adapter/);
  });

  /*
   * The abandoned request is still running and may still produce a device. Nothing else will free
   * one that arrives after the answer, so it is destroyed on arrival rather than left holding a GPU
   * allocation for the life of the process.
   */
  it('destroys a device that turns up after the deadline', async () => {
    const device = drawableDevice();
    let handOver: (value: GPUDevice) => void = () => {};
    const late = new Promise<GPUDevice>((resolve) => {
      handOver = resolve;
    });
    vi.stubGlobal('navigator', {
      gpu: {
        requestAdapter: async () => ({
          limits: { maxSampledTexturesPerShaderStage: 48 },
          requestDevice: () => late,
        }),
      },
    });
    const choice = await selectBackend('', true, false, [], 20);
    expect(choice.backend).toBe('webgl2');
    expect(device.destroy).not.toHaveBeenCalled();
    handOver(device);
    /* Two turns: one for the device to arrive, one for the probe and the destroy behind it. */
    for (let i = 0; i < 8; i++) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(device.destroy).toHaveBeenCalled();
  });

  /** And a deadline is a bound rather than a delay: a device that arrives in time is still used. */
  it('does not cost a backend that answers promptly', async () => {
    const device = drawableDevice();
    vi.stubGlobal('navigator', {
      gpu: {
        requestAdapter: async () => ({
          limits: { maxSampledTexturesPerShaderStage: 48 },
          requestDevice: async () => device,
        }),
      },
    });
    const choice = await selectBackend('', true, false, [], 5_000);
    expect(choice.backend).toBe('webgpu');
    expect(choice.device).toBe(device);
    expect(device.destroy).not.toHaveBeenCalled();
  });

  /** `Infinity` is how a caller asks for what this did before the deadline existed. */
  it('waits without bound when asked to', async () => {
    const device = drawableDevice();
    vi.stubGlobal('navigator', {
      gpu: {
        requestAdapter: async () => ({
          limits: { maxSampledTexturesPerShaderStage: 48 },
          requestDevice: () =>
            new Promise<GPUDevice>((resolve) => setTimeout(() => resolve(device), 30)),
        }),
      },
    });
    const choice = await selectBackend('', true, false, [], Infinity);
    expect(choice.backend).toBe('webgpu');
  });
});
