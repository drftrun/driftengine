import { expect, it } from 'vitest';

import { BC7_ANCHOR2, BC7_ANCHOR3, BC7_PARTITION2, BC7_PARTITION3 } from './bc7Decode.ts';
import { decodeBc } from './bcDecode.ts';
import type { BcFormat } from './bcDecode.ts';

/*
 * **Blocks decoded by an independent implementation, pasted as literals.** Each row is one 4x4 block
 * and the sixteen texels the Rust crate `texture2ddecoder` 0.1.2 (MIT OR Apache-2.0) decodes it to,
 * as RGBA hex. The blocks are seeded random bits with the BC7 mode forced, two per mode, so every
 * mode's bit layout, partition table, p-bits, rotation and index selection is exercised. That crate
 * is not the code under test; agreeing with it is agreeing with a second reading of the spec.
 *
 * BC7 interpolation is defined exactly, so those rows must match to the byte. BC1, BC3, BC4 and BC5
 * are not — hardware decoders round their interpolants differently, and this one rounds where that
 * crate truncates — so those agree within one.
 *
 * BC1 is that crate's `decode_bc1a`, which reads a three-colour block's fourth index as transparent
 * black. That is what `bc1-rgba-unorm` samples as, the only BC1 format WebGPU has; its `decode_bc1`
 * reads it as opaque black, and a fixture built from that one disagreed by 255 in alpha.
 *
 * The BC3 row's colour endpoints are high first. With them low first that crate takes BC1's
 * three-colour branch inside a BC3 block, and the format says the colour half of BC2 and BC3 is
 * always four colours — `dds.test.ts` pins that case by hand, so a random row need not.
 */
