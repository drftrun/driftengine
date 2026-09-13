import { expect, test } from 'vitest';

/**
 * **What this file is for: the one constant the fold could get wrong, and only in one direction.**
 *
 * The diffuse ambient used to be nine spherical-harmonic coefficients projected on the CPU, and it
 * is now a cosine convolution written into a level of the probe array by `prefilter.ts`. Both are
 * the same integral and the two can only disagree by a factor.
 *
 * Irradiance is `integral of L cos(theta)`, the cosine density is `cos(theta) / pi`, so a
 * cosine-weighted estimate is `pi / N * sum(L)` — and `irradianceSh.ts` divides its band factors by
 * `pi` already, because "what a shader wants back is radiance rather than irradiance". So the two
 * agree exactly when the convolution is a **plain mean** of the sampled radiance, with no `pi`
 * anywhere, and a scene lit by either is the same brightness.
 *
 * Getting it wrong is invisible in the pattern and only visible in the level: a room 3.14 times too
 * bright or too dark with every direction still in the right proportion to every other, which reads
 * as a scene that needs a tuning pass. That is the exact shape of the two mistakes
 * `projectIrradiance`'s own header records paying for.
 *
 * **The estimator here is the GLSL's arithmetic in TypeScript, not the GLSL.** What it proves is
 * the decision; what proves the shader is the exit page, where a grid of one is compared against
 * the probe this replaces.
 *
 * **Checked against the closed form rather than against the projection it replaces.** The
 * spherical-harmonic path was the obvious oracle and it is being deleted with the readback that
 * fed it, so the assertions below are analytic: a field linear in the direction convolves to a
 * field linear in the normal, with the constant band unchanged and the linear band scaled by
 * exactly `2/3`. Those are the first two of the three numbers `irradianceSh.ts` carried as
 * `BAND_FACTOR`, so this pins the same decision without depending on the code that stated it.
 */

/** Hammersley, the same two dimensions the shader draws its pairs from. */
function radicalInverse(index: number): number {
  let bits = index >>> 0;
  bits = ((bits << 16) | (bits >>> 16)) >>> 0;
  bits = (((bits & 0x55555555) << 1) | ((bits & 0xaaaaaaaa) >>> 1)) >>> 0;
  bits = (((bits & 0x33333333) << 2) | ((bits & 0xcccccccc) >>> 2)) >>> 0;
  bits = (((bits & 0x0f0f0f0f) << 4) | ((bits & 0xf0f0f0f0) >>> 4)) >>> 0;
  bits = (((bits & 0x00ff00ff) << 8) | ((bits & 0xff00ff00) >>> 8)) >>> 0;
  return bits * 2.3283064365386963e-10;
}

type Direction = readonly [number, number, number];

/** `importanceSampleCosine`, transcribed. A direction drawn with density `cos(theta) / pi`. */
function sampleCosine(u: number, v: number, n: Direction): Direction {
  const phi = 2 * Math.PI * u;
  const cosTheta = Math.sqrt(Math.max(1 - v, 0));
  const sinTheta = Math.sqrt(v);
  const hx = sinTheta * Math.cos(phi);
  const hy = sinTheta * Math.sin(phi);
  const hz = cosTheta;

  const up: Direction = Math.abs(n[2]) < 0.999 ? [0, 0, 1] : [1, 0, 0];
  const tx: Direction = normalise([
    up[1] * n[2] - up[2] * n[1],
    up[2] * n[0] - up[0] * n[2],
    up[0] * n[1] - up[1] * n[0],
  ]);
  const ty: Direction = [
    n[1] * tx[2] - n[2] * tx[1],
    n[2] * tx[0] - n[0] * tx[2],
    n[0] * tx[1] - n[1] * tx[0],
  ];
  return normalise([
    tx[0] * hx + ty[0] * hy + n[0] * hz,
    tx[1] * hx + ty[1] * hy + n[1] * hz,
    tx[2] * hx + ty[2] * hy + n[2] * hz,
  ]);
}

