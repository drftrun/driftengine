/**
 * History that disagrees with its neighbourhood, pulled in without changing its hue.
 *
 * **Why a luminance-chrominance space, and why a variance box.** The temporal resolve bounds its
 * history by the minimum and maximum of nine red-green-blue samples, which is as wide as the most
 * extreme of them: one bright pixel beside a moving edge lets the whole ghost through. A box of the
 * mean plus or minus `gamma` standard deviations is as wide as the neighbourhood actually varies, and
 * YCoCg separates the luminance the eye is sensitive to from the chrominance it is not.
 *
 * **Why clipping rather than clamping**, the resolve's own reason: a clamp moves each channel on its
 * own, so a history merely brighter than its surroundings lands on a corner of the box and comes back
 * a different hue — coloured fringing on every moving edge. Shortening the whole offset from the
 * box's centre by one ratio keeps its direction and changes only its length. `clipToBox` is
 * `clipToNeighbourhood` over plain arrays, and the test holds the two to one rule.
 */

/** YCoCg from linear red, green and blue, into `out`. Dyadic, so it round-trips exactly. */
export function rgbToYCoCg(
  out: Float32Array | Float64Array,
  r: number,
  g: number,
  b: number,
): void {
  out[0] = r * 0.25 + g * 0.5 + b * 0.25;
  out[1] = r * 0.5 - b * 0.5;
  out[2] = -r * 0.25 + g * 0.5 - b * 0.25;
}

/** Linear red, green and blue from YCoCg, into `out`. */
export function yCoCgToRgb(
  out: Float32Array | Float64Array,
  y: number,
  co: number,
  cg: number,
): void {
  const base = y - cg;
  out[0] = base + co;
  out[1] = y + cg;
  out[2] = base - co;
}

/**
 * The box of `count` three-channel samples: each channel's mean plus or minus `gamma` of its
 * standard deviation, into `outMin` and `outMax`.
 *
 * **A channel whose samples all agree has that value as its box, exactly.** A mean of nine equal
 * numbers is not always that number in floating point, and a box a rounding wide around the current
 * colour would let a history through by a rounding instead of collapsing it onto the colour.
 */
export function varianceBox(
  samples: ArrayLike<number>,
  count: number,
  gamma: number,
  outMin: Float32Array | Float64Array,
  outMax: Float32Array | Float64Array,
): void {
  for (let c = 0; c < 3; c += 1) {
    const first = samples[c] as number;
    let same = true;
    let sum = 0;
    for (let i = 0; i < count; i += 1) {
      const value = samples[i * 3 + c] as number;
      sum += value;
      if (value !== first) same = false;
    }
    if (same) {
      outMin[c] = first;
      outMax[c] = first;
      continue;
    }
    const mean = sum / count;
    let spread = 0;
    for (let i = 0; i < count; i += 1) {
      const d = (samples[i * 3 + c] as number) - mean;
      spread += d * d;
    }
    const deviation = Math.sqrt(spread / count);
    outMin[c] = mean - gamma * deviation;
    outMax[c] = mean + gamma * deviation;
  }
}

/**
 * `history` pulled into the box `min`..`max`, along the line towards the box's centre, into `out`.
 *
 * Unchanged inside the box; on its boundary from outside it. A channel with no extent bounds any
 * history that differs from it infinitely, so such a history collapses to the centre — the honest
 * answer for a flat neighbourhood, and the alternative is a division by zero.
 */
export function clipToBox(
  out: Float32Array | Float64Array,
  history: ArrayLike<number>,
  min: ArrayLike<number>,
  max: ArrayLike<number>,
): void {
  let ratio = 0;
  for (let c = 0; c < 3; c += 1) {
    const centre = ((min[c] as number) + (max[c] as number)) * 0.5;
    const offset = (history[c] as number) - centre;
    const extent = ((max[c] as number) - (min[c] as number)) * 0.5;
    if (extent > 1e-7) ratio = Math.max(ratio, Math.abs(offset) / extent);
    else if (Math.abs(offset) > 1e-7) ratio = Number.POSITIVE_INFINITY;
  }
  if (!(ratio > 1)) {
    for (let c = 0; c < 3; c += 1) out[c] = history[c] as number;
    return;
  }
  const scale = Number.isFinite(ratio) ? 1 / ratio : 0;
  for (let c = 0; c < 3; c += 1) {
    const centre = ((min[c] as number) + (max[c] as number)) * 0.5;
    out[c] = centre + ((history[c] as number) - centre) * scale;
  }
}
