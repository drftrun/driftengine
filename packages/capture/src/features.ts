/**
 * Corners in a frame, a binary description of each, and the matches between two frames.
 *
 * **A corner is a place where the image moves in two directions at once**, which is the one thing
 * that can be found again from another angle: an edge slides along itself and a flat patch could be
 * anywhere. So the response is Shi–Tomasi's — the smaller eigenvalue of the gradient's structure
 * tensor, which is how much the weaker direction moves — kept where it is the largest in its own
 * neighbourhood, and the strongest `budget` of those are the frame's features.
 *
 * **Each carries an orientation, and it is a vector rather than an angle.** The intensity centroid
 * of a patch points away from its darker side; normalised, that is the cosine and sine the
 * descriptor's pattern is turned by, so no inverse tangent is taken — which matters because this
 * package is inside the determinism gate and `atan2` is one of the twenty-two functions no two
 * engines must agree on.
 *
 * **The description is 256 comparisons of a blurred patch**, at pairs of places drawn once from a
 * seed and turned by the feature's own orientation: a bit per pair, so two features compare in a
 * few instructions and a frame's worth fits in memory. Blurred, because a comparison of two raw
 * pixels is a comparison of two samples of the noise.
 *
 * **A match is mutual and unambiguous.** Each feature's nearest description in the other frame must
 * also have it as its nearest, and each must be clearly nearer than its own second nearest —
 * Lowe's ratio, applied from both sides — because a repeated texture answers every query equally
 * well and a wrong match at this stage is a wrong camera later. **From both sides rather than one**,
 * so matching the frames the other way round gives the same pairs; tested one-sided, it gave 46
 * pairs one way and 48 the other, which would make a capture's answer depend on which frame it
 * called first.
 */
import { mulberry32 } from '@driftengine/core';

/** The features of one frame, in the arrays a caller owns. */
export interface FeatureSet {
  readonly x: Float32Array;
  readonly y: Float32Array;
  /** Shi–Tomasi's smaller eigenvalue: how strong a corner it is. */
  readonly response: Float32Array;
  /** The orientation, as a unit vector rather than an angle. */
  readonly cos: Float32Array;
  readonly sin: Float32Array;
  count: number;
}

/** The descriptions of a frame's features: `BYTES` bytes each, bit by comparison. */
export interface Descriptors {
  readonly bits: Uint8Array;
  readonly count: number;
}

/** A description is 256 bits, which is 32 bytes. */
export const DESCRIPTOR_BYTES = 32;
const PAIRS = DESCRIPTOR_BYTES * 8;
/** The patch a description is drawn from, and the one an orientation is measured over. */
const PATCH = 15;
const SUPPRESS = 3;
/** A corner must reach this share of the frame's strongest to be one at all. */
const FLOOR = 0.01;
/**
 * And this much movement outright, in luma squared. **A share alone is not enough**: a wall carries
 * a level or two of sensor noise, and a share of the strongest noise is still noise — measured, an
 * uncorrelated level of ±1 answers with 265 "corners" of up to 6, and ±2 with 268 of up to 17,
 * while the test scene's weakest real corner is 180 and its strongest 12,100. **25 sits between
 * them**, three orders below what a texture scores and above what noise reaches.
 */
const LEAST = 25;

export function createFeatureSet(budget: number): FeatureSet {
  return {
    x: new Float32Array(budget),
    y: new Float32Array(budget),
    response: new Float32Array(budget),
    cos: new Float32Array(budget),
    sin: new Float32Array(budget),
    count: 0,
  };
}

/* The pattern, drawn once: pairs of offsets inside the patch, the same on every machine. */
const PATTERN = ((): Int8Array => {
  const random = mulberry32(0x0c0ffee1);
  const out = new Int8Array(PAIRS * 4);
  const reach = (PATCH - 1) / 2;
  for (let i = 0; i < PAIRS * 4; i += 1) {
    /* A rounded draw over the patch, which keeps the pairs inside it once they are turned. */
    out[i] = Math.round((random() * 2 - 1) * reach * 0.7);
  }
  return out;
})();

