/**
 * A frame as a model takes it: the preparation each upstream does to its own inputs, done here so a
 * host hands the engine pixels and nothing else.
 *
 * **Depth Anything 3**, as its `InputProcessor` prepares a frame: the longest side brought to 504
 * by an area resize, each side then rounded to the nearest whole patch of 14 by another, the bytes
 * divided by 255 and normalised by ImageNet's mean and deviation, and laid out channel by row. A
 * clip's aspect ratio decides the grid, which is why the graph is rebuilt per size.
 *
 * **MobileSAM**, as its predictor prepares one: the longest side to 1,024 by Pillow's bilinear,
 * normalised by the upstream's pixel mean and deviation in 0–255, and padded with zeros after its
 * last row and column to the square the encoder takes. The prepared frame's own size is answered
 * too, since a prompt's coordinates are in it and a mask comes back cropped to it.
 *
 * **SAM 2.1**, as its processor prepares one: the frame to a 1,024 square whatever its shape —
 * each axis scaled by its own factor, which is why a prompt's coordinates scale by their own too —
 * through torchvision's antialiased bilinear, divided by 255 and normalised by ImageNet's.
 *
 * **OWLv2**, as its processor prepares one, which is the odd one: the bytes divided by 255 first,
 * the frame padded with zeros after its last row and column to a square — so a box's coordinates
 * scale by the longer side — blurred by a gaussian wide enough for the reduction, resized to 960
 * by a plain bilinear with no antialiasing of its own, and normalised by CLIP's statistics. The
 * blur is what the antialiasing is here, which is why the resize after it has none.
 *
 * **A frame smaller than the model's size is refused rather than guessed at.** The upstream scales
 * such a frame up with a cubic resize, which this does not have; a wrong preparation is a wrong
 * depth that looks like a right one, and a refusal names what is missing. What would lift it is
 * OpenCV's `INTER_CUBIC`, written and held to the same parity as the area resize.
 */
import { exactExp } from '@driftengine/core';
import { resize } from '@driftengine/texture';

import { areaResize, triangleResize, TORCHVISION_PRECISION } from './resample.ts';

export const DEPTH_PIXEL_MEAN = [0.485, 0.456, 0.406] as const;
export const DEPTH_PIXEL_STD = [0.229, 0.224, 0.225] as const;

export interface PreparedFrame {
  /** `[3, height, width]`, normalised. */
  readonly pixels: Float32Array;
  readonly width: number;
  readonly height: number;
}

/** Python's `round`: halves to even, which is what the upstream's sizes are rounded by. */
function halfToEven(value: number): number {
  const down = Math.floor(value);
  const rest = value - down;
  if (rest > 0.5) return down + 1;
  if (rest < 0.5) return down;
  return down % 2 === 0 ? down : down + 1;
}

/** The nearest multiple of `patch`, the larger one on a tie, as the upstream rounds it. */
function nearestMultiple(value: number, patch: number): number {
  const down = Math.floor(value / patch) * patch;
  const up = down + patch;
  return up - value <= value - down ? up : down;
}

/**
 * `rgba`, `width × height` pixels of four bytes, as Depth Anything 3 takes it at `size`, in whole
 * patches of `patch`.
 */
