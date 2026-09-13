/** Linear RGBA floats packed into whatever format the environment cube was actually allocated as. */

import { toHalfFloats } from '../../halfFloat.ts';

/** The packed texels and how wide one is, which is what a `writeTexture` layout needs. */
export interface PackedTexels {
  readonly data: ArrayBufferView;
  readonly bytesPerTexel: number;
}

/**
 * Pack linear RGBA floats for `format`.
 *
 * **`writeTexture` does not convert, and that is the whole reason this exists.** Its `bytesPerRow`
 * describes the *source* stride and it reads `width * bytesPerTexel-of-the-destination` bytes from
 * each row — so float data handed to an eight-bit cube is a legal layout that reinterprets the raw
 * bytes of the floats as unorm bytes. Nothing raises anything: no validation error, no device
 * message, and a cube full of a plausible-looking environment.
 *
 * That is the 2026-08-14 family of WebGPU failure wearing its quietest face. The others at least
 * invalidate a command buffer and leave an empty canvas; this one draws a picture.
 *
 * **Measured, because it was found by measuring rather than by reading.** On a uniform sky the
 * other backend read 81 of 255 and this one read 45.7 from the same file. Neither number looks
 * wrong on its own — the two backends being a control for each other is the only thing that
 * separated them.
 *
 * **What it costs** is one conversion pass over six faces at load. **What would make it wrong** is
 * a format this does not know, which is why the default arm throws rather than guessing: a guess
 * here is exactly the silent picture this function exists to prevent.
 */
export function environmentTexels(pixels: Float32Array, format: GPUTextureFormat): PackedTexels {
  switch (format) {
    /* Already what the source is. No copy, because there is nothing to change. */
    case 'rgba32float':
      return { data: pixels, bytesPerTexel: 16 };

    case 'rgba16float':
      return { data: toHalf(pixels), bytesPerTexel: 8 };

    case 'rgba8unorm':
      return { data: toUnorm(pixels, false, false), bytesPerTexel: 4 };
    case 'bgra8unorm':
      return { data: toUnorm(pixels, true, false), bytesPerTexel: 4 };

    /*
     * An sRGB view decodes what it samples, so the byte stored has to be the *encoded* value or
     * every environment comes back roughly twice as bright as the file. The engine's own scene
     * targets are linear, so this arm is for a surface format a device chose rather than one this
     * renderer asked for.
     */
    case 'rgba8unorm-srgb':
      return { data: toUnorm(pixels, false, true), bytesPerTexel: 4 };
    case 'bgra8unorm-srgb':
      return { data: toUnorm(pixels, true, true), bytesPerTexel: 4 };

    default:
      throw new Error(
        `environmentTexels: no packing for "${format}". Add one rather than letting a wrong ` +
          'layout through — WebGPU accepts a mismatched stride without complaint and draws a ' +
          'plausible picture from reinterpreted bytes.',
      );
  }
}

function toHalf(pixels: Float32Array): Uint16Array {
  return toHalfFloats(pixels);
}

/**
 * Eight bits a channel, clipped at white.
 *
 * **Clipped rather than tone-mapped**, matching what the other backend does with a non-float cube
 * and for the reason a bake documents at length: the cube stores radiance, and a curve applied here
 * would be a viewing transform baked into stored light.
 */
function toUnorm(pixels: Float32Array, swapRedAndBlue: boolean, encodeSrgb: boolean): Uint8Array {
  const texels = pixels.length / 4;
  const out = new Uint8Array(texels * 4);
  for (let texel = 0; texel < texels; texel++) {
    for (let channel = 0; channel < 3; channel++) {
      const linear = pixels[texel * 4 + channel] ?? 0;
      const clipped = linear <= 0 ? 0 : linear >= 1 ? 1 : linear;
      const value = encodeSrgb ? srgbEncode(clipped) : clipped;
      const at = texel * 4 + (swapRedAndBlue ? 2 - channel : channel);
      out[at] = Math.round(value * 255);
    }
    out[texel * 4 + 3] = 255;
  }
  return out;
}

/** The sRGB transfer function, in the direction that prepares a value for a decoding sampler. */
function srgbEncode(linear: number): number {
  return linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055;
}