function normalise(d: Direction): Direction {
  const l = Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]) || 1;
  return [d[0] / l, d[1] / l, d[2] / l];
}

/** The convolution `prefilter.ts` writes into the irradiance level: a mean, and nothing else. */
function cosineConvolve(
  environment: (d: Direction) => Direction,
  n: Direction,
  samples: number,
): Direction {
  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i < samples; i++) {
    const l = sampleCosine(i / samples, radicalInverse(i), n);
    const c = environment(l);
    r += c[0];
    g += c[1];
    b += c[2];
  }
  return [r / samples, g / samples, b / samples];
}

/** A spread of normals that is not axis-aligned, seeded so a failure reproduces. */
function normals(): Direction[] {
  const out: Direction[] = [
    [0, 1, 0],
    [0, -1, 0],
    [1, 0, 0],
    [0, 0, 1],
  ];
  let s = 7;
  const next = (): number => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648 - 0.5;
  };
  for (let i = 0; i < 12; i++) out.push(normalise([next(), next(), next()]));
  return out;
}

/*
 * **The uniform case is where the factor has nowhere to hide.** A sky of one radiance lights every
 * surface at exactly that radiance, whatever the normal, so any stray `pi` shows up immediately and
 * at full size. This is the assertion the whole fold rests on.
 */
test('a uniform environment convolves to exactly its own radiance', () => {
  const sky = (): Direction => [0.4, 0.6, 0.9];
  for (const n of normals()) {
    const got = cosineConvolve(sky, n, 1024);
    expect(got[0], `normal ${n.join(',')}`).toBeCloseTo(0.4, 6);
    expect(got[1]).toBeCloseTo(0.6, 6);
    expect(got[2]).toBeCloseTo(0.9, 6);
  }
});

/*
 * **A directional environment, against the closed form.**
 *
 * A cosine convolution is a per-band scale: the constant band passes through untouched and the
 * linear band is multiplied by `2/3`. So a field `a + b (d . u)` convolves to `a + (2/3) b (n . u)`
 * exactly, and there is no oracle to drift from — this is the integral, written down.
 *
 * The tolerance is the estimator's rather than the integral's: 4,096 cosine samples on a smooth
 * field settle inside a per cent, and the shader draws far fewer per texel and leans on the
 * neighbouring texels for the rest.
 */
test('a directional environment convolves to the closed form', () => {
  const environment = (d: Direction): Direction => [
    0.5 + 0.4 * d[1],
    0.3 + 0.25 * d[0],
    0.6 - 0.3 * d[2],
  ];
  /** The linear band's own factor, which is the whole of what a cosine convolution does to it. */
  const BAND_1 = 2 / 3;

  let worst = 0;
  for (const n of normals()) {
    const got = cosineConvolve(environment, n, 4096);
    const want: Direction = [
      0.5 + BAND_1 * 0.4 * n[1],
      0.3 + BAND_1 * 0.25 * n[0],
      0.6 - BAND_1 * 0.3 * n[2],
    ];
    for (let c = 0; c < 3; c++) {
      worst = Math.max(
        worst,
        Math.abs((got[c] ?? 0) - (want[c] ?? 0)) / Math.max(want[c] ?? 0, 1e-3),
      );
    }
  }
  expect(worst, 'worst relative disagreement across sixteen normals').toBeLessThan(0.02);
});

/*
 * The mistake this is really guarding, stated as a failing alternative. A convolution that kept the
 * `pi` would be 3.14 times too bright everywhere, with every direction still in the right
 * proportion to every other — which reads as a scene needing a tuning pass rather than as a factor.
 */
test('keeping the pi would be visibly wrong, which is why the mean is the whole convolution', () => {
  const sky = (): Direction => [0.5, 0.5, 0.5];
  const mean = cosineConvolve(sky, [0, 1, 0], 1024);
  expect((mean[0] ?? 0) * Math.PI).toBeCloseTo(0.5 * Math.PI, 6);
  expect(mean[0]).toBeCloseTo(0.5, 6);
});
