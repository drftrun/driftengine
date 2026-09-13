import { expect, test } from 'vitest';
import { ddsToRgba, isDds } from './dds.ts';

/**
 * DDS block decoding, asserted against blocks whose exact output is worked out by hand.
 *
 * **Every case here is an endpoint case, not a sample.** A block codec has two modes chosen by
 * comparing its endpoints, and the mode nobody tests is the one that ships wrong: BC1 with
 * `c0 <= c1` is a three-colour block with a transparent fourth, and BC3's alpha with `a0 <= a1`
 * has six interpolated values plus a hard 0 and 255. Getting either backwards produces an image
 * that is plausible everywhere and wrong in the places that matter.
 */

/** A DDS header for a single-mip, uncompressed-flagged, FourCC-compressed surface. */
function ddsHeader(width: number, height: number, fourcc: string): Uint8Array {
  const bytes = new Uint8Array(128);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('DDS '), 0);
  view.setUint32(4, 124, true); // header size
  view.setUint32(12, height, true);
  view.setUint32(16, width, true);
  view.setUint32(28, 1, true); // mip count
  view.setUint32(76, 32, true); // pixel format size
  view.setUint32(80, 0x4, true); // DDPF_FOURCC
  bytes.set(new TextEncoder().encode(fourcc), 84);
  return bytes;
}

function withBlocks(width: number, height: number, fourcc: string, blocks: number[]): Uint8Array {
  const header = ddsHeader(width, height, fourcc);
  const out = new Uint8Array(header.length + blocks.length);
  out.set(header, 0);
  out.set(blocks, header.length);
  return out;
}

/** RGB565 for pure red and pure blue, the two endpoints every case below uses. */
const RED565 = 0xf800;
const BLUE565 = 0x001f;

function le16(value: number): [number, number] {
  return [value & 0xff, (value >> 8) & 0xff];
}

