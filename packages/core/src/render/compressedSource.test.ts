import { expect, test } from 'vitest';

import {
  compressedFormatName,
  compressedLevels,
  isCompressedSource,
  uploadsCompressed,
} from './compressedSource.ts';
import type { CompressedTextureFormat, CompressedTextureSource } from './compressedSource.ts';

const EVERY: readonly CompressedTextureFormat[] = [
  'bc1',
  'bc1-srgb',
  'bc2',
  'bc2-srgb',
  'bc3',
  'bc3-srgb',
  'bc4',
  'bc5',
  'bc7',
  'bc7-srgb',
];

/*
 * **Which BC sources a device takes as blocks, and which the loader decodes.** A format is uploaded
 * compressed only where the device offers it in the colour space asked for, and only at a size of
 * whole blocks: WebGPU refuses a BC texture whose level 0 is not a multiple of four each way, and
 * WebGL2's S3TC extension says the same. BC4 and BC5 have no sRGB form at all — they hold data —
 * so a colour slot handed one decodes it.
 */
test('A BC SOURCE UPLOADS AS BLOCKS ONLY WHERE THE DEVICE OFFERS ITS FORMAT, AT WHOLE BLOCKS', () => {
  expect(uploadsCompressed('bc7', true, 1024, 512, EVERY)).toBe(true);
  expect(uploadsCompressed('bc7', true, 1024, 512, ['bc7']), 'linear offered, sRGB asked').toBe(
    false,
  );
  expect(uploadsCompressed('bc7', false, 1024, 512, ['bc7'])).toBe(true);
  expect(uploadsCompressed('bc1', false, 1024, 512, []), 'a phone: nothing offered').toBe(false);
  expect(uploadsCompressed('bc1', false, 6, 8, EVERY), 'six is not whole blocks').toBe(false);
  expect(uploadsCompressed('bc1', false, 8, 2, EVERY), 'nor is two').toBe(false);
  expect(uploadsCompressed('bc5', true, 64, 64, EVERY), 'BC5 has no sRGB form').toBe(false);
  expect(uploadsCompressed('bc5', false, 64, 64, EVERY)).toBe(true);
  expect(compressedFormatName('bc4', true)).toBeNull();
  expect(compressedFormatName('bc3', true)).toBe('bc3-srgb');
});

/*
 * The stored chain checked before any device sees it: every level the size its place requires —
 * 16x8 BC1 is four blocks then one then one then one, a level smaller than a block still a block —
 * at most the full chain, and every layer of an array the same format, size and chain.
 */
test('a compressed source is checked level by level before an upload, and refused by name', () => {
  const ok: CompressedTextureSource = {
    format: 'bc1',
    width: 16,
    height: 8,
    levels: [new Uint8Array(64), new Uint8Array(16), new Uint8Array(8), new Uint8Array(8)],
  };
  expect(compressedLevels([ok])).toBe(4);
  expect(() => compressedLevels([{ ...ok, levels: [new Uint8Array(63)] }])).toThrow(
    /level 0 .* 64 bytes.* 63/,
  );
  const five = [...ok.levels, new Uint8Array(8), new Uint8Array(8)];
  expect(() => compressedLevels([{ ...ok, levels: five }])).toThrow(/6 levels .* at most 5/);
  expect(() => compressedLevels([ok, { ...ok, format: 'bc3' }])).toThrow(/layer 1/);
  expect(isCompressedSource(ok)).toBe(true);
  expect(isCompressedSource({ width: 1, height: 1 })).toBe(false);
});

/*
 * **A phone's two families**, under the same rule: blocks where the device offers the format, at
 * whole blocks — and an ASTC block is not always four texels across, so a 12x12 image is whole
 * blocks of 6x6 and of 12x12 and not of 5x5.
 */
test('ETC2, EAC AND ASTC UPLOAD AS BLOCKS WHERE OFFERED, AT WHOLE BLOCKS OF THEIR OWN SIZE', () => {
  const phone: readonly CompressedTextureFormat[] = [
    'etc2-rgb8',
    'etc2-rgba8-srgb',
    'eac-rg11',
    'astc-6x6',
    'astc-6x6-srgb',
  ];
  expect(uploadsCompressed('etc2-rgb8', false, 8, 8, phone)).toBe(true);
  expect(uploadsCompressed('etc2-rgba8', true, 8, 8, phone)).toBe(true);
  expect(uploadsCompressed('etc2-rgba8', false, 8, 8, phone), 'not offered linear').toBe(false);
  expect(uploadsCompressed('eac-rg11', false, 8, 8, phone)).toBe(true);
  expect(compressedFormatName('eac-rg11', true), 'two channels of data have no sRGB').toBeNull();
  expect(uploadsCompressed('astc-6x6', false, 12, 12, phone)).toBe(true);
  expect(uploadsCompressed('astc-6x6', false, 8, 8, phone), 'not whole 6x6 blocks').toBe(false);
  expect(uploadsCompressed('bc7', false, 8, 8, phone), 'no BC on a phone').toBe(false);
});

test('a level of ASTC is counted in its own blocks, sixteen bytes each', () => {
  /* 12x12 in 6x6 blocks is four; level 1 is 6x6, one; level 2 is 3x3, still one. */
  const source = {
    format: 'astc-6x6',
    width: 12,
    height: 12,
    levels: [new Uint8Array(64), new Uint8Array(16), new Uint8Array(16)],
  } as const;
  expect(compressedLevels([source])).toBe(3);
  expect(() => compressedLevels([{ ...source, levels: [new Uint8Array(16)] }])).toThrow(/64 bytes/);
});