export function prepareDepthFrame(
  rgba: Uint8Array,
  width: number,
  height: number,
  size = 504,
  patch = 14,
): PreparedFrame {
  const longest = Math.max(width, height);
  if (longest < size) {
    throw new RangeError(
      `a frame of ${width}×${height} is smaller than the model's ${size} and would have to be ` +
        'scaled up, which needs the cubic resize this does not have',
    );
  }
  const scale = size / longest;
  let held = rgba;
  let at = { width, height };
  if (longest !== size) {
    at = {
      width: Math.max(1, halfToEven(width * scale)),
      height: Math.max(1, halfToEven(height * scale)),
    };
    held = new Uint8Array(at.width * at.height * 4);
    areaResize(rgba, width, height, 4, held, at.width, at.height);
  }
  const whole = {
    width: Math.max(1, nearestMultiple(at.width, patch)),
    height: Math.max(1, nearestMultiple(at.height, patch)),
  };
  if (whole.width > at.width || whole.height > at.height) {
    throw new RangeError(
      `a frame of ${at.width}×${at.height} rounds up to ${whole.width}×${whole.height} whole ` +
        'patches, which needs the cubic resize this does not have',
    );
  }
  if (whole.width !== at.width || whole.height !== at.height) {
    const rounded = new Uint8Array(whole.width * whole.height * 4);
    areaResize(held, at.width, at.height, 4, rounded, whole.width, whole.height);
    held = rounded;
    at = whole;
  }
  const pixels = new Float32Array(3 * at.width * at.height);
  const cells = at.width * at.height;
  for (let channel = 0; channel < 3; channel += 1) {
    const mean = DEPTH_PIXEL_MEAN[channel] as number;
    const deviation = DEPTH_PIXEL_STD[channel] as number;
    for (let cell = 0; cell < cells; cell += 1) {
      const value = (held[cell * 4 + channel] as number) / 255;
      pixels[channel * cells + cell] = Math.fround((Math.fround(value) - mean) / deviation);
    }
  }
  return { pixels, width: at.width, height: at.height };
}

/** The size a frame is resized to, its longest side at `size`, rounded up at a half. */
export function longestSideSize(
  width: number,
  height: number,
  size: number,
): { readonly width: number; readonly height: number } {
  const scale = size / Math.max(width, height);
  return {
    width: Math.trunc(width * scale + 0.5),
    height: Math.trunc(height * scale + 0.5),
  };
}

/**
 * `rgba` as MobileSAM's predictor prepares it: `[3, square, square]`, the frame itself in the top
 * left at the size this answers, and zeros after it.
 */
export function prepareSamFrame(
  rgba: Uint8Array,
  width: number,
  height: number,
  mean: readonly number[],
  deviation: readonly number[],
  square = 1024,
): PreparedFrame {
  const at = longestSideSize(width, height, square);
  let held = rgba;
  if (at.width !== width || at.height !== height) {
    held = new Uint8Array(at.width * at.height * 4);
    triangleResize(rgba, width, height, 4, held, at.width, at.height);
  }
  const pixels = new Float32Array(3 * square * square);
  for (let channel = 0; channel < 3; channel += 1) {
    const centre = mean[channel] as number;
    const spread = deviation[channel] as number;
    for (let y = 0; y < at.height; y += 1) {
      for (let x = 0; x < at.width; x += 1) {
        const value = held[(y * at.width + x) * 4 + channel] as number;
        pixels[channel * square * square + y * square + x] = Math.fround((value - centre) / spread);
      }
    }
  }
  return { pixels, width: at.width, height: at.height };
}

/**
 * `rgba` as SAM 2's processor prepares it: `[3, square, square]`, each axis scaled on its own, and
 * normalised by `mean` and `deviation` in 0–1.
 */
export function prepareSam2Frame(
  rgba: Uint8Array,
  width: number,
  height: number,
  mean: readonly number[] = DEPTH_PIXEL_MEAN,
  deviation: readonly number[] = DEPTH_PIXEL_STD,
  square = 1024,
): PreparedFrame {
  let held = rgba;
  if (width !== square || height !== square) {
    held = new Uint8Array(square * square * 4);
    triangleResize(rgba, width, height, 4, held, square, square, TORCHVISION_PRECISION);
  }
  const pixels = new Float32Array(3 * square * square);
  const cells = square * square;
  for (let channel = 0; channel < 3; channel += 1) {
    const centre = mean[channel] as number;
    const spread = deviation[channel] as number;
    for (let cell = 0; cell < cells; cell += 1) {
      const value = Math.fround((held[cell * 4 + channel] as number) / 255);
      pixels[channel * cells + cell] = Math.fround((value - centre) / spread);
    }
  }
  return { pixels, width: square, height: square };
}

