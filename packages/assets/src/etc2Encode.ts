/**
 * ETC2 and EAC blocks made from pixels: what a phone samples, at half a byte a texel for colour and
 * a byte with alpha, where RGBA costs four. The loader encodes a texture this way where the device
 * takes ETC2 and not the BC its file holds (`etc2Plan`), and a caller holding pixels of its own can
 * call `encodeEtc2` directly — off the main thread, since a 2048² image is 262,144 blocks.
 *
 * **ETC2's colour, through the modes it shares with ETC1**: each 4x4 block split in two halves,
 * side by side or one above the other, each half a base colour and one of eight tables of
 * brightness steps, each texel the step nearest its own colour. Both splits and both ways of storing
 * the two bases — each on its own at four bits, or the second as a small difference from the first
 * at five — are tried, and the least error kept. **What it gives up** is ETC2's three further modes,
 * T, H and planar, which every ETC2 device decodes and this encoder never chooses: a smooth gradient
 * across a block and a sharp edge between two colours come out a little coarser than a full search
 * would make them. What would make that worth changing is a texture whose banding shows at the size
 * it is seen.
 *
 * **EAC for everything that is not colour**: an alpha channel beside ETC2's colour, and one or two
 * channels of data on their own (`eac-r11`, `eac-rg11`) — a roughness map, a normal map's x and y.
 * Each block a base, a step size and one of sixteen tables of eight steps, searched per table.
 *
 * Texels past the edge of a level smaller than a block repeat the last row and column, so a 2x2 or
 * 1x1 level is one block whose other texels match. Allocates the blocks it returns, once a level.
 */

/** The formats this encodes: colour, colour with alpha, and one or two channels of data. */
export type Etc2Format = 'etc2-rgb8' | 'etc2-rgba8' | 'eac-r11' | 'eac-rg11';

/** ETC1's eight tables of brightness steps: the small and the large, each added and subtracted. */
const STEPS: readonly (readonly [number, number])[] = [
  [2, 8],
  [5, 17],
  [9, 29],
  [13, 42],
  [18, 60],
  [24, 80],
  [33, 106],
  [47, 183],
];

/** A texel's step by its two-bit index: the small added, the large added, then both subtracted. */
function step(table: number, index: number): number {
  const [small, large] = STEPS[table] as readonly [number, number];
  return index === 0 ? small : index === 1 ? large : index === 2 ? -small : -large;
}

/** EAC's sixteen tables of eight steps. */
const EAC: readonly (readonly number[])[] = [
  [-3, -6, -9, -15, 2, 5, 8, 14],
  [-3, -7, -10, -13, 2, 6, 9, 12],
  [-2, -5, -8, -13, 1, 4, 7, 12],
  [-2, -4, -6, -13, 1, 3, 5, 12],
  [-3, -6, -8, -12, 2, 5, 7, 11],
  [-3, -7, -9, -11, 2, 6, 8, 10],
  [-4, -7, -8, -11, 3, 6, 7, 10],
  [-3, -5, -8, -11, 2, 4, 7, 10],
  [-2, -6, -8, -10, 1, 5, 7, 9],
  [-2, -5, -8, -10, 1, 4, 7, 9],
  [-2, -4, -8, -10, 1, 3, 7, 9],
  [-2, -5, -7, -10, 1, 4, 6, 9],
  [-3, -4, -7, -10, 2, 3, 6, 9],
  [-1, -2, -3, -10, 0, 1, 2, 9],
  [-4, -6, -8, -9, 3, 5, 7, 8],
  [-3, -5, -7, -9, 2, 4, 6, 8],
];

/** Per EAC table, the index of the step nearest each whole offset from -16 to 15. */
const NEAREST: readonly Int8Array[] = EAC.map((steps) => {
  const lookup = new Int8Array(32);
  for (let u = -16; u < 16; u++) {
    let chosen = 0;
    for (let index = 1; index < 8; index++) {
      if (Math.abs((steps[index] as number) - u) < Math.abs((steps[chosen] as number) - u)) {
        chosen = index;
      }
    }
    lookup[u + 16] = chosen;
  }
  return lookup;
});

