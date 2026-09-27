/**
 * What `demo/dev/bounce.html`'s far wall should read, from a path tracer that shares nothing with the
 * engine but its lighting convention.
 *
 * **A reference, so the traced grid can be held to a number rather than to the rasterised one.**
 * Until 2026-09-27 the two grids were only compared with each other, and the comparison could not
 * say which was wrong: the traced wall read two thirds of the rasterised one. Against this it read a
 * third of the truth, because the bake divided the sun by pi where the frame does not, and the
 * rasterised grid read half of it, because this page keeps no range and so captures in eight bits,
 * which clips a sunlit wall at one.
 *
 * **The convention is the engine's, not a textbook's.** A surface sends
 * `albedo * (sun * cosine * visible + mean incoming radiance)`, which is what the flat shader draws:
 * `directionalColor` is the radiance a white surface facing the sun sends back, and a probe stores
 * the cosine-weighted mean radiance a Lambertian multiplies by its albedo. Rays are cosine-weighted,
 * so a path's mean is that integral directly. Eight bounces, which at an albedo of 0.82 leaves a few
 * per cent of the series; that remainder is inside the margin the check allows.
 *
 * **The room is `bounce.ts`'s**, restated here because a browser module cannot be imported by a
 * script: 2 × 1.5 × 2 half-extents less 0.2 m slabs, open on +z where the camera stands, the -x wall
 * red and the rest white, the sun toward (0.75, 0.2, 0.63). A change there wants a change here.
 */

const LOW = [-1.8, -1.3, -1.8];
const HIGH = [1.8, 1.3, 2.0];
const WHITE = [0.82, 0.82, 0.82];
const RED = [0.9, 0.06, 0.06];
const SUN = [4, 3.88, 3.68];
const SKY = [0.01, 0.01, 0.012];
const SUN_DIR = (() => {
  const d = [0.75, 0.2, 0.63];
  const l = Math.hypot(...d);
  return d.map((v) => v / l);
})();
const BOUNCES = 8;

/** Mulberry32, seeded, so the reference is the same number every run. */
function generator(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The face a ray from inside the room leaves through, and how far away it is. */
function exit(p, d) {
  let axis = 0;
  let best = Infinity;
  for (let k = 0; k < 3; k++) {
    if (d[k] === 0) continue;
    const t = ((d[k] > 0 ? HIGH[k] : LOW[k]) - p[k]) / d[k];
    if (t < best) {
      best = t;
      axis = k;
    }
  }
  return { axis, t: best };
}

/** A direction about `n`, cosine-weighted. */
function cosineAbout(n, random) {
  const u1 = random();
  const u2 = random();
  const r = Math.sqrt(u1);
  const phi = 2 * Math.PI * u2;
  const x = r * Math.cos(phi);
  const y = r * Math.sin(phi);
  const z = Math.sqrt(1 - u1);
  const a = Math.abs(n[0]) > 0.9 ? [0, 1, 0] : [1, 0, 0];
  const t = [n[1] * a[2] - n[2] * a[1], n[2] * a[0] - n[0] * a[2], n[0] * a[1] - n[1] * a[0]];
  const tl = Math.hypot(...t);
  for (let k = 0; k < 3; k++) t[k] /= tl;
  const b = [n[1] * t[2] - n[2] * t[1], n[2] * t[0] - n[0] * t[2], n[0] * t[1] - n[1] * t[0]];
  return [0, 1, 2].map((k) => x * t[k] + y * b[k] + z * n[k]);
}

/** What arrives at `p` along `-d`: the radiance of whatever the ray from `p` along `d` strikes. */
function radiance(p, d, depth, random) {
  const { axis, t } = exit(p, d);
  if (axis === 2 && d[2] > 0) return SKY;
  if (depth === 0) return [0, 0, 0];
  const n = [0, 0, 0];
  n[axis] = d[axis] > 0 ? -1 : 1;
  const albedo = axis === 0 && d[0] < 0 ? RED : WHITE;
  const q = [0, 1, 2].map((k) => p[k] + d[k] * t + n[k] * 1e-4);
  const cosine = Math.max(0, n[0] * SUN_DIR[0] + n[1] * SUN_DIR[1] + n[2] * SUN_DIR[2]);
  const toSun = cosine > 0 ? exit(q, SUN_DIR) : { axis: -1, t: 0 };
  const visible = toSun.axis === 2 && SUN_DIR[2] > 0 ? 1 : 0;
  const bounced = radiance(q, cosineAbout(n, random), depth - 1, random);
  return [0, 1, 2].map((k) => albedo[k] * (SUN[k] * cosine * visible + bounced[k]));
}

/** The cosine-weighted mean radiance at `p` about `n`, over `paths` paths. */
export function meanRadiance(p, n, paths, seed) {
  const random = generator(seed);
  const sum = [0, 0, 0];
  for (let i = 0; i < paths; i++) {
    const l = radiance(p, cosineAbout(n, random), BOUNCES, random);
    for (let k = 0; k < 3; k++) sum[k] += l[k];
  }
  return sum.map((v) => v / paths);
}

/**
 * The range each channel of the far wall may read, in levels of 255.
 *
 * **The wall is beyond the grid's last layer of probes**, at x = 1.8 against probes at 1.6, and the
 * page reads it between y = -0.3 and 0.3 and z = -1.15 and -0.62. So what the frame draws there is
 * a blend of the four probes at x = 1.6, y in {-0.3, 0.9} and z in {-0.8, 0.4}, facing -x, times the
 * white wall's albedo: whatever the blend's weights, it lies between the least and the most of them.
 */
export function farWallRange(paths = 60000) {
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  let seed = 1;
  for (const y of [-0.3, 0.9]) {
    for (const z of [-0.8, 0.4]) {
      const e = meanRadiance([1.6, y, z], [-1, 0, 0], paths, seed++);
      for (let k = 0; k < 3; k++) {
        const level = Math.min(255, WHITE[k] * e[k] * 255);
        low[k] = Math.min(low[k], level);
        high[k] = Math.max(high[k], level);
      }
    }
  }
  return { low, high };
}