test('recognises a DDS by its magic and nothing else', () => {
  expect(isDds(ddsHeader(4, 4, 'DXT1'))).toBe(true);
  expect(isDds(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(false);
  expect(isDds(new Uint8Array([0x44]))).toBe(false);
});

test('BC1 four-colour mode gives both endpoints and both interpolants', () => {
  /* c0 > c1, so the block is opaque and the two middles are thirds. */
  const block = [...le16(RED565), ...le16(BLUE565), 0b11100100, 0, 0, 0];
  const { width, height, rgba } = ddsToRgba(withBlocks(4, 4, 'DXT1', block));
  expect([width, height]).toEqual([4, 4]);
  /* Index order in byte 4 is texel 0 = 00, 1 = 01, 2 = 10, 3 = 11. */
  expect([...rgba.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
  expect([...rgba.subarray(4, 8)]).toEqual([0, 0, 255, 255]);
  const twoThirdsRed = rgba[8]!;
  const oneThirdRed = rgba[12]!;
  expect(twoThirdsRed).toBeGreaterThan(oneThirdRed);
  expect(rgba[11]).toBe(255);
});

test('BC1 three-colour mode makes its fourth index transparent', () => {
  /* c0 <= c1 selects the punch-through mode, and index 3 is transparent black. */
  const block = [...le16(BLUE565), ...le16(RED565), 0b11000000, 0, 0, 0];
  const { rgba } = ddsToRgba(withBlocks(4, 4, 'DXT1', block));
  expect(rgba[3]).toBe(255);
  /* Texel 3 uses index 3. */
  expect(rgba[15]).toBe(0);
});

test('BC3 carries eight-value alpha alongside a BC1 colour block', () => {
  /* a0 = 255 > a1 = 0, so six interpolants sit between them. */
  const alpha = [255, 0, 0b00001000, 0, 0, 0, 0, 0];
  const colour = [...le16(RED565), ...le16(BLUE565), 0, 0, 0, 0];
  const { rgba } = ddsToRgba(withBlocks(4, 4, 'DXT5', [...alpha, ...colour]));
  expect(rgba[3]).toBe(255);
  /* Texel 1 takes alpha index 1, which is a1 itself. */
  expect(rgba[7]).toBe(0);
});

test('BC3 six-value alpha mode pins its last two indices to 0 and 255', () => {
  /* a0 <= a1 selects the mode where index 6 is 0 and index 7 is 255. */
  /* Three-bit indices, least significant first: texel 0 takes index 6, texel 1 takes index 7. */
  const alpha = [0, 255, 6 | (7 << 3), 0, 0, 0, 0, 0];
  const colour = [...le16(RED565), ...le16(BLUE565), 0, 0, 0, 0];
  const { rgba } = ddsToRgba(withBlocks(4, 4, 'DXT5', [...alpha, ...colour]));
  expect(rgba[3]).toBe(0); // index 6
  expect(rgba[7]).toBe(255); // index 7
});

test('BC5 puts its two channels in red and green and fills blue', () => {
  const red = [255, 0, 0, 0, 0, 0, 0, 0];
  const green = [0, 255, 0, 0, 0, 0, 0, 0];
  const { rgba } = ddsToRgba(withBlocks(4, 4, 'ATI2', [...red, ...green]));
  expect(rgba[0]).toBe(255);
  expect(rgba[1]).toBe(0);
  expect(rgba[3]).toBe(255);
});

test('a surface not a multiple of four decodes only the texels it has', () => {
  const block = [...le16(RED565), ...le16(BLUE565), 0, 0, 0, 0];
  const { width, height, rgba } = ddsToRgba(withBlocks(2, 2, 'DXT1', block));
  expect([width, height]).toEqual([2, 2]);
  expect(rgba.length).toBe(2 * 2 * 4);
  expect([...rgba.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
});

test('refuses a format it cannot decode, naming the FourCC', () => {
  const block = new Array(16).fill(0);
  expect(() => ddsToRgba(withBlocks(4, 4, 'BC7 ', block))).toThrow(/BC7/);
});

test('refuses a truncated surface rather than decoding whatever is there', () => {
  const short = withBlocks(8, 8, 'DXT1', [0, 0, 0, 0]);
  expect(() => ddsToRgba(short)).toThrow(/short|truncat/i);
});

/**
 * The gaps a consumer measured on six vehicle bundles, and one defect found underneath them.
 *
 * Reported from outside with the bytes counted: one bundle carries 20 textures behind a `DX10`
 * header — the car's paint, its wheels, its lamps, its plate and seven interior maps — and this
 * reader refused every one of them for a header it could not read, while decoding the identical
 * blocks announced the other way round. The consumer's baker falls back to a 1x1 white pixel, which
 * for an ORM map is roughness 1 *and* metallic 1, and a fully metallic surface in the flat shader
 * has no diffuse term. It was reported as a lighting bug: the bodywork had stopped being paint and
 * become a blurred mirror of the field the car was parked in.
 */

/** A `DX10` header: the classic 128 bytes with `DX10` at 84, then the 20-byte extension. */
function dx10Header(
  width: number,
  height: number,
  dxgi: number,
  { dimension = 3, misc = 0, arraySize = 1 } = {},
): Uint8Array {
  const bytes = new Uint8Array(148);
  bytes.set(ddsHeader(width, height, 'DX10'), 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(128, dxgi, true);
  view.setUint32(132, dimension, true);
  view.setUint32(136, misc, true);
  view.setUint32(140, arraySize, true);
  view.setUint32(144, 0, true);
  return bytes;
}

function withDx10Blocks(
  width: number,
  height: number,
  dxgi: number,
  blocks: number[],
  options?: { dimension?: number; misc?: number; arraySize?: number },
): Uint8Array {
  const header = dx10Header(width, height, dxgi, options);
  const out = new Uint8Array(header.length + blocks.length);
  out.set(header, 0);
  out.set(blocks, header.length);
  return out;
}

/**
 * **BC2 and BC3 never take BC1's punch-through branch, whatever the endpoint order.**
 *
 * The colour half of a BC2 or BC3 block is always the four-colour opaque mode: alpha is carried
 * separately, so there is no index left over to mean transparent. A decoder that reaches the BC1
 * path unconditionally gets this wrong only where `c0 <= c1`, which is how one lived here unseen —
 * every other test in this file orders its endpoints the other way, and so does most real data.
 */
test('a BC3 colour block with its endpoints the low way round still uses four colours', () => {
  const alpha = [255, 0, 0, 0, 0, 0, 0, 0];
  /* c0 <= c1, and every texel takes index 3 — the interpolant BC1 would call transparent. */
  const colour = [...le16(BLUE565), ...le16(RED565), 0xff, 0xff, 0xff, 0xff];
  const { rgba } = ddsToRgba(withBlocks(4, 4, 'DXT5', [...alpha, ...colour]));
  /* Two thirds of the way from blue to red, not black, and opaque from the alpha block. */
  expect(rgba[0]).toBeGreaterThan(128);
  expect(rgba[2]).toBeLessThan(128);
  expect(rgba[3]).toBe(255);
});

test('BC2 reads its explicit four-bit alpha, one nibble a texel, low nibble first', () => {
  /*
   * Texel 0 alpha 0x0, texel 1 alpha 0xF, the rest 0. A nibble is scaled to eight bits by
   * replication — 0xF is 255 and not 240 — so a fully opaque texel stays fully opaque.
   */
  const alpha = [0xf0, 0, 0, 0, 0, 0, 0, 0];
  const colour = [...le16(RED565), ...le16(BLUE565), 0b11100100, 0, 0, 0];
  const { rgba } = ddsToRgba(withBlocks(4, 4, 'DXT3', [...alpha, ...colour]));
  expect(rgba[3]).toBe(0);
  expect(rgba[7]).toBe(255);
  /* And the colour block is read as four colours, exactly as BC3's is. */
  expect([...rgba.subarray(0, 3)]).toEqual([255, 0, 0]);
  expect([...rgba.subarray(4, 7)]).toEqual([0, 0, 255]);
});

test('a BC2 colour block with its endpoints the low way round still uses four colours', () => {
  const alpha = new Array(8).fill(0xff);
  const colour = [...le16(BLUE565), ...le16(RED565), 0xff, 0xff, 0xff, 0xff];
  const { rgba } = ddsToRgba(withBlocks(4, 4, 'DXT3', [...alpha, ...colour]));
  expect(rgba[0]).toBeGreaterThan(128);
  expect(rgba[3]).toBe(255);
});

test('a DX10 header naming BC3 decodes as the DXT5 it is, byte for byte', () => {
  const alpha = [255, 0, 0, 0, 0, 0, 0, 0];
  const colour = [...le16(RED565), ...le16(BLUE565), 0b11100100, 0, 0, 0];
  const blocks = [...alpha, ...colour];
  /* 78 is `DXGI_FORMAT_BC3_UNORM_SRGB`: the same blocks, announced in the extension. */
  const viaDx10 = ddsToRgba(withDx10Blocks(4, 4, 78, blocks));
  const viaFourCC = ddsToRgba(withBlocks(4, 4, 'DXT5', blocks));
  expect([...viaDx10.rgba]).toEqual([...viaFourCC.rgba]);
  expect([viaDx10.width, viaDx10.height]).toEqual([4, 4]);
});

test.each([
  ['BC1', 71, 'DXT1', 8],
  ['BC2', 74, 'DXT3', 16],
  ['BC3', 77, 'DXT5', 16],
  ['BC5', 83, 'ATI2', 16],
] as const)('a DX10 header naming %s decodes as its FourCC does', (_name, dxgi, fourcc, size) => {
  const colour = [...le16(RED565), ...le16(BLUE565), 0b11100100, 0, 0, 0];
  const blocks = size === 8 ? colour : [...new Array(8).fill(0x44), ...colour];
  expect([...ddsToRgba(withDx10Blocks(4, 4, dxgi, blocks)).rgba]).toEqual([
    ...ddsToRgba(withBlocks(4, 4, fourcc, blocks)).rgba,
  ]);
});

/**
 * What a classic header cannot say, refused rather than flattened.
 *
 * It has no way to state a cube map, an array or a volume, so a reader that took one would hand its
 * caller six faces claiming to be a single surface — a picture rather than an error, which is the
 * outcome every refusal in this file exists to avoid.
 */
test.each([
  ['a volume', { dimension: 4 }],
  ['a cube map', { misc: 0x4 }],
  ['an array', { arraySize: 6 }],
] as const)(
  'refuses %s behind a DX10 header rather than reading its first surface',
  (_what, options) => {
    const blocks = [...new Array(8).fill(0), ...le16(RED565), ...le16(BLUE565), 0, 0, 0, 0];
    expect(() => ddsToRgba(withDx10Blocks(4, 4, 78, blocks, options))).toThrow(
      /2D|cube|array|volume/i,
    );
  },
);

test('refuses a DXGI format it does not decode, naming the number', () => {
  const blocks = new Array(16).fill(0);
  /* 98 is `DXGI_FORMAT_BC7_UNORM`, which this reader has never decoded. */
  expect(() => ddsToRgba(withDx10Blocks(4, 4, 98, blocks))).toThrow(/98/);
  /* 84 is `BC5_SNORM`: the same blocks, signed, so it would decode to wrong numbers not an error. */
  expect(() => ddsToRgba(withDx10Blocks(4, 4, 84, blocks))).toThrow(/84/);
});

/**
 * The uncompressed surfaces, which are the other 289 of that consumer's 766.
 *
 * **A pixel format that describes channels rather than naming a compression**, so there is no block
 * to decode and nothing here is new arithmetic: a bit count, four masks, and a copy. It was refused
 * for as long as this file has existed — clearly and with a message, so nothing was silently wrong,
 * but the consumer wrote the other half themselves rather than lose the textures.
 *
 * **One mask walk covers every shape they carry**, which is why there are no per-format branches
 * below. Surveyed across the six bundles: 210 at 32bpp BGRA, 27 at 16bpp luminance-with-alpha, 23 at
 * 32bpp RGBA, 15 at 8bpp luminance, 14 at 24bpp BGR.
 */

/** A header whose pixel format describes channels: `flags`, a bit count, and four masks. */
function rawHeader(
  width: number,
  height: number,
  flags: number,
  bits: number,
  masks: [number, number, number, number],
  pitch?: number,
): Uint8Array {
  const bytes = new Uint8Array(128);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('DDS '), 0);
  view.setUint32(4, 124, true);
  /* `DDSD_PITCH` is 0x8, and it is what says the row stride below is meant to be read. */
  view.setUint32(8, pitch === undefined ? 0 : 0x8, true);
  view.setUint32(12, height, true);
  view.setUint32(16, width, true);
  view.setUint32(20, pitch ?? 0, true);
  view.setUint32(28, 1, true);
  view.setUint32(76, 32, true);
  view.setUint32(80, flags, true);
  view.setUint32(88, bits, true);
  view.setUint32(92, masks[0], true);
  view.setUint32(96, masks[1], true);
  view.setUint32(100, masks[2], true);
  view.setUint32(104, masks[3], true);
  return bytes;
}

function withPixels(header: Uint8Array, pixels: number[]): Uint8Array {
  const out = new Uint8Array(header.length + pixels.length);
  out.set(header, 0);
  out.set(pixels, header.length);
  return out;
}

const RGB = 0x40;
const ALPHAPIXELS = 0x1;
const LUMINANCE = 0x20000;

test('a 32-bit BGRA surface puts each channel where its mask says, not where it sits', () => {
  /* The 210-of-289 case. Bytes are little-endian, so B G R A on disk is R at 0x00ff0000. */
  const header = rawHeader(
    2,
    1,
    RGB | ALPHAPIXELS,
    32,
    [0x00ff0000, 0x0000ff00, 0x000000ff, 0xff000000],
  );
  const { width, height, rgba } = ddsToRgba(withPixels(header, [10, 20, 30, 40, 50, 60, 70, 80]));
  expect([width, height]).toEqual([2, 1]);
  expect([...rgba.subarray(0, 4)]).toEqual([30, 20, 10, 40]);
  expect([...rgba.subarray(4, 8)]).toEqual([70, 60, 50, 80]);
});

test('a 32-bit RGBA surface reads the same bytes the other way round', () => {
  const header = rawHeader(
    1,
    1,
    RGB | ALPHAPIXELS,
    32,
    [0x000000ff, 0x0000ff00, 0x00ff0000, 0xff000000],
  );
  expect([...ddsToRgba(withPixels(header, [10, 20, 30, 40])).rgba]).toEqual([10, 20, 30, 40]);
});

test('a 24-bit surface has no alpha channel, and comes back opaque rather than empty', () => {
  /* The trap for a reader that assumes four bytes a texel: three, and an alpha mask of zero. */
  const header = rawHeader(2, 1, RGB, 24, [0x00ff0000, 0x0000ff00, 0x000000ff, 0]);
  const { rgba } = ddsToRgba(withPixels(header, [10, 20, 30, 40, 50, 60]));
  expect([...rgba.subarray(0, 4)]).toEqual([30, 20, 10, 255]);
  expect([...rgba.subarray(4, 8)]).toEqual([60, 50, 40, 255]);
});

test('an eight-bit luminance surface fills all three colour channels from the one it has', () => {
  const header = rawHeader(2, 1, LUMINANCE, 8, [0xff, 0, 0, 0]);
  const { rgba } = ddsToRgba(withPixels(header, [77, 200]));
  expect([...rgba.subarray(0, 4)]).toEqual([77, 77, 77, 255]);
  expect([...rgba.subarray(4, 8)]).toEqual([200, 200, 200, 255]);
});

test('a sixteen-bit luminance-with-alpha surface keeps its alpha', () => {
  const header = rawHeader(1, 1, LUMINANCE | ALPHAPIXELS, 16, [0x00ff, 0, 0, 0xff00]);
  expect([...ddsToRgba(withPixels(header, [90, 128])).rgba]).toEqual([90, 90, 90, 128]);
});

/**
 * **A narrow channel is scaled by replication, not by a shift**, which is the one place this goes
 * quietly wrong: five bits of 0x1F is white, and shifting it left by three gives 248. A surface that
 * should be pure white comes back very slightly grey, on every texel, and nothing raises.
 */
test('a five-bit channel at its maximum comes back at 255 and not 248', () => {
  const header = rawHeader(1, 1, RGB, 16, [0xf800, 0x07e0, 0x001f, 0]);
  /* 0xFFFF: every channel at its own maximum. */
  expect([...ddsToRgba(withPixels(header, [0xff, 0xff])).rgba]).toEqual([255, 255, 255, 255]);
});

test('a declared row pitch is honoured, so padding between rows is skipped', () => {
  /* Two rows of one BGRA texel, each padded to eight bytes. */
  const header = rawHeader(
    1,
    2,
    RGB | ALPHAPIXELS,
    32,
    [0x00ff0000, 0x0000ff00, 0x000000ff, 0xff000000],
    8,
  );
  const pixels = [1, 2, 3, 255, 0, 0, 0, 0, 4, 5, 6, 255, 0, 0, 0, 0];
  const { rgba } = ddsToRgba(withPixels(header, pixels));
  expect([...rgba.subarray(0, 4)]).toEqual([3, 2, 1, 255]);
  expect([...rgba.subarray(4, 8)]).toEqual([6, 5, 4, 255]);
});

test('refuses an uncompressed surface whose masks describe nothing', () => {
  const header = rawHeader(1, 1, RGB, 32, [0, 0, 0, 0]);
  expect(() => ddsToRgba(withPixels(header, [0, 0, 0, 0]))).toThrow(/mask/i);
});

test('refuses a bit count it cannot walk, naming it', () => {
  const header = rawHeader(1, 1, RGB, 12, [0xf00, 0x0f0, 0x00f, 0]);
  expect(() => ddsToRgba(withPixels(header, [0, 0]))).toThrow(/12/);
});

test('refuses an uncompressed surface that is short, as it does a block one', () => {
  const header = rawHeader(
    4,
    4,
    RGB | ALPHAPIXELS,
    32,
    [0x00ff0000, 0x0000ff00, 0x000000ff, 0xff000000],
  );
  expect(() => ddsToRgba(withPixels(header, [0, 0, 0, 0]))).toThrow(/short/i);
});
