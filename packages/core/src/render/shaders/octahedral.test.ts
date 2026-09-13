import { vec2, vec3 } from 'gl-matrix';
import { expect, test } from 'vitest';

import {
  OCTAHEDRAL_GLSL,
  octDecode,
  octEncode,
  octInsetDir,
  octInsetUv,
  octWrapUv,
} from './octahedral.ts';

const uv = vec2.create();
const back = vec3.create();

/*
 * **Doubles, where the claim is about the fold rather than about storage.**
 *
 * `vec2.create()` is a `Float32Array`, so a fold that is exact to 3.3e-16 reads as 6.2e-8 through
 * one — which is float32's own epsilon and says nothing about the arithmetic being asserted. The
 * tests that pin the border rule use plain tuples, which `gl-matrix` accepts as `vec2` and `vec3`,
 * and the tests above keep the typed arrays the shader path actually uses.
 */
const doubles2 = (): vec2 => [0, 0];
const doubles3 = (): vec3 => [0, 0, 0];

/** Every axis, every edge, every corner, and a deterministic spread between them. */
function directions(): number[][] {
  const out: number[][] = [];
  for (const a of [-1, 0, 1])
    for (const b of [-1, 0, 1])
      for (const c of [-1, 0, 1]) {
        if (a === 0 && b === 0 && c === 0) continue;
        out.push([a, b, c]);
      }
  /* A spread that is not axis-aligned, seeded rather than random so a failure reproduces. */
  let s = 1;
  const next = (): number => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648 - 0.5;
  };
  for (let i = 0; i < 200; i++) {
    const d = [next(), next(), next()];
    if (Math.hypot(d[0] ?? 0, d[1] ?? 0, d[2] ?? 0) > 1e-3) out.push(d);
  }
  return out;
}

test('encode and decode are inverses over the whole sphere', () => {
  for (const d of directions()) {
    const n = vec3.normalize(vec3.create(), vec3.fromValues(d[0] ?? 0, d[1] ?? 0, d[2] ?? 0));
    octEncode(n[0], n[1], n[2], uv);
    octDecode(uv[0], uv[1], back);
    expect(vec3.dist(back, n), `direction ${n[0]},${n[1]},${n[2]}`).toBeLessThan(1e-6);
  }
});

/*
 * The trap this file's header is about. GLSL's `sign` returns 0 at 0, and a direction with an
 * exact zero component is not a rarity here — it is every axis-aligned wall in every scene this
 * engine draws. A `sign()`-based fold sends those directions to the origin of the map, which reads
 * as a light's shadow landing on a surface it does not face.
 *
 * These are the five that a `sign()` fold gets wrong, and they are all in the `z < 0` hemisphere
 * because that is the only branch the fold is in.
 */
test('a direction with an exact zero component survives the fold', () => {
  for (const d of [
    [0, 0, -1],
    [1, 0, -1],
    [0, 1, -1],
    [-1, 0, -1],
    [0, -1, -1],
  ]) {
    const n = vec3.normalize(vec3.create(), vec3.fromValues(d[0] ?? 0, d[1] ?? 0, d[2] ?? 0));
    octEncode(n[0], n[1], n[2], uv);
    octDecode(uv[0], uv[1], back);
    expect(vec3.dist(back, n), `direction ${d.join(',')}`).toBeLessThan(1e-6);
  }
});

/*
 * The whole seam argument, as an assertion.
 *
 * A cube map's six faces are six separate projections, so two directions either side of a shared
 * edge are read from images that disagree — which is what draws the straight rays from beneath a
 * light that seven reports pointed at. This map has one projection, and the property that makes
 * that worth anything is continuity: two directions a ten-thousandth apart across the fold must
 * encode to two points a thousandth apart, or the cube's problem has been reproduced in a new
 * shape and nobody would know until a capture.
 */
test('the encoding is continuous across the fold at z = 0', () => {
  const above = vec2.create();
  const below = vec2.create();
  for (let i = 0; i < 64; i++) {
    const t = (i / 64) * Math.PI * 2;
    const x = Math.cos(t);
    const y = Math.sin(t);
    octEncode(x, y, 1e-4, above);
    octEncode(x, y, -1e-4, below);
    expect(vec2.dist(above, below), `at angle ${t}`).toBeLessThan(1e-3);
  }
});

/*
 * The one divergence the TypeScript above cannot catch, because it is a property of the other
 * language. The two implementations are one algorithm and the GLSL is the one that runs; asserted
 * on the text, which is the only oracle there is without a device.
 */
test('the GLSL uses the ternary fold rather than sign()', () => {
  expect(OCTAHEDRAL_GLSL).not.toContain('sign(');
  expect(OCTAHEDRAL_GLSL).toContain('octEncode');
  expect(OCTAHEDRAL_GLSL).toContain('octDecode');
  expect(OCTAHEDRAL_GLSL).toContain('octWrapUv');
  expect(OCTAHEDRAL_GLSL).toContain('octInsetUv');
  expect(OCTAHEDRAL_GLSL).toContain('octInsetDir');
});

