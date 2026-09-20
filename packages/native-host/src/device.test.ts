import { describe, expect, test } from 'vitest';

import { adaptDevice, alphaStepFor, errorsOf } from './device.ts';

/**
 * **What this file is for: the one thing the engine hears from its device, delivered by a host whose
 * binding does not deliver it.** The engine's surface listens for `uncapturederror` and says what the
 * device rejected; `@kmamal/gpu` 0.2.0 refuses the listener outright ("no overload matched") and its
 * `onuncapturederror` cannot be assigned. Error scopes work, so the host opens one around each frame
 * and hands what it catches to the listeners — which is when a browser would have raised it.
 */

function refusingDevice(errors: (GPUError | null)[]) {
  const pushed: string[] = [];
  const device = {
    addEventListener() {
      throw new TypeError('no overload matched for addEventListener:');
    },
    pushErrorScope(filter: GPUErrorFilter) {
      pushed.push(filter);
    },
    popErrorScope() {
      pushed.pop();
      return Promise.resolve(errors.shift() ?? null);
    },
  };
  return { device: device as unknown as GPUDevice, pushed };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('a device whose binding does not deliver errors', () => {
  test('TAKES THE ENGINE’S LISTENER, and hands it what a frame’s error scope caught', async () => {
    const rejected = { message: 'swizzle used without the feature enabled' } as GPUError;
    const { device, pushed } = refusingDevice([rejected]);
    adaptDevice(device);
    const heard: string[] = [];
    device.addEventListener('uncapturederror', (event) => {
      heard.push((event as GPUUncapturedErrorEvent).error.message);
    });
    const errors = errorsOf(device);
    expect(errors).not.toBeNull();
    errors?.open();
    expect(pushed).toEqual(['validation']);
    errors?.close();
    await flush();
    expect(pushed).toEqual([]);
    expect(heard).toEqual(['swizzle used without the feature enabled']);
  });

  test('A FRAME THAT DREW CLEANLY SAYS NOTHING, and a removed listener hears nothing', async () => {
    const { device } = refusingDevice([null, { message: 'late' } as GPUError]);
    adaptDevice(device);
    const heard: string[] = [];
    const listener = (event: Event) => {
      heard.push((event as GPUUncapturedErrorEvent).error.message);
    };
    device.addEventListener('uncapturederror', listener);
    const errors = errorsOf(device);
    errors?.open();
    errors?.close();
    await flush();
    device.removeEventListener('uncapturederror', listener);
    errors?.open();
    errors?.close();
    await flush();
    expect(heard).toEqual([]);
  });

  test('A DEVICE THAT DELIVERS ITS OWN EVENTS IS LEFT ALONE', () => {
    const own = { addEventListener: () => undefined } as unknown as GPUDevice;
    const before = own.addEventListener;
    adaptDevice(own);
    expect(own.addEventListener).toBe(before);
    expect(errorsOf(own)).toBeNull();
  });
});

describe('a device’s queue, given an image the host decoded', () => {
  function queueDevice() {
    const writes: { destination: unknown; data: number[]; layout: unknown; size: unknown }[] = [];
    const passed: unknown[] = [];
    const device = {
      addEventListener: () => undefined,
      queue: {
        writeTexture(destination: unknown, data: Uint8Array, layout: unknown, size: unknown) {
          writes.push({ destination, data: Array.from(data), layout, size });
        },
        copyExternalImageToTexture(source: unknown) {
          passed.push(source);
        },
      },
    } as unknown as GPUDevice;
    return { device, writes, passed };
  }

  test('WRITES A HOST BITMAP’S BYTES where the browser would have copied an image', async () => {
    const { hostCreateImageBitmap } = await import('./images.ts');
    const { device, writes, passed } = queueDevice();
    adaptDevice(device);
    /* Straight, so this is about the copy and the flip; alpha has its own tests below. */
    const bitmap = await hostCreateImageBitmap(
      {
        data: new Uint8ClampedArray([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]),
        width: 2,
        height: 2,
      } as ImageData,
      { premultiplyAlpha: 'none' },
    );
    const texture = { label: 'model' } as GPUTexture;
    device.queue.copyExternalImageToTexture(
      { source: bitmap as unknown as ImageBitmap, flipY: false },
      { texture },
      [2, 2],
    );
    expect(passed).toEqual([]);
    expect(writes).toEqual([
      {
        destination: { texture, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
        data: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
        layout: { offset: 0, bytesPerRow: 8, rowsPerImage: 2 },
        size: { width: 2, height: 2, depthOrArrayLayers: 1 },
      },
    ]);
    /* Flipped when asked, as the browser's copy is. */
    device.queue.copyExternalImageToTexture(
      { source: bitmap as unknown as ImageBitmap, flipY: true },
      { texture },
      [2, 2],
    );
    expect(writes[1]?.data).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test('ANY OTHER SOURCE GOES TO THE BINDING, untouched', () => {
    const { device, writes, passed } = queueDevice();
    adaptDevice(device);
    const other = { source: { width: 1, height: 1 } } as unknown as GPUCopyExternalImageSourceInfo;
    device.queue.copyExternalImageToTexture(other, { texture: {} as GPUTexture }, [1, 1]);
    expect(passed).toEqual([other]);
    expect(writes).toEqual([]);
  });
});

describe('alpha, through a decode and a copy, as Chrome takes it', () => {
  /*
   * **Chrome holds what `createImageBitmap` decodes premultiplied unless told not to**, with Skia's
   * integer rounding, and a copy between that and a texture wanting the other alpha runs a step on
   * the GPU (`alphaCopy.ts`, and the device check holds its bytes to Chrome's). Here: which bytes go
   * straight in, and which copies go to the device instead.
   */
  function recordingDevice() {
    const writes: { texture: unknown; data: number[] }[] = [];
    const passes: GPURenderPassDescriptor[] = [];
    const viewports: number[][] = [];
    const device = {
      addEventListener: () => undefined,
      queue: {
        writeTexture(destination: { texture: unknown }, data: Uint8Array) {
          writes.push({ texture: destination.texture, data: Array.from(data) });
        },
        writeBuffer() {},
        submit() {},
        onSubmittedWorkDone: () => Promise.resolve(),
        copyExternalImageToTexture() {},
      },
      createTexture: (descriptor: GPUTextureDescriptor) => ({
        label: descriptor.label,
        createView: () => ({}),
        destroy() {},
      }),
      createBuffer: () => ({ destroy() {} }),
      createShaderModule: () => ({}),
      createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
      createBindGroup: () => ({}),
      createCommandEncoder: () => ({
        beginRenderPass(descriptor: GPURenderPassDescriptor) {
          passes.push(descriptor);
          return {
            setPipeline() {},
            setBindGroup() {},
            setViewport(...box: number[]) {
              viewports.push(box);
            },
            setScissorRect() {},
            draw() {},
            end() {},
          };
        },
        finish: () => ({}),
      }),
    } as unknown as GPUDevice;
    adaptDevice(device);
    return { device, writes, passes, viewports };
  }

  const target = (format: GPUTextureFormat) =>
    ({ format, createView: () => ({ label: 'destination' }) }) as unknown as GPUTexture;

  async function bitmapOf(pixel: number[], premultiplyAlpha?: PremultiplyAlpha) {
    const { hostCreateImageBitmap } = await import('./images.ts');
    return hostCreateImageBitmap(
      { data: new Uint8ClampedArray(pixel), width: pixel.length / 4, height: 1 } as ImageData,
      premultiplyAlpha === undefined ? {} : { premultiplyAlpha },
    );
  }

  test('HELD AS THE TEXTURE WANTS IT, THE BYTES GO IN AS THEY ARE: premultiplied by Skia’s rounding', async () => {
    const { device, writes, passes } = recordingDevice();
    const texture = target('rgba8unorm');
    device.queue.copyExternalImageToTexture(
      { source: (await bitmapOf([200, 100, 50, 85, 200, 100, 50, 0])) as unknown as ImageBitmap },
      { texture, premultipliedAlpha: true },
      [2, 1],
    );
    /*
     * ((200·85 + 128)·257) >> 16 = 67, ((100·85 + 128)·257) >> 16 = 33, ((50·85 + 128)·257) >> 16
     * = 17; and a texel with no alpha keeps no colour.
     */
    expect(writes).toEqual([{ texture, data: [67, 33, 17, 85, 0, 0, 0, 0] }]);
    expect(passes).toEqual([]);
  });

  test('HELD ONE WAY AND WANTED THE OTHER, THE STEP RUNS ON THE DEVICE, into the rectangle copied', async () => {
    const { device, writes, passes, viewports } = recordingDevice();
    const texture = target('rgba8unorm-srgb');
    device.queue.copyExternalImageToTexture(
      { source: (await bitmapOf([200, 100, 50, 85])) as unknown as ImageBitmap },
      { texture, origin: { x: 3, y: 4 } },
      [1, 1],
    );
    /* The held bytes go to a texture of the host's own, and nothing is written into the target. */
    expect(writes.map((write) => write.data)).toEqual([[67, 33, 17, 85]]);
    expect(writes[0]?.texture).not.toBe(texture);
    expect(passes.length).toBe(1);
    const attachment = Array.from(passes[0]?.colorAttachments ?? [])[0];
    /* Loaded, since the level outside the rectangle is not the copy's to clear. */
    expect(attachment?.loadOp).toBe('load');
    expect(viewports).toEqual([[3, 4, 1, 1, 0, 1]]);
  });

  test('WHICH STEP, from the alpha an image is held in to the alpha its texture wants', () => {
    expect(alphaStepFor(true, false)).toBe('unpremultiply');
    expect(alphaStepFor(false, true)).toBe('premultiply');
    expect(alphaStepFor(true, true)).toBeNull();
    expect(alphaStepFor(false, false)).toBeNull();
  });
});
