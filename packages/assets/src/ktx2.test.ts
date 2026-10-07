import { describe, expect, it } from 'vitest';

import { readKtx2 } from './ktx2.ts';

interface Header {
  vkFormat: number;
  width: number;
  height: number;
  depth?: number;
  layers?: number;
  faces?: number;
  scheme?: number;
  /** Each level's bytes, level 0 first; written to the file smallest first, as the format orders them. */
  levels: Uint8Array[];
}

/** A KTX2 file: the identifier, the header, an empty index, the level index, then the levels. */
function ktx2(header: Header): Uint8Array {
  const { levels } = header;
  const dataStart = 80 + levels.length * 24;
  const total = dataStart + levels.reduce((sum, level) => sum + level.length, 0);
  const bytes = new Uint8Array(total);
  bytes.set([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  const fields = [
    header.vkFormat,
    1,
    header.width,
    header.height,
    header.depth ?? 0,
    header.layers ?? 0,
    header.faces ?? 1,
    levels.length,
    header.scheme ?? 0,
  ];
  fields.forEach((value, i) => view.setUint32(12 + i * 4, value, true));
  let at = total;
  for (let level = 0; level < levels.length; level++) {
    const data = levels[level] as Uint8Array;
    at -= data.length;
    bytes.set(data, at);
    view.setUint32(80 + level * 24, at, true);
    view.setUint32(80 + level * 24 + 8, data.length, true);
    view.setUint32(80 + level * 24 + 16, data.length, true);
  }
  return bytes;
}

const filled = (length: number, value: number): Uint8Array => new Uint8Array(length).fill(value);

describe('a KTX2 texture', () => {
  /*
   * vkFormat 148 is ETC2 RGB8 in sRGB. An 8x8 level is four blocks of eight bytes, and its next
   * level one block; the file stores the smaller first, so each is found by its index, not its
   * place.
   */
  it('IS READ AS THE BLOCKS IT CARRIES, EACH LEVEL WHERE ITS INDEX SAYS, IN THE COLOUR SPACE ITS FORMAT NAMES', () => {
    const file = ktx2({
      vkFormat: 148,
      width: 8,
      height: 8,
      levels: [filled(32, 7), filled(8, 9)],
    });
    const { source, srgb } = readKtx2(file);
    expect(source.format).toBe('etc2-rgb8');
    expect(srgb).toBe(true);
    expect([source.width, source.height]).toEqual([8, 8]);
    expect(source.levels.map((level) => [level.length, level[0]])).toEqual([
      [32, 7],
      [8, 9],
    ]);
    expect(source.levels[0]?.buffer, 'a view, not a copy').toBe(file.buffer);
  });

  /* vkFormat 171 is ASTC 8x8, linear: a 16x16 level is two by two blocks of sixteen bytes. */
  it('READS ASTC AT ITS OWN BLOCK SIZE', () => {
    const { source, srgb } = readKtx2(
      ktx2({ vkFormat: 171, width: 16, height: 16, levels: [filled(64, 1)] }),
    );
    expect(source.format).toBe('astc-8x8');
    expect(srgb).toBe(false);
  });

  it('REFUSES WHAT A SURFACE TEXTURE CANNOT BE, BY NAME', () => {
    const level = [filled(32, 0)];
    const etc = { vkFormat: 147, width: 8, height: 8, levels: level };
    expect(() => readKtx2(ktx2({ ...etc, scheme: 1 }))).toThrow(/BasisLZ/);
    expect(() => readKtx2(ktx2({ ...etc, scheme: 2 }))).toThrow(/Zstandard/);
    expect(() => readKtx2(ktx2({ ...etc, vkFormat: 143 }))).toThrow(/HDR BC6H/);
    expect(() => readKtx2(ktx2({ ...etc, vkFormat: 154 }))).toThrow(/signed EAC R11/);
    expect(() => readKtx2(ktx2({ ...etc, vkFormat: 37 }))).toThrow(/vkFormat 37/);
    expect(() => readKtx2(ktx2({ ...etc, faces: 6 }))).toThrow(/cube of 6 faces/);
    expect(() => readKtx2(ktx2({ ...etc, layers: 3 }))).toThrow(/array of 3 layers/);
    expect(() => readKtx2(ktx2({ ...etc, levels: [filled(24, 0)] }))).toThrow(
      /level 0 of a 8x8 etc2-rgb8 texture is 32 bytes, and the file gives it 24/,
    );
    expect(() => readKtx2(filled(100, 0))).toThrow(/not a KTX2 file/);
  });
});