const REFERENCE: readonly (readonly [BcFormat, string, string])[] = [
  [
    'bc7',
    '2bce5016f25e94e923915d9f881a83d9',
    '3a3e8eff 2c2aa1ff 8cff18ff 79b39eff 49567aff 1000c6ff 708edfff 74a0beff 576a67ff 1e15b3ff a7998dff 212194ff 49567aff 1e15b3ff 635c91ff 635c91ff',
  ],
  [
    'bc7',
    '21ef6c410d1e5fc7de65a9dc225c9c9c',
    '97a49dff 847e5aff 6e93bdff 706ca5ff 807449ff 939a8cff 6e93bdff 730063ff 807449ff 33d759ff b584e7ff 6bffffff 4cc675ff 4cc675ff 69b593ff 82a4afff',
  ],
  [
    'bc7',
    '22fac07b815ebbae43017741007c1f17',
    'cc26a9ff 0eeb3aff ad4697ff eb06bbff ad4697ff eb06bbff eb06bbff eb06bbff 2dcb4cff 0eeb3aff 2dcb4cff 7abb02ff eb06bbff 0eeb3aff d1cf3cff f3d752ff',
  ],
  [
    'bc7',
    'ce3e6dd2f6e8d61372c67ab1ab8d6d2d',
    'eec440ff d18d20ff eec440ff e2ad33ff dca22cff b3c7b0ff dca22cff d79826ff abc3aaff a3bfa5ff cbd3c1ff d79826ff d79826ff abc3aaff e8b939ff f3ce46ff',
  ],
  [
    'bc7',
    '7ceddfc53aef7154847a6300aa50f285',
    'cdf7c0ff e7f7dcff e7f7dcff b5f7a5ff b55200ff a3b331ff 9f4216ff 649f31ff b55200ff 649f31ff 732142ff 298c31ff 89312cff dec631ff b55200ff a3b331ff',
  ],
  [
    'bc7',
    'b449853f47c6f06b8f860fffa802850c',
    '4f6371ff d794acff d794acff 7f633cff 2163a5ff 84c6ffff 84c6ffff 7f633cff 7f633cff 84c6ffff 84c6ffff 4f6371ff a27664ff b870b3ff ce6bffff ce6bffff',
  ],
  [
    'bc7',
    'f800a729b7a9df2a3bd3ab66dfd7dbf3',
    '8d86aeff a6fad2ff 9ac1c1ff a6fad2ff a6fad2ff 9ac1c1ff 9ac1c1ff a6fad2ff 8d86aeff a6fad2ff 9ac1c1ff a6fad2ff 80806dff b0a685ff ddcb9bff 80806dff',
  ],
  [
    'bc7',
    'a8cb822d88188843b1bf395d0734eec6',
    '6faed0ff 5b7173ff 5b7173ff 5b7173ff 345c74ff 345c74ff 486774ff 65c5d9ff 215175ff 6faed0ff 8280beff 6faed0ff 8280beff 65c5d9ff 7897c7ff 486774ff',
  ],
  [
    'bc7',
    'd06098c791ad1f218684b8b12a0f0757',
    '00e0e731 18eb427b 15db5971 00e6e731 0adba150 11db7066 07e0b946 03dbd03b 18eb427b 03dbd03b 0edb885c 0ae0a150 00e6e731 15db5971 11db7066 07e0b946',
  ],
  [
    'bc7',
    '500e306d286ac399911401db434dd128',
    '73a23163 73a23163 26c37fb0 00cba5d6 73cb3163 00dba5d6 73a23163 00b2a5d6 73cb3163 26aa7fb0 73cb3163 4da25789 26cb7fb0 26aa7fb0 73b23163 26aa7fb0',
  ],
  [
    'bc7',
    '20065fa37ac49da1efdea6f48309b8b6',
    '314a8591 314a8567 7cab7067 314a85be 7cab7091 7cab70be 577b7a67 314a8567 7cab7067 0c1a8fbe 314a85e8 314a85be 577b7abe 577b7a91 7cab70e8 7cab70be',
  ],
  [
    'bc7',
    '20616abf2e2ad10b9c5546a2077ad063',
    'baf646a5 a9eb4aa5 c3fb44f4 a9eb4af4 b2f04851 b2f04851 b2f04802 c3fb44a5 a9eb4af4 c3fb44f4 b2f048a5 c3fb4402 baf64602 c3fb44f4 baf64651 a9eb4aa5',
  ],
  [
    'bc7',
    '40fe849ea06a24159e1bfdb31c36045e',
    '96847227 7b696328 5e4b5328 ebdba124 44304429 2612342a cdbd9025 5e4b5328 513d4c29 ebdba124 a3917926 cdbd9025 c0af8926 f8e8a824 331f3b2a b3a28226',
  ],
  [
    'bc7',
    'c0f4a81ca39d447e18420fd7e89f0081',
    'adae6175 c9c46650 bebb645e adae6175 46624efc d2ca6844 90995c9a 5a7152e2 88935aa6 4f6950f1 46624efc 7f8c59b1 d2ca6844 d2ca6844 c9c46650 88935aa6',
  ],
  [
    'bc7',
    '801f6d2691910c6065bb1cbcd2f91ca1',
    'a2200071 7e1d44b0 30492808 4d34dff7 3a426456 7e1d44b0 6d1c65cf 4d34dff7 30492808 6d1c65cf 911f2190 30492808 3a426456 30492808 7e1d44b0 7e1d44b0',
  ],
  [
    'bc7',
    '80c9e31cbd73c4f4423e779d0c8f56fe',
    '9d65b978 9d65b978 e33810ba 761d6789 e73cf775 ae2b3ba2 e33810ba ae2b3ba2 41109271 761d6789 761d6789 e33810ba 41109271 41109271 41109271 ae2b3ba2',
  ],
  [
    'bc1',
    '6da4bee20309accf',
    '00000000 a58e6bff a58e6bff a58e6bff e755f7ff c671b1ff a58e6bff a58e6bff a58e6bff 00000000 c671b1ff c671b1ff 00000000 00000000 a58e6bff 00000000',
  ],
  [
    'bc1',
    'c5d6188896d153c7',
    'bd925dff 8c00c6ff 8c00c6ff bd925dff 8c00c6ff d6db29ff 8c00c6ff a44991ff a44991ff d6db29ff 8c00c6ff 8c00c6ff a44991ff 8c00c6ff d6db29ff a44991ff',
  ],
  [
    'bc3',
    '9b6874018de21f7a2ce5773fc568e4f8',
    '39efbd85 39efbd76 e7a6637d 73d69f9b e7a6639b adbe8193 adbe818c 39efbd85 e7a66393 39efbd85 adbe816f 73d69f6f e7a66368 adbe8185 73d69f76 73d69f8c',
  ],
  [
    'bc4',
    'e345225e894c3d6e',
    'cc0000ff 9f0000ff e30000ff 5b0000ff 880000ff cc0000ff cc0000ff 9f0000ff 9f0000ff 450000ff 880000ff 720000ff b50000ff 9f0000ff b50000ff b50000ff',
  ],
  [
    'bc4',
    '24de898b5e95f374',
    'de0000ff de0000ff 000000ff b80000ff 240000ff b80000ff ff0000ff 490000ff b80000ff 490000ff 000000ff de0000ff ff0000ff de0000ff b80000ff 6e0000ff',
  ],
  [
    'bc5',
    '6527cf1da2d37cdc64ec9d516b37ae92',
    '2fd000ff 279a00ff 2f0000ff 386400ff 27d000ff 4a0000ff 657f00ff 419a00ff 53ff00ff 5c0000ff 536400ff 38ff00ff 2f7f00ff 65d000ff 2fb500ff 38b500ff',
  ],
  [
    'bc1',
    '10002000e41bff00',
    '000084ff 000400ff 000242ff 00000000 00000000 000242ff 000400ff 000084ff 00000000 00000000 00000000 00000000 000084ff 000084ff 000084ff 000084ff',
  ],
];

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

