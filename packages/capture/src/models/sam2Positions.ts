/**
 * SAM 2's position tables, which depend only on shapes: the feature pyramid's and the memory's
 * two-dimensional sines, the object pointers' one-dimensional sines, and the memory attention's
 * rotary tables. Each is laid out once per size and used as a constant of a graph or by the host.
 *
 * **Every rounding is the upstream's, in single precision**: a coordinate normalised to the grid's
 * extent, divided by its frequency, and only then taken through `sin` or `cos` — the engine's
 * reproducible ones, since a capture reproduces. A frequency is `10000^t`, taken as `exp(t·ln 10000)`
 * rather than `**`, which is not the same bits on every engine.
 */
import { exactCos, exactExp, exactSin } from '@driftengine/core';

const f = Math.fround;
const TWO_PI = f(2 * Math.PI);
/** `ln 10000`, the temperature's logarithm. */
const LOG_TEMPERATURE = 9.210340371976184;

/* `10000^(2·⌊i/2⌋/count)` in single precision, as the upstream's `temperature ** (...)` makes it. */
function frequency(i: number, count: number): number {
  return f(exactExp(f((2 * Math.floor(i / 2)) / count) * LOG_TEMPERATURE));
}

/**
 * `[2·features, height, width]`: the upstream's normalised sine embedding — a row's and a column's
 * index from one, over the last and times 2π, each divided by `features` frequencies taken in pairs,
 * sine then cosine alternating — with the rows' `features` channels before the columns'.
 */
export function sam2SinePositions(features: number, height: number, width: number): Float32Array {
  const out = new Float32Array(2 * features * height * width);
  const plane = height * width;
  const embed = (index: number, count: number): number =>
    f(f((index + 1) / f(count + 1e-6)) * TWO_PI);
  for (let i = 0; i < features; i += 1) {
    const divisor = frequency(i, features);
    const wave = i % 2 === 0 ? exactSin : exactCos;
    for (let y = 0; y < height; y += 1) {
      const row = wave(f(embed(y, height) / divisor));
      for (let x = 0; x < width; x += 1) {
        out[i * plane + y * width + x] = row;
        out[(features + i) * plane + y * width + x] = wave(f(embed(x, width) / divisor));
      }
    }
  }
  return out;
}

/**
 * `[positions.length, dim]`: the upstream's `get_1d_sine_pe` — each position divided by `dim / 2`
 * frequencies taken in pairs, its sines then its cosines.
 */
export function sam2PointerPositions(positions: readonly number[], dim: number): Float32Array {
  const half = dim / 2;
  const out = new Float32Array(positions.length * dim);
  for (let p = 0; p < positions.length; p += 1) {
    for (let k = 0; k < half; k += 1) {
      const angle = f(f(positions[p] as number) / frequency(k, half));
      out[p * dim + k] = exactSin(angle);
      out[p * dim + half + k] = exactCos(angle);
    }
  }
  return out;
}

/**
 * The memory attention's axial rotary tables over a `width` by `height` grid, row by row, for a
 * head of `dim`, at the upstream's base of 10,000 — its configuration's `rope_theta`, the one value
 * any checkpoint here uses: `[cells, dim]` cosines and sines, the first half of the channels turning by the
 * column and the second by the row, each frequency on a pair of channels. **The sine carries the
 * rotation's sign** — negative on a pair's first channel, positive on its second — so a rotation is
 * `x·cos + swap(x)·sin`, `swap` exchanging each pair, which a graph composes from its shape
 * operators.
 */
export function sam2Rotary(
  dim: number,
  width: number,
  height: number,
): { readonly cos: Float32Array; readonly sin: Float32Array } {
  const spatial = dim / 2;
  const count = spatial / 2;
  const inverse = Float32Array.from({ length: count }, (_, k) =>
    f(1 / f(exactExp(f((2 * k) / spatial) * LOG_TEMPERATURE))),
  );
  const cells = width * height;
  const cos = new Float32Array(cells * dim);
  const sin = new Float32Array(cells * dim);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * dim;
      for (let k = 0; k < count; k += 1) {
        for (const [offset, position] of [
          [0, x],
          [spatial, y],
        ] as const) {
          const angle = f(position * (inverse[k] as number));
          const c = exactCos(angle);
          const s = exactSin(angle);
          cos[at + offset + 2 * k] = c;
          cos[at + offset + 2 * k + 1] = c;
          sin[at + offset + 2 * k] = -s;
          sin[at + offset + 2 * k + 1] = s;
        }
      }
    }
  }
  return { cos, sin };
}
