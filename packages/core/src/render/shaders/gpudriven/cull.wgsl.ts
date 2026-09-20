import { MATERIAL_SLOTS, MATERIAL_TABLE_WGSL } from './materialTable.wgsl.ts';

/**
 * The device half of the GPU-driven pipeline's arithmetic.
 *
 * **Hand-written WGSL, which is the exception this directory exists to record.** Every other
 * shader in this engine is authored in GLSL and generated to WGSL by `scripts/wgsl.ts`, and that
 * direction is the safety property of the WebGPU backend: a defect in the generator can only reach
 * WebGPU, never the path that runs everywhere. These have no GLSL original because WebGL2 has no
 * compute stage at all — `indirectSupport(backend)` is false there, which §3 row 2 already records
 * — so there is nothing to generate them from and nothing they could break by being wrong.
 *
 * **What keeps them honest is `scripts/gpu-parity.mjs`.** The same arithmetic lives in
 * `render/gpudriven/*.ts` as the reference, and that script runs both over generated input on a
 * real device and requires them to agree. One authored expression, two consumers, one test that
 * they have not drifted — the discipline `splats` established for shaders that *can* be generated,
 * applied where they cannot.
 *
 * Every entry point takes its inputs as storage buffers and writes one result per invocation, so a
 * harness can bind them without knowing what any of them mean.
 */

/**
 * Plane extraction and the sphere test, one flag a mesh. Mirrors `gpudriven/frustum.ts`, and
 * `gpudriven/instances.ts` says what the frame does with the flag: the cut reads it.
 */
/**
 * Floats in the cluster cull's settings: the eye, the pyramid switch, its shape, the count, and
 * the cone switch. One number the pass allocates, writes and the shader declares.
 */
export const CULL_SETTINGS_FLOATS = 9;
/** Where in those settings the cone switch sits. One for the visibility raster, zero for blending. */
export const CULL_CONES = 8;

export const CULL_INSTANCES_WGSL = `
@group(0) @binding(0) var<storage, read> viewProj: array<f32, 16>;
@group(0) @binding(1) var<storage, read> spheres: array<f32>;
@group(0) @binding(2) var<storage, read_write> culled: array<u32>;

fn setPlane(a: f32, b: f32, c: f32, d: f32) -> vec4<f32> {
  let length = sqrt(a * a + b * b + c * c);
  let k = select(0.0, 1.0 / length, length > 0.0);
  return vec4<f32>(a * k, b * k, c * k, d * k);
}

fn planeAt(index: u32) -> vec4<f32> {
  let m = &viewProj;
  let r0 = vec4<f32>((*m)[0], (*m)[4], (*m)[8], (*m)[12]);
  let r1 = vec4<f32>((*m)[1], (*m)[5], (*m)[9], (*m)[13]);
  let r2 = vec4<f32>((*m)[2], (*m)[6], (*m)[10], (*m)[14]);
  let r3 = vec4<f32>((*m)[3], (*m)[7], (*m)[11], (*m)[15]);
  switch index {
    case 0u: { return setPlane(r3.x + r0.x, r3.y + r0.y, r3.z + r0.z, r3.w + r0.w); }
    case 1u: { return setPlane(r3.x - r0.x, r3.y - r0.y, r3.z - r0.z, r3.w - r0.w); }
    case 2u: { return setPlane(r3.x + r1.x, r3.y + r1.y, r3.z + r1.z, r3.w + r1.w); }
    case 3u: { return setPlane(r3.x - r1.x, r3.y - r1.y, r3.z - r1.z, r3.w - r1.w); }
    /* The two depth planes, in clip terms rather than near/far terms: reversed-Z swaps which
       physical plane each one is, and a sphere satisfying both is inside either way. */
    case 4u: { return setPlane(r2.x, r2.y, r2.z, r2.w); }
    default: { return setPlane(r3.x - r2.x, r3.y - r2.y, r3.z - r2.z, r3.w - r2.w); }
  }
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i * 4u + 3u >= arrayLength(&spheres)) { return; }
  let centre = vec3<f32>(spheres[i * 4u], spheres[i * 4u + 1u], spheres[i * 4u + 2u]);
  let radius = spheres[i * 4u + 3u];

  var outside = 0u;
  for (var p = 0u; p < 6u; p = p + 1u) {
    let plane = planeAt(p);
    let distance = dot(plane.xyz, centre) + plane.w;
    /* Conservative in one direction only: a sphere straddling a plane survives, because culling
       something visible is a hole in the picture and keeping something invisible is a wasted draw. */
    if (distance < -radius) { outside = 1u; }
  }
  culled[i] = outside;
}
`;