it('DECODES EVERY BC7 MODE AS AN INDEPENDENT DECODER DOES, to the byte', () => {
  let checked = 0;
  for (const [format, block, texels] of REFERENCE) {
    if (format !== 'bc7') continue;
    const got = decodeBc(format, 4, 4, hexBytes(block));
    expect(Array.from(got), block).toEqual(Array.from(hexBytes(texels.replace(/ /g, ''))));
    checked += 1;
  }
  expect(checked, 'two blocks for each of the eight modes').toBe(16);
});

/*
 * **One block of every partition, against the same decoder.** The random rows above reach a handful
 * of the 128 partition entries, and a transcription slip anywhere else — `0x7310` typed as `0x7130`
 * was tried, and all five other tests passed it. Mode 1 for each two-subset partition and mode 2 for
 * each three-subset one, bytes from a fixed formula, every RGBA byte hashed (FNV-1a) in order. The
 * blocks are generated here; the hash is that crate's, decoding the same blocks.
 */
it('decodes one block of every BC7 partition as the independent decoder does', () => {
  const blocks = new Uint8Array(128 * 16);
  for (let b = 0; b < 128; b++) {
    const at = b * 16;
    for (let k = 0; k < 16; k++) blocks[at + k] = ((b + 1) * 151 + k * 89 + k * k * 13) & 0xff;
    const p = b % 64;
    if (b < 64) {
      blocks[at] = 2 | (p << 2);
    } else {
      blocks[at] = 4 | ((p & 31) << 3);
      blocks[at + 1] = ((blocks[at + 1] as number) & 0xfe) | (p >> 5);
    }
  }
  /* Four texels wide, so each block's sixteen texels are contiguous and in the crate's order. */
  const rgba = decodeBc('bc7', 4, 4 * 128, blocks);
  let hash = 0x811c9dc5;
  for (const byte of rgba) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  expect(hash.toString(16)).toBe('c3a68710');
});

it('decodes BC1, BC3, BC4 and BC5 within one of an independent decoder', () => {
  for (const [format, block, texels] of REFERENCE) {
    if (format === 'bc7') continue;
    const got = decodeBc(format, 4, 4, hexBytes(block));
    const want = hexBytes(texels.replace(/ /g, ''));
    /* BC4 is one channel and BC5 two: compare what the format stores. */
    const channels = format === 'bc4' ? [0] : format === 'bc5' ? [0, 1] : [0, 1, 2, 3];
    for (let t = 0; t < 16; t++) {
      for (const c of channels) {
        expect(
          Math.abs((got[t * 4 + c] as number) - (want[t * 4 + c] as number)),
          `${format} ${block} texel ${t}`,
        ).toBeLessThanOrEqual(1);
      }
    }
  }
});

