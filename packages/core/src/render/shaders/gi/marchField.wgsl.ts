/** The composed field, drawn — so a pass that fills one can be looked at rather than trusted. */

import { SAMPLE_FIELD_WGSL } from './sampleField.wgsl.ts';

/**
 * **A visualisation, and it is the honest first consumer of the field.**
 *
 * What Wave 4A's chain is eventually for is indirect light in the shading path, and that is a far
 * larger integration than a pass. What a pass can do now is prove the composition runs on a device
 * and say what it costs — and a distance field is a thing you can *see*, by sphere-tracing it from
 * the camera. If the geometry in the picture is the geometry in the scene, in the right places and
 * the right sizes, the composition is right; if a cascade boundary shows as a seam, the fade is
 * wrong. Neither is available from a number.
 *
 * That is what `DRAFT_SCENES` is for, and it is the same shape the GPU-driven pipeline's three rigs
 * took: a second path drawn beside the first, measured, and kept out of the published set until
 * what it draws is the whole material.
 *
 * **The march is `traceField.ts`'s, minus the cone.** Step by the field's own value, which is a
 * distance nothing can be nearer than; stop where it falls under an epsilon; give up where the ray
 * leaves the outermost cascade, because past that there is no information and stepping on a clamped
 * value converges on the boundary and reports a surface made of nothing.
 */

/** Floats in the march's params: the inverse view-projection, the eye, and four scalars. */
export const MARCH_PARAM_FLOATS = 24;

/** Where each field starts. `INV_VIEW_PROJ` is column-major, as `gl-matrix` stores it. */
export const MARCH_INV_VIEW_PROJ = 0;
export const MARCH_EYE = 16;
export const MARCH_LEVELS = 20;
export const MARCH_SIDE = 21;
export const MARCH_STEPS = 22;
export const MARCH_EPSILON = 23;

export const MARCH_FIELD_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read> params: array<f32>;
@group(0) @binding(1) var<storage, read> cascades: array<f32>;
@group(0) @binding(2) var<storage, read> fields: array<f32>;

${SAMPLE_FIELD_WGSL}

struct Varying {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

/*
 * One triangle covering the frame, which is one fewer than two and has no diagonal for a
 * derivative to straddle. Clip y of +1 is the top of the image on both backends — see
 * CLIP_CORRECTION's own note, which spent months saying otherwise — so uv.y counts down from it.
 */
@vertex
fn vertexMain(@builtin(vertex_index) index: u32) -> Varying {
  var out: Varying;
  let x = f32(i32(index) / 2) * 4.0 - 1.0;
  let y = f32(i32(index) & 1) * 4.0 - 1.0;
  out.position = vec4<f32>(x, y, 0.0, 1.0);
  out.uv = vec2<f32>(x * 0.5 + 0.5, 0.5 - y * 0.5);
  return out;
}

fn unproject(ndc: vec2<f32>) -> vec3<f32> {
  let m = ${MARCH_INV_VIEW_PROJ}u;
  let clip = vec4<f32>(ndc.x, ndc.y, 0.5, 1.0);
  /*
   * Column-major, so column c is params[c * 4 .. c * 4 + 3]. Any depth gives the same ray from the
   * eye, which is why the z above is a half rather than a near or a far plane — this is the one
   * place the depth convention does not have to be known.
   */
  var world = vec4<f32>(0.0, 0.0, 0.0, 0.0);
  for (var row = 0u; row < 4u; row = row + 1u) {
    world[row] =
      params[m + row] * clip.x +
      params[m + 4u + row] * clip.y +
      params[m + 8u + row] * clip.z +
      params[m + 12u + row] * clip.w;
  }
  return world.xyz / world.w;
}

/** The field's gradient, which for a distance field is the surface normal. */
fn normalAt(levels: u32, side: u32, p: vec3<f32>, h: f32) -> vec3<f32> {
  let dx = sampleField(levels, side, p + vec3<f32>(h, 0.0, 0.0)) - sampleField(levels, side, p - vec3<f32>(h, 0.0, 0.0));
  let dy = sampleField(levels, side, p + vec3<f32>(0.0, h, 0.0)) - sampleField(levels, side, p - vec3<f32>(0.0, h, 0.0));
  let dz = sampleField(levels, side, p + vec3<f32>(0.0, 0.0, h)) - sampleField(levels, side, p - vec3<f32>(0.0, 0.0, h));
  let g = vec3<f32>(dx, dy, dz);
  let length2 = dot(g, g);
  return select(vec3<f32>(0.0, 1.0, 0.0), g * inverseSqrt(length2), length2 > 1e-12);
}

/** Whether a point is still inside the outermost cascade, which is all the field knows about. */
fn withinField(levels: u32, p: vec3<f32>) -> bool {
  let base = (levels - 1u) * 8u;
  let low = vec3<f32>(cascades[base], cascades[base + 1u], cascades[base + 2u]);
  let high = vec3<f32>(cascades[base + 3u], cascades[base + 4u], cascades[base + 5u]);
  return all(p >= low) && all(p <= high);
}

@fragment
fn fragmentMain(vary: Varying) -> @location(0) vec4<f32> {
  let levels = u32(params[${MARCH_LEVELS}]);
  let side = u32(params[${MARCH_SIDE}]);
  let steps = u32(params[${MARCH_STEPS}]);
  let epsilon = params[${MARCH_EPSILON}];
  let eye = vec3<f32>(
    params[${MARCH_EYE}],
    params[${MARCH_EYE} + 1u],
    params[${MARCH_EYE} + 2u],
  );

  let ndc = vec2<f32>(vary.uv.x * 2.0 - 1.0, 1.0 - vary.uv.y * 2.0);
  let direction = normalize(unproject(ndc) - eye);

  /* The finest cascade's step, which is the smallest move worth making. */
  let floorStep = cascades[6] * 0.25;
  var travelled = 0.0;
  var hit = false;
  var at = eye;
  for (var i = 0u; i < steps; i = i + 1u) {
    at = eye + direction * travelled;
    if (!withinField(levels, at)) {
      break;
    }
    let distance = sampleField(levels, side, at);
    if (distance <= epsilon) {
      hit = true;
      break;
    }
    travelled = travelled + max(distance, floorStep);
  }

  if (!hit) {
    /* Nothing here, so the frame keeps whatever drew before this. */
    discard;
  }

  let normal = normalAt(levels, side, at, cascades[6] * 0.5);
  let sun = normalize(vec3<f32>(0.4, 0.8, 0.45));
  let lambert = max(dot(normal, sun), 0.0);
  /* A hemispheric fill under it, so a face turned away is readable rather than black. */
  let ambient = 0.18 + 0.12 * (normal.y * 0.5 + 0.5);
  let shade = vec3<f32>(0.62, 0.66, 0.72) * (lambert * 0.85 + ambient);
  return vec4<f32>(shade, 1.0);
}
`;