/**
 * The level-of-detail cut, with the meshes the instance cull hid left out. Mirrors
 * `selectClusters` in `gpudriven/instances.ts`, over `gpudriven/lodCut.ts`'s rule.
 *
 * **The mesh is read from the cluster's four meta words** rather than from a buffer of its own:
 * the frame already uploads them for the raster, and a binding is a thing a stage has eight of.
 *
 * **It runs twice where a scene has a blended material**, once for each half of the frame, and
 * `params[6]` is which half is being asked for. A visibility buffer holds one surface a pixel, so
 * a blended cluster cannot go through it at all; what the two runs share is this question — which
 * clusters, at which level of detail — which is the same question for a pane of glass as for a
 * wall and is the whole reason the front half of the pipeline is reusable. A scene with nothing
 * blended runs this once and the filter costs it one comparison against a uniform.
 */
export const LOD_CUT_WGSL = /* wgsl */ `
struct Params {
  screenHeight: f32,
  fovY: f32,
  thresholdPixels: f32,
  eyeX: f32,
  eyeY: f32,
  eyeZ: f32,
  /** Non-zero to select the blended clusters, zero to select everything else. */
  wantBlend: f32,
};
${MATERIAL_TABLE_WGSL}
@group(0) @binding(0) var<storage, read> params: array<f32, 7>;
/** Six floats a cluster: centre, radius, own error, parent error. */
@group(0) @binding(1) var<storage, read> clusters: array<f32>;
@group(0) @binding(2) var<storage, read_write> selected: array<u32>;
/** Four words a cluster: index offset, index count, identifier, mesh. */
@group(0) @binding(3) var<storage, read> clusterMeta: array<u32>;
/** One word a mesh, nonzero where CULL_INSTANCES_WGSL found it wholly outside the view. */
@group(0) @binding(4) var<storage, read> instanceHidden: array<u32>;
/** One material a cluster, and the table it indexes. Both only to read one flag. */
@group(0) @binding(5) var<storage, read> materialOf: array<u32>;
@group(0) @binding(6) var<uniform> materials: array<Material, ${MATERIAL_SLOTS}>;

fn projectedError(error: f32, distance: f32, radius: f32, screenHeight: f32, fovY: f32) -> f32 {
  let safe = max(max(distance, radius), 1e-4);
  let scale = screenHeight / (2.0 * tan(fovY * 0.5));
  return (error * scale) / safe;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i * 6u + 5u >= arrayLength(&clusters)) { return; }
  /* A hidden mesh contributes nothing, so none of its clusters is in the cut at any level. */
  if (instanceHidden[clusterMeta[i * 4u + 3u]] != 0u) {
    selected[i] = 0u;
    return;
  }
  /*
   * **Which half of the frame this cluster belongs to, asked once.** The two halves are exclusive:
   * a blended cluster is not in the opaque cut and an opaque one is not in the blended cut, so
   * neither is drawn twice and neither is dropped. The flag is read through a uniform by an index
   * that is the same for every cluster of a mesh, so the branch is as coherent as this shader gets.
   */
  let blended = materials[min(materialOf[i], ${MATERIAL_SLOTS - 1}u)].orm.w != 0.0;
  if (blended != (params[6] != 0.0)) {
    selected[i] = 0u;
    return;
  }
  let screenHeight = params[0];
  let fovY = params[1];
  let threshold = params[2];
  let eye = vec3<f32>(params[3], params[4], params[5]);

  let centre = vec3<f32>(clusters[i * 6u], clusters[i * 6u + 1u], clusters[i * 6u + 2u]);
  let radius = clusters[i * 6u + 3u];
  let ownError = clusters[i * 6u + 4u];
  let parentError = clusters[i * 6u + 5u];
  let distance = length(centre - eye);

  let own = projectedError(ownError, distance, radius, screenHeight, fovY);
  let parent = projectedError(parentError, distance, radius, screenHeight, fovY);
  /* Both halves: the first alone draws every ancestor too, the second alone draws nothing. */
  selected[i] = select(0u, 1u, own <= threshold && parent > threshold);
}
`;

