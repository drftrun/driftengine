/**
 * The resampling a model's own preparation does, as the library its upstream uses does it.
 *
 * **Area resizing is OpenCV's `INTER_AREA`**, which Depth Anything 3's `InputProcessor` resizes a
 * frame down with: an output pixel is the average of the source rectangle it covers, with the
 * pixels at either end weighted by the fraction of them inside it. It is the right filter for
 * shrinking a photograph — every source pixel reaches the output exactly once, so nothing aliases
 * and nothing is dropped — and it is what the model was trained on, which is the reason that
 * matters here.
 *
 * **The antialiased bilinear is the other one**, which MobileSAM's predictor and SAM 2's processor
 * each resize a frame with: a triangle filter whose support grows with the reduction, so shrinking
 * averages rather than samples. One axis at a time, through an eight-bit intermediate, with
 * coefficients normalised to sum to one and held in fixed point — **and how many fraction bits they
 * keep is the whole difference between the two libraries**: Pillow keeps 22 and torchvision's
 * eight-bit path keeps 15, and at each the engine answers what that library answers, measured on
 * the pinned frames at 0 of 3,145,728 values apart. A coefficient rounded differently is a pixel
 * rounded differently, which is why this is a number rather than an approximation.
 *
 * **The area resize is summed the way OpenCV sums it**: one weight per source pixel of the rectangle, the row's
 * times the column's, accumulated in single precision, and rounded by halves to even as `cvRound`
 * does. Measured against OpenCV on the two pinned frames, that leaves **24 values of 846,720 a
 * single level of 255 apart** — a sum landing either side of a half — where summing in double and
 * rounding halves away from zero leaves 46. What would close the rest is OpenCV's own fixed-point
 * table, which is worth writing when a measurement says a level of 255 matters.
 */

const f = Math.fround;

/** `cvRound`: halves to even, which is what OpenCV's saturating cast does. */
function toByte(value: number): number {
  const down = Math.floor(value);
  const rest = value - down;
  const rounded = rest > 0.5 ? down + 1 : rest < 0.5 ? down : down % 2 === 0 ? down : down + 1;
  return Math.min(255, Math.max(0, rounded));
}

/** One output axis's source span: where it starts, and the weight of each source pixel in it. */
interface Span {
  readonly first: number;
  readonly weights: Float64Array;
}

function spans(from: number, to: number): Span[] {
  const scale = from / to;
  const out: Span[] = [];
  for (let at = 0; at < to; at += 1) {
    const start = at * scale;
    const end = start + scale;
    const first = Math.ceil(start);
    const last = Math.floor(end);
    /* The cell is the part of it inside the image, as OpenCV's `resizeArea` measures it. */
    const cell = Math.min(scale, from - start);
    const weights: number[] = [];
    if (first > start) weights.push((first - start) / cell);
    for (let source = first; source < last; source += 1) weights.push(1 / cell);
    if (end > last && last < from) weights.push((end - last) / cell);
    out.push({
      first: Math.min(first > start ? first - 1 : first, from - 1),
      weights: Float64Array.from(weights),
    });
  }
  return out;
}

/**
 * `src`, `width × height` pixels of `channels` bytes, into `out` at `outWidth × outHeight`. Only
 * shrinking is defined, which is what a frame's preparation asks for.
 */
export function areaResize(
  src: Uint8Array,
  width: number,
  height: number,
  channels: number,
  out: Uint8Array,
  outWidth: number,
  outHeight: number,
): void {
  const across = spans(width, outWidth);
  const down = spans(height, outHeight);
  for (let y = 0; y < outHeight; y += 1) {
    const rows = down[y] as Span;
    for (let x = 0; x < outWidth; x += 1) {
      const columns = across[x] as Span;
      for (let c = 0; c < channels; c += 1) {
        let sum = 0;
        for (let dy = 0; dy < rows.weights.length; dy += 1) {
          const row = (rows.first + dy) * width;
          for (let dx = 0; dx < columns.weights.length; dx += 1) {
            const weight = f(f(rows.weights[dy] as number) * f(columns.weights[dx] as number));
            sum = f(sum + f((src[(row + columns.first + dx) * channels + c] as number) * weight));
          }
        }
        out[(y * outWidth + x) * channels + c] = toByte(sum);
      }
    }
  }
}

