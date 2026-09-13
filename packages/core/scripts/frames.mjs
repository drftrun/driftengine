/**
 * What two frames differ by, and how speckled one is. Pure functions over decoded pixels.
 *
 * **These two measurements are the ones that have paid for themselves here**, and they are worth
 * having in one place because both have a wrong version that looks right.
 *
 * `compare` reports by *brightness band* rather than as one number, which is what makes a result
 * readable: "19% of the near-white pixels moved by 3, everything else by 0.03" is a description
 * of an effect, and the single mean it collapses into is not. It was written the flat way first
 * and the flat way could not tell a tone curve from rounding between eight bits and a half float.
 *
 * `speckle` counts a pixel brighter than the median of its neighbours, which is how a shading
 * artefact made of single stray pixels gets counted at all: it survives a change of camera, it
 * ignores a legitimate highlight's interior, and it is the metric two consumers arrived at
 * independently while chasing the same fault.
 */

/** Rec. 709 luminance of one pixel, in 0..255. */
export function luminance(pixels, at) {
  return 0.2126 * pixels[at] + 0.7152 * pixels[at + 1] + 0.0722 * pixels[at + 2];
}

/** The bands `compare` splits a frame into, by the luminance of the *first* image's pixel. */
export const BANDS = [
  { name: 'dark', from: 0, to: 32 },
  { name: 'mid', from: 32, to: 128 },
  { name: 'bright', from: 128, to: 224 },
  { name: 'near white', from: 224, to: 256 },
];

/**
 * Two decoded images, band by band.
 *
 * `region` is `{ x0, y0, x1, y1 }` and defaults to the whole frame. It earns its place: a harness
 * draws its own readout over the picture, and a frame rate printed in a corner differs between
 * any two runs, so a comparison that includes it always reports a change.
 *
 * `tolerance` is the difference in luminance below which a pixel is called unchanged. 1 is the
 * useful default, being the smallest step eight bits can express.
 */
export function compare(one, two, { region, tolerance = 1 } = {}) {
  if (one.width !== two.width || one.height !== two.height) {
    throw new Error(
      `frames are ${one.width}x${one.height} and ${two.width}x${two.height}; nothing to compare`,
    );
  }
  const box = {
    x0: region?.x0 ?? 0,
    y0: region?.y0 ?? 0,
    x1: region?.x1 ?? one.width,
    y1: region?.y1 ?? one.height,
  };
  const bands = BANDS.map((band) => ({ ...band, pixels: 0, changed: 0, delta: 0 }));

  let pixels = 0;
  let changed = 0;
  let delta = 0;
  let worst = 0;
  let worstAt = null;
  let sumOne = 0;
  let sumTwo = 0;

  for (let y = box.y0; y < box.y1; y++) {
    for (let x = box.x0; x < box.x1; x++) {
      const at = (y * one.width + x) * one.channels;
      const a = luminance(one.pixels, at);
      const b = luminance(two.pixels, at);
      const d = Math.abs(a - b);
      pixels++;
      sumOne += a;
      sumTwo += b;
      const band =
        bands.find((entry) => a >= entry.from && a < entry.to) ?? bands[bands.length - 1];
      band.pixels++;
      if (d > tolerance) {
        changed++;
        delta += d;
        band.changed++;
        band.delta += d;
        if (d > worst) {
          worst = d;
          worstAt = { x, y };
        }
      }
    }
  }

  const mean = (sum, count) => (count === 0 ? 0 : sum / count);
  return {
    pixels,
    changed,
    meanDelta: mean(delta, changed),
    worst,
    worstAt,
    meanLuminance: [mean(sumOne, pixels), mean(sumTwo, pixels)],
    bands: bands.map((band) => ({
      name: band.name,
      pixels: band.pixels,
      changed: band.changed,
      meanDelta: mean(band.delta, band.changed),
    })),
  };
}

/**
 * How many pixels stand brighter than the median of their eight neighbours by more than
 * `threshold`.
 *
 * The 3x3 median rather than the mean, and this is the part that matters: a mean is dragged up by
 * the very pixel being tested, so a bright speck partly hides itself and a run of them reads as a
 * gentle gradient. A median ignores it entirely, so the comparison is against what the
 * neighbourhood would have been.
 *
 * Two thresholds are usually worth reporting together. The lower one moves with legitimate
 * silhouette detail and the higher one is the artefact, so a change that improves one and not the
 * other has said something specific.
 */
export function speckle(image, { threshold = 12, region } = {}) {
  const box = {
    x0: Math.max(1, region?.x0 ?? 1),
    y0: Math.max(1, region?.y0 ?? 1),
    x1: Math.min(image.width - 1, region?.x1 ?? image.width - 1),
    y1: Math.min(image.height - 1, region?.y1 ?? image.height - 1),
  };
  const neighbours = new Array(9);
  let count = 0;
  for (let y = box.y0; y < box.y1; y++) {
    for (let x = box.x0; x < box.x1; x++) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          neighbours[n++] = luminance(
            image.pixels,
            ((y + dy) * image.width + (x + dx)) * image.channels,
          );
        }
      }
      const centre = neighbours[4];
      const sorted = neighbours.slice().sort((a, b) => a - b);
      if (centre - sorted[4] > threshold) count++;
    }
  }
  return count;
}

/** One line per band, for printing a `compare` result without every caller writing the format. */
export function formatComparison(result) {
  const lines = [
    `${result.changed} of ${result.pixels} pixels changed, mean delta ${result.meanDelta.toFixed(2)}`,
    `mean luminance ${result.meanLuminance[0].toFixed(1)} to ${result.meanLuminance[1].toFixed(1)}` +
      (result.worstAt === null
        ? ''
        : `, worst ${result.worst.toFixed(0)} at ${result.worstAt.x},${result.worstAt.y}`),
  ];
  for (const band of result.bands) {
    const share = band.pixels === 0 ? 0 : (band.changed / band.pixels) * 100;
    lines.push(
      `  ${band.name.padEnd(11)}${String(band.pixels).padStart(9)} px ` +
        `${share.toFixed(1).padStart(6)}% changed, mean delta ${band.meanDelta.toFixed(2)}`,
    );
  }
  return lines.join('\n');
}
