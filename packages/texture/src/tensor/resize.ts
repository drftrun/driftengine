/**
 * Resizing a channel-major image, `[channels][height][width]`, by the upstream's conventions.
 *
 * **They are followed exactly, because they are the bug every port has.** Without aligned corners
 * a destination pixel reads source `(i + ½)·scale − ½`, and for bilinear a negative source is
 * clamped to zero; with aligned corners it reads `i·(in − 1)/(out − 1)`, and an output of one reads
 * source zero. Bicubic uses the cubic convolution kernel with `a = −0.75`, not the −0.5 of the
 * textbooks, and clamps its four taps to the border rather than its coordinate. Nearest reads
 * `⌊i·scale⌋`, PyTorch's legacy `nearest` rather than `nearest-exact`.
 */
const CUBIC_A = -0.75;

/* The cubic convolution kernel's two pieces, for |x| ≤ 1 and 1 < |x| < 2. */
function cubicNear(x: number): number {
  return ((CUBIC_A + 2) * x - (CUBIC_A + 3)) * x * x + 1;
}

function cubicFar(x: number): number {
  return ((CUBIC_A * x - 5 * CUBIC_A) * x + 8 * CUBIC_A) * x - 4 * CUBIC_A;
}

/*
 * Where destination index `i` reads from, in the upstream's convention. Without aligned corners a
 * destination pixel covers `input / output` source pixels — unless a step is given, which is what
 * PyTorch's interpolate uses when it is handed a scale factor: the factor's inverse, not the ratio
 * of the sizes it rounded to.
 */
function sourceOf(
  i: number,
  input: number,
  output: number,
  align: boolean,
  cubic: boolean,
  step?: number,
): number {
  if (align) return output <= 1 ? 0 : (i * (input - 1)) / (output - 1);
  const source = step === undefined ? ((i + 0.5) * input) / output - 0.5 : (i + 0.5) * step - 0.5;
  return !cubic && source < 0 ? 0 : source;
}

function clampIndex(i: number, size: number): number {
  return i < 0 ? 0 : i >= size ? size - 1 : i;
}

/**
 * `out[channels][outH][outW]` resized from `input[channels][inH][inW]`. `step`, without aligned
 * corners, is the source pixels a destination pixel covers, vertically and then horizontally, where
 * it is not the ratio of the sizes.
 */
export function resize(
  out: Float32Array,
  input: Float32Array,
  channels: number,
  inH: number,
  inW: number,
  outH: number,
  outW: number,
  mode: 'bilinear' | 'bicubic' | 'nearest',
  alignCorners: boolean,
  step?: readonly [number, number],
): void {
  if (mode === 'nearest') {
    nearest(out, input, channels, inH, inW, outH, outW, step);
    return;
  }
  const cubic = mode === 'bicubic';
  const wx = [0, 0, 0, 0];
  const wy = [0, 0, 0, 0];
  for (let c = 0; c < channels; c += 1) {
    const plane = c * inH * inW;
    for (let y = 0; y < outH; y += 1) {
      const sy = sourceOf(y, inH, outH, alignCorners, cubic, step?.[0]);
      const y0 = Math.floor(sy);
      const ty = sy - y0;
      for (let x = 0; x < outW; x += 1) {
        const sx = sourceOf(x, inW, outW, alignCorners, cubic, step?.[1]);
        const x0 = Math.floor(sx);
        const tx = sx - x0;
        let value = 0;
        if (cubic) {
          wx[0] = cubicFar(tx + 1);
          wx[1] = cubicNear(tx);
          wx[2] = cubicNear(1 - tx);
          wx[3] = cubicFar(2 - tx);
          wy[0] = cubicFar(ty + 1);
          wy[1] = cubicNear(ty);
          wy[2] = cubicNear(1 - ty);
          wy[3] = cubicFar(2 - ty);
          for (let j = 0; j < 4; j += 1) {
            const row = plane + clampIndex(y0 - 1 + j, inH) * inW;
            let across = 0;
            for (let i = 0; i < 4; i += 1) {
              across += (wx[i] as number) * (input[row + clampIndex(x0 - 1 + i, inW)] as number);
            }
            value += (wy[j] as number) * across;
          }
        } else {
          const x1 = Math.min(x0 + 1, inW - 1);
          const y1 = Math.min(y0 + 1, inH - 1);
          const top =
            (input[plane + y0 * inW + x0] as number) * (1 - tx) +
            (input[plane + y0 * inW + x1] as number) * tx;
          const bottom =
            (input[plane + y1 * inW + x0] as number) * (1 - tx) +
            (input[plane + y1 * inW + x1] as number) * tx;
          value = top * (1 - ty) + bottom * ty;
        }
        out[(c * outH + y) * outW + x] = value;
      }
    }
  }
}

/*
 * PyTorch's `nearest`: destination `i` reads source `⌊i·scale⌋`, clamped to the last, the product
 * taken in single precision as its kernel takes it — `scale` the step where the node gives one, as
 * a resize by a scale factor does, and the sizes' ratio otherwise.
 */
function nearest(
  out: Float32Array,
  input: Float32Array,
  channels: number,
  inH: number,
  inW: number,
  outH: number,
  outW: number,
  step?: readonly [number, number],
): void {
  const scaleY = Math.fround(step?.[0] ?? inH / outH);
  const scaleX = Math.fround(step?.[1] ?? inW / outW);
  for (let c = 0; c < channels; c += 1) {
    for (let y = 0; y < outH; y += 1) {
      const sy = Math.min(Math.floor(Math.fround(y * scaleY)), inH - 1);
      for (let x = 0; x < outW; x += 1) {
        const sx = Math.min(Math.floor(Math.fround(x * scaleX)), inW - 1);
        out[(c * outH + y) * outW + x] = input[(c * inH + sy) * inW + sx] as number;
      }
    }
  }
}
