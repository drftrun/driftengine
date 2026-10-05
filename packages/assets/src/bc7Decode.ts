/**
 * One BC7 block into sixteen RGBA texels, exactly as the format defines it.
 *
 * **BC7 is the format to get bit-exact, and the one with no slack.** Eight modes, each a different
 * split of 128 bits into partitions, endpoints, p-bits and indices; a field read one bit early
 * shifts every field after it, and the picture that comes out is plausible noise rather than an
 * error. Unlike BC1 to BC5, its interpolation is specified to the integer, so a decoder either
 * agrees with the format to the byte or is wrong — `bcDecode.test.ts` holds it to that against an
 * independent implementation, two random blocks a mode.
 *
 * A reserved mode — a first byte with no bit set — decodes to transparent black, which is what the
 * format says a decoder returns for it.
 *
 * **Scratch lives at module scope**, because a phone without BC sampling decodes every block of
 * every texture through here at load: a 2048² surface is 262,144 calls, and per-call arrays would
 * be five allocations each. Not re-entrant, which nothing here needs; a worker has its own module.
 */

/**
 * Each mode's layout: subsets, then the bit widths of its partition, rotation, index selection,
 * colour and alpha fields, whether it has a p-bit per endpoint or one shared per subset, and the
 * widths of its primary and secondary indices.
 */
type Bc7Mode = readonly [
  subsets: number,
  partitionBits: number,
  rotationBits: number,
  selectionBits: number,
  colourBits: number,
  alphaBits: number,
  endpointP: number,
  sharedP: number,
  index1: number,
  index2: number,
];

const BC7_MODES: readonly Bc7Mode[] = [
  [3, 4, 0, 0, 4, 0, 1, 0, 3, 0],
  [2, 6, 0, 0, 6, 0, 0, 1, 3, 0],
  [3, 6, 0, 0, 5, 0, 0, 0, 2, 0],
  [2, 6, 0, 0, 7, 0, 1, 0, 2, 0],
  [1, 0, 2, 1, 5, 6, 0, 0, 2, 3],
  [1, 0, 2, 0, 7, 8, 0, 0, 2, 2],
  [1, 0, 0, 0, 7, 7, 1, 0, 4, 0],
  [2, 6, 0, 0, 5, 5, 1, 0, 2, 0],
];

/** Interpolation weights out of 64, for two-, three- and four-bit indices. */
const BC7_WEIGHTS: readonly (readonly number[])[] = [
  [0, 21, 43, 64],
  [0, 9, 18, 27, 37, 46, 55, 64],
  [0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64],
];

/**
 * The two-subset partitions, a bit a pixel (pixel 0 lowest), 1 for the second subset.
 *
 * The format's own table, as published in the D3D11 BC7 specification; transcribed from
 * `texture2ddecoder` 0.1.2 (MIT OR Apache-2.0) and held by `bcDecode.test.ts` to what the format
 * says of it: pixel 0 in subset 0, and every anchor inside the subset it anchors.
 */
export const BC7_PARTITION2: readonly number[] = [
  0xcccc, 0x8888, 0xeeee, 0xecc8, 0xc880, 0xfeec, 0xfec8, 0xec80, 0xc800, 0xffec, 0xfe80, 0xe800,
  0xffe8, 0xff00, 0xfff0, 0xf000, 0xf710, 0x008e, 0x7100, 0x08ce, 0x008c, 0x7310, 0x3100, 0x8cce,
  0x088c, 0x3110, 0x6666, 0x366c, 0x17e8, 0x0ff0, 0x718e, 0x399c, 0xaaaa, 0xf0f0, 0x5a5a, 0x33cc,
  0x3c3c, 0x55aa, 0x9696, 0xa55a, 0x73ce, 0x13c8, 0x324c, 0x3bdc, 0x6996, 0xc33c, 0x9966, 0x0660,
  0x0272, 0x04e4, 0x4e40, 0x2720, 0xc936, 0x936c, 0x39c6, 0x639c, 0x9336, 0x9cc6, 0x817e, 0xe718,
  0xccf0, 0x0fcc, 0x7744, 0xee22,
];

