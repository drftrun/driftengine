import { describe, expect, it, vi } from 'vitest';

import { probeDevice } from './probe.ts';

/** The smallest object that behaves like the parts of `GPUDevice` the probe touches. */
function stubDevice(options: {
  compileError?: string;
  validationError?: string;
  pixel?: readonly [number, number, number, number];
}): GPUDevice {
  const pixel = options.pixel ?? [255, 0, 255, 255];
  const bytes = new Uint8Array([...pixel]);
  return {
    createShaderModule: vi.fn(() => ({
      getCompilationInfo: async () => ({
        messages:
          options.compileError === undefined
            ? []
            : [{ type: 'error', message: options.compileError }],
      }),
    })),
    createRenderPipeline: vi.fn(() => ({})),
    createTexture: vi.fn(() => ({ createView: () => ({}), destroy: vi.fn() })),
    createBuffer: vi.fn(() => ({
      mapAsync: async () => undefined,
      getMappedRange: () => bytes.buffer,
      unmap: vi.fn(),
      destroy: vi.fn(),
    })),
    createCommandEncoder: vi.fn(() => ({
      beginRenderPass: () => ({ setPipeline: vi.fn(), draw: vi.fn(), end: vi.fn() }),
      copyTextureToBuffer: vi.fn(),
      finish: () => ({}),
    })),
    pushErrorScope: vi.fn(),
    popErrorScope: async () =>
      options.validationError === undefined ? null : { message: options.validationError },
    queue: { submit: vi.fn(), onSubmittedWorkDone: async () => undefined },
  } as unknown as GPUDevice;
}

describe('probeDevice', () => {
  it('accepts a device that compiles and draws', async () => {
    const verdict = await probeDevice(stubDevice({}), ['@fragment fn f() {}']);
    expect(verdict.ok).toBe(true);
  });

  /*
   * The iOS black screen in one assertion. `navigator.gpu` was present, an adapter was
   * offered and a device was returned; what failed was the compile, and nothing asked.
   */
  it('refuses a device that cannot compile a shader it will be given', async () => {
    const verdict = await probeDevice(
      stubDevice({
        compileError: 'arrays in the uniform address space must have a stride multiple of 16 bytes',
      }),
      ['@fragment fn f() {}'],
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/stride multiple of 16/);
  });

  it('refuses a device that reports a validation error', async () => {
    const verdict = await probeDevice(stubDevice({ validationError: 'invalid bind group' }), []);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/invalid bind group/);
  });

  /*
   * The positive control. A probe that only checks for errors passes on a device that
   * validates everything and rasterises nothing, which is a black screen with a clean log.
   */
  it('refuses a device that draws nothing', async () => {
    const verdict = await probeDevice(stubDevice({ pixel: [0, 0, 0, 0] }), []);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/drew nothing/i);
  });
});
