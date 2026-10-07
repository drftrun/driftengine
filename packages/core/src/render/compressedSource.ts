/**
 * A block-compressed image a caller hands to `createSurfaceTexture`, and the one decision about it
 * both backends share: whether this device takes it as blocks.
 *
 * **Uploaded as it is, or not at all.** A block format costs a byte a texel on the GPU (BC7, ETC2
 * with alpha, ASTC 4x4) or half of one (BC1, ETC2 without) against four for RGBA, and keeps the mip
 * chain its author built rather than one a box filter makes. **Three families, and a device has the
 * ones it has**: desktops sample BC, phones ETC2 and ASTC, and few anything else. A device that
 * cannot sample a format gets nothing from its blocks, and core does not convert them: the loader
 * in `@driftengine/assets` asks `uploadsCompressed` first, and where the answer is no it decodes
 * them — and encodes ETC2 where the device takes that — off the main thread. A caller handing a
 * source this device cannot take is refused by name.
 *
 * Backend-neutral, because both backends must agree on what they accept before either touches a
 * device. `@driftengine/drft`'s `BcFormat` is the BC part of `BlockFormat`; core imports nothing
 * from that package, and a format added there without a twin here fails where the loader passes one
 * to the other, at compile time.
 */

/**
 * BC1 to BC5 and BC7; ETC2's three and EAC's two; and ASTC at every block size the LDR profile has.
 * BC6H, ASTC HDR and the signed forms are not among them.
 */
export type BlockFormat =
  | 'bc1'
  | 'bc2'
  | 'bc3'
  | 'bc4'
  | 'bc5'
  | 'bc7'
  | 'etc2-rgb8'
  | 'etc2-rgb8a1'
  | 'etc2-rgba8'
  | 'eac-r11'
  | 'eac-rg11'
  | 'astc-4x4'
  | 'astc-5x4'
  | 'astc-5x5'
  | 'astc-6x5'
  | 'astc-6x6'
  | 'astc-8x5'
  | 'astc-8x6'
  | 'astc-8x8'
  | 'astc-10x5'
  | 'astc-10x6'
  | 'astc-10x8'
  | 'astc-10x10'
  | 'astc-12x10'
  | 'astc-12x12';

/** The formats with no sRGB form: one or two channels of data, never colour. */
type LinearOnly = 'bc4' | 'bc5' | 'eac-r11' | 'eac-rg11';

/** A format as a device offers it: the colour space is part of the name, as WebGPU's are. */
export type CompressedTextureFormat = BlockFormat | `${Exclude<BlockFormat, LinearOnly>}-srgb`;

/** A format's block: how many texels across and down, and how many bytes it takes. */
export interface BlockShape {
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
}

const shape = (width: number, height: number, bytes: number): BlockShape => ({
  width,
  height,
  bytes,
});

/** Every format's block. ASTC's are sixteen bytes whatever their size, which is its whole idea. */
export const BLOCK_SHAPES: Readonly<Record<BlockFormat, BlockShape>> = {
  bc1: shape(4, 4, 8),
  bc2: shape(4, 4, 16),
  bc3: shape(4, 4, 16),
  bc4: shape(4, 4, 8),
  bc5: shape(4, 4, 16),
  bc7: shape(4, 4, 16),
  'etc2-rgb8': shape(4, 4, 8),
  'etc2-rgb8a1': shape(4, 4, 8),
  'etc2-rgba8': shape(4, 4, 16),
  'eac-r11': shape(4, 4, 8),
  'eac-rg11': shape(4, 4, 16),
  'astc-4x4': shape(4, 4, 16),
  'astc-5x4': shape(5, 4, 16),
  'astc-5x5': shape(5, 5, 16),
  'astc-6x5': shape(6, 5, 16),
  'astc-6x6': shape(6, 6, 16),
  'astc-8x5': shape(8, 5, 16),
  'astc-8x6': shape(8, 6, 16),
  'astc-8x8': shape(8, 8, 16),
  'astc-10x5': shape(10, 5, 16),
  'astc-10x6': shape(10, 6, 16),
  'astc-10x8': shape(10, 8, 16),
  'astc-10x10': shape(10, 10, 16),
  'astc-12x10': shape(12, 10, 16),
  'astc-12x12': shape(12, 12, 16),
};

/** Every format's family, which is what a device offers or does not. */
export function blockFamily(format: BlockFormat): 'bc' | 'etc2' | 'astc' {
  if (format.startsWith('bc')) return 'bc';
  if (format.startsWith('astc')) return 'astc';
  return 'etc2';
}

/** Block-compressed texels with their stored mip chain, level 0 first. */
export interface CompressedTextureSource {
  readonly format: BlockFormat;
  readonly width: number;
  readonly height: number;
  readonly levels: readonly Uint8Array[];
}

/** What `createSurfaceTexture` takes: an image, or blocks. */
export type SurfaceSource = TexImageSource | CompressedTextureSource;

/**
 * The layers as blocks, or null where every one is an image. An array mixing the two is refused:
 * one GPU texture has one format.
 */
export function compressedLayers(
  sources: readonly SurfaceSource[],
): readonly CompressedTextureSource[] | null {
  let count = 0;
  for (const source of sources) if (isCompressedSource(source)) count++;
  if (count === 0) return null;
  if (count !== sources.length) {
    throw new Error(
      'createSurfaceTextureArray: some layers are blocks and some are images, and one texture has ' +
        'one format. Decode the blocks, or build the array from blocks alone.',
    );
  }
  return sources as readonly CompressedTextureSource[];
}

/** Bytes per block. See `BLOCK_SHAPES` for the block's size, which is not always 4x4. */
export const BLOCK_BYTES: Readonly<Record<BlockFormat, number>> = Object.fromEntries(
  Object.entries(BLOCK_SHAPES).map(([format, block]) => [format, block.bytes]),
) as Record<BlockFormat, number>;