/** The frame as luma, one byte a pixel, which everything below reads. */
function luma(image: Uint8Array, width: number, height: number): Float32Array {
  const out = new Float32Array(width * height);
  for (let at = 0; at < width * height; at += 1) {
    out[at] =
      0.299 * (image[at * 4] as number) +
      0.587 * (image[at * 4 + 1] as number) +
      0.114 * (image[at * 4 + 2] as number);
  }
  return out;
}

/** A 3 × 3 box blur, which is what a description compares rather than raw samples. */
function blurred(grey: Float32Array, width: number, height: number): Float32Array {
  const out = new Float32Array(grey.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        const row = Math.min(height - 1, Math.max(0, y + dy)) * width;
        for (let dx = -1; dx <= 1; dx += 1) {
          sum += grey[row + Math.min(width - 1, Math.max(0, x + dx))] as number;
        }
      }
      out[y * width + x] = sum / 9;
    }
  }
  return out;
}

/**
 * The strongest corners of `image`, RGBA at `width × height`, into `out` — at most `budget` of
 * them, strongest first.
 */
export function detectFeatures(
  image: Uint8Array,
  width: number,
  height: number,
  out: FeatureSet,
  budget: number,
): void {
  const grey = luma(image, width, height);
  const response = new Float32Array(width * height);
  const border = (PATCH - 1) / 2 + 1;
  let strongest = 0;
  for (let y = border; y < height - border; y += 1) {
    for (let x = border; x < width - border; x += 1) {
      /* The structure tensor over a 3 × 3 window of central differences. */
      let xx = 0;
      let yy = 0;
      let xy = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const at = (y + dy) * width + x + dx;
          const gx = ((grey[at + 1] as number) - (grey[at - 1] as number)) / 2;
          const gy = ((grey[at + width] as number) - (grey[at - width] as number)) / 2;
          xx += gx * gx;
          yy += gy * gy;
          xy += gx * gy;
        }
      }
      const half = (xx + yy) / 2;
      const side = (xx - yy) / 2;
      /* Shi–Tomasi: the smaller eigenvalue, which is the weaker direction's movement. */
      const smaller = half - Math.sqrt(side * side + xy * xy);
      response[y * width + x] = smaller;
      strongest = Math.max(strongest, smaller);
    }
  }

  /* Keep a response that is the largest within its neighbourhood and above the floor. */
  const floor = Math.max(strongest * FLOOR, LEAST);
  const kept: number[] = [];
  for (let y = border; y < height - border; y += 1) {
    for (let x = border; x < width - border; x += 1) {
      const here = response[y * width + x] as number;
      if (here < floor) continue;
      let best = true;
      for (let dy = -SUPPRESS; dy <= SUPPRESS && best; dy += 1) {
        for (let dx = -SUPPRESS; dx <= SUPPRESS; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const other = response[(y + dy) * width + x + dx] as number;
          /* A tie goes to the earlier pixel, so the answer does not depend on the scan. */
          if (other > here || (other === here && (dy < 0 || (dy === 0 && dx < 0)))) {
            best = false;
            break;
          }
        }
      }
      if (best) kept.push(y * width + x);
    }
  }
  kept.sort((a, b) => (response[b] as number) - (response[a] as number) || a - b);

  const reach = (PATCH - 1) / 2;
  out.count = Math.min(budget, out.x.length, kept.length);
  for (let i = 0; i < out.count; i += 1) {
    const at = kept[i] as number;
    const x = at % width;
    const y = (at - x) / width;
    out.x[i] = x;
    out.y[i] = y;
    out.response[i] = response[at] as number;
    /* The intensity centroid of the patch, as a direction. */
    let mx = 0;
    let my = 0;
    for (let dy = -reach; dy <= reach; dy += 1) {
      for (let dx = -reach; dx <= reach; dx += 1) {
        if (dx * dx + dy * dy > reach * reach) continue;
        const value = grey[(y + dy) * width + x + dx] as number;
        mx += dx * value;
        my += dy * value;
      }
    }
    const length = Math.sqrt(mx * mx + my * my);
    out.cos[i] = length === 0 ? 1 : mx / length;
    out.sin[i] = length === 0 ? 0 : my / length;
  }
}