/** Bytes a block of each format takes. */
const BYTES: Readonly<Record<Etc2Format, number>> = {
  'etc2-rgb8': 8,
  'etc2-rgba8': 16,
  'eac-r11': 8,
  'eac-rg11': 16,
};

const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);

/** One block's texels, RGBA, in ETC's own order: down each column, then across. */
const texels = new Int32Array(64);

/** `rgba` at `width` by `height` as `format` blocks, row of blocks after row of blocks. */
export function encodeEtc2(
  format: Etc2Format,
  rgba: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const across = Math.max(1, Math.ceil(width / 4));
  const down = Math.max(1, Math.ceil(height / 4));
  const bytes = BYTES[format];
  const out = new Uint8Array(across * down * bytes);
  for (let by = 0; by < down; by++) {
    for (let bx = 0; bx < across; bx++) {
      gather(rgba, width, height, bx * 4, by * 4);
      const at = (by * across + bx) * bytes;
      if (format === 'etc2-rgb8') encodeColour(out, at);
      else if (format === 'etc2-rgba8') {
        encodeEac(out, at, 3, false);
        encodeColour(out, at + 8);
      } else if (format === 'eac-r11') encodeEac(out, at, 0, true);
      else {
        encodeEac(out, at, 0, true);
        encodeEac(out, at + 8, 1, true);
      }
    }
  }
  return out;
}

/** The block at `(x0, y0)` into `texels`, the edge repeated past a level smaller than a block. */
function gather(rgba: Uint8Array, width: number, height: number, x0: number, y0: number): void {
  for (let x = 0; x < 4; x++) {
    for (let y = 0; y < 4; y++) {
      const sx = Math.min(x0 + x, width - 1);
      const sy = Math.min(y0 + y, height - 1);
      const from = (sy * width + sx) * 4;
      const to = (x * 4 + y) * 4;
      texels[to] = rgba[from] as number;
      texels[to + 1] = rgba[from + 1] as number;
      texels[to + 2] = rgba[from + 2] as number;
      texels[to + 3] = rgba[from + 3] as number;
    }
  }
}

/** Whether texel `i` (ETC order) is in the first half, for a split `flip` names. */
const firstHalf = (i: number, flip: number): boolean => (flip === 0 ? i < 8 : i % 4 < 2);

/** The eight texels of each half: `HALF_TEXELS[flip * 2 + half]`. */
const HALF_TEXELS: readonly Int32Array[] = [0, 1, 2, 3].map((k) => {
  const list = new Int32Array(8);
  let count = 0;
  for (let i = 0; i < 16; i++) {
    if (firstHalf(i, k >> 1) === ((k & 1) === 0)) list[count++] = i;
  }
  return list;
});

/** Each table's small and large step, as numbers the search reads without unpacking a pair. */
const SMALL = new Int32Array(STEPS.map(([small]) => small));
const LARGE = new Int32Array(STEPS.map(([, large]) => large));

/** A half's search result, reused. */
interface Half {
  error: number;
  table: number;
  /** The two-bit index of each of the half's eight texels, in `HALF_TEXELS` order. */
  readonly indices: Int32Array;
}
const halves: [Half, Half] = [
  { error: 0, table: 0, indices: new Int32Array(8) },
  { error: 0, table: 0, indices: new Int32Array(8) },
];
const best = { error: Infinity, high: 0, low: 0 };
const base = new Int32Array(6);
const quantized = new Int32Array(6);
const offsets = new Float64Array(8);

