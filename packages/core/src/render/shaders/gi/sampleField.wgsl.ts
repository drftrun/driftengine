/** Reading the composed field on the device, the way `sampleGlobalField` reads it on the CPU. */

import { GLOBAL_FIELD_BLEND } from '../../gi/globalField.ts';

/**
 * **One function, included by everything that reads the field, because two spellings drift.**
 *
 * `globalField.ts`'s `sampleGlobalField` is the reference: the finest cascade that holds a point
 * answers, faded into the one outside it across the outer tenth of its extent, and a point past
 * every cascade takes the outermost clamped at its edge. Every one of those three is a decision a
 * second implementation would get subtly differently, so this is text rather than a copy — the
 * march includes it, the parity entry point below includes it, and anything else that needs the
 * field includes it too.
 *
 * **`GLOBAL_FIELD_BLEND` is interpolated in rather than restated**, which is the 2026-08-13 rule
 * about one number in one place: a fade that is a tenth here and a twelfth there is a seam that
 * moves with the camera and nothing in either file looks wrong.
 */

/** Floats a cascade in the `cascades` buffer: six bounds, the step, and a pad to keep it aligned. */
export const CASCADE_FLOATS = 8;

/**
 * The sampler, as WGSL text to include.
 *
 * Expects `cascades: array<f32>` and `fields: array<f32>` in scope, and takes the cascade count and
 * the samples a side as arguments rather than reading them from a third buffer — a function that
 * reads a global it was not given is one that cannot be moved.
 */
export const SAMPLE_FIELD_WGSL = /* wgsl */ `
/* Trilinear read of one cascade, clamped at its own edge. The layout is x fastest, then y, then z. */
fn cascadeAt(level: u32, side: u32, p: vec3<f32>) -> f32 {
  let base = level * ${CASCADE_FLOATS}u;
  let low = vec3<f32>(cascades[base], cascades[base + 1u], cascades[base + 2u]);
  let step = cascades[base + 6u];
  let count = f32(side);

  var corner = vec3<f32>(0.0, 0.0, 0.0);
  var frac = vec3<f32>(0.0, 0.0, 0.0);
  for (var axis = 0u; axis < 3u; axis = axis + 1u) {
    let local = (p[axis] - low[axis]) / step;
    let clamped = clamp(local, 0.0, count - 1.0);
    /*
     * **The same line guards different things on the two sides, and only one of them shows.**
     * Stopping one plane short keeps the pair this interpolates between inside the cascade. Drop it
     * and the corner at count carries weight zero, so the *value* is identical here — WGSL clamps
     * an out-of-range storage read and zero times anything is zero — while the TypeScript reads
     * \`undefined\` out of a \`Float32Array\` past its end and \`undefined * 0\` is NaN. Perturbing it
     * fails \`globalField.test.ts\` and passes \`gi-parity.mjs\`. It stays because it is what keeps
     * the read inside this cascade rather than in the next one's samples, which share the buffer.
     */
    let index = min(floor(clamped), count - 2.0);
    corner[axis] = index;
    frac[axis] = clamped - index;
  }

  let offset = level * side * side * side;
  let lx = u32(corner.x);
  let ly = u32(corner.y);
  let lz = u32(corner.z);
  var total = 0.0;
  for (var cz = 0u; cz < 2u; cz = cz + 1u) {
    let wz = select(1.0 - frac.z, frac.z, cz == 1u);
    for (var cy = 0u; cy < 2u; cy = cy + 1u) {
      let wy = select(1.0 - frac.y, frac.y, cy == 1u);
      for (var cx = 0u; cx < 2u; cx = cx + 1u) {
        let wx = select(1.0 - frac.x, frac.x, cx == 1u);
        let at = lx + cx + side * (ly + cy + side * (lz + cz));
        total = total + fields[offset + at] * wx * wy * wz;
      }
    }
  }
  return total;
}

/* How far inside a cascade a point is, measured to the nearest face. Negative means outside. */
fn insideBy(level: u32, p: vec3<f32>) -> f32 {
  let base = level * ${CASCADE_FLOATS}u;
  let low = vec3<f32>(cascades[base], cascades[base + 1u], cascades[base + 2u]);
  let high = vec3<f32>(cascades[base + 3u], cascades[base + 4u], cascades[base + 5u]);
  let gap = min(p - low, high - p);
  return min(gap.x, min(gap.y, gap.z));
}

/*
 * The field at a world point, from the finest cascade that holds it.
 *
 * Faded into the cascade outside across the outer tenth of the extent, because every boundary here
 * moves with the camera — the cascades are centred on it — and a hard switch at a boundary that
 * moves is a seam sweeping through the picture whenever the camera turns.
 */
fn sampleField(levels: u32, side: u32, p: vec3<f32>) -> f32 {
  let last = levels - 1u;
  for (var level = 0u; level <= last; level = level + 1u) {
    let inside = insideBy(level, p);
    if (inside <= 0.0) {
      continue;
    }
    let value = cascadeAt(level, side, p);
    if (level == last) {
      return value;
    }
    let base = level * ${CASCADE_FLOATS}u;
    let band = ${GLOBAL_FIELD_BLEND.toFixed(6)} * (cascades[base + 3u] - cascades[base]);
    if (inside >= band) {
      return value;
    }
    let outer = cascadeAt(level + 1u, side, p);
    return mix(outer, value, inside / band);
  }
  return cascadeAt(last, side, p);
}
`;

/** Floats in the sampler parity entry point's params: cascade count, samples a side, point count. */
export const SAMPLE_PARAM_FLOATS = 4;

/**
 * A compute entry point that does nothing but sample, so `gi-parity.mjs` can compare the function
 * above against `sampleGlobalField` directly rather than through whatever is using it.
 */
export const SAMPLE_FIELD_PARITY_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read> params: array<f32>;
@group(0) @binding(1) var<storage, read> cascades: array<f32>;
@group(0) @binding(2) var<storage, read> fields: array<f32>;
@group(0) @binding(3) var<storage, read> points: array<f32>;
@group(0) @binding(4) var<storage, read_write> out: array<f32>;

${SAMPLE_FIELD_WGSL}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let count = u32(params[2]);
  if (id.x >= count) {
    return;
  }
  let p = vec3<f32>(points[id.x * 3u], points[id.x * 3u + 1u], points[id.x * 3u + 2u]);
  out[id.x] = sampleField(u32(params[0]), u32(params[1]), p);
}
`;