/**
 * The pyramid's base level, copied out of the depth attachment a phase drew into.
 *
 * **A copy and nothing else, which is the point.** `HZB_REDUCE_WGSL` below does every reduction,
 * and it is checked against `hzb.ts` texel by texel; putting a first reduction here would be a
 * second place for the fold to be wrong and the one place nothing compares. What this does have
 * is an index, and an index that is wrong draws a pyramid of somebody else's depth — which is
 * unmistakable rather than subtle, because the occlusion then culls the picture.
 *
 * **A depth attachment cannot be read as a buffer and the reduction reads a buffer**, which is
 * the whole reason this dispatch exists. `texture_depth_2d` binds the attachment the render pass
 * wrote, in a later pass, and `textureLoad` needs no sampler.
 */
export const HZB_SEED_WGSL = `
/** width, height. The base level starts at zero, which is what makes it the base level. */
@group(0) @binding(0) var<storage, read> size: array<u32, 2>;
@group(0) @binding(1) var depth: texture_depth_2d;
@group(0) @binding(2) var<storage, read_write> pyramid: array<f32>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let width = size[0];
  if (id.x >= width || id.y >= size[1]) { return; }
  pyramid[id.y * width + id.x] = textureLoad(depth, vec2<i32>(i32(id.x), i32(id.y)), 0);
}
`;

/**
 * A light's pyramid's base, from its shadow map: half the map, the furthest of each group, turned
 * over into the camera's convention. Mirrors `shadowPyramidBase` in `gpudriven/hzb.ts`, which says
 * why it is turned over and why it is half.
 *
 * **Not a copy, as the camera's seed is**, and so not unchecked the way that one can be: the map
 * is conventional depth and the fold is the camera's reduction's, and getting either backwards
 * keeps the nearest texel of a group — a caster hidden behind nothing, a shadow with a hole in it.
 * So the arithmetic is one body and where the depth comes from is a prelude: the pass reads the
 * map through `texture_depth_2d`, and `gpu-parity.mjs` runs the same body over an `r32float`
 * texture, because a depth texture cannot be written by a copy and a harness can write that one.
 */
const SHADOW_HZB_SEED_BODY = `
/** The map's width and height. The base is half of each, as hzbMipSize says, and starts at zero. */
@group(0) @binding(0) var<storage, read> size: array<u32, 2>;
@group(0) @binding(2) var<storage, read_write> pyramid: array<f32>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let width = size[0];
  let height = size[1];
  let outWidth = max(1u, width / 2u);
  let outHeight = max(1u, height / 2u);
  if (id.x >= outWidth || id.y >= outHeight) { return; }

  let x0 = id.x * 2u;
  let y0 = id.y * 2u;
  /* An odd map's extra row and column fold into the last group, as in HZB_REDUCE_WGSL. */
  let lastX = select(min(width - 1u, x0 + 1u), width - 1u, id.x == outWidth - 1u);
  let lastY = select(min(height - 1u, y0 + 1u), height - 1u, id.y == outHeight - 1u);

  var deepest = -3.402823466e+38;
  for (var sy = y0; sy <= lastY; sy = sy + 1u) {
    for (var sx = x0; sx <= lastX; sx = sx + 1u) {
      deepest = max(deepest, mapDepth(sx, sy));
    }
  }
  /* Turned over: the furthest of the group is now the smallest value, as the camera's is. */
  pyramid[id.y * outWidth + id.x] = 1.0 - deepest;
}
`;

/** The light's pyramid's base, read from the shadow map itself. */
export const SHADOW_HZB_SEED_WGSL = `
@group(0) @binding(1) var depth: texture_depth_2d;

fn mapDepth(x: u32, y: u32) -> f32 {
  return textureLoad(depth, vec2<i32>(i32(x), i32(y)), 0);
}
${SHADOW_HZB_SEED_BODY}`;

/** The same body over an `r32float` texture, for `gpu-parity.mjs`. */
export const SHADOW_HZB_SEED_FLOAT_WGSL = `
@group(0) @binding(1) var depth: texture_2d<f32>;

fn mapDepth(x: u32, y: u32) -> f32 {
  return textureLoad(depth, vec2<i32>(i32(x), i32(y)), 0).r;
}
${SHADOW_HZB_SEED_BODY}`;

