/** Composing the world's distance field, on the device, because 707 ms is not a frame. */

/**
 * **This is the only version of `composeGlobalField` that can run in a frame.**
 *
 * The TypeScript in `gi/globalField.ts` is the reference and says so in its own header: it visits
 * every sample of every cascade for every instance it cannot cull outright, deliberately, because
 * a reference that was already accelerated would be a second thing to be wrong rather than the
 * thing the first is checked by. Measured by `scripts/gi-schemes.mjs`, that costs **707 ms a
 * frame** for 32 instances over four cascades of 65 cubed — 35 million inverse transforms and
 * trilinear reads, which is exactly the shape a GPU is for and exactly the shape a CPU is not.
 *
 * **One invocation a sample, and no culling at all.** The reference culls an instance further from
 * a cascade than that cascade's reach, and the measurement that justified it there — 19.4 ms
 * against 150.2 — is a statement about a serial loop. Here every sample is already parallel, so
 * what the cull would save is a branch per instance per thread and what it would cost is a
 * divergent one. It is left out, and `scripts/gi-parity.mjs` is what proves that changes no answer:
 * the cull cannot change a result, only the time taken to reach it, because a culled instance is
 * one whose contribution the minimum would have discarded.
 *
 * **The layouts are the reference's, restated rather than shared, and that is the hazard.** A
 * shader and a TypeScript function cannot import a struct from each other, so the eight-corner
 * blend below and `read()` in `globalField.ts` are two spellings of one decision. `gi-parity.mjs`
 * runs both over generated input and compares every sample, which is the arrangement
 * `gpu-parity.mjs` established for exactly this reason.
 */

/** Floats per instance in the `instances` buffer. See `INSTANCE_*` below for what they are. */
export const COMPOSE_INSTANCE_FLOATS = 32;

/** Where each field of an instance record starts, in floats. */
export const INSTANCE_INVERSE = 0;
export const INSTANCE_SCALE = 16;
export const INSTANCE_BOUNDS = 17;
export const INSTANCE_DIMS = 23;
export const INSTANCE_OFFSET = 26;
/** The instance's own colour, three floats. White where a consumer declared none. */
export const INSTANCE_ALBEDO = 28;

/**
 * Floats in the `params` buffer: cascade origin, step, dims, reach, instance count, output base.
 *
 * **Every cascade has its own copy, at its own 256-byte-aligned offset.** `queue.writeBuffer` is a
 * queue operation and is not ordered against the commands of an encoder, so rewriting one params
 * buffer between dispatches gives every dispatch the *last* write — three cascades composed with
 * the outermost one's origin and step, which looks like a field that is simply wrong everywhere.
 */
export const COMPOSE_PARAM_FLOATS = 12;

/** Where a cascade's samples start in the shared output, in floats. `params[9]`. */
export const COMPOSE_OUTPUT_BASE = 9;

/**
 * Bytes between one cascade's params and the next.
 *
 * A storage binding's offset must be a multiple of `minStorageBufferOffsetAlignment`, which is 256
 * on every device this targets — the same limit the GPU-driven pyramid's levels are padded to.
 */
export const COMPOSE_PARAM_STRIDE = 256;

/** Invocations a workgroup. 64 is this backend's default everywhere else. */
export const COMPOSE_WORKGROUP = 64;

