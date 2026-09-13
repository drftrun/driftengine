import {
  CLUSTER_COUNT,
  CLUSTER_TEXELS,
  CLUSTER_X,
  CLUSTER_Y,
  CLUSTER_Z,
  LIGHT_REGION_TEXELS,
  LIGHT_TEXELS,
  MAX_LIGHTS_PER_CLUSTER,
  TABLE_WIDTH,
} from '../../../clusteredLights.ts';

/**
 * The froxel binner, in WGSL, hand-authored.
 *
 * **`npm run wgsl` does not produce this file and `npm run wgsl:check` does not police it.** That
 * is an exception to the standing rule that GLSL is the source of truth, it is written down in
 * `AGENTS.md` under the 2026-08-12 rule, and the argument is in
 * the compute-seam design. In one line: the rule exists so
 * no shader is maintained twice and so a generator defect can only reach the backend that has a
 * fallback, and a compute shader has no twin and no fallback — generating it would invert the very
 * property the rule protects.
 *
 * **Every layout constant is interpolated from `clusteredLights.ts` rather than written here.**
 * Two files agreeing about a stride by both containing the number 8 is the shape of defect this
 * whole feature is gated against; there is one definition and this reads it.
 *
 * **It must produce the same bytes as `buildLightClusters`.** Where the two could have differed
 * they were made to agree deliberately: lights are visited in increasing index so a cluster's list
 * is sorted without sorting, unused slots are written as zero on both sides, and the overflow rule
 * is the same eviction of the farthest from the cluster centre followed by the same ascending
 * sort. `scripts/cluster-check.mjs` is what holds that, and the 2026-08-17 rule about two
 * implementations of one decision is why it exists at all.
 */
