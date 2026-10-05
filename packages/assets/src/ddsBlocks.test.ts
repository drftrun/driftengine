import { expect, test } from 'vitest';

import { ddsBlocks } from './ddsBlocks.ts';

/*
 * A DDS kept as its blocks: format, colour space, size and every stored level, with no texel
 * decoded. Each level below is a run of distinct bytes, so a level read from the wrong offset, or
 * one level short, cannot match by accident.
 */

/** `n` bytes counting up from `from`. */
function run(n: number, from: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (from + i) & 0xff;
  return out;
}

interface Shape {
  readonly width: number;
  readonly height: number;
  readonly fourcc: string;
  readonly mips?: number;
  readonly dxgi?: number;
  readonly caps2?: number;
}

/** A DDS of `levels` back to back, behind a classic header or, with `dxgi`, a `DX10` one. */
function dds(shape: Shape, levels: readonly Uint8Array[]): Uint8Array {
  const extension = shape.dxgi === undefined ? 0 : 20;
  const size = levels.reduce((sum, level) => sum + level.length, 0);
  const bytes = new Uint8Array(128 + extension + size);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('DDS '), 0);
  view.setUint32(4, 124, true);
  view.setUint32(8, 0x1007 | (shape.mips === undefined ? 0 : 0x20000), true);
  view.setUint32(12, shape.height, true);
  view.setUint32(16, shape.width, true);
  view.setUint32(28, shape.mips ?? 0, true);
  view.setUint32(76, 32, true);
  view.setUint32(80, 0x4, true);
  bytes.set(new TextEncoder().encode(shape.fourcc), 84);
  view.setUint32(112, shape.caps2 ?? 0, true);
  if (shape.dxgi !== undefined) {
    view.setUint32(128, shape.dxgi, true);
    view.setUint32(132, 3, true);
    view.setUint32(140, 1, true);
  }
  let at = 128 + extension;
  for (const level of levels) {
    bytes.set(level, at);
    at += level.length;
  }
  return bytes;
}

const listed = (levels: readonly Uint8Array[]): number[][] => levels.map((l) => Array.from(l));

/*
 * **A DX10 BC7 chain, every level, and its colour space.** 8x8 is four blocks of sixteen bytes at
 * level 0, then one block each at 4x4, 2x2 and 1x1. Format 99 is `BC7_UNORM_SRGB` and 98 the same
 * blocks declared linear.
 */
test('KEEPS A DX10 BC7 SURFACE’S BLOCKS AND EVERY STORED LEVEL, AND ITS COLOUR SPACE', () => {
  const levels = [run(64, 0), run(16, 64), run(16, 80), run(16, 96)];
  const image = ddsBlocks(dds({ width: 8, height: 8, fourcc: 'DX10', dxgi: 99, mips: 4 }, levels));
  expect([image.format, image.srgb, image.width, image.height]).toEqual(['bc7', true, 8, 8]);
  expect(listed(image.levels)).toEqual(listed(levels));
  const linear = ddsBlocks(dds({ width: 8, height: 8, fourcc: 'DX10', dxgi: 98, mips: 4 }, levels));
  expect(linear.srgb).toBe(false);
});

/*
 * A classic DXT5 header, 8x4: level 0 is two blocks of sixteen, levels 1 (4x2) and 2 (2x1) one
 * each. A mip count of zero is one level, which is what Microsoft's own loader reads it as — many
 * writers leave it zero on a surface with no chain.
 */
test('keeps a classic DXT5 chain, and reads a mip count of zero as one level', () => {
  const levels = [run(32, 0), run(16, 40), run(16, 70)];
  const image = ddsBlocks(dds({ width: 8, height: 4, fourcc: 'DXT5', mips: 3 }, levels));
  expect([image.format, image.srgb]).toEqual(['bc3', false]);
  expect(listed(image.levels)).toEqual(listed(levels));
  const single = ddsBlocks(dds({ width: 8, height: 4, fourcc: 'DXT5' }, [run(32, 0)]));
  expect(listed(single.levels)).toEqual([Array.from(run(32, 0))]);
});

/* BC4 in both spellings, and the two signed formats refused by name rather than read as unsigned. */
test('reads BC4 in both spellings and refuses the signed ones by name', () => {
  for (const fourcc of ['ATI1', 'BC4U']) {
    expect(ddsBlocks(dds({ width: 4, height: 4, fourcc }, [run(8, 0)])).format).toBe('bc4');
  }
  expect(
    ddsBlocks(dds({ width: 4, height: 4, fourcc: 'DX10', dxgi: 80 }, [run(8, 0)])).format,
  ).toBe('bc4');
  expect(() => ddsBlocks(dds({ width: 4, height: 4, fourcc: 'BC4S' }, [run(8, 0)]))).toThrow(
    /BC4S/,
  );
  expect(() =>
    ddsBlocks(dds({ width: 4, height: 4, fourcc: 'DX10', dxgi: 81 }, [run(8, 0)])),
  ).toThrow(/81/);
});

/*
 * **Refused, and the baker falls back to decoding level 0.** A chain longer than the image has
 * levels for (4x4 has three), a chain whose last level is cut short, a volume texture — whose
 * levels hold several slices each, so the layout is not a chain of images — and an uncompressed
 * surface, which has no blocks to keep.
 */
test('refuses a chain too long, a chain cut short, a volume and an uncompressed surface', () => {
  const four = [run(8, 0), run(8, 8), run(8, 16), run(8, 24)];
  expect(() => ddsBlocks(dds({ width: 4, height: 4, fourcc: 'DXT1', mips: 4 }, four))).toThrow(
    /4 levels.*at most 3/,
  );
  expect(() =>
    ddsBlocks(
      dds({ width: 4, height: 4, fourcc: 'DXT1', mips: 3 }, [run(8, 0), run(8, 8), run(4, 16)]),
    ),
  ).toThrow(/level 2/);
  expect(() =>
    ddsBlocks(dds({ width: 4, height: 4, fourcc: 'DXT1', caps2: 0x200000 }, [run(8, 0)])),
  ).toThrow(/volume/);
  const flat = dds({ width: 4, height: 4, fourcc: 'DXT1' }, [run(64, 0)]);
  new DataView(flat.buffer).setUint32(80, 0x40, true);
  expect(() => ddsBlocks(flat)).toThrow(/uncompressed/);
});