/** The least-error ETC1-mode block for `texels`, written at `at`. */
function encodeColour(out: Uint8Array, at: number): void {
  best.error = Infinity;
  const [first, second] = halves;
  for (let flip = 0; flip < 2; flip++) {
    let fitted = false;
    for (let differential = 1; differential >= 0; differential--) {
      /* Five bits where the pair's difference fits, which is nearly always the better; four bits
         each only where it does not, so a split pays for one search and not two. */
      if (differential === 0 && fitted) continue;
      fitted = bases(flip, differential === 1);
      if (!fitted) continue;
      /* Each half searched only as far as it could still beat the best block so far. */
      searchHalf(flip, 0, first, best.error);
      if (first.error >= best.error) continue;
      searchHalf(flip, 1, second, best.error - first.error);
      const error = first.error + second.error;
      if (error >= best.error) continue;
      best.error = error;
      let high = 0;
      if (differential === 1) {
        for (let c = 0; c < 3; c++) {
          const q = quantized[c] as number;
          const delta = (quantized[c + 3] as number) - q;
          high |= ((q << 3) | (delta & 7)) << (24 - c * 8);
        }
      } else {
        for (let c = 0; c < 3; c++) {
          high |= (((quantized[c] as number) << 4) | (quantized[c + 3] as number)) << (24 - c * 8);
        }
      }
      high |= (first.table << 5) | (second.table << 2) | (differential << 1) | flip;
      let low = 0;
      for (let half = 0; half < 2; half++) {
        const list = HALF_TEXELS[flip * 2 + half] as Int32Array;
        const indices = (halves[half] as Half).indices;
        for (let k = 0; k < 8; k++) {
          const i = list[k] as number;
          const index = indices[k] as number;
          low |= ((index >> 1) << (i + 16)) | ((index & 1) << i);
        }
      }
      best.high = high >>> 0;
      best.low = low >>> 0;
    }
  }
  write32(out, at, best.high);
  write32(out, at + 4, best.low);
}

/**
 * Each half's average, quantised as the mode stores it and expanded back, into `base` — and false
 * where the differential mode cannot hold the second as a step of -4 to 3 from the first.
 */
function bases(flip: number, differential: boolean): boolean {
  for (let half = 0; half < 2; half++) {
    const list = HALF_TEXELS[flip * 2 + half] as Int32Array;
    let r = 0;
    let g = 0;
    let b = 0;
    for (let k = 0; k < 8; k++) {
      const i = list[k] as number;
      r += texels[i * 4] as number;
      g += texels[i * 4 + 1] as number;
      b += texels[i * 4 + 2] as number;
    }
    for (let c = 0; c < 3; c++) {
      const average = (c === 0 ? r : c === 1 ? g : b) / 8;
      if (differential) {
        const q = Math.round((average * 31) / 255);
        quantized[half * 3 + c] = q;
        base[half * 3 + c] = (q << 3) | (q >> 2);
      } else {
        const q = Math.round((average * 15) / 255);
        quantized[half * 3 + c] = q;
        base[half * 3 + c] = (q << 4) | q;
      }
    }
  }
  if (!differential) return true;
  for (let c = 0; c < 3; c++) {
    const delta = (quantized[c + 3] as number) - (quantized[c] as number);
    if (delta < -4 || delta > 3) return false;
  }
  return true;
}

/**
 * The table with the least error for one half against its base, and each texel's step for it —
 * or `into.error` left at infinity where no table comes under `bound`.
 *
 * **A texel's step is found, not searched.** Every step moves all three channels by one amount, so
 * the amount that brings a texel nearest its colour is its average offset from the base, and the
 * step to take is the one nearest that. Unclamped, a texel's error at step `s` is its spread about
 * that average offset `o` plus `3(s − o)²`, so a table's error is the half's spread, summed once,
 * plus that term — exact, with no channel read again. **Only a table whose large step could carry a
 * channel past 0 or 255 is checked texel by texel**, with the clamp a device applies and the
 * nearest step's neighbour as a second candidate, since a clamped channel can make the nearest step
 * no longer the closest. On a photograph that is a dark or a bright block's few tables.
 *
 * What it gives up is the error a weighting by channel would trade; the steps are one brightness for
 * all three, so a weight changes which of two near steps wins and little else.
 */
