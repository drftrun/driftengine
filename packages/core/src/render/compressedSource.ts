/**
 * A block-compressed image a caller hands to `createSurfaceTexture`, and the one decision about it
 * both backends share: whether this device takes it as blocks.
 *
 * **Uploaded as it is, or not at all.** A BC texture costs a byte a texel on the GPU (BC7) or half
 * of one (BC1) against four for RGBA, and keeps the mip chain its author built rather than one a box
 * filter makes. A device that cannot sample the format — most phones, which have ASTC and ETC2 —
 * gets nothing from the blocks, and the engine does not decode them here: core ships no decoder.
 * The loader in `@driftengine/assets` asks `uploadsCompressed` first and decodes at load where the
 * answer is no; a caller handing a source this device cannot take is refused by name.
 *
 * Backend-neutral, because both backends must agree on what they accept before either touches a
 * device. `BlockFormat` is the same union `@driftengine/drft` names `BcFormat`; core imports nothing
 * from that package, and a format added there without a twin here fails where the loader passes one
 * to the other, at compile time.
 */

/** BC1 to BC5 and BC7. BC6H and the signed forms are not among them. */
export type BlockFormat = 'bc1' | 'bc2' | 'bc3' | 'bc4' | 'bc5' | 'bc7';

/** A format as a device offers it: the colour space is part of the name, as WebGPU's are. */
export type CompressedTextureFormat =
  'bc1' | 'bc1-srgb' | 'bc2' | 'bc2-srgb' | 'bc3' | 'bc3-srgb' | 'bc4' | 'bc5' | 'bc7' | 'bc7-srgb';

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

/** Bytes per 4x4 block. */
export const BLOCK_BYTES: Readonly<Record<BlockFormat, number>> = {
  bc1: 8,
  bc2: 16,
  bc3: 16,
  bc4: 8,
  bc5: 16,
  bc7: 16,
};

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
  return format === 'bc4' || format === 'bc5' ? null : `${format}-srgb`;
}

/**
 * Whether a `width` by `height` source in `format` uploads as blocks on a device offering
 * `available`. Level 0 must be whole blocks each way: WebGPU refuses any other size for a BC
 * texture, and WebGL2's S3TC extension says the same, so a 6x6 image is decoded rather than
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
  return name !== null && width % 4 === 0 && height % 4 === 0 && available.includes(name);
}

/** The bytes level `level` of a `width` by `height` image takes: whole blocks, one at least. */
function levelBytes(format: BlockFormat, width: number, height: number, level: number): number {
  const w = Math.max(1, width >> level);
  const h = Math.max(1, height >> level);
  return Math.ceil(w / 4) * Math.ceil(h / 4) * BLOCK_BYTES[format];
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
  const offered = available.length === 0 ? 'no BC format' : available.join(', ');
  return (
    `createSurfaceTexture: this device cannot take ${asked} as blocks — it offers ${offered}, and ` +
    'a BC texture must be whole 4x4 blocks at level 0. Decode it first (decodeBc in ' +
    '@driftengine/assets), or ask renderer.compressedFormats before choosing.'
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
