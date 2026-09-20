/**
 * An image as the second pipeline reads one: a decode program of one sample, over a block that
 * carries every mip level down to one texel.
 *
 * **Shared by the voxel sandbox's atlas and the city's facade**, which are the two images in the
 * demos that are pictures rather than generated fields. An ordinary image is already a program of
 * one instruction — `SAMPLE_BLOCK` over a block with a full chain, which `imageProgram` in
 * `demo/gpuDrivenRig.ts` established — and the two things every picture here needs beyond that are
 * a chain built the right way and, for a colour, the sRGB curve.
 *
 * - **`srgbImage`** is a colour: bytes as a canvas holds them, decoded to linear light by three
 *   `REMAP_CHANNEL`s in the program, with a chain averaged in linear light and weighted by coverage.
 * - **`linearImage`** is a quantity — an emissive mask, a roughness — whose bytes already are the
 *   value, so the program is the sample alone and the chain is a plain average.
 *
 * Both take the address mode, because an atlas clamps and a facade repeats.
 */
import { DECODE_OP, REMAP_SEMANTICS, linearToSrgb, srgbToLinear } from '@driftengine/texture';

import type { GpuDrivenProgram } from '../packages/core/src/index';

/** The packed operand `REMAP_CHANNEL` takes: a semantic's index in the high bits, a component low. */
function srgbChannel(component: number): number {
  return (REMAP_SEMANTICS.indexOf('albedo-srgb') << 4) | component;
}

/** sRGB bytes to linear light, once, so the chain is not re-decoding the same 256 values. */
const TO_LINEAR = Float64Array.from({ length: 256 }, (_, byte) => srgbToLinear(byte / 255));

/**
 * One level down: each texel the mean of the four above it.
 *
 * **In linear light and weighted by coverage.** A byte average of black and white is 128, which
 * is a fifth of the light rather than half; and a canvas hands a transparent texel back as black,
 * so an unweighted mean darkens every leaf toward its holes the further away it is. The colour is
 * the coverage-weighted mean of the light, re-encoded; the coverage is the plain mean.
 */
export function halfLevel(from: Uint8Array, wide: number): Uint8Array {
  const size = wide >> 1;
  const next = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let alpha = 0;
      for (let dy = 0; dy < 2; dy += 1) {
        for (let dx = 0; dx < 2; dx += 1) {
          const at = ((y * 2 + dy) * wide + (x * 2 + dx)) * 4;
          const weight = (from[at + 3] as number) / 255;
          r += (TO_LINEAR[from[at] as number] as number) * weight;
          g += (TO_LINEAR[from[at + 1] as number] as number) * weight;
          b += (TO_LINEAR[from[at + 2] as number] as number) * weight;
          alpha += weight;
        }
      }
      const out = (y * size + x) * 4;
      /* Where nothing covers the texel it keeps the zero it was made with. For clarity rather than
         safety: 0/0 is NaN and a Uint8Array stores NaN as zero, so removing this changed nothing. */
      if (alpha > 0) {
        next[out] = Math.round(linearToSrgb(r / alpha) * 255);
        next[out + 1] = Math.round(linearToSrgb(g / alpha) * 255);
        next[out + 2] = Math.round(linearToSrgb(b / alpha) * 255);
      }
      next[out + 3] = Math.round((alpha / 4) * 255);
    }
  }
  return next;
}

/** Every level below `level0`, by `reduce`, down to one texel. */
function chainOf(
  level0: Uint8Array,
  edge: number,
  reduce: (from: Uint8Array, wide: number) => Uint8Array,
): Uint8Array[] {
  if (!(edge >= 1) || (edge & (edge - 1)) !== 0 || level0.length !== edge * edge * 4) {
    throw new Error(
      `[driftengine] an image here is a power-of-two square of RGBA bytes, and ${level0.length} ` +
        `bytes were given for an edge of ${edge}`,
    );
  }
  const levels: Uint8Array[] = [level0];
  for (let wide = edge; wide > 1; wide >>= 1) {
    levels.push(reduce(levels[levels.length - 1] as Uint8Array, wide));
  }
  return levels;
}

/** One level down by the plain mean of four, for bytes that are the value they hold. */
export function averageLevel(from: Uint8Array, wide: number): Uint8Array {
  const size = wide >> 1;
  const next = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      for (let k = 0; k < 4; k += 1) {
        let sum = 0;
        for (let dy = 0; dy < 2; dy += 1) {
          for (let dx = 0; dx < 2; dx += 1) {
            sum += from[((y * 2 + dy) * wide + (x * 2 + dx)) * 4 + k] as number;
          }
        }
        next[(y * size + x) * 4 + k] = Math.round(sum / 4);
      }
    }
  }
  return next;
}

/**
 * A colour image: sRGB bytes, top row first as a canvas reads it, decoded to linear light in the
 * program. See the header.
 */
export function srgbImage(level0: Uint8Array, edge: number, addressMode: number): GpuDrivenProgram {
  return {
    graph: {
      /* Sample, then decode the curve on red, green and blue in place. Alpha is linear. */
      nodes: Uint32Array.from([
        DECODE_OP.SAMPLE_BLOCK,
        0,
        0,
        0,
        DECODE_OP.REMAP_CHANNEL,
        0,
        srgbChannel(0),
        0,
        DECODE_OP.REMAP_CHANNEL,
        0,
        srgbChannel(1),
        0,
        DECODE_OP.REMAP_CHANNEL,
        0,
        srgbChannel(2),
        0,
      ]),
      count: 4,
      result: 0,
      addressMode,
    },
    latents: [],
    blocks: [
      { width: edge, height: edge, components: 4, levels: chainOf(level0, edge, halfLevel) },
    ],
    networks: [],
  };
}

/** A quantity image: bytes that are the value over 255, read as they are. See the header. */
export function linearImage(
  level0: Uint8Array,
  edge: number,
  addressMode: number,
): GpuDrivenProgram {
  return {
    graph: {
      nodes: Uint32Array.from([DECODE_OP.SAMPLE_BLOCK, 0, 0, 0]),
      count: 1,
      result: 0,
      addressMode,
    },
    latents: [],
    blocks: [
      { width: edge, height: edge, components: 4, levels: chainOf(level0, edge, averageLevel) },
    ],
    networks: [],
  };
}