function searchHalf(flip: number, half: number, into: Half, bound: number): void {
  const list = HALF_TEXELS[flip * 2 + half] as Int32Array;
  const r0 = base[half * 3] as number;
  const g0 = base[half * 3 + 1] as number;
  const b0 = base[half * 3 + 2] as number;
  const lowest = Math.min(r0, g0, b0);
  const highest = Math.max(r0, g0, b0);
  let spread = 0;
  for (let k = 0; k < 8; k++) {
    const i = list[k] as number;
    const dr = (texels[i * 4] as number) - r0;
    const dg = (texels[i * 4 + 1] as number) - g0;
    const db = (texels[i * 4 + 2] as number) - b0;
    const offset = (dr + dg + db) / 3;
    offsets[k] = offset;
    spread += dr * dr + dg * dg + db * db - 3 * offset * offset;
  }
  into.error = Infinity;
  let chosen = -1;
  let least = bound;
  for (let table = 0; table < 8; table++) {
    const small = SMALL[table] as number;
    const large = LARGE[table] as number;
    const error =
      lowest - large >= 0 && highest + large <= 255
        ? spread + 3 * nearestSum(small, large, null)
        : clampedError(list, r0, g0, b0, small, large, least, null);
    if (error < least) {
      least = error;
      chosen = table;
    }
  }
  if (chosen < 0) return;
  into.error = least;
  into.table = chosen;
  const small = SMALL[chosen] as number;
  const large = LARGE[chosen] as number;
  if (lowest - large >= 0 && highest + large <= 255) nearestSum(small, large, into.indices);
  else clampedError(list, r0, g0, b0, small, large, Infinity, into.indices);
}

/** `Σ (s − o)²` over the half's offsets at each one's nearest step, the steps into `write`. */
function nearestSum(small: number, large: number, write: Int32Array | null): number {
  const middle = (small + large) / 2;
  let sum = 0;
  for (let k = 0; k < 8; k++) {
    const offset = offsets[k] as number;
    let index: number;
    let d: number;
    if (offset >= 0) {
      index = offset > middle ? 1 : 0;
      d = (index === 1 ? large : small) - offset;
    } else {
      index = offset < -middle ? 3 : 2;
      d = (index === 3 ? -large : -small) - offset;
    }
    if (write !== null) write[k] = index;
    sum += d * d;
  }
  return sum;
}

/** A table's error with every channel clamped as a device does, stopping once past `bound`. */
function clampedError(
  list: Int32Array,
  r0: number,
  g0: number,
  b0: number,
  small: number,
  large: number,
  bound: number,
  write: Int32Array | null,
): number {
  let error = 0;
  for (let k = 0; k < 8; k++) {
    const i = list[k] as number;
    const offset = offsets[k] as number;
    /* The nearest step by the offset, and its neighbour toward zero. */
    let near: number;
    let other: number;
    if (offset >= 0) {
      near = offset > (small + large) / 2 ? 1 : 0;
      other = near === 1 ? 0 : 2;
    } else {
      near = offset < -(small + large) / 2 ? 3 : 2;
      other = near === 3 ? 2 : 0;
    }
    const e1 = texelError(i, r0, g0, b0, stepOf(near, small, large));
    const e2 = texelError(i, r0, g0, b0, stepOf(other, small, large));
    if (write !== null) write[k] = e1 <= e2 ? near : other;
    error += e1 <= e2 ? e1 : e2;
    if (error >= bound) return error;
  }
  return error;
}

/** A step by its two-bit index, from a table's two amounts. */
function stepOf(index: number, small: number, large: number): number {
  return index === 0 ? small : index === 1 ? large : index === 2 ? -small : -large;
}