/*
 * A wrap that moved an interior texel would resample every map by a function that exists to touch
 * the border, and nothing downstream would say so — the picture would simply be slightly soft.
 */
test('the wrap is the identity inside the square', () => {
  const out = doubles2();
  for (let i = 1; i < 20; i++) {
    for (let j = 1; j < 20; j++) {
      const u = i / 20;
      const v = j / 20;
      octWrapUv(u, v, out);
      expect(Math.abs(out[0] - u), `at ${u},${v}`).toBeLessThan(1e-12);
      expect(Math.abs(out[1] - v), `at ${u},${v}`).toBeLessThan(1e-12);
    }
  }
});

/*
 * **The gutter, which is the whole reason these three functions exist.**
 *
 * The point-shadow array never needed one: it is a single storage level with `NEAREST` on both
 * filters, so no tap crosses the map's outer border. A prefiltered environment is `LINEAR` with a
 * chain, and a tap that crosses the border reads whatever is on the other side of it. The border
 * is a fold rather than an edge — past the right side at height `v` is inside it at `1 - v`.
 */
test('a gutter texel holds the direction of the texel it is folded against', () => {
  const wrapped = doubles2();
  const outside = doubles3();
  const inside = doubles3();
  for (const step of [1e-3, 1e-2, 0.05, 0.2]) {
    for (let k = 1; k < 40; k++) {
      const s = k / 40;
      for (const [out, back] of [
        [
          [1 + step, s],
          [1 - step, 1 - s],
        ],
        [
          [-step, s],
          [step, 1 - s],
        ],
        [
          [s, 1 + step],
          [1 - s, 1 - step],
        ],
        [
          [s, -step],
          [1 - s, step],
        ],
      ]) {
        octWrapUv(out[0] ?? 0, out[1] ?? 0, wrapped);
        octDecode(wrapped[0], wrapped[1], outside);
        octDecode(back[0] ?? 0, back[1] ?? 0, inside);
        expect(vec3.dist(outside, inside), `past ${out.join(',')} at step ${step}`).toBeLessThan(
          1e-12,
        );
      }
    }
  }
});

/*
 * Without the rule, and this is the measurement that decided the design rather than an argument
 * about it: the same border, sampled straight across, is wrong by about 4.6e-2 in direction. That
 * is a seam, and it is what a probe grid would have shipped with.
 */
test('sampling straight across the border is wrong, which is what the wrap is for', () => {
  const naive = doubles3();
  const folded = doubles3();
  let worst = 0;
  for (let k = 1; k < 40; k++) {
    const s = k / 40;
    octDecode(1 + 1e-2, s, naive);
    octDecode(1 - 1e-2, 1 - s, folded);
    worst = Math.max(worst, vec3.dist(naive, folded));
  }
  expect(worst).toBeGreaterThan(1e-2);
});

/*
 * All four corners are the same pole, so a path leaving through one re-enters at the opposite one.
 * Asserted as the rule states it — the gutter texel past a corner *is* the interior texel at the
 * opposite corner — because comparing the two outside points instead compares two different
 * places and reads as the rule being wrong when it is the assertion that is.
 */
test('a corner folds to the opposite corner, exactly', () => {
  const out = doubles2();
  for (const step of [1e-4, 1e-3, 1e-2]) {
    for (const [cu, cv] of [
      [1, 1],
      [1, 0],
      [0, 1],
      [0, 0],
    ]) {
      const u = cu === 1 ? 1 + step : -step;
      const v = cv === 1 ? 1 + step : -step;
      octWrapUv(u, v, out);
      expect(Math.abs(out[0] - (cu === 1 ? step : 1 - step)), `corner ${cu},${cv}`).toBeLessThan(
        1e-12,
      );
      expect(Math.abs(out[1] - (cv === 1 ? step : 1 - step)), `corner ${cu},${cv}`).toBeLessThan(
        1e-12,
      );
    }
  }
});

/*
 * The two ends of the inset are one relation and a level of the chain uses both: the convolution
 * asks what direction a texel holds, the lit pass asks where a direction lives. A disagreement
 * between them is every reflection in the scene rotated by half a texel, which reads as the probe
 * being subtly wrong and points at nothing.
 */
test('the inset maps a direction to a texel and back over every level of a chain', () => {
  const uv = vec2.create();
  const back = vec3.create();
  for (const edge of [256, 128, 64, 32, 16, 8]) {
    for (const d of directions()) {
      const n = vec3.normalize(vec3.create(), vec3.fromValues(d[0] ?? 0, d[1] ?? 0, d[2] ?? 0));
      octInsetUv(n[0], n[1], n[2], edge, uv);
      /* Inside the gutter, never on it: the inner region is where a direction may land. */
      expect(uv[0], `edge ${edge}`).toBeGreaterThanOrEqual(1 / edge - 1e-12);
      expect(uv[0], `edge ${edge}`).toBeLessThanOrEqual(1 - 1 / edge + 1e-12);
      octInsetDir(uv[0], uv[1], edge, back);
      expect(vec3.dist(back, n), `edge ${edge}, direction ${n[0]},${n[1]},${n[2]}`).toBeLessThan(
        1e-6,
      );
    }
  }
});