/** The three-subset partitions, two bits a pixel (pixel 0 lowest). From the same source. */
export const BC7_PARTITION3: readonly number[] = [
  0xaa685050, 0x6a5a5040, 0x5a5a4200, 0x5450a0a8, 0xa5a50000, 0xa0a05050, 0x5555a0a0, 0x5a5a5050,
  0xaa550000, 0xaa555500, 0xaaaa5500, 0x90909090, 0x94949494, 0xa4a4a4a4, 0xa9a59450, 0x2a0a4250,
  0xa5945040, 0x0a425054, 0xa5a5a500, 0x55a0a0a0, 0xa8a85454, 0x6a6a4040, 0xa4a45000, 0x1a1a0500,
  0x0050a4a4, 0xaaa59090, 0x14696914, 0x69691400, 0xa08585a0, 0xaa821414, 0x50a4a450, 0x6a5a0200,
  0xa9a58000, 0x5090a0a8, 0xa8a09050, 0x24242424, 0x00aa5500, 0x24924924, 0x24499224, 0x50a50a50,
  0x500aa550, 0xaaaa4444, 0x66660000, 0xa5a0a5a0, 0x50a050a0, 0x69286928, 0x44aaaa44, 0x66666600,
  0xaa444444, 0x54a854a8, 0x95809580, 0x96969600, 0xa85454a8, 0x80959580, 0xaa141414, 0x96960000,
  0xaaaa1414, 0xa05050a0, 0xa0a5a5a0, 0x96000000, 0x40804080, 0xa9a8a9a8, 0xaaaaaa44, 0x2a4a5254,
];

/** The anchor pixel of the second subset of each two-subset partition. From the same source. */
export const BC7_ANCHOR2: readonly number[] = [
  15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 2, 8, 2, 2, 8, 8, 15, 2, 8, 2,
  2, 8, 8, 2, 2, 15, 15, 6, 8, 2, 8, 15, 15, 2, 8, 2, 2, 2, 15, 15, 6, 6, 2, 6, 8, 15, 15, 2, 2, 15,
  15, 15, 15, 15, 2, 2, 15,
];

/** The anchor pixels of the second and third subsets of each three-subset partition. */
export const BC7_ANCHOR3: readonly (readonly number[])[] = [
  [
    3, 3, 15, 15, 8, 3, 15, 15, 8, 8, 6, 6, 6, 5, 3, 3, 3, 3, 8, 15, 3, 3, 6, 10, 5, 8, 8, 6, 8, 5,
    15, 15, 8, 15, 3, 5, 6, 10, 8, 15, 15, 3, 15, 5, 15, 15, 15, 15, 3, 15, 5, 5, 5, 8, 5, 10, 5,
    10, 8, 13, 15, 12, 3, 3,
  ],
  [
    15, 8, 8, 3, 15, 15, 3, 8, 15, 15, 15, 15, 15, 15, 15, 8, 15, 8, 15, 3, 15, 8, 15, 8, 3, 15, 6,
    10, 15, 15, 10, 8, 15, 3, 15, 10, 10, 8, 9, 10, 6, 15, 8, 15, 3, 6, 6, 8, 15, 3, 15, 15, 15, 15,
    15, 15, 15, 15, 15, 15, 3, 15, 15, 8,
  ],
];

/** `n` bits of a block from bit `pos`, least significant first, as the format orders them. */
function bits(bytes: Uint8Array, at: number, pos: number, n: number): number {
  let value = 0;
  for (let i = 0; i < n; i++) {
    const p = pos + i;
    value |= (((bytes[at + (p >> 3)] as number) >> (p & 7)) & 1) << i;
  }
  return value;
}

/** A quantised endpoint widened to eight bits by replicating its top bits into the bottom. */
function expandEndpoint(value: number, width: number): number {
  const shifted = (value << (8 - width)) & 0xff;
  return shifted | (shifted >> width);
}

/** The subset and anchor of each pixel, for a partition. */
function subsetOf(subsets: number, partition: number, pixel: number): number {
  if (subsets === 2) return ((BC7_PARTITION2[partition] as number) >> pixel) & 1;
  if (subsets === 3) return ((BC7_PARTITION3[partition] as number) >>> (2 * pixel)) & 3;
  return 0;
}

function isAnchor(subsets: number, partition: number, pixel: number): boolean {
  if (pixel === 0) return true;
  if (subsets === 2) return BC7_ANCHOR2[partition] === pixel;
  if (subsets === 3) {
    return BC7_ANCHOR3[0]?.[partition] === pixel || BC7_ANCHOR3[1]?.[partition] === pixel;
  }
  return false;
}

