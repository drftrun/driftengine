/**
 * The spatial operators: convolution, its transpose, a patch embedding and max pooling. Resizing is
 * `resize.ts`'s.
 *
 * **Channel-major images, one at a time** — `[channels][height][width]`, the layout the upstream
 * frameworks call NCHW with a batch of one — and **weights in the upstream layout**: a convolution's
 * `[out][in][kh][kw]`, a transposed convolution's `[in][out][kh][kw]`. A converted checkpoint is
 * then read as it was stored, and a rearrangement is never a place for a transposed weight to hide.
 */

/**
 * `out[cout][oh][ow]` from `input[cin][h][w]`, with `oh = ⌊(h + 2·padding − kh)/stride⌋ + 1` and
 * likewise `ow`. `bias` may be null.
 *
 * **Grouped, the channels split into `groups` runs** and output `o` reads only the run `o` falls in:
 * the weight is `[cout][cin / groups][kh][kw]`, as the upstream stores it, and a depthwise
 * convolution is `groups = cin = cout`.
 */
export function conv2d(
  out: Float32Array,
  input: Float32Array,
  cin: number,
  h: number,
  w: number,
  weight: Float32Array,
  bias: Float32Array | null,
  cout: number,
  kh: number,
  kw: number,
  stride: number,
  padding: number,
  groups = 1,
): void {
  const oh = Math.floor((h + 2 * padding - kh) / stride) + 1;
  const ow = Math.floor((w + 2 * padding - kw) / stride) + 1;
  const inPerGroup = cin / groups;
  const outPerGroup = cout / groups;
  for (let o = 0; o < cout; o += 1) {
    const first = Math.floor(o / outPerGroup) * inPerGroup;
    for (let y = 0; y < oh; y += 1) {
      for (let x = 0; x < ow; x += 1) {
        let sum = bias === null ? 0 : (bias[o] as number);
        for (let c = 0; c < inPerGroup; c += 1) {
          for (let ky = 0; ky < kh; ky += 1) {
            const sy = y * stride - padding + ky;
            if (sy < 0 || sy >= h) continue;
            for (let kx = 0; kx < kw; kx += 1) {
              const sx = x * stride - padding + kx;
              if (sx < 0 || sx >= w) continue;
              sum +=
                (input[((first + c) * h + sy) * w + sx] as number) *
                (weight[((o * inPerGroup + c) * kh + ky) * kw + kx] as number);
            }
          }
        }
        out[(o * oh + y) * ow + x] = sum;
      }
    }
  }
}

/**
 * `out[cout][oh][ow]` from `input[cin][h][w]`, with `oh = (h − 1)·stride − 2·padding + kh`: each input
 * pixel spread over the kernel at its strided place, which is how a decoder head upsamples.
 */
export function convTranspose2d(
  out: Float32Array,
  input: Float32Array,
  cin: number,
  h: number,
  w: number,
  weight: Float32Array,
  bias: Float32Array | null,
  cout: number,
  kh: number,
  kw: number,
  stride: number,
  padding: number,
): void {
  const oh = (h - 1) * stride - 2 * padding + kh;
  const ow = (w - 1) * stride - 2 * padding + kw;
  for (let o = 0; o < cout; o += 1) {
    const value = bias === null ? 0 : (bias[o] as number);
    for (let i = 0; i < oh * ow; i += 1) out[o * oh * ow + i] = value;
  }
  for (let c = 0; c < cin; c += 1) {
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const pixel = input[(c * h + y) * w + x] as number;
        for (let o = 0; o < cout; o += 1) {
          for (let ky = 0; ky < kh; ky += 1) {
            const ty = y * stride - padding + ky;
            if (ty < 0 || ty >= oh) continue;
            for (let kx = 0; kx < kw; kx += 1) {
              const tx = x * stride - padding + kx;
              if (tx < 0 || tx >= ow) continue;
              const at = (o * oh + ty) * ow + tx;
              out[at] =
                (out[at] as number) +
                pixel * (weight[((c * cout + o) * kh + ky) * kw + kx] as number);
            }
          }
        }
      }
    }
  }
}

/**
 * A patch embedding: a convolution with stride and kernel both `patch`, written token-major —
 * `out[tokens][dim]`, tokens row by row — which is the order a transformer reads them in.
 */
export function patchEmbed(
  out: Float32Array,
  image: Float32Array,
  cin: number,
  h: number,
  w: number,
  weight: Float32Array,
  bias: Float32Array | null,
  dim: number,
  patch: number,
): void {
  const rows = Math.floor(h / patch);
  const cols = Math.floor(w / patch);
  for (let ty = 0; ty < rows; ty += 1) {
    for (let tx = 0; tx < cols; tx += 1) {
      const token = ty * cols + tx;
      for (let o = 0; o < dim; o += 1) {
        let sum = bias === null ? 0 : (bias[o] as number);
        for (let c = 0; c < cin; c += 1) {
          for (let ky = 0; ky < patch; ky += 1) {
            for (let kx = 0; kx < patch; kx += 1) {
              sum +=
                (image[(c * h + ty * patch + ky) * w + tx * patch + kx] as number) *
                (weight[((o * cin + c) * patch + ky) * patch + kx] as number);
            }
          }
        }
        out[token * dim + o] = sum;
      }
    }
  }
}

/**
 * `out[channels][oh][ow]`, each the largest of its `kernel`-square window at `stride`, with
 * `oh = ⌊(h − kernel)/stride⌋ + 1`: no padding, and a ragged last row or column dropped, as
 * PyTorch's `max_pool2d` does without `ceil_mode`.
 */
export function maxPool2d(
  out: Float32Array,
  input: Float32Array,
  channels: number,
  h: number,
  w: number,
  kernel: number,
  stride: number,
): void {
  const oh = Math.floor((h - kernel) / stride) + 1;
  const ow = Math.floor((w - kernel) / stride) + 1;
  for (let c = 0; c < channels; c += 1) {
    for (let y = 0; y < oh; y += 1) {
      for (let x = 0; x < ow; x += 1) {
        let largest = Number.NEGATIVE_INFINITY;
        for (let ky = 0; ky < kernel; ky += 1) {
          for (let kx = 0; kx < kernel; kx += 1) {
            largest = Math.max(
              largest,
              input[(c * h + y * stride + ky) * w + x * stride + kx] as number,
            );
          }
        }
        out[(c * oh + y) * ow + x] = largest;
      }
    }
  }
}
