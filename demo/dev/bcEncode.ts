/**
 * Just enough of a BC encoder to make test images for `compressedTextures.ts`: BC1, BC4/BC5 and BC7
 * in mode 6 alone, each block from its own range and its nearest palette entries.
 *
 * **A fixture maker, not an encoder anybody should ship**: no endpoint search, no partitions, one
 * mode of BC7's eight. Its only job is blocks a GPU and `decodeBc` can both read, so the page can
 * compare the two; how good the blocks look is not the question. Nothing under `src/` may import it.
 */

/** The 4x4 block at `bx, by`, edges repeated for an image smaller than a block. */
function blockPixels(
  rgba: Uint8Array,
  width: number,
  height: number,
  bx: number,
  by: number,
): number[] {
  const out: number[] = [];
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const sx = Math.min(width - 1, bx * 4 + x);
      const sy = Math.min(height - 1, by * 4 + y);
      const at = (sy * width + sx) * 4;
      out.push(rgba[at] ?? 0, rgba[at + 1] ?? 0, rgba[at + 2] ?? 0, rgba[at + 3] ?? 0);
    }
  }
  return out;
}

function eachBlock(
  width: number,
  height: number,
  blockBytes: number,
  write: (bx: number, by: number, out: Uint8Array, at: number) => void,
): Uint8Array {
  const across = Math.ceil(width / 4);
  const down = Math.ceil(height / 4);
  const out = new Uint8Array(across * down * blockBytes);
  for (let by = 0; by < down; by++) {
    for (let bx = 0; bx < across; bx++) write(bx, by, out, (by * across + bx) * blockBytes);
  }
  return out;
}

const to565 = (r: number, g: number, b: number): number =>
  ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
const from565 = (c: number): [number, number, number] => {
  const r = (c >> 11) & 31;
  const g = (c >> 5) & 63;
  const b = c & 31;
  return [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)];
};

/** BC1, four-colour blocks, endpoints at the darkest and brightest texel. */
export function encodeBc1(rgba: Uint8Array, width: number, height: number): Uint8Array {
  return eachBlock(width, height, 8, (bx, by, out, at) => {
    const p = blockPixels(rgba, width, height, bx, by);
    let lo = 0;
    let hi = 0;
    const luma = (i: number): number =>
      (p[i * 4] ?? 0) * 3 + (p[i * 4 + 1] ?? 0) * 6 + (p[i * 4 + 2] ?? 0);
    for (let i = 1; i < 16; i++) {
      if (luma(i) < luma(lo)) lo = i;
      if (luma(i) > luma(hi)) hi = i;
    }
    let c0 = to565(p[hi * 4] ?? 0, p[hi * 4 + 1] ?? 0, p[hi * 4 + 2] ?? 0);
    let c1 = to565(p[lo * 4] ?? 0, p[lo * 4 + 1] ?? 0, p[lo * 4 + 2] ?? 0);
    if (c0 < c1) [c0, c1] = [c1, c0];
    const e0 = from565(c0);
    const e1 = from565(c1);
    const palette = [
      e0,
      e1,
      e0.map((v, k) => Math.round((2 * v + (e1[k] ?? 0)) / 3)),
      e0.map((v, k) => Math.round((v + 2 * (e1[k] ?? 0)) / 3)),
    ];
    let indices = 0;
    for (let i = 0; i < 16; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let k = 0; k < (c0 === c1 ? 1 : 4); k++) {
        const c = palette[k] as number[];
        let d = 0;
        for (let ch = 0; ch < 3; ch++) d += ((p[i * 4 + ch] ?? 0) - (c[ch] ?? 0)) ** 2;
        if (d < bestD) [best, bestD] = [k, d];
      }
      indices |= best << (i * 2);
    }
    out.set([c0 & 255, c0 >> 8, c1 & 255, c1 >> 8], at);
    out.set([indices & 255, (indices >>> 8) & 255, (indices >>> 16) & 255, indices >>> 24], at + 4);
  });
}