/** Whether `source` is a compressed source rather than an image. */
export function isCompressedSource(source: unknown): source is CompressedTextureSource {
  const candidate = source as { format?: unknown; levels?: unknown } | null;
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof candidate.format === 'string' &&
    Array.isArray(candidate.levels)
  );
}

/** The format a device would have to offer, or null for one with no sRGB form. */
export function compressedFormatName(
  format: BlockFormat,
  srgb: boolean,
): CompressedTextureFormat | null {
  if (!srgb) return format;
  return format === 'bc4' || format === 'bc5' || format === 'eac-r11' || format === 'eac-rg11'
    ? null
    : `${format}-srgb`;
}

/**
 * Whether a `width` by `height` source in `format` uploads as blocks on a device offering
 * `available`. Level 0 must be whole blocks each way: WebGPU refuses any other size for a block
 * texture, and WebGL2's extensions say the same, so a 6x6 image in 4x4 blocks is decoded rather than
 * refused. What would make that wrong is a device that pads; none is relied on here.
 */
export function uploadsCompressed(
  format: BlockFormat,
  srgb: boolean,
  width: number,
  height: number,
  available: readonly CompressedTextureFormat[],
): boolean {
  const name = compressedFormatName(format, srgb);
  const block = BLOCK_SHAPES[format];
  return (
    name !== null &&
    width % block.width === 0 &&
    height % block.height === 0 &&
    available.includes(name)
  );
}

/** The bytes level `level` of a `width` by `height` image takes: whole blocks, one at least. */
export function levelBytes(
  format: BlockFormat,
  width: number,
  height: number,
  level: number,
): number {
  const w = Math.max(1, width >> level);
  const h = Math.max(1, height >> level);
  const block = BLOCK_SHAPES[format];
  return Math.ceil(w / block.width) * Math.ceil(h / block.height) * block.bytes;
}

/**
 * How many levels the layers carry, after checking each is the size its place requires and every
 * layer matches the first. Refuses by name: a short level uploaded anyway is a device error at
 * submit, which on WebGPU is a frame that draws nothing and says so somewhere else.
 */
export function compressedLevels(layers: readonly CompressedTextureSource[]): number {
  const first = layers[0];
  if (first === undefined)
    throw new Error('createSurfaceTexture: an array needs at least one image');
  const { format, width, height } = first;
  const count = first.levels.length;
  const most = Math.floor(Math.log2(Math.max(1, width, height))) + 1;
  if (count < 1 || count > most) {
    throw new Error(
      `createSurfaceTexture: ${count} levels for a ${width}x${height} image, which has at least 1 ` +
        `and at most ${most}`,
    );
  }
  for (let layer = 0; layer < layers.length; layer++) {
    const source = layers[layer] as CompressedTextureSource;
    if (
      source.format !== format ||
      source.width !== width ||
      source.height !== height ||
      source.levels.length !== count
    ) {
      throw new Error(
        `createSurfaceTexture: layer ${layer} is ${source.width}x${source.height} ` +
          `${source.format.toUpperCase()} with ${source.levels.length} levels, and layer 0 is ` +
          `${width}x${height} ${format.toUpperCase()} with ${count}. Every layer of an array is one ` +
          'format, size and chain on the device.',
      );
    }
    for (let level = 0; level < count; level++) {
      const want = levelBytes(format, width, height, level);
      const got = (source.levels[level] as Uint8Array).length;
      if (got !== want) {
        throw new Error(
          `createSurfaceTexture: level ${level} of a ${width}x${height} ${format.toUpperCase()} ` +
            `image is ${want} bytes, and ${got} were given`,
        );
      }
    }
  }
  return count;
}

/** What a refusal names: the format, its colour space, and what the device offers instead. */
export function compressedRefusal(
  format: BlockFormat,
  srgb: boolean,
  width: number,
  height: number,
  available: readonly CompressedTextureFormat[],
): string {
  const asked = `${format.toUpperCase()}${srgb ? ' sRGB' : ''} at ${width}x${height}`;
  const offered = available.length === 0 ? 'no block format' : available.join(', ');
  const block = BLOCK_SHAPES[format];
  return (
    `createSurfaceTexture: this device cannot take ${asked} as blocks — it offers ${offered}, and ` +
    `the texture must be whole ${block.width}x${block.height} blocks at level 0. Decode it first ` +
    '(decodeBc, or encodeEtc2 for a device that takes ETC2, in @driftengine/assets), or ask ' +
    'renderer.compressedFormats before choosing.'
  );
}

/** The format name and level count blocks upload as here, or a refusal naming why they cannot. */
export function planBlocks(
  blocks: readonly CompressedTextureSource[],
  srgb: boolean,
  compressed: readonly CompressedTextureFormat[],
): { readonly name: CompressedTextureFormat; readonly levels: number } {
  const { format, width, height } = blocks[0] as CompressedTextureSource;
  const name = compressedFormatName(format, srgb);
  if (name === null || !uploadsCompressed(format, srgb, width, height, compressed)) {
    throw new Error(compressedRefusal(format, srgb, width, height, compressed));
  }
  return { name, levels: compressedLevels(blocks) };
}

/**
 * `update` replaces pixels with an image, and a texture holding blocks has no pixels to replace:
 * its format is the blocks', and an image would be a different texture. Refused rather than
 * quietly reallocated, so the handle a draw holds keeps meaning what it meant.
 */
export function refuseBlockUpdate(format: BlockFormat | null): void {
  if (format === null) return;
  throw new Error(
    `updateSurfaceTexture: this texture holds ${format.toUpperCase()} blocks, and update replaces ` +
      'an image. Build a new texture for new contents.',
  );
}
