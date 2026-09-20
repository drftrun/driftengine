import { expect, test } from 'vitest';

import { openInferenceDevice } from './device.ts';

/**
 * **Half precision on a device that cannot run it is refused when the device is opened, in words.**
 * The alternative failures are worse and later: a module with `enable f16` fails to compile at the
 * first graph, far from the choice that caused it, or a runner quietly falls back and answers at a
 * precision nobody asked for.
 */

interface Asked {
  features?: readonly string[];
}

function fakeGpu(features: readonly string[], asked: Asked): GPU {
  const adapter = {
    features: new Set(features),
    limits: { maxStorageBufferBindingSize: 1 << 30, maxBufferSize: 1 << 30 },
    requestDevice: async (descriptor: GPUDeviceDescriptor) => {
      asked.features = [...(descriptor.requiredFeatures ?? [])];
      return {} as GPUDevice;
    },
  };
  return { requestAdapter: async () => adapter } as unknown as GPU;
}

test('HALF PRECISION WITHOUT SHADER-F16 IS REFUSED, naming the feature and the way out', async () => {
  await expect(openInferenceDevice(fakeGpu([], {}), { half: true })).rejects.toThrow(
    /shader-f16.*half: false/s,
  );
});

test('half precision with it asks the device for it, and single precision does not', async () => {
  const asked: Asked = {};
  const half = await openInferenceDevice(fakeGpu(['shader-f16'], asked), { half: true });
  expect(half.half).toBe(true);
  expect(asked.features).toContain('shader-f16');
  const single = await openInferenceDevice(fakeGpu(['shader-f16'], asked), { half: false });
  expect(single.half).toBe(false);
  expect(asked.features).not.toContain('shader-f16');
});

test('no adapter is refused rather than answered with nothing', async () => {
  const gpu = { requestAdapter: async () => null } as unknown as GPU;
  await expect(openInferenceDevice(gpu, { half: false })).rejects.toThrow(/adapter/);
});