/** One texel's squared error against a base moved by `s`, every channel clamped as a device does. */
function texelError(i: number, r0: number, g0: number, b0: number, s: number): number {
  const dr = (texels[i * 4] as number) - clamp255(r0 + s);
  const dg = (texels[i * 4 + 1] as number) - clamp255(g0 + s);
  const db = (texels[i * 4 + 2] as number) - clamp255(b0 + s);
  return dr * dr + dg * dg + db * db;
}
const eacIndices = new Int32Array(16);
const eacBest = new Int32Array(16);

/**
 * One EAC block of channel `channel` at `at`: eight-bit, as alpha beside colour is, or eleven-bit,
 * as `eac-r11` stores data. A block of one value is stored exactly, through the one table with a
 * zero step.
 */
function encodeEac(out: Uint8Array, at: number, channel: number, eleven: boolean): void {
  let min = 255;
  let max = 0;
  for (let i = 0; i < 16; i++) {
    const v = texels[i * 4 + channel] as number;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  /* Targets in the stored range: eight bits, or eleven with 255 at 2047. */
  const scale = eleven ? 2047 / 255 : 1;
  let bestError = Infinity;
  let bestBase = 0;
  let bestMultiplier = 1;
  let bestTable = 13;
  for (let table = 0; table < 16; table++) {
    const steps = EAC[table] as readonly number[];
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of steps) {
      if (s < lo) lo = s;
      if (s > hi) hi = s;
    }
    const span = (max - min) * scale;
    const grain = eleven ? 8 : 1;
    const ideal = span / ((hi - lo) * grain);
    for (let round = 0; round < 2; round++) {
      const m = Math.min(15, Math.max(1, round === 0 ? Math.floor(ideal) : Math.ceil(ideal)));
      /* The base that puts the table's middle on the block's. */
      const middle = ((min + max) / 2) * scale - ((hi + lo) / 2) * m * grain;
      const b = Math.min(255, Math.max(0, Math.round(eleven ? (middle - 4) / 8 : middle)));
      let error = 0;
      const nearest = NEAREST[table] as Int8Array;
      const origin = eleven ? b * 8 + 4 : b;
      const unit = m * grain;
      for (let i = 0; i < 16; i++) {
        const target = (texels[i * 4 + channel] as number) * scale;
        /* The step nearest the texel's offset, looked up, and checked exactly with the clamp. */
        const u = Math.round((target - origin) / unit);
        const chosen = nearest[(u < -16 ? -16 : u > 15 ? 15 : u) + 16] as number;
        const d = eacValue(b, m, steps[chosen] as number, eleven) - target;
        eacIndices[i] = chosen;
        error += d * d;
        if (error >= bestError) break;
      }
      if (error < bestError) {
        bestError = error;
        bestBase = b;
        bestMultiplier = m;
        bestTable = table;
        eacBest.set(eacIndices);
      }
    }
  }
  out[at] = bestBase;
  out[at + 1] = (bestMultiplier << 4) | bestTable;
  /* Forty-eight bits of three-bit indices, the first texel in the highest: two words of 24. */
  let first = 0;
  let second = 0;
  for (let i = 0; i < 8; i++) first = (first << 3) | (eacBest[i] as number);
  for (let i = 8; i < 16; i++) second = (second << 3) | (eacBest[i] as number);
  out[at + 2] = (first >>> 16) & 255;
  out[at + 3] = (first >>> 8) & 255;
  out[at + 4] = first & 255;
  out[at + 5] = (second >>> 16) & 255;
  out[at + 6] = (second >>> 8) & 255;
  out[at + 7] = second & 255;
}

/** What an EAC block decodes a step to: eight-bit, or eleven-bit as `eac-r11` stores. */
function eacValue(base: number, multiplier: number, step: number, eleven: boolean): number {
  if (!eleven) return clamp255(base + step * multiplier);
  const v = base * 8 + 4 + step * multiplier * 8;
  return v < 0 ? 0 : v > 2047 ? 2047 : v;
}

