/**
 * `LVOL`: a world's fixed lights summed into one dense volume offline, as the renderer reads it.
 *
 * **Optional, because the file is whole without it.** A reader that skips it draws the world lit by
 * the lights it shades exactly and loses the glow of every light past them — less, not wrong.
 *
 * **Runs, because most of a city's volume is dark.** Lamps reach thirty metres and the volume stands
 * a hundred and more, so the samples above the light are nothing, and a sample inside a building is
 * nothing of another kind: it is not a sample at all, which the shader's filtering must be told.
 * So samples are written in order as runs of three kinds — dark air, solid, and literal — and only a
 * literal run carries values, eight half floats a sample: the colour and whether it is a sample,
 * then the direction light arrives from.
 *
 * Layout, little-endian:
 * - f32 × 3 origin, f32 spacing, u32 × 3 samples on each axis;
 * - runs until every sample is covered, each a u32 whose top two bits are the kind (0 dark air,
 *   1 solid, 2 literal) and whose low thirty are the count, a literal followed by its halves.
 */
import { DrftError, align } from './drftFormat.ts';

/** The same shape as core's `DenseLightVolume`, so a read volume goes straight to the renderer. */
export interface DrftLightVolume {
  readonly origin: readonly [number, number, number];
  readonly spacing: number;
  readonly dims: readonly [number, number, number];
  /** Four floats a sample, x fastest: the colour, then 1 for a sample and 0 inside solid. */
  readonly light: Float32Array;
  /** Four floats a sample: the direction light arrives from, then 0. */
  readonly direction: Float32Array;
}

const DARK = 0;
const SOLID = 1;
const LITERAL = 2;
const COUNT_MASK = 0x3fffffff;

function kindOf(volume: DrftLightVolume, sample: number): number {
  const at = sample * 4;
  const light = volume.light;
  const lit =
    light[at] !== 0 ||
    light[at + 1] !== 0 ||
    light[at + 2] !== 0 ||
    volume.direction[at] !== 0 ||
    volume.direction[at + 1] !== 0 ||
    volume.direction[at + 2] !== 0;
  if (lit) return LITERAL;
  if (light[at + 3] === 1) return DARK;
  if (light[at + 3] === 0) return SOLID;
  return LITERAL;
}

export function buildLightVolume(volume: DrftLightVolume): Uint8Array {
  const count = volume.dims[0] * volume.dims[1] * volume.dims[2];
  if (volume.light.length !== count * 4 || volume.direction.length !== count * 4) {
    throw new DrftError(`a light volume of ${count} samples needs ${count * 4} floats a channel`);
  }
  if (!(volume.spacing > 0)) throw new DrftError(`a light volume's spacing is ${volume.spacing}`);
  /* Measured first, so the payload is allocated once. */
  let bytes = 28;
  for (let sample = 0; sample < count;) {
    const kind = kindOf(volume, sample);
    let end = sample + 1;
    while (end < count && end - sample < COUNT_MASK && kindOf(volume, end) === kind) end++;
    bytes += 4 + (kind === LITERAL ? (end - sample) * 16 : 0);
    sample = end;
  }
  const out = new Uint8Array(align(bytes));
  const view = new DataView(out.buffer);
  for (let i = 0; i < 3; i++) view.setFloat32(i * 4, volume.origin[i] as number, true);
  view.setFloat32(12, volume.spacing, true);
  for (let i = 0; i < 3; i++) view.setUint32(16 + i * 4, volume.dims[i] as number, true);
  let at = 28;
  for (let sample = 0; sample < count;) {
    const kind = kindOf(volume, sample);
    let end = sample + 1;
    while (end < count && end - sample < COUNT_MASK && kindOf(volume, end) === kind) end++;
    view.setUint32(at, ((kind << 30) | (end - sample)) >>> 0, true);
    at += 4;
    if (kind === LITERAL) {
      for (let s = sample; s < end; s++) {
        for (let c = 0; c < 4; c++) {
          view.setUint16(at, halfOf(volume.light[s * 4 + c] as number), true);
          view.setUint16(at + 8, halfOf(volume.direction[s * 4 + c] as number), true);
          at += 2;
        }
        at += 8;
      }
    }
    sample = end;
  }
  return out;
}

export function readLightVolume(
  buffer: ArrayBufferLike,
  offset: number,
  byteLength: number,
): DrftLightVolume {
  if (byteLength < 28) throw new DrftError('LVOL ends inside its header');
  const view = new DataView(buffer, offset, byteLength);
  const origin: [number, number, number] = [
    view.getFloat32(0, true),
    view.getFloat32(4, true),
    view.getFloat32(8, true),
  ];
  const spacing = view.getFloat32(12, true);
  const dims: [number, number, number] = [
    view.getUint32(16, true),
    view.getUint32(20, true),
    view.getUint32(24, true),
  ];
  const count = dims[0] * dims[1] * dims[2];
  if (!(spacing > 0) || count === 0) {
    throw new DrftError(`LVOL has spacing ${spacing} and ${dims.join(' x ')} samples`);
  }
  const light = new Float32Array(count * 4);
  const direction = new Float32Array(count * 4);
  let at = 28;
  let sample = 0;
  while (sample < count) {
    if (at + 4 > byteLength) throw new DrftError(`LVOL ends at sample ${sample} of ${count}`);
    const word = view.getUint32(at, true);
    at += 4;
    const kind = word >>> 30;
    const run = word & COUNT_MASK;
    if (run === 0 || sample + run > count || kind > LITERAL) {
      throw new DrftError(`LVOL has a run of ${run} of kind ${kind} at sample ${sample}`);
    }
    if (kind === DARK) {
      for (let s = sample; s < sample + run; s++) light[s * 4 + 3] = 1;
    } else if (kind === LITERAL) {
      if (at + run * 16 > byteLength) throw new DrftError(`LVOL ends inside sample ${sample}`);
      for (let s = sample; s < sample + run; s++) {
        for (let c = 0; c < 4; c++) {
          light[s * 4 + c] = floatOf(view.getUint16(at, true));
          direction[s * 4 + c] = floatOf(view.getUint16(at + 8, true));
          at += 2;
        }
        at += 8;
      }
    }
    sample += run;
  }
  return { origin, spacing, dims, light, direction };
}

const scratchFloat = new Float32Array(1);
const scratchWord = new Uint32Array(scratchFloat.buffer);

/** A float as IEEE half-precision bits, rounded to nearest, overflow to infinity. */
function halfOf(value: number): number {
  scratchFloat[0] = value;
  const word = scratchWord[0] as number;
  const sign = (word >>> 16) & 0x8000;
  const exponent = ((word >>> 23) & 0xff) - 127 + 15;
  const mantissa = word & 0x7fffff;
  if (exponent >= 31)
    return sign | 0x7c00 | (((word >>> 23) & 0xff) === 0xff && mantissa ? 0x200 : 0);
  if (exponent <= 0) {
    if (exponent < -10) return sign;
    const full = mantissa | 0x800000;
    const shift = 14 - exponent;
    const rounded = (full + (1 << (shift - 1))) >> shift;
    return sign | rounded;
  }
  const rounded = (exponent << 10) + ((mantissa + 0x1000) >> 13);
  return sign | Math.min(rounded, 0x7c00);
}

/** IEEE half-precision bits as a float. */
function floatOf(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const mantissa = bits & 0x3ff;
  if (exponent === 0) return sign * mantissa * 2 ** -24;
  if (exponent === 31) return mantissa ? Number.NaN : sign * Number.POSITIVE_INFINITY;
  return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}