/** One reduction level of the hierarchical depth buffer. Mirrors `gpudriven/hzb.ts`. */
export const HZB_REDUCE_WGSL = `
/**
 * srcWidth, srcHeight, where this level's source starts and where its output starts.
 *
 * **One binding for both halves, and it is a rule about scopes rather than a saving.** A buffer
 * bound once as read-only and once as writable inside one compute pass is refused outright —
 * "includes writable usage and another usage in the same synchronization scope" — and the whole
 * pyramid lives in one buffer because CULL_CLUSTERS_WGSL reads every level through one binding and
 * a levelStart table. So the reduction addresses both ends of its own copy itself. No backticks in
 * here: one would close the template literal this shader is written in.
 */
@group(0) @binding(0) var<storage, read> size: array<u32, 4>;
@group(0) @binding(1) var<storage, read_write> pyramid: array<f32>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let width = size[0];
  let height = size[1];
  let srcStart = size[2];
  let dstStart = size[3];
  let outWidth = max(1u, width / 2u);
  let outHeight = max(1u, height / 2u);
  if (id.x >= outWidth || id.y >= outHeight) { return; }

  let x0 = id.x * 2u;
  let y0 = id.y * 2u;
  let x1 = min(width - 1u, x0 + 1u);
  let y1 = min(height - 1u, y0 + 1u);
  /* An odd level's extra row and column fold into the last group rather than being dropped. */
  let lastX = select(x1, width - 1u, id.x == outWidth - 1u);
  let lastY = select(y1, height - 1u, id.y == outHeight - 1u);

  var furthest = 3.402823466e+38;
  for (var sy = y0; sy <= lastY; sy = sy + 1u) {
    for (var sx = x0; sx <= lastX; sx = sx + 1u) {
      /* Minimum, because reversed-Z puts the far plane at zero. Section 3 row 1. */
      furthest = min(furthest, pyramid[srcStart + sy * width + sx]);
    }
  }
  pyramid[dstStart + id.y * outWidth + id.x] = furthest;
}
`;

/**
 * The three cluster tests and the flag each writes. Mirrors `gpudriven/cullClusters.ts`.
 *
 * **One flag per invocation and no compaction here.** A dispatch can decide every cluster in
 * parallel and cannot append them in input order without a prefix sum, so the ordered list is the
 * host's — see the module's header. That also makes this checkable: a flag is order-free, so
 * `gpu-parity.mjs` can compare it element by element without reproducing an atomic's arrival
 * order, which is a thing no reference can do.
 *
 * `settings` carries the eye and the pyramid's shape rather than a second uniform block: three
 * floats and four counts is smaller than the alignment rules for a struct would make it, and
 * everything the harness binds is a plain array.
 *
 * **And whether to test cones at all**, in its ninth float. The visibility raster culls back faces,
 * so a cluster whose every face points away draws nothing there and the cone test only saves the
 * work. The blended raster draws both sides, so for its run the same answer would take the far face
 * of every pane away — which the materials rig showed the day cones started working.
 *
 * **A cluster the cut did not select is not tested.** The compaction would drop it anyway; testing
 * it was six planes, a cone and, in phase two, a walk of the pyramid for nothing — and it is how the
 * instance cull reaches the clusters of a hidden mesh. That is the eighth binding, and the last a
 * stage has by default.
 */
