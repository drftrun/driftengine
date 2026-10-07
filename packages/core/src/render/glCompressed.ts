/**
 * BC on WebGL2: which formats this context samples, and the upload of a stored chain.
 *
 * **Four extensions, each a different subset**, and the names a device offers are read off them:
 * `WEBGL_compressed_texture_s3tc` is BC1 to BC3, its `_srgb` twin their sRGB forms,
 * `EXT_texture_compression_rgtc` BC4 and BC5, and `EXT_texture_compression_bptc` BC7 in both. A
 * desktop GPU usually has all four and a phone none, which is why the loader decodes there.
 *
 * BC1 is uploaded as `COMPRESSED_RGBA_S3TC_DXT1_EXT` rather than the RGB one, so a three-colour
 * block's fourth index is transparent here as it is on WebGPU, whose only BC1 is `bc1-rgba-unorm`.
 *
 * The stored levels are uploaded as they are and no chain is generated: `generateMipmap` cannot
 * write a compressed format, and the chain its author stored is the better one anyway. A chain that
 * stops before 1x1 sets `TEXTURE_MAX_LEVEL` to its last level, or the texture is incomplete and
 * samples black.
 */
import type { CompressedTextureFormat, CompressedTextureSource } from './compressedSource.ts';

/** The constants each extension defines, written out so a missing extension cannot be read for one. */
const INTERNAL: Readonly<Record<CompressedTextureFormat, number>> = {
  bc1: 0x83f1, // COMPRESSED_RGBA_S3TC_DXT1_EXT
  bc2: 0x83f2, // COMPRESSED_RGBA_S3TC_DXT3_EXT
  bc3: 0x83f3, // COMPRESSED_RGBA_S3TC_DXT5_EXT
  'bc1-srgb': 0x8c4d, // COMPRESSED_SRGB_ALPHA_S3TC_DXT1_EXT
  'bc2-srgb': 0x8c4e, // COMPRESSED_SRGB_ALPHA_S3TC_DXT3_EXT
  'bc3-srgb': 0x8c4f, // COMPRESSED_SRGB_ALPHA_S3TC_DXT5_EXT
  bc4: 0x8dbb, // COMPRESSED_RED_RGTC1_EXT
  bc5: 0x8dbd, // COMPRESSED_RED_GREEN_RGTC2_EXT
  bc7: 0x8e8c, // COMPRESSED_RGBA_BPTC_UNORM_EXT
  'bc7-srgb': 0x8e8d, // COMPRESSED_SRGB_ALPHA_BPTC_UNORM_EXT
  'eac-r11': 0x9270, // COMPRESSED_R11_EAC
  'eac-rg11': 0x9272, // COMPRESSED_RG11_EAC
  'etc2-rgb8': 0x9274, // COMPRESSED_RGB8_ETC2
  'etc2-rgb8-srgb': 0x9275, // COMPRESSED_SRGB8_ETC2
  'etc2-rgb8a1': 0x9276, // COMPRESSED_RGB8_PUNCHTHROUGH_ALPHA1_ETC2
  'etc2-rgb8a1-srgb': 0x9277, // COMPRESSED_SRGB8_PUNCHTHROUGH_ALPHA1_ETC2
  'etc2-rgba8': 0x9278, // COMPRESSED_RGBA8_ETC2_EAC
  'etc2-rgba8-srgb': 0x9279, // COMPRESSED_SRGB8_ALPHA8_ETC2_EAC
  'astc-4x4': 0x93b0, // COMPRESSED_RGBA_ASTC_4x4_KHR
  'astc-4x4-srgb': 0x93d0, // COMPRESSED_SRGB8_ALPHA8_ASTC_4x4_KHR
  'astc-5x4': 0x93b1, // COMPRESSED_RGBA_ASTC_5x4_KHR
  'astc-5x4-srgb': 0x93d1, // COMPRESSED_SRGB8_ALPHA8_ASTC_5x4_KHR
  'astc-5x5': 0x93b2, // COMPRESSED_RGBA_ASTC_5x5_KHR
  'astc-5x5-srgb': 0x93d2, // COMPRESSED_SRGB8_ALPHA8_ASTC_5x5_KHR
  'astc-6x5': 0x93b3, // COMPRESSED_RGBA_ASTC_6x5_KHR
  'astc-6x5-srgb': 0x93d3, // COMPRESSED_SRGB8_ALPHA8_ASTC_6x5_KHR
  'astc-6x6': 0x93b4, // COMPRESSED_RGBA_ASTC_6x6_KHR
  'astc-6x6-srgb': 0x93d4, // COMPRESSED_SRGB8_ALPHA8_ASTC_6x6_KHR
  'astc-8x5': 0x93b5, // COMPRESSED_RGBA_ASTC_8x5_KHR
  'astc-8x5-srgb': 0x93d5, // COMPRESSED_SRGB8_ALPHA8_ASTC_8x5_KHR
  'astc-8x6': 0x93b6, // COMPRESSED_RGBA_ASTC_8x6_KHR
  'astc-8x6-srgb': 0x93d6, // COMPRESSED_SRGB8_ALPHA8_ASTC_8x6_KHR
  'astc-8x8': 0x93b7, // COMPRESSED_RGBA_ASTC_8x8_KHR
  'astc-8x8-srgb': 0x93d7, // COMPRESSED_SRGB8_ALPHA8_ASTC_8x8_KHR
  'astc-10x5': 0x93b8, // COMPRESSED_RGBA_ASTC_10x5_KHR
  'astc-10x5-srgb': 0x93d8, // COMPRESSED_SRGB8_ALPHA8_ASTC_10x5_KHR
  'astc-10x6': 0x93b9, // COMPRESSED_RGBA_ASTC_10x6_KHR
  'astc-10x6-srgb': 0x93d9, // COMPRESSED_SRGB8_ALPHA8_ASTC_10x6_KHR
  'astc-10x8': 0x93ba, // COMPRESSED_RGBA_ASTC_10x8_KHR
  'astc-10x8-srgb': 0x93da, // COMPRESSED_SRGB8_ALPHA8_ASTC_10x8_KHR
  'astc-10x10': 0x93bb, // COMPRESSED_RGBA_ASTC_10x10_KHR
  'astc-10x10-srgb': 0x93db, // COMPRESSED_SRGB8_ALPHA8_ASTC_10x10_KHR
  'astc-12x10': 0x93bc, // COMPRESSED_RGBA_ASTC_12x10_KHR
  'astc-12x10-srgb': 0x93dc, // COMPRESSED_SRGB8_ALPHA8_ASTC_12x10_KHR
  'astc-12x12': 0x93bd, // COMPRESSED_RGBA_ASTC_12x12_KHR
  'astc-12x12-srgb': 0x93dd, // COMPRESSED_SRGB8_ALPHA8_ASTC_12x12_KHR
};

