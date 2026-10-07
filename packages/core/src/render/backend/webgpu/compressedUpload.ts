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
import { BLOCK_SHAPES, blockFamily } from '../../compressedSource.ts';
import type { BlockFormat } from '../../compressedSource.ts';

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
  'etc2-rgb8': 'etc2-rgb8unorm',
  'etc2-rgb8-srgb': 'etc2-rgb8unorm-srgb',
  'etc2-rgb8a1': 'etc2-rgb8a1unorm',
  'etc2-rgb8a1-srgb': 'etc2-rgb8a1unorm-srgb',
  'etc2-rgba8': 'etc2-rgba8unorm',
  'etc2-rgba8-srgb': 'etc2-rgba8unorm-srgb',
  'eac-r11': 'eac-r11unorm',
  'eac-rg11': 'eac-rg11unorm',
  'astc-4x4': 'astc-4x4-unorm',
  'astc-4x4-srgb': 'astc-4x4-unorm-srgb',
  'astc-5x4': 'astc-5x4-unorm',
  'astc-5x4-srgb': 'astc-5x4-unorm-srgb',
  'astc-5x5': 'astc-5x5-unorm',
  'astc-5x5-srgb': 'astc-5x5-unorm-srgb',
  'astc-6x5': 'astc-6x5-unorm',
  'astc-6x5-srgb': 'astc-6x5-unorm-srgb',
  'astc-6x6': 'astc-6x6-unorm',
  'astc-6x6-srgb': 'astc-6x6-unorm-srgb',
  'astc-8x5': 'astc-8x5-unorm',
  'astc-8x5-srgb': 'astc-8x5-unorm-srgb',
  'astc-8x6': 'astc-8x6-unorm',
  'astc-8x6-srgb': 'astc-8x6-unorm-srgb',
  'astc-8x8': 'astc-8x8-unorm',
  'astc-8x8-srgb': 'astc-8x8-unorm-srgb',
  'astc-10x5': 'astc-10x5-unorm',
  'astc-10x5-srgb': 'astc-10x5-unorm-srgb',
  'astc-10x6': 'astc-10x6-unorm',
  'astc-10x6-srgb': 'astc-10x6-unorm-srgb',
  'astc-10x8': 'astc-10x8-unorm',
  'astc-10x8-srgb': 'astc-10x8-unorm-srgb',
  'astc-10x10': 'astc-10x10-unorm',
  'astc-10x10-srgb': 'astc-10x10-unorm-srgb',
  'astc-12x10': 'astc-12x10-unorm',
  'astc-12x10-srgb': 'astc-12x10-unorm-srgb',
  'astc-12x12': 'astc-12x12-unorm',
  'astc-12x12-srgb': 'astc-12x12-unorm-srgb',
};

/** Every BC format, where the device carries the feature; none where it does not. */
/** The feature that grants each family, which `select.ts` asks for wherever the adapter offers it. */
const FEATURE: Readonly<Record<'bc' | 'etc2' | 'astc', string>> = {
  bc: 'texture-compression-bc',
  etc2: 'texture-compression-etc2',
  astc: 'texture-compression-astc',
};

export function gpuCompressedFormats(device: GPUDevice): CompressedTextureFormat[] {
  return (Object.keys(GPU_FORMAT) as CompressedTextureFormat[]).filter((name) =>
    device.features.has(FEATURE[blockFamily(baseOf(name))]),
  );
}

/** The format a name is of, without its colour space. */
function baseOf(name: CompressedTextureFormat): BlockFormat {
  return (name.endsWith('-srgb') ? name.slice(0, -'-srgb'.length) : name) as BlockFormat;
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
    label: `surface.texture.${format}`,
    size: [width, height, layers.length],
    format: GPU_FORMAT[name],
    mipLevelCount: levels,
    usage: 0x2 | 0x4, // COPY_DST | TEXTURE_BINDING
  });
  const block = BLOCK_SHAPES[format];
  for (let level = 0; level < levels; level++) {
    const across = Math.ceil(Math.max(1, width >> level) / block.width);
    const down = Math.ceil(Math.max(1, height >> level) / block.height);
    for (let layer = 0; layer < layers.length; layer++) {
      device.queue.writeTexture(
        { texture, mipLevel: level, origin: [0, 0, layer] },
        (layers[layer] as CompressedTextureSource).levels[level] as Uint8Array<ArrayBuffer>,
        { bytesPerRow: across * block.bytes, rowsPerImage: down },
        { width: across * block.width, height: down * block.height, depthOrArrayLayers: 1 },
      );
    }
  }
  return texture;
}