/** Pillow's fraction bits, and torchvision's eight-bit path's. */
export const PILLOW_PRECISION = 22;
export const TORCHVISION_PRECISION = 15;

/** One output pixel's source pixels and their fixed-point weights. */
function triangleCoefficients(
  from: number,
  to: number,
  precision: number,
): { first: number; weights: Int32Array }[] {
  const scale = from / to;
  const filterScale = Math.max(1, scale);
  const support = filterScale;
  const out: { first: number; weights: Int32Array }[] = [];
  for (let at = 0; at < to; at += 1) {
    const centre = (at + 0.5) * scale;
    const first = Math.max(0, Math.trunc(centre - support + 0.5));
    const last = Math.min(from, Math.trunc(centre + support + 0.5));
    const weights: number[] = [];
    let total = 0;
    for (let source = first; source < last; source += 1) {
      /* The triangle, over a support the reduction widens. */
      const distance = Math.abs((source - centre + 0.5) / filterScale);
      const weight = distance < 1 ? 1 - distance : 0;
      weights.push(weight);
      total += weight;
    }
    const fixed = new Int32Array(weights.length);
    for (let i = 0; i < weights.length; i += 1) {
      const share = total === 0 ? 0 : (weights[i] as number) / total;
      /* A coefficient rounds away from zero at this precision. */
      fixed[i] =
        share < 0
          ? -Math.floor(-share * (1 << precision) + 0.5)
          : Math.floor(share * (1 << precision) + 0.5);
    }
    out.push({ first, weights: fixed });
  }
  return out;
}

/** The clamp of a fixed-point sum back to a byte. */
function clip8(sum: number, precision: number): number {
  const value = Math.floor(sum / (1 << precision));
  return value < 0 ? 0 : value > 255 ? 255 : value;
}

/**
 * `src` into `out` by the antialiased bilinear: across first, then down, through an eight-bit
 * intermediate, which is the order both libraries' passes have. `precision` says whose rounding.
 */
export function triangleResize(
  src: Uint8Array,
  width: number,
  height: number,
  channels: number,
  out: Uint8Array,
  outWidth: number,
  outHeight: number,
  precision: number = PILLOW_PRECISION,
): void {
  const rounding = 1 << (precision - 1);
  const across = triangleCoefficients(width, outWidth, precision);
  const middle = width === outWidth ? src : new Uint8Array(outWidth * height * channels);
  if (middle !== src) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < outWidth; x += 1) {
        const { first, weights } = across[x] as { first: number; weights: Int32Array };
        for (let c = 0; c < channels; c += 1) {
          let sum = rounding;
          for (let i = 0; i < weights.length; i += 1) {
            sum += (src[(y * width + first + i) * channels + c] as number) * (weights[i] as number);
          }
          middle[(y * outWidth + x) * channels + c] = clip8(sum, precision);
        }
      }
    }
  }
  const down = triangleCoefficients(height, outHeight, precision);
  if (height === outHeight) {
    out.set(middle.subarray(0, outWidth * outHeight * channels));
    return;
  }
  for (let y = 0; y < outHeight; y += 1) {
    const { first, weights } = down[y] as { first: number; weights: Int32Array };
    for (let x = 0; x < outWidth; x += 1) {
      for (let c = 0; c < channels; c += 1) {
        let sum = rounding;
        for (let i = 0; i < weights.length; i += 1) {
          sum +=
            (middle[((first + i) * outWidth + x) * channels + c] as number) *
            (weights[i] as number);
        }
        out[(y * outWidth + x) * channels + c] = clip8(sum, precision);
      }
    }
  }
}