/** A description of every feature in `features`, 32 bytes each. */
export function describeFeatures(
  image: Uint8Array,
  width: number,
  height: number,
  features: FeatureSet,
): Descriptors {
  const smooth = blurred(luma(image, width, height), width, height);
  const bits = new Uint8Array(features.count * DESCRIPTOR_BYTES);
  for (let i = 0; i < features.count; i += 1) {
    const x = features.x[i] as number;
    const y = features.y[i] as number;
    const cos = features.cos[i] as number;
    const sin = features.sin[i] as number;
    for (let pair = 0; pair < PAIRS; pair += 1) {
      const sample = (at: number): number => {
        const dx = PATTERN[pair * 4 + at * 2] as number;
        const dy = PATTERN[pair * 4 + at * 2 + 1] as number;
        /* The pattern turns with the feature, which is what makes it survive a rotation. */
        const rx = Math.round(x + cos * dx - sin * dy);
        const ry = Math.round(y + sin * dx + cos * dy);
        const cx = Math.min(width - 1, Math.max(0, rx));
        const cy = Math.min(height - 1, Math.max(0, ry));
        return smooth[cy * width + cx] as number;
      };
      if (sample(0) < sample(1)) {
        bits[i * DESCRIPTOR_BYTES + (pair >> 3)] |= 1 << (pair & 7);
      }
    }
  }
  return { bits, count: features.count };
}

const ONES = ((): Uint8Array => {
  const out = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) out[i] = (i & 1) + (out[i >> 1] as number);
  return out;
})();

function distance(a: Uint8Array, at: number, b: Uint8Array, to: number): number {
  let sum = 0;
  for (let byte = 0; byte < DESCRIPTOR_BYTES; byte += 1) {
    sum += ONES[(a[at + byte] as number) ^ (b[to + byte] as number)] as number;
  }
  return sum;
}

/**
 * The matches between two frames' descriptions into `out`, two indices each, and how many there
 * are. A match is mutual and clears Lowe's `ratio`, which defaults to 0.8.
 */
export function matchFeatures(
  a: Descriptors,
  b: Descriptors,
  out: Int32Array,
  options: { readonly ratio?: number } = {},
): number {
  const ratio = options.ratio ?? 0.8;
  const bestOf = (
    from: Descriptors,
    to: Descriptors,
    index: number,
  ): { at: number; best: number; second: number } => {
    let at = -1;
    let best = Infinity;
    let second = Infinity;
    for (let j = 0; j < to.count; j += 1) {
      const off = distance(from.bits, index * DESCRIPTOR_BYTES, to.bits, j * DESCRIPTOR_BYTES);
      if (off < best) {
        second = best;
        best = off;
        at = j;
      } else if (off < second) {
        second = off;
      }
    }
    return { at, best, second };
  };

  let count = 0;
  for (let i = 0; i < a.count && count * 2 + 1 < out.length; i += 1) {
    const forward = bestOf(a, b, i);
    if (forward.at < 0) continue;
    /* Unambiguous: the nearest must be clearly nearer than whatever came second. */
    if (!(forward.best < ratio * forward.second)) continue;
    /* And mutual, by the same rule from the other side: matching either way gives one answer. */
    const back = bestOf(b, a, forward.at);
    if (back.at !== i || !(back.best < ratio * back.second)) continue;
    out[count * 2] = i;
    out[count * 2 + 1] = forward.at;
    count += 1;
  }
  return count;
}