/* torchvision's 1-D gaussian: samples about the centre, normalised to sum to one. */
function gaussianKernel(size: number, sigma: number): Float32Array {
  const half = (size - 1) * 0.5;
  const kernel = new Float32Array(size);
  let total = 0;
  for (let i = 0; i < size; i += 1) {
    /* `linspace` from −half to half, which is how torchvision places the samples. */
    const at = size === 1 ? 0 : -half + (2 * half * i) / (size - 1);
    const value = Math.fround(exactExp(-0.5 * (at / sigma) * (at / sigma)));
    kernel[i] = value;
    total += value;
  }
  for (let i = 0; i < size; i += 1) kernel[i] = Math.fround((kernel[i] as number) / total);
  return kernel;
}

/* A separable blur with the edges reflected, as torchvision's `gaussian_blur` pads them. */
function blur(
  values: Float32Array,
  channels: number,
  height: number,
  width: number,
  down: Float32Array,
  across: Float32Array,
): Float32Array {
  const reflect = (at: number, length: number): number => {
    let index = at;
    while (index < 0 || index >= length) index = index < 0 ? -index : 2 * length - index - 2;
    return index;
  };
  const middle = new Float32Array(values.length);
  const half = (across.length - 1) / 2;
  for (let c = 0; c < channels; c += 1) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let sum = 0;
        for (let k = 0; k < across.length; k += 1) {
          sum = Math.fround(
            sum +
              Math.fround(
                (values[(c * height + y) * width + reflect(x + k - half, width)] as number) *
                  (across[k] as number),
              ),
          );
        }
        middle[(c * height + y) * width + x] = sum;
      }
    }
  }
  const out = new Float32Array(values.length);
  const tall = (down.length - 1) / 2;
  for (let c = 0; c < channels; c += 1) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let sum = 0;
        for (let k = 0; k < down.length; k += 1) {
          sum = Math.fround(
            sum +
              Math.fround(
                (middle[(c * height + reflect(y + k - tall, height)) * width + x] as number) *
                  (down[k] as number),
              ),
          );
        }
        out[(c * height + y) * width + x] = sum;
      }
    }
  }
  return out;
}

/** `rgba` as OWLv2's processor prepares it: `[3, square, square]` at the model's size. */
export function prepareOwlv2Frame(
  rgba: Uint8Array,
  width: number,
  height: number,
  mean: readonly number[],
  deviation: readonly number[],
  square = 960,
): PreparedFrame {
  const side = Math.max(width, height);
  const padded = new Float32Array(3 * side * side);
  for (let channel = 0; channel < 3; channel += 1) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        padded[(channel * side + y) * side + x] = Math.fround(
          (rgba[(y * width + x) * 4 + channel] as number) / 255,
        );
      }
    }
  }
  const factor = side / square;
  const sigma = Math.max(0, (factor - 1) / 2);
  let blurred: Float32Array = padded;
  if (sigma > 0) {
    const size = 2 * Math.ceil(3 * sigma) + 1;
    const kernel = gaussianKernel(size, sigma);
    blurred = blur(padded, 3, side, side, kernel, kernel);
  }
  const resized = new Float32Array(3 * square * square);
  resize(resized, blurred, 3, side, side, square, square, 'bilinear', false);
  const cells = square * square;
  for (let channel = 0; channel < 3; channel += 1) {
    const centre = mean[channel] as number;
    const spread = deviation[channel] as number;
    for (let cell = 0; cell < cells; cell += 1) {
      resized[channel * cells + cell] = Math.fround(
        ((resized[channel * cells + cell] as number) - centre) / spread,
      );
    }
  }
  return { pixels: resized, width: square, height: square };
}