const RAW = new Uint8Array(24);
const PBITS = new Uint8Array(6);
const COLOURS = new Uint8Array(24);
const PRIMARY = new Uint8Array(16);
const SECONDARY = new Uint8Array(16);

/** One BC7 block at `bytes[at]` into sixteen RGBA texels in `out`. */
export function decodeBc7Block(bytes: Uint8Array, at: number, out: Uint8Array): void {
  let mode = 0;
  while (mode < 8 && bits(bytes, at, mode, 1) === 0) mode++;
  const layout = BC7_MODES[mode];
  if (layout === undefined) {
    out.fill(0, 0, 64);
    return;
  }
  const [
    subsets,
    partitionBits,
    rotationBits,
    selectionBits,
    colourBits,
    alphaBits,
    endpointP,
    sharedP,
    index1,
    index2,
  ] = layout;
  let pos = mode + 1;
  const partition = bits(bytes, at, pos, partitionBits);
  pos += partitionBits;
  const rotation = bits(bytes, at, pos, rotationBits);
  pos += rotationBits;
  const selection = bits(bytes, at, pos, selectionBits);
  pos += selectionBits;

  /* Endpoints channel by channel, two per subset: red for every subset, then green, blue, alpha. */
  const endpoints = 2 * subsets;
  const channels = alphaBits > 0 ? 4 : 3;
  for (let c = 0; c < channels; c++) {
    const width = c < 3 ? colourBits : alphaBits;
    for (let e = 0; e < endpoints; e++) {
      RAW[e * 4 + c] = bits(bytes, at, pos, width);
      pos += width;
    }
  }
  /* P-bits: one per endpoint, or one per subset shared by its two, appended below each value. */
  const hasP = endpointP !== 0 || sharedP !== 0;
  for (let e = 0; e < endpoints; e++) {
    if (endpointP !== 0) PBITS[e] = bits(bytes, at, pos++, 1);
    else if (sharedP !== 0 && e % 2 === 0) PBITS[e] = PBITS[e + 1] = bits(bytes, at, pos++, 1);
  }
  for (let e = 0; e < endpoints; e++) {
    for (let c = 0; c < 4; c++) {
      if (c === 3 && alphaBits === 0) {
        COLOURS[e * 4 + 3] = 255;
        continue;
      }
      const stored = RAW[e * 4 + c] as number;
      const width = (c < 3 ? colourBits : alphaBits) + (hasP ? 1 : 0);
      COLOURS[e * 4 + c] = expandEndpoint(
        hasP ? (stored << 1) | (PBITS[e] as number) : stored,
        width,
      );
    }
  }

  /* Indices: primary for all sixteen pixels, each anchor one bit short; then secondary, if any. */
  for (let pixel = 0; pixel < 16; pixel++) {
    const width = index1 - (isAnchor(subsets, partition, pixel) ? 1 : 0);
    PRIMARY[pixel] = bits(bytes, at, pos, width);
    pos += width;
  }
  for (let pixel = 0; index2 > 0 && pixel < 16; pixel++) {
    const width = index2 - (pixel === 0 ? 1 : 0);
    SECONDARY[pixel] = bits(bytes, at, pos, width);
    pos += width;
  }

  const weights1 = BC7_WEIGHTS[index1 - 2] as readonly number[];
  const weights2 = BC7_WEIGHTS[Math.max(index2, 2) - 2] as readonly number[];
  for (let pixel = 0; pixel < 16; pixel++) {
    /* One index for both unless the mode has two; mode 4's selection bit says which drives alpha. */
    const first = weights1[PRIMARY[pixel] as number] as number;
    const second = index2 > 0 ? (weights2[SECONDARY[pixel] as number] as number) : first;
    const colourWeight = selection === 0 ? first : second;
    const alphaWeight = selection === 0 ? second : first;
    const e0 = subsetOf(subsets, partition, pixel) * 8;
    const texel = pixel * 4;
    for (let c = 0; c < 4; c++) {
      const w = c < 3 ? colourWeight : alphaWeight;
      out[texel + c] =
        ((COLOURS[e0 + c] as number) * (64 - w) + (COLOURS[e0 + 4 + c] as number) * w + 32) >> 6;
    }
    /* Rotation: the stored alpha was one of the colour channels, and that channel was alpha. */
    if (rotation !== 0) {
      const swap = texel + rotation - 1;
      const alpha = out[texel + 3] as number;
      out[texel + 3] = out[swap] as number;
      out[swap] = alpha;
    }
  }
}
