/**
 * Where a pixel's surface was, and the history sampled there.
 *
 * **Off the edge is a disocclusion, not a clamp.** A surface that was outside last frame's picture
 * has no history; sampling the border instead drags one row of pixels inward as a smear for as long
 * as the camera keeps turning. The temporal resolve already refuses it, and this keeps the rule.
 *
 * **The history is read bicubically**, because a bilinear read of an accumulated picture blurs it a
 * little more every frame it is carried: a history reprojected by half a pixel sixty times a second
 * is a history bilinearly filtered sixty times a second. Catmull-Rom interpolates — a texel centre
 * returns that texel — and its weights sum to one, so the picture neither brightens nor darkens as
 * it accumulates. Its negative lobes can undershoot beside a bright edge; a colour cannot be
 * negative, so the sample is floored at zero, and the neighbourhood clip bounds the rest.
 *
 * **The shader uses five bilinear taps for the sixteen texels**: the middle pair of each axis folded
 * into one tap, the four corners dropped, the weights renormalised. On an accumulated picture the
 * corners carry almost nothing, and the test beside this says how little.
 *
 * Images are rows from `v = 0` upward, texel centres at whole texel coordinates, clamped at the
 * border.
 */

/**
 * Reproject pixel `(x, y)` of a `width` by `height` target by a motion vector in uv units, into the
 * texel coordinate its surface had. Returns false where that is off the picture — past the outer
 * edge of the border texels, or not a number.
 */
export function reprojectPixel(
  x: number,
  y: number,
  motion: ArrayLike<number>,
  width: number,
  height: number,
  out: Float32Array,
): boolean {
  const u = (x + 0.5) / width + (motion[0] as number);
  const v = (y + 0.5) / height + (motion[1] as number);
  out[0] = u * width - 0.5;
  out[1] = v * height - 0.5;
  return u >= 0 && u <= 1 && v >= 0 && v <= 1;
}

/** Catmull-Rom's four weights for the texels at -1, 0, 1 and 2 about a fraction `t`. */
export function catmullRomWeights(t: number, out: Float64Array): void {
  const t2 = t * t;
  const t3 = t2 * t;
  out[0] = -0.5 * t3 + t2 - 0.5 * t;
  out[1] = 1.5 * t3 - 2.5 * t2 + 1;
  out[2] = -1.5 * t3 + 2 * t2 + 0.5 * t;
  out[3] = 0.5 * t3 - 0.5 * t2;
}

function clampIndex(value: number, size: number): number {
  return value < 0 ? 0 : value >= size ? size - 1 : value;
}

/** One texel, clamped to the image. */
function texel(
  image: ArrayLike<number>,
  x: number,
  y: number,
  width: number,
  height: number,
  channels: number,
  c: number,
): number {
  return image[(clampIndex(y, height) * width + clampIndex(x, width)) * channels + c] as number;
}

/** A bilinear read at texel coordinate `(x, y)`, clamped at the border. */
export function sampleBilinear(
  image: ArrayLike<number>,
  x: number,
  y: number,
  width: number,
  height: number,
  channels: number,
  out: Float32Array,
): void {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  for (let c = 0; c < channels; c += 1) {
    const top =
      texel(image, x0, y0, width, height, channels, c) * (1 - fx) +
      texel(image, x0 + 1, y0, width, height, channels, c) * fx;
    const bottom =
      texel(image, x0, y0 + 1, width, height, channels, c) * (1 - fx) +
      texel(image, x0 + 1, y0 + 1, width, height, channels, c) * fx;
    out[c] = top * (1 - fy) + bottom * fy;
  }
}

const WX = new Float64Array(4);
const WY = new Float64Array(4);

/** The full sixteen-texel Catmull-Rom read at texel coordinate `(x, y)`, floored at zero. */
export function sampleHistoryBicubic(
  image: ArrayLike<number>,
  x: number,
  y: number,
  width: number,
  height: number,
  channels: number,
  out: Float32Array,
): void {
  const x1 = Math.floor(x);
  const y1 = Math.floor(y);
  catmullRomWeights(x - x1, WX);
  catmullRomWeights(y - y1, WY);
  for (let c = 0; c < channels; c += 1) {
    let sum = 0;
    for (let j = 0; j < 4; j += 1) {
      let row = 0;
      for (let i = 0; i < 4; i += 1) {
        row += (WX[i] as number) * texel(image, x1 - 1 + i, y1 - 1 + j, width, height, channels, c);
      }
      sum += (WY[j] as number) * row;
    }
    out[c] = Math.max(0, sum);
  }
}

const TAP = new Float32Array(4);

/**
 * The five-tap approximation the shader uses, at texel coordinate `(x, y)`, floored at zero.
 *
 * Each axis's middle two texels are one bilinear tap placed at `w2 / (w1 + w2)` between them, which
 * is exact for those four texels; the edge taps read a row or column the same way; the corners are
 * dropped and the five weights renormalised.
 */
export function sampleHistoryBicubic5(
  image: ArrayLike<number>,
  x: number,
  y: number,
  width: number,
  height: number,
  channels: number,
  out: Float32Array,
): void {
  const x1 = Math.floor(x);
  const y1 = Math.floor(y);
  catmullRomWeights(x - x1, WX);
  catmullRomWeights(y - y1, WY);
  const wx12 = (WX[1] as number) + (WX[2] as number);
  const wy12 = (WY[1] as number) + (WY[2] as number);
  const x12 = x1 + (WX[2] as number) / wx12;
  const y12 = y1 + (WY[2] as number) / wy12;
  const x0 = x1 - 1;
  const y0 = y1 - 1;
  const x3 = x1 + 2;
  const y3 = y1 + 2;
  const weights = [
    wx12 * (WY[0] as number),
    (WX[0] as number) * wy12,
    wx12 * wy12,
    (WX[3] as number) * wy12,
    wx12 * (WY[3] as number),
  ];
  const at = [
    [x12, y0],
    [x0, y12],
    [x12, y12],
    [x3, y12],
    [x12, y3],
  ];
  const total = weights.reduce((sum, w) => sum + w, 0);
  for (let c = 0; c < channels; c += 1) out[c] = 0;
  for (let k = 0; k < 5; k += 1) {
    const place = at[k] as number[];
    sampleBilinear(image, place[0] as number, place[1] as number, width, height, channels, TAP);
    for (let c = 0; c < channels; c += 1) {
      out[c] = (out[c] as number) + (weights[k] as number) * (TAP[c] as number);
    }
  }
  for (let c = 0; c < channels; c += 1) out[c] = Math.max(0, (out[c] as number) / total);
}