export const COMPOSE_FIELD_WGSL = /* wgsl */ `
struct Params {
  originX: f32,
  originY: f32,
  originZ: f32,
  step: f32,
  countX: f32,
  countY: f32,
  countZ: f32,
  reach: f32,
  instances: f32,
  padA: f32,
  padB: f32,
  padC: f32,
};

@group(0) @binding(0) var<storage, read> params: array<f32>;
@group(0) @binding(1) var<storage, read> instances: array<f32>;
@group(0) @binding(2) var<storage, read> sources: array<f32>;
@group(0) @binding(3) var<storage, read_write> field: array<f32>;
/* The colour of whatever won the union at each sample, three floats. See GlobalFieldCascade. */
@group(0) @binding(4) var<storage, read_write> albedo: array<f32>;

/*
 * The eight-corner blend of one object's field, at a point already in that object's space.
 *
 * Clamped at the grid's edge, exactly as the reference is: a sample past the last plane takes that
 * plane rather than extrapolating, and the index stops one short so the pair it interpolates
 * between is always inside.
 */
fn sourceAt(base: u32, bounds0: vec3<f32>, bounds1: vec3<f32>, dims: vec3<f32>, p: vec3<f32>) -> f32 {
  /* One step for all three axes, because an object's voxels are cubic. bakeObjectSdf is why. */
  let step = (bounds1.x - bounds0.x) / (dims.x - 1.0);

  var low = vec3<f32>(0.0, 0.0, 0.0);
  var frac = vec3<f32>(0.0, 0.0, 0.0);
  for (var axis = 0u; axis < 3u; axis = axis + 1u) {
    let count = dims[axis];
    let local = (p[axis] - bounds0[axis]) / step;
    let clamped = clamp(local, 0.0, count - 1.0);
    let index = min(floor(clamped), count - 2.0);
    low[axis] = index;
    frac[axis] = clamped - index;
  }

  let nx = u32(dims.x);
  let ny = u32(dims.y);
  let lx = u32(low.x);
  let ly = u32(low.y);
  let lz = u32(low.z);

  var total = 0.0;
  for (var cz = 0u; cz < 2u; cz = cz + 1u) {
    let wz = select(1.0 - frac.z, frac.z, cz == 1u);
    for (var cy = 0u; cy < 2u; cy = cy + 1u) {
      let wy = select(1.0 - frac.y, frac.y, cy == 1u);
      for (var cx = 0u; cx < 2u; cx = cx + 1u) {
        let wx = select(1.0 - frac.x, frac.x, cx == 1u);
        let at = lx + cx + nx * (ly + cy + ny * (lz + cz));
        total = total + sources[base + at] * wx * wy * wz;
      }
    }
  }
  return total;
}

@compute @workgroup_size(${COMPOSE_WORKGROUP})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let countX = u32(params[4]);
  let countY = u32(params[5]);
  let countZ = u32(params[6]);
  let total = countX * countY * countZ;
  let index = id.x;
  if (index >= total) {
    return;
  }

  let ix = index % countX;
  let iy = (index / countX) % countY;
  let iz = index / (countX * countY);
  let step = params[3];
  let world = vec3<f32>(
    params[0] + f32(ix) * step,
    params[1] + f32(iy) * step,
    params[2] + f32(iz) * step,
  );

  /* The reach, which is both the initial value and a bound on what any instance can lower it to. */
  var best = params[7];
  /* White, so a sample no instance reached is neutral rather than a light that vanishes. */
  var bestAlbedo = vec3<f32>(1.0, 1.0, 1.0);
  let instanceCount = u32(params[8]);

  for (var i = 0u; i < instanceCount; i = i + 1u) {
    let base = i * ${COMPOSE_INSTANCE_FLOATS}u;

    /*
     * The world point carried into the object's space through the **inverse**. Column-major, the
     * order gl-matrix stores a matrix in, which is the order the reference reads it in too.
     */
    let object = vec3<f32>(
      instances[base + 0u] * world.x + instances[base + 4u] * world.y + instances[base + 8u] * world.z + instances[base + 12u],
      instances[base + 1u] * world.x + instances[base + 5u] * world.y + instances[base + 9u] * world.z + instances[base + 13u],
      instances[base + 2u] * world.x + instances[base + 6u] * world.y + instances[base + 10u] * world.z + instances[base + 14u],
    );

    let scale = instances[base + ${INSTANCE_SCALE}u];
    let bounds0 = vec3<f32>(
      instances[base + ${INSTANCE_BOUNDS}u],
      instances[base + ${INSTANCE_BOUNDS}u + 1u],
      instances[base + ${INSTANCE_BOUNDS}u + 2u],
    );
    let bounds1 = vec3<f32>(
      instances[base + ${INSTANCE_BOUNDS}u + 3u],
      instances[base + ${INSTANCE_BOUNDS}u + 4u],
      instances[base + ${INSTANCE_BOUNDS}u + 5u],
    );

    /*
     * **Outside the source's box, bounded two ways and the larger taken.** The distance to the box
     * alone is a true bound and a useless one: just outside it says zero, so a sphere trace stops
     * on a phantom shell around every instance. d(q) >= d(c) - |q - c| by the triangle
     * inequality, against the field's own value at the nearest point of the box, is the bound that
     * reports the real clearance. See sampleInstance in globalField.ts.
     */
    let clamped = clamp(object, bounds0, bounds1);
    let outside = length(object - clamped);

    var distance = 0.0;
    if (outside > 0.0) {
      let dims = vec3<f32>(
        instances[base + 23u],
        instances[base + 23u + 1u],
        instances[base + 23u + 2u],
      );
      let sourceBase = u32(instances[base + 26u]);
      let atBox = sourceAt(sourceBase, bounds0, bounds1, dims, clamped);
      distance = max(outside, atBox - outside) * scale;
    } else {
      let dims = vec3<f32>(
        instances[base + ${INSTANCE_DIMS}u],
        instances[base + ${INSTANCE_DIMS}u + 1u],
        instances[base + ${INSTANCE_DIMS}u + 2u],
      );
      let sourceBase = u32(instances[base + ${INSTANCE_OFFSET}u]);
      distance = sourceAt(sourceBase, bounds0, bounds1, dims, object) * scale;
    }

    /*
     * **The minimum, because the union of two solids is the nearer surface** — and the colour goes
     * with it rather than beside it. Writing the albedo unconditionally would paint every sample
     * with whichever instance happened to come last, which is a field of the right shape in the
     * wrong colours and looks like a lighting bug rather than a composition one.
     */
    if (distance < best) {
      best = distance;
      bestAlbedo = vec3<f32>(
        instances[base + ${INSTANCE_ALBEDO}u],
        instances[base + ${INSTANCE_ALBEDO}u + 1u],
        instances[base + ${INSTANCE_ALBEDO}u + 2u],
      );
    }
  }

  /*
   * **Into this cascade's own region of one shared buffer.** Without the base every cascade writes
   * the same samples and the last one wins, which reads as a field that has only its outermost
   * level — the innermost detail simply absent, at the resolution a viewer is closest to.
   */
  field[u32(params[9]) + index] = best;
  let colourAt = (u32(params[9]) + index) * 3u;
  albedo[colourAt] = bestAlbedo.x;
  albedo[colourAt + 1u] = bestAlbedo.y;
  albedo[colourAt + 2u] = bestAlbedo.z;
}
`;