export const CLUSTER_BIN_WGSL = `
const CLUSTER_X: u32 = ${CLUSTER_X}u;
const CLUSTER_Y: u32 = ${CLUSTER_Y}u;
const CLUSTER_Z: u32 = ${CLUSTER_Z}u;
const CLUSTER_COUNT: u32 = ${CLUSTER_COUNT}u;
const CLUSTER_TEXELS: u32 = ${CLUSTER_TEXELS}u;
const MAX_LIGHTS_PER_CLUSTER: u32 = ${MAX_LIGHTS_PER_CLUSTER}u;
const LIGHT_TEXELS: u32 = ${LIGHT_TEXELS}u;
const LIGHT_REGION_TEXELS: u32 = ${LIGHT_REGION_TEXELS}u;
const TABLE_WIDTH: u32 = ${TABLE_WIDTH}u;

struct Params {
  view: mat4x4<f32>,
  /** near, far, tan(fovY/2), aspect. */
  frustum: vec4<f32>,
  lightCount: u32,
  pad0: u32,
  pad1: u32,
  pad2: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
/** Three vec4s a light, in exactly the record order \`buildLightClusters\` writes. */
@group(0) @binding(1) var<storage, read> lights: array<vec4<f32>>;
/**
 * Write-only, which is all core WGSL offers and all the fixed-slot layout needs.
 *
 * A read-modify-write list would need a storage buffer and an atomic counter, and it is the reason
 * a cluster owns a fixed run rather than appending into a shared one.
 */
@group(0) @binding(2) var table: texture_storage_2d<rgba32uint, write>;

/** A flat texel index to its place in the table. TABLE_WIDTH divides both regions exactly. */
fn texelAt(texel: u32) -> vec2<i32> {
  return vec2<i32>(i32(texel % TABLE_WIDTH), i32(texel / TABLE_WIDTH));
}

fn sliceNearDepth(slice: f32) -> f32 {
  return params.frustum.x * pow(params.frustum.y / params.frustum.x, slice / f32(CLUSTER_Z));
}

/** Squared distance from a point to an axis-aligned box, zero inside it. */
fn distanceSqToBounds(p: vec3<f32>, lo: vec3<f32>, hi: vec3<f32>) -> f32 {
  let d = max(max(lo - p, p - hi), vec3<f32>(0.0));
  return dot(d, d);
}

/** A light's view-space centre, with depth positive along the view direction. */
fn viewOf(light: u32) -> vec3<f32> {
  let world = lights[light * LIGHT_TEXELS];
  let v = params.view * vec4<f32>(world.xyz, 1.0);
  return vec3<f32>(v.x, v.y, -v.z);
}

/**
 * Squared distance from a light's view-space centre to a point.
 *
 * **Squared, matching \`centreDistanceSq\` in \`clusteredLights.ts\` rather than taking a root.** The
 * ranking is identical either way, and a square root is one more operation for the two
 * implementations to round differently.
 */
fn centreDistanceSq(light: u32, centre: vec3<f32>) -> f32 {
  let d = viewOf(light) - centre;
  return dot(d, d);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let id = gid.x;

  /*
   * The light records, written by the first invocations that have one.
   *
   * **Two jobs in one kernel, and it is deliberate.** The records have to reach the same texture
   * the clusters do, because the lit pass reads both through one texture unit; writing them from
   * the CPU instead would mean a partial texture upload racing a dispatch over the same resource.
   * There are always more clusters than lights, so every record has an invocation.
   */
  if (id < params.lightCount) {
    let record = id * LIGHT_TEXELS;
    for (var t: u32 = 0u; t < LIGHT_TEXELS; t = t + 1u) {
      textureStore(table, texelAt(record + t), bitcast<vec4<u32>>(lights[record + t]));
    }
  }

  if (id >= CLUSTER_COUNT) {
    return;
  }

  let k = id / (CLUSTER_X * CLUSTER_Y);
  let j = (id - k * CLUSTER_X * CLUSTER_Y) / CLUSTER_X;
  let i = id - k * CLUSTER_X * CLUSTER_Y - j * CLUSTER_X;

  /* The AABB of the froxel's eight corners, exactly as \`clusterViewBounds\` derives it. */
  let zNear = sliceNearDepth(f32(k));
  let zFar = sliceNearDepth(f32(k + 1u));
  let xLo = -1.0 + 2.0 * f32(i) / f32(CLUSTER_X);
  let xHi = -1.0 + 2.0 * f32(i + 1u) / f32(CLUSTER_X);
  let yLo = -1.0 + 2.0 * f32(j) / f32(CLUSTER_Y);
  let yHi = -1.0 + 2.0 * f32(j + 1u) / f32(CLUSTER_Y);
  let halfHNear = zNear * params.frustum.z;
  let halfHFar = zFar * params.frustum.z;
  let halfWNear = halfHNear * params.frustum.w;
  let halfWFar = halfHFar * params.frustum.w;

  let lo = vec3<f32>(
    min(min(xLo * halfWNear, xLo * halfWFar), min(xHi * halfWNear, xHi * halfWFar)),
    min(min(yLo * halfHNear, yLo * halfHFar), min(yHi * halfHNear, yHi * halfHFar)),
    zNear,
  );
  let hi = vec3<f32>(
    max(max(xLo * halfWNear, xLo * halfWFar), max(xHi * halfWNear, xHi * halfWFar)),
    max(max(yLo * halfHNear, yLo * halfHFar), max(yHi * halfHNear, yHi * halfHFar)),
    zFar,
  );
  let centre = (lo + hi) * 0.5;

  var indices: array<u32, MAX_LIGHTS_PER_CLUSTER>;
  for (var n: u32 = 0u; n < MAX_LIGHTS_PER_CLUSTER; n = n + 1u) {
    indices[n] = 0u;
  }
  var count: u32 = 0u;

  /* Increasing light index, which is what makes the list sorted without a sort. */
  for (var light: u32 = 0u; light < params.lightCount; light = light + 1u) {
    let radius = lights[light * LIGHT_TEXELS].w;
    let v = viewOf(light);
    if (v.z + radius <= 0.0) {
      continue;
    }
    if (distanceSqToBounds(v, lo, hi) > radius * radius) {
      continue;
    }

    if (count < MAX_LIGHTS_PER_CLUSTER) {
      indices[count] = light;
      count = count + 1u;
      continue;
    }

    /*
     * Full. Drop the farthest from the cluster's centre if this one is nearer.
     *
     * **The only float comparison that decides anything here**, and the reason the *order* is an
     * integer: a float rank cannot be relied on to agree between this and the JavaScript binner,
     * so it is confined to membership, where the conformance script forgives a light sitting
     * within epsilon of a boundary.
     */
    var worstSlot: i32 = -1;
    var worst = centreDistanceSq(light, centre);
    for (var n: u32 = 0u; n < MAX_LIGHTS_PER_CLUSTER; n = n + 1u) {
      let d = centreDistanceSq(indices[n], centre);
      if (d > worst) {
        worst = d;
        worstSlot = i32(n);
      }
    }
    if (worstSlot < 0) {
      continue;
    }
    indices[u32(worstSlot)] = light;

    /* Insertion sort over at most 28 integers, so the bytes stay ascending after a replacement. */
    for (var n: u32 = 1u; n < MAX_LIGHTS_PER_CLUSTER; n = n + 1u) {
      let value = indices[n];
      var m: i32 = i32(n) - 1;
      while (m >= 0 && indices[u32(m)] > value) {
        indices[u32(m) + 1u] = indices[u32(m)];
        m = m - 1;
      }
      indices[u32(m + 1)] = value;
    }
  }

  let base = LIGHT_REGION_TEXELS + id * CLUSTER_TEXELS;
  textureStore(table, texelAt(base), vec4<u32>(count, 0u, 0u, 0u));
  for (var t: u32 = 0u; t < CLUSTER_TEXELS - 1u; t = t + 1u) {
    textureStore(
      table,
      texelAt(base + 1u + t),
      vec4<u32>(indices[t * 4u], indices[t * 4u + 1u], indices[t * 4u + 2u], indices[t * 4u + 3u]),
    );
  }
}
`;
