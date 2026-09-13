import { afterEach, describe, expect, it, vi } from 'vitest';

import { createGpuSurface } from './device.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A device whose loss can be triggered on demand, which the real one cannot. */
function fakeDevice() {
  let resolveLost: (value: { reason: string }) => void = () => {};
  const lost = new Promise<{ reason: string }>((resolve) => {
    resolveLost = resolve;
  });
  /* A real device reports validation failures through this; the surface listens for them. */
  const handlers: ((event: unknown) => void)[] = [];
  return {
    lost,
    destroy: vi.fn(),
    addEventListener: vi.fn((_type: string, handler: (event: unknown) => void) => {
      handlers.push(handler);
    }),
    loseNow: () => resolveLost({ reason: 'destroyed' }),
    rejectNow: (message: string) => {
      for (const handler of handlers) handler({ error: { message } });
    },
  };
}

function fakeCanvas() {
  const context = { configure: vi.fn(), unconfigure: vi.fn() };
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => context),
  };
  return { canvas: canvas as unknown as HTMLCanvasElement, context, raw: canvas };
}

/** Two ticks, which is what a promise-then chain needs to settle. */
async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('the gpu surface', () => {
  it('configures the canvas context with the preferred format', () => {
    vi.stubGlobal('navigator', { gpu: { getPreferredCanvasFormat: () => 'bgra8unorm' } });
    const { canvas, context } = fakeCanvas();
    const surface = createGpuSurface(canvas, fakeDevice() as unknown as GPUDevice);

    surface.configure(320, 240);

    expect(surface.format).toBe('bgra8unorm');
    expect(context.configure).toHaveBeenCalled();
  });

  /* The drawing buffer is the canvas's own size, so resize has to reach both. */
  it('sizes the canvas when it configures', () => {
    vi.stubGlobal('navigator', { gpu: { getPreferredCanvasFormat: () => 'bgra8unorm' } });
    const { canvas, raw } = fakeCanvas();
    const surface = createGpuSurface(canvas, fakeDevice() as unknown as GPUDevice);

    surface.configure(320, 240);

    expect(raw.width).toBe(320);
    expect(raw.height).toBe(240);
  });

  it('tells a listener registered before the loss', async () => {
    vi.stubGlobal('navigator', { gpu: { getPreferredCanvasFormat: () => 'bgra8unorm' } });
    const device = fakeDevice();
    const { canvas } = fakeCanvas();
    const surface = createGpuSurface(canvas, device as unknown as GPUDevice);

    const early = vi.fn();
    surface.onLost(early);
    device.loseNow();
    await settle();

    expect(early).toHaveBeenCalledTimes(1);
  });

  /*
   * **Loss is a resolved promise rather than an event, and that is the whole difficulty.**
   * A `webglcontextlost` event fires once and is missed by anybody not already listening;
   * `device.lost` has *already resolved* by the time a renderer built late asks about it,
   * so a listener registered afterwards must still be told or it will draw into a dead
   * device forever, silently.
   */
  it('tells a listener registered after the loss has already happened', async () => {
    vi.stubGlobal('navigator', { gpu: { getPreferredCanvasFormat: () => 'bgra8unorm' } });
    const device = fakeDevice();
    const { canvas } = fakeCanvas();
    const surface = createGpuSurface(canvas, device as unknown as GPUDevice);

    device.loseNow();
    await settle();

    const late = vi.fn();
    surface.onLost(late);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('reports that it is lost, so a frame can be skipped without a listener', async () => {
    vi.stubGlobal('navigator', { gpu: { getPreferredCanvasFormat: () => 'bgra8unorm' } });
    const device = fakeDevice();
    const { canvas } = fakeCanvas();
    const surface = createGpuSurface(canvas, device as unknown as GPUDevice);

    expect(surface.lost).toBe(false);
    device.loseNow();
    await settle();
    expect(surface.lost).toBe(true);
  });

  /* Disposing is not losing: a torn-down surface must not report a fault to anybody. */
  it('does not report a loss when it was disposed on purpose', async () => {
    vi.stubGlobal('navigator', { gpu: { getPreferredCanvasFormat: () => 'bgra8unorm' } });
    const device = fakeDevice();
    const { canvas, context } = fakeCanvas();
    const surface = createGpuSurface(canvas, device as unknown as GPUDevice);
    const listener = vi.fn();
    surface.onLost(listener);

    surface.dispose();
    device.loseNow();
    await settle();

    expect(context.unconfigure).toHaveBeenCalled();
    expect(device.destroy).toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });

  /**
   * **The failure mode this exists for draws a picture rather than raising anything.**
   *
   * A bind group whose sample type does not match its texture is returned invalid, not thrown;
   * the pass records nothing and the frame still presents. The shadow peel was implemented
   * three times against that silence. Reported rather than thrown because it surfaces at
   * submission, and nothing may throw in the frame loop.
   */
  it('reports what the device rejected, once per distinct message', () => {
    vi.stubGlobal('navigator', { gpu: { getPreferredCanvasFormat: () => 'bgra8unorm' } });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const device = fakeDevice();
    const { canvas } = fakeCanvas();
    createGpuSurface(canvas, device as unknown as GPUDevice);

    device.rejectNow('sample types (Float) do not match');
    device.rejectNow('sample types (Float) do not match');
    device.rejectNow('a different complaint');

    expect(errors).toHaveBeenCalledTimes(2);
    expect(errors.mock.calls[0]?.[0]).toContain('sample types (Float) do not match');
    errors.mockRestore();
  });

  /* A surface torn down on purpose has nothing to say, the same as it reports no loss. */
  it('stays quiet about rejections once it has been disposed', () => {
    vi.stubGlobal('navigator', { gpu: { getPreferredCanvasFormat: () => 'bgra8unorm' } });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const device = fakeDevice();
    const { canvas } = fakeCanvas();
    const surface = createGpuSurface(canvas, device as unknown as GPUDevice);

    surface.dispose();
    device.rejectNow('too late to matter');

    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it('fails at init when the canvas will not give a webgpu context', () => {
    vi.stubGlobal('navigator', { gpu: { getPreferredCanvasFormat: () => 'bgra8unorm' } });
    const canvas = { getContext: vi.fn(() => null) } as unknown as HTMLCanvasElement;

    expect(() => createGpuSurface(canvas, fakeDevice() as unknown as GPUDevice)).toThrow(/webgpu/i);
  });
});
