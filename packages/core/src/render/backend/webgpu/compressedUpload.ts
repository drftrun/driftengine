/**
 * BC on WebGPU: which formats this device samples, and the upload of a stored chain.
 *
 * **One feature covers every BC format**, `texture-compression-bc`, which `select.ts` asks for
 * wherever the adapter offers it and never demands: a device without it is still a device, and the
 * loader decodes for it. Desktop adapters have it; phones have ASTC and ETC2 instead.
 *
 * **Written with `writeTexture`, level by level**, because `copyExternalImageToTexture` takes images
 * and a compressed format cannot be a render attachment, so neither the image upload nor the mip
 * blit applies. Each level's copy is whole blocks: a level smaller than a block is still one, and
 * its copy extent is the block's four texels — WebGPU's physical size — rather than the one or two
 * the level nominally has.
 */
import type { CompressedTextureFormat, CompressedTextureSource } from '../../compressedSource.ts';
import { BLOCK_BYTES } from '../../compressedSource.ts';

const GPU_FORMAT: Readonly<Record<CompressedTextureFormat, GPUTextureFormat>> = {
  bc1: 'bc1-rgba-unorm',
  'bc1-srgb': 'bc1-rgba-unorm-srgb',
  bc2: 'bc2-rgba-unorm',
  'bc2-srgb': 'bc2-rgba-unorm-srgb',
  bc3: 'bc3-rgba-unorm',
  'bc3-srgb': 'bc3-rgba-unorm-srgb',
  bc4: 'bc4-r-unorm',
  bc5: 'bc5-rg-unorm',
  bc7: 'bc7-rgba-unorm',
  'bc7-srgb': 'bc7-rgba-unorm-srgb',
};

/** Every BC format, where the device carries the feature; none where it does not. */
export function gpuCompressedFormats(device: GPUDevice): CompressedTextureFormat[] {
  return device.features.has('texture-compression-bc')
    ? (Object.keys(GPU_FORMAT) as CompressedTextureFormat[])
    : [];
}

/** A texture holding `layers` as `name`, `levels` levels of each, written as they are. */
export function createCompressedTexture(
  device: GPUDevice,
  name: CompressedTextureFormat,
  layers: readonly CompressedTextureSource[],
  levels: number,
): GPUTexture {
  const { format, width, height } = layers[0] as CompressedTextureSource;
  const texture = device.createTexture({
    label: 'surface.texture.bc',
    size: [width, height, layers.length],
    format: GPU_FORMAT[name],
    mipLevelCount: levels,
    usage: 0x2 | 0x4, // COPY_DST | TEXTURE_BINDING
  });
  for (let level = 0; level < levels; level++) {
    const across = Math.ceil(Math.max(1, width >> level) / 4);
    const down = Math.ceil(Math.max(1, height >> level) / 4);
    for (let layer = 0; layer < layers.length; layer++) {
      device.queue.writeTexture(
        { texture, mipLevel: level, origin: [0, 0, layer] },
        (layers[layer] as CompressedTextureSource).levels[level] as Uint8Array<ArrayBuffer>,
        { bytesPerRow: across * BLOCK_BYTES[format], rowsPerImage: down },
        { width: across * 4, height: down * 4, depthOrArrayLayers: 1 },
      );
    }
  }
  return texture;
}