export const CULL_CLUSTERS_WGSL = `
@group(0) @binding(0) var<storage, read> planes: array<f32, 24>;
@group(0) @binding(1) var<storage, read> viewProj: array<f32, 16>;
/** eye.xyz, hasHzb, width, height, levelCount, clusterCount, testCones. */
@group(0) @binding(2) var<storage, read> settings: array<f32, ${CULL_SETTINGS_FLOATS}>;
@group(0) @binding(3) var<storage, read> clusters: array<f32>;
@group(0) @binding(4) var<storage, read> hzb: array<f32>;
@group(0) @binding(5) var<storage, read> levelStart: array<u32>;
@group(0) @binding(6) var<storage, read_write> keep: array<u32>;
/** The cut's flag a cluster, from LOD_CUT_WGSL. */
@group(0) @binding(7) var<storage, read> selected: array<u32>;

fn outsideFrustum(cx: f32, cy: f32, cz: f32, radius: f32) -> bool {
  for (var p = 0u; p < 6u; p = p + 1u) {
    let at = p * 4u;
    let distance = planes[at] * cx + planes[at + 1u] * cy + planes[at + 2u] * cz + planes[at + 3u];
    if (distance < -radius) { return true; }
  }
  return false;
}

/* See coneBackfacing in cullClusters.ts: the cutoff is sin(a) and the radius term is the
   sphere's own angular size. */
fn coneBackfacing(axis: vec3<f32>, cutoff: f32, centre: vec3<f32>, radius: f32, eye: vec3<f32>) -> bool {
  let d = centre - eye;
  return dot(d, axis) >= cutoff * length(d) + radius;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let count = u32(settings[7]);
  if (id.x >= count) { return; }
  if (selected[id.x] == 0u) {
    keep[id.x] = 0u;
    return;
  }
  let at = id.x * 8u;
  let centre = vec3<f32>(clusters[at], clusters[at + 1u], clusters[at + 2u]);
  let radius = clusters[at + 3u];
  let axis = vec3<f32>(clusters[at + 4u], clusters[at + 5u], clusters[at + 6u]);
  let cutoff = clusters[at + 7u];
  let eye = vec3<f32>(settings[0], settings[1], settings[2]);

  var survives = !outsideFrustum(centre.x, centre.y, centre.z, radius);
  if (survives && settings[${CULL_CONES}] > 0.5) {
    survives = !coneBackfacing(axis, cutoff, centre, radius, eye);
  }

  if (survives && settings[3] > 0.5) {
    /* The eight corners of the sphere's box, which is larger than the sphere and therefore
       conservative. A corner at or behind the eye means there is no rectangle at all. */
    var minX = 3.402823466e+38;
    var minY = 3.402823466e+38;
    var maxX = -3.402823466e+38;
    var maxY = -3.402823466e+38;
    var nearest = -3.402823466e+38;
    var bounded = true;
    for (var corner = 0u; corner < 8u; corner = corner + 1u) {
      let p = vec3<f32>(
        centre.x + select(-radius, radius, (corner & 1u) != 0u),
        centre.y + select(-radius, radius, (corner & 2u) != 0u),
        centre.z + select(-radius, radius, (corner & 4u) != 0u),
      );
      let cw = viewProj[3] * p.x + viewProj[7] * p.y + viewProj[11] * p.z + viewProj[15];
      if (cw <= 1e-6) { bounded = false; }
      let cx = viewProj[0] * p.x + viewProj[4] * p.y + viewProj[8] * p.z + viewProj[12];
      let cy = viewProj[1] * p.x + viewProj[5] * p.y + viewProj[9] * p.z + viewProj[13];
      let cz = viewProj[2] * p.x + viewProj[6] * p.y + viewProj[10] * p.z + viewProj[14];
      let inv = 1.0 / cw;
      let u = cx * inv * 0.5 + 0.5;
      let v = cy * inv * 0.5 + 0.5;
      minX = min(minX, u);
      maxX = max(maxX, u);
      minY = min(minY, v);
      maxY = max(maxY, v);
      /* Nearest is the largest clip depth: reversed-Z puts the near plane at one. */
      nearest = max(nearest, cz * inv);
    }

    if (bounded) {
      let width = u32(settings[4]);
      let height = u32(settings[5]);
      let levels = u32(settings[6]);
      let longest = max(max((maxX - minX) * f32(width), (maxY - minY) * f32(height)), 1.0);
      let wanted = max(0.0, ceil(log2(longest)) - 1.0);
      let top = floor(log2(max(1.0, f32(max(width, height)))));
      let level = u32(min(wanted, top));
      if (level < levels) {
        let levelWidth = max(1u, width >> level);
        let levelHeight = max(1u, height >> level);
        let base = levelStart[level];
        let x0 = u32(clamp(floor(minX * f32(levelWidth)), 0.0, f32(levelWidth - 1u)));
        let x1 = u32(clamp(floor(maxX * f32(levelWidth)), 0.0, f32(levelWidth - 1u)));
        /*
         * The rows run the other way: the rectangle is in clip-up coordinates and the pyramid is
         * seeded from the depth texture, whose row 0 is where clip y is +1. See clusterOccluded
         * in cullClusters.ts, which carries what this cost before it was flipped.
         */
        let y0 = u32(clamp(floor((1.0 - maxY) * f32(levelHeight)), 0.0, f32(levelHeight - 1u)));
        let y1 = u32(clamp(floor((1.0 - minY) * f32(levelHeight)), 0.0, f32(levelHeight - 1u)));
        var furthest = 3.402823466e+38;
        for (var y = y0; y <= y1; y = y + 1u) {
          for (var x = x0; x <= x1; x = x + 1u) {
            /* The weakest of the group decides, so a gap in the occluder keeps the cluster. */
            furthest = min(furthest, hzb[base + y * levelWidth + x]);
          }
        }
        if (nearest < furthest) { survives = false; }
      }
    }
  }

  keep[id.x] = select(0u, 1u, survives);
}
`;