const BY_EXTENSION: readonly (readonly [string, readonly CompressedTextureFormat[]])[] = [
  ['WEBGL_compressed_texture_s3tc', ['bc1', 'bc2', 'bc3']],
  ['WEBGL_compressed_texture_s3tc_srgb', ['bc1-srgb', 'bc2-srgb', 'bc3-srgb']],
  ['EXT_texture_compression_rgtc', ['bc4', 'bc5']],
  ['EXT_texture_compression_bptc', ['bc7', 'bc7-srgb']],
  /* The two families a phone has: every GLES 3 device takes ETC2, and most take ASTC beside it. */
  [
    'WEBGL_compressed_texture_etc',
    [
      'etc2-rgb8',
      'etc2-rgb8-srgb',
      'etc2-rgb8a1',
      'etc2-rgb8a1-srgb',
      'etc2-rgba8',
      'etc2-rgba8-srgb',
      'eac-r11',
      'eac-rg11',
    ],
  ],
  [
    'WEBGL_compressed_texture_astc',
    [
      'astc-4x4',
      'astc-4x4-srgb',
      'astc-5x4',
      'astc-5x4-srgb',
      'astc-5x5',
      'astc-5x5-srgb',
      'astc-6x5',
      'astc-6x5-srgb',
      'astc-6x6',
      'astc-6x6-srgb',
      'astc-8x5',
      'astc-8x5-srgb',
      'astc-8x6',
      'astc-8x6-srgb',
      'astc-8x8',
      'astc-8x8-srgb',
      'astc-10x5',
      'astc-10x5-srgb',
      'astc-10x6',
      'astc-10x6-srgb',
      'astc-10x8',
      'astc-10x8-srgb',
      'astc-10x10',
      'astc-10x10-srgb',
      'astc-12x10',
      'astc-12x10-srgb',
      'astc-12x12',
      'astc-12x12-srgb',
    ],
  ],
];

/**
 * The BC formats this context samples, enabling each extension that offers some. Enabling is what
 * `getExtension` does, and a format is only legal in an upload once it has been called.
 */
export function glCompressedFormats(gl: WebGL2RenderingContext): CompressedTextureFormat[] {
  const out: CompressedTextureFormat[] = [];
  for (const [name, formats] of BY_EXTENSION) {
    if (gl.getExtension(name) !== null) out.push(...formats);
  }
  return out;
}

/**
 * Upload `layers`, every one of `levels` levels, to the bound `TEXTURE_2D_ARRAY` as `name`, and cap
 * the chain at what was stored. The caller has checked the sources and the device.
 */
export function uploadCompressedArray(
  gl: WebGL2RenderingContext,
  name: CompressedTextureFormat,
  layers: readonly CompressedTextureSource[],
  levels: number,
): void {
  const first = layers[0] as CompressedTextureSource;
  for (let level = 0; level < levels; level++) {
    let size = 0;
    for (const layer of layers) size += (layer.levels[level] as Uint8Array).length;
    const data = new Uint8Array(size);
    let at = 0;
    for (const layer of layers) {
      const bytes = layer.levels[level] as Uint8Array;
      data.set(bytes, at);
      at += bytes.length;
    }
    gl.compressedTexImage3D(
      gl.TEXTURE_2D_ARRAY,
      level,
      INTERNAL[name],
      Math.max(1, first.width >> level),
      Math.max(1, first.height >> level),
      layers.length,
      0,
      data,
    );
  }
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_BASE_LEVEL, 0);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAX_LEVEL, levels - 1);
}