function write32(out: Uint8Array, at: number, value: number): void {
  out[at] = (value >>> 24) & 255;
  out[at + 1] = (value >>> 16) & 255;
  out[at + 2] = (value >>> 8) & 255;
  out[at + 3] = value & 255;
}

/**
 * One level of a block back to RGBA, for the modes this encoder writes and EAC: what a device
 * decodes, stated here so the encoder can be held to a number. A block in T, H or planar mode is
 * refused by name, since nothing here writes one.
 */
export function decodeEtc2(
  format: Etc2Format,
  blocks: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const across = Math.max(1, Math.ceil(width / 4));
  const bytes = BYTES[format];
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (Math.floor(y / 4) * across + Math.floor(x / 4)) * bytes;
      const i = (x % 4) * 4 + (y % 4);
      const to = (y * width + x) * 4;
      out[to + 3] = 255;
      if (format === 'etc2-rgb8' || format === 'etc2-rgba8') {
        decodeColourTexel(blocks, format === 'etc2-rgba8' ? at + 8 : at, i, out, to);
        if (format === 'etc2-rgba8') out[to + 3] = decodeEacTexel(blocks, at, i, false);
      } else {
        out[to] = Math.round((decodeEacTexel(blocks, at, i, true) * 255) / 2047);
        out[to + 1] =
          format === 'eac-rg11'
            ? Math.round((decodeEacTexel(blocks, at + 8, i, true) * 255) / 2047)
            : 0;
        out[to + 2] = 0;
      }
    }
  }
  return out;
}

function read32(blocks: Uint8Array, at: number): number {
  return (
    (((blocks[at] as number) << 24) |
      ((blocks[at + 1] as number) << 16) |
      ((blocks[at + 2] as number) << 8) |
      (blocks[at + 3] as number)) >>>
    0
  );
}

function decodeColourTexel(
  blocks: Uint8Array,
  at: number,
  i: number,
  out: Uint8Array,
  to: number,
): void {
  const high = read32(blocks, at);
  const low = read32(blocks, at + 4);
  const flip = high & 1;
  const differential = (high >> 1) & 1;
  const half = firstHalf(i, flip) ? 0 : 1;
  const table = half === 0 ? (high >> 5) & 7 : (high >> 2) & 7;
  const index = (((low >>> (i + 16)) & 1) << 1) | ((low >>> i) & 1);
  for (let c = 0; c < 3; c++) {
    let value: number;
    if (differential === 1) {
      const first = (high >>> (27 - c * 8)) & 31;
      let delta = (high >>> (24 - c * 8)) & 7;
      if (delta >= 4) delta -= 8;
      const q = half === 0 ? first : first + delta;
      if (q < 0 || q > 31) {
        throw new Error('decodeEtc2: a block in T, H or planar mode, which this does not decode');
      }
      value = (q << 3) | (q >> 2);
    } else {
      const q = (high >>> (half === 0 ? 28 - c * 8 : 24 - c * 8)) & 15;
      value = (q << 4) | q;
    }
    out[to + c] = clamp255(value + step(table, index));
  }
}

function decodeEacTexel(blocks: Uint8Array, at: number, i: number, eleven: boolean): number {
  const b = blocks[at] as number;
  const multiplier = (blocks[at + 1] as number) >> 4;
  const table = (blocks[at + 1] as number) & 15;
  const first =
    ((blocks[at + 2] as number) << 16) |
    ((blocks[at + 3] as number) << 8) |
    (blocks[at + 4] as number);
  const second =
    ((blocks[at + 5] as number) << 16) |
    ((blocks[at + 6] as number) << 8) |
    (blocks[at + 7] as number);
  const index = i < 8 ? (first >>> (21 - i * 3)) & 7 : (second >>> (21 - (i - 8) * 3)) & 7;
  return eacValue(b, multiplier, (EAC[table] as readonly number[])[index] as number, eleven);
}