/** One BC4 half from one channel of the block, eight-value mode, at `out[at]`. */
function encodeBc4Half(values: readonly number[], out: Uint8Array, at: number): void {
  const a0 = Math.max(...values);
  const a1 = Math.min(...values);
  const palette = [a0, a1];
  for (let i = 1; i <= 6; i++) palette.push(Math.round(((7 - i) * a0 + i * a1) / 7));
  let low = 0;
  let high = 0;
  for (let i = 0; i < 16; i++) {
    let best = 0;
    for (let k = 1; k < (a0 === a1 ? 1 : 8); k++) {
      if (
        Math.abs((values[i] ?? 0) - (palette[k] ?? 0)) <
        Math.abs((values[i] ?? 0) - (palette[best] ?? 0))
      )
        best = k;
    }
    if (i < 8) low |= best << (i * 3);
    else high |= best << ((i - 8) * 3);
  }
  out.set(
    [
      a0,
      a1,
      low & 255,
      (low >> 8) & 255,
      (low >> 16) & 255,
      high & 255,
      (high >> 8) & 255,
      (high >> 16) & 255,
    ],
    at,
  );
}

/** BC5 from the red and green of `rgba`. */
export function encodeBc5(rgba: Uint8Array, width: number, height: number): Uint8Array {
  return eachBlock(width, height, 16, (bx, by, out, at) => {
    const p = blockPixels(rgba, width, height, bx, by);
    encodeBc4Half(
      Array.from({ length: 16 }, (_, i) => p[i * 4] ?? 0),
      out,
      at,
    );
    encodeBc4Half(
      Array.from({ length: 16 }, (_, i) => p[i * 4 + 1] ?? 0),
      out,
      at + 8,
    );
  });
}

const WEIGHTS4 = [0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64];

/** BC7 mode 6: one subset, RGBA endpoints of seven bits and a p-bit each, four-bit indices. */
export function encodeBc7(rgba: Uint8Array, width: number, height: number): Uint8Array {
  return eachBlock(width, height, 16, (bx, by, out, at) => {
    const p = blockPixels(rgba, width, height, bx, by);
    let e0 = [255, 255, 255, 255];
    let e1 = [0, 0, 0, 0];
    for (let i = 0; i < 16; i++) {
      for (let c = 0; c < 4; c++) {
        e0[c] = Math.min(e0[c] ?? 0, p[i * 4 + c] ?? 0) & 0xfe;
        e1[c] = Math.max(e1[c] ?? 0, p[i * 4 + c] ?? 0) & 0xfe;
      }
    }
    const index = (i: number): number => {
      let best = 0;
      let bestD = Infinity;
      for (let k = 0; k < 16; k++) {
        const w = WEIGHTS4[k] as number;
        let d = 0;
        for (let c = 0; c < 4; c++) {
          const v = ((e0[c] ?? 0) * (64 - w) + (e1[c] ?? 0) * w + 32) >> 6;
          d += ((p[i * 4 + c] ?? 0) - v) ** 2;
        }
        if (d < bestD) [best, bestD] = [k, d];
      }
      return best;
    };
    let indices = Array.from({ length: 16 }, (_, i) => index(i));
    /* The anchor's top bit is implied zero, so a block whose first index has it set swaps ends. */
    if ((indices[0] ?? 0) >= 8) {
      [e0, e1] = [e1, e0];
      indices = indices.map((i) => 15 - i);
    }
    let bit = 0;
    const put = (value: number, n: number): void => {
      for (let k = 0; k < n; k++, bit++) {
        if (((value >> k) & 1) !== 0)
          out[at + (bit >> 3)] = (out[at + (bit >> 3)] ?? 0) | (1 << (bit & 7));
      }
    };
    put(1 << 6, 7);
    for (let c = 0; c < 4; c++) {
      put((e0[c] ?? 0) >> 1, 7);
      put((e1[c] ?? 0) >> 1, 7);
    }
    put(0, 1);
    put(0, 1);
    indices.forEach((i, pixel) => put(i, pixel === 0 ? 3 : 4));
  });
}

/** Half the size, each texel the mean of the four it covers. */
export function halve(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const w = Math.max(1, width >> 1);
  const h = Math.max(1, height >> 1);
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const sx = Math.min(width - 1, x * 2 + dx);
            const sy = Math.min(height - 1, y * 2 + dy);
            sum += rgba[(sy * width + sx) * 4 + c] ?? 0;
          }
        }
        out[(y * w + x) * 4 + c] = Math.round(sum / 4);
      }
    }
  }
  return out;
}