/*
 * What a GPU returns for the channels a format does not store, so the decoded fallback reads
 * exactly as the compressed upload does: BC4 is (r, 0, 0, 1) and BC5 (r, g, 0, 1).
 */
it('fills the channels BC4 and BC5 do not store as a GPU samples them', () => {
  const bc4 = decodeBc('bc4', 4, 4, new Uint8Array([200, 10, 0, 0, 0, 0, 0, 0]));
  expect([bc4[1], bc4[2], bc4[3]]).toEqual([0, 0, 255]);
  const bc5 = decodeBc('bc5', 4, 4, new Uint8Array(16));
  expect([bc5[2], bc5[3]]).toEqual([0, 255]);
});

/* A surface that is not a whole number of blocks is cropped, as the format's own padding is. */
/*
 * Four solid BC1 blocks — red, green, blue, white, as `c0 = c1` with every index 0 — cover a padded
 * 8x8, cropped to 5x6. Each texel must be its own block's colour: a texel written one column past
 * the edge lands on the next row's first, which a length check cannot see.
 */
it('crops a surface that is not a whole number of blocks, texel by texel', () => {
  const solid = (c: number): number[] => [c & 0xff, c >> 8, c & 0xff, c >> 8, 0, 0, 0, 0];
  const blocks = new Uint8Array([
    ...solid(0xf800),
    ...solid(0x07e0),
    ...solid(0x001f),
    ...solid(0xffff),
  ]);
  const colours = [
    [255, 0, 0, 255],
    [0, 255, 0, 255],
    [0, 0, 255, 255],
    [255, 255, 255, 255],
  ];
  const got = decodeBc('bc1', 5, 6, blocks);
  expect(got.length).toBe(5 * 6 * 4);
  for (let y = 0; y < 6; y++) {
    for (let x = 0; x < 5; x++) {
      const at = (y * 5 + x) * 4;
      expect(Array.from(got.subarray(at, at + 4)), `texel ${x},${y}`).toEqual(
        colours[(y >> 2) * 2 + (x >> 2)],
      );
    }
  }
  expect(() => decodeBc('bc7', 5, 6, new Uint8Array(16))).toThrow(/needs 64 bytes/);
});

/*
 * **Equal endpoints are the four-value mode, so indices 6 and 7 are a hard 0 and 255.** That is how
 * an encoder can store a binary mask — a lash, a strand of hair — in BC4 or in BC3's alpha, and a
 * decoder testing `a0 >= a1` reads both as 128. Texel 0 takes index 6, texel 1 index 7: the first
 * index byte is 6 | 7 << 3 = 0x3e.
 */
it('a BC4 block with equal endpoints keeps its hard 0 and 255', () => {
  const got = decodeBc('bc4', 4, 4, new Uint8Array([128, 128, 0x3e, 0, 0, 0, 0, 0]));
  expect([got[0], got[4], got[8]]).toEqual([0, 255, 128]);
});

/*
 * **The partition tables, held to what the format says of them.** Every partition puts pixel 0 in
 * subset 0, and every anchor — the pixel whose index is stored a bit short — lies inside the subset
 * it anchors. A transcription slip in either table breaks one of these, where it might decode a
 * random block plausibly.
 */
it('every partition starts in subset 0 and every anchor lies in its own subset', () => {
  expect(BC7_PARTITION2).toHaveLength(64);
  expect(BC7_PARTITION3).toHaveLength(64);
  for (let p = 0; p < 64; p++) {
    const two = BC7_PARTITION2[p] as number;
    const three = BC7_PARTITION3[p] as number;
    expect(two & 1, `two-subset ${p}`).toBe(0);
    expect(three & 3, `three-subset ${p}`).toBe(0);
    expect((two >> (BC7_ANCHOR2[p] as number)) & 1, `two-subset anchor ${p}`).toBe(1);
    expect(
      (three >> (2 * (BC7_ANCHOR3[0]?.[p] as number))) & 3,
      `three-subset anchor 1 of ${p}`,
    ).toBe(1);
    expect(
      (three >> (2 * (BC7_ANCHOR3[1]?.[p] as number))) & 3,
      `three-subset anchor 2 of ${p}`,
    ).toBe(2);
  }
});
