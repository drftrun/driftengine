/**
 * Seeded value noise and fBm, the only source of randomness the terrain has.
 *
 * **The engine's own `mulberry32` and `hashToUnit` are deliberately not used here.** This port
 * exists to be compared against the demo it came from, and that comparison is only meaningful
 * while both generate the same world from the same seed — so the hash constants below are the
 * reference's, unchanged, and must stay so. Engine RNG is for everything terrain does not
 * decide: spawn jitter, particle seeds, cloud offsets.
 */

function hash2(seed: number, ix: number, iy: number): number {
  let h = seed ^ Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function hash3(seed: number, ix: number, iy: number, iz: number): number {
  let h = seed ^ Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(iz, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Value noise in [0,1] at (x,y). */
export function valueNoise2(seed: number, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = smooth(x - x0);
  const fy = smooth(y - y0);
  const v00 = hash2(seed, x0, y0);
  const v10 = hash2(seed, x0 + 1, y0);
  const v01 = hash2(seed, x0, y0 + 1);
  const v11 = hash2(seed, x0 + 1, y0 + 1);
  return lerp(lerp(v00, v10, fx), lerp(v01, v11, fx), fy);
}

/** Value noise in [0,1] at (x,y,z). */
export function valueNoise3(seed: number, x: number, y: number, z: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const fx = smooth(x - x0);
  const fy = smooth(y - y0);
  const fz = smooth(z - z0);
  const c000 = hash3(seed, x0, y0, z0);
  const c100 = hash3(seed, x0 + 1, y0, z0);
  const c010 = hash3(seed, x0, y0 + 1, z0);
  const c110 = hash3(seed, x0 + 1, y0 + 1, z0);
  const c001 = hash3(seed, x0, y0, z0 + 1);
  const c101 = hash3(seed, x0 + 1, y0, z0 + 1);
  const c011 = hash3(seed, x0, y0 + 1, z0 + 1);
  const c111 = hash3(seed, x0 + 1, y0 + 1, z0 + 1);
  const x00 = lerp(c000, c100, fx);
  const x10 = lerp(c010, c110, fx);
  const x01 = lerp(c001, c101, fx);
  const x11 = lerp(c011, c111, fx);
  return lerp(lerp(x00, x10, fy), lerp(x01, x11, fy), fz);
}

/**
 * fBm over value noise: octaves at decreasing amplitude, in [0,1].
 *
 * The sum is divided by the accumulated amplitude rather than by a constant, which is what keeps
 * the output in the unit range for any octave count.
 */
export function fbm2(
  seed: number,
  x: number,
  y: number,
  octaves: number,
  lacunarity = 2,
  gain = 0.5,
): number {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise2(seed + o * 1013, x * freq, y * freq);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/** A deterministic [0,1) keyed on three integers, for scatter and decoration. */
export function rand3(seed: number, x: number, y: number, z: number): number {
  return hash3(seed, x, y, z);
}
