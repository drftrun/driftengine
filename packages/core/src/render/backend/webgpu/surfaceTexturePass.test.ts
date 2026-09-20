import { expect, test, vi } from 'vitest';

import { GpuSurfaceTexture } from './surfaceTexturePass.ts';

/**
 * The sampler a surface texture is read through, on the backend that refuses an illegal one.
 *
 * **This file exists because nothing covered that sampler, and one of its fields is a validation
 * error rather than a preference.** `maxAnisotropy` above 1 is legal only when every filter is
 * `linear`; WebGPU refuses the sampler outright, and a refused sampler is a bind group that never
 * builds and a frame that draws nothing at all — with the reason in a console line, from a frame
 * that recorded correctly. WebGL2 accepts the same combination and simply gets nothing from it, so
 * a capture on the backend consumers run cannot show the difference.
 */
function fakeDevice() {
  const samplers: GPUSamplerDescriptor[] = [];
  const device = {
    createTexture: vi.fn(() => ({
      createView: vi.fn(() => ({}) as GPUTextureView),
      destroy: vi.fn(),
    })),
    createSampler: vi.fn((descriptor: GPUSamplerDescriptor) => {
      samplers.push(descriptor);
      return {} as GPUSampler;
    }),
    createCommandEncoder: vi.fn(() => ({
      beginRenderPass: vi.fn(() => ({
        setPipeline: vi.fn(),
        setBindGroup: vi.fn(),
        draw: vi.fn(),
        end: vi.fn(),
      })),
      finish: vi.fn(() => ({})),
    })),
    createBindGroup: vi.fn(() => ({})),
    queue: { copyExternalImageToTexture: vi.fn(), submit: vi.fn() },
  };
  return { samplers, device: device as unknown as GPUDevice };
}

/* Enough of the cache for the mip chain to be built; this file is about the sampler. */
const PIPELINES = {
  get: () => ({ getBindGroupLayout: () => ({}) }),
  device: undefined,
} as unknown as never;
const SOURCE = { width: 4, height: 4 } as unknown as TexImageSource;

test('a surface texture is filtered linearly unless a caller asks otherwise', () => {
  const { device, samplers } = fakeDevice();
  new GpuSurfaceTexture(device, PIPELINES, SOURCE, { mipmap: false });
  expect(samplers[0]).toMatchObject({ magFilter: 'linear', minFilter: 'linear' });
});

test('a caller asking for nearest gets it on both stages of magnification', () => {
  const { device, samplers } = fakeDevice();
  new GpuSurfaceTexture(device, PIPELINES, SOURCE, { mipmap: false, filter: 'nearest' });
  expect(samplers[0]).toMatchObject({ magFilter: 'nearest', minFilter: 'nearest' });
});

/*
 * **The one that is a validation error and not a nicety.** A caller can reasonably ask for nearest
 * filtering *and* leave anisotropy at its default, and the two are legal separately and illegal
 * together. Getting this wrong draws no frame at all on this backend and a correct one on the other.
 */
test('anisotropy drops to 1 when the filter is nearest, which WebGPU requires', () => {
  const { device, samplers } = fakeDevice();
  new GpuSurfaceTexture(device, PIPELINES, SOURCE, {
    mipmap: true,
    filter: 'nearest',
    anisotropy: 8,
  });
  expect(samplers[0]?.maxAnisotropy).toBe(1);
});

test('and stays above 1 for the linear case that has always had it', () => {
  const { device, samplers } = fakeDevice();
  new GpuSurfaceTexture(device, PIPELINES, SOURCE, { mipmap: true, anisotropy: 8 });
  expect(samplers[0]?.maxAnisotropy).toBe(8);
});

/*
 * Blending between mip levels is minification, which the option is not about: taking the nearest
 * level as well would trade a smear for a visible pop as the camera pulls back.
 */
test('the mip chain is still blended between levels under nearest', () => {
  const { device, samplers } = fakeDevice();
  new GpuSurfaceTexture(device, PIPELINES, SOURCE, { mipmap: true, filter: 'nearest' });
  expect(samplers[0]?.mipmapFilter).toBe('linear');
});

/**
 * **An image of another size is a texture of another size.**
 *
 * `update` copied `[width, height]` of the texture it was created with, whatever it was handed. A
 * model loader creates each texture from a small preview and then updates it with the real image,
 * so wherever the preview's decode won the race, the real image was copied into the preview's
 * size: its top-left corner, stretched over the surface. It was a race, so it showed up as the
 * showroom not repeating itself at the car's roundel, its licence plate and its wheels. WebGL2
 * never had it, because `texImage2D` takes the size of what it is given.
 */
test('AN IMAGE OF ANOTHER SIZE IS COPIED WHOLE into a texture of its size, and the old one is handed back', () => {
  const { device } = fakeDevice();
  const texture = new GpuSurfaceTexture(device, PIPELINES, SOURCE, {});
  const create = device.createTexture as unknown as ReturnType<typeof vi.fn>;
  const first = create.mock.results[0]?.value as GPUTexture;
  const firstView = texture.view;

  const replaced = texture.update({ width: 8, height: 2 } as unknown as TexImageSource);

  const descriptor = create.mock.calls.at(-1)?.[0] as GPUTextureDescriptor;
  expect(descriptor.size).toEqual([8, 2]);
  /* ⌊log2 8⌋ + 1: 8, 4, 2 and 1 texels across. */
  expect(descriptor.mipLevelCount).toBe(4);
  const copy = device.queue.copyExternalImageToTexture as unknown as ReturnType<typeof vi.fn>;
  expect(copy.mock.calls.at(-1)?.[2]).toEqual([8, 2]);
  expect(replaced, 'the texture it replaced, for the renderer to retire').toBe(first);
  expect(texture.view, 'a new view, which every binding of the old one must drop').not.toBe(
    firstView,
  );
  expect(first.destroy, 'not here: a recorded draw may still read it').not.toHaveBeenCalled();
});

test('AN IMAGE OF THE SAME SIZE GOES INTO THE TEXTURE IT HAS', () => {
  const { device } = fakeDevice();
  const texture = new GpuSurfaceTexture(device, PIPELINES, SOURCE, {});
  const view = texture.view;
  expect(texture.update({ width: 4, height: 4 } as unknown as TexImageSource)).toBeNull();
  expect(device.createTexture).toHaveBeenCalledTimes(1);
  expect(texture.view).toBe(view);
});
