/**
 * A cloud of Gaussians drawn and differentiated on the device, one workgroup per tile.
 *
 * **Hand-authored WGSL, which the 2026-08-12 rule makes the exception for a compute shader**: there
 * is no second copy to keep in step, because a compute shader has no WebGL2 twin, and the safety
 * property inverts — this *is* the bottom of its own stack. What stands in for the generator's
 * check is `scripts/gpu-parity.mjs`, which runs every one of these against
 * `@driftengine/capture`'s reference rasteriser on the same cloud.
 *
 * **Why a tile and not a splat.** Splats overlap and compositing is ordered, so one invocation per
 * splat has no way for two of them writing one pixel to agree who was in front. Turned inside out —
 * one workgroup per tile of the frame, one invocation per pixel, each walking the list of splats
 * that touch its tile — every pixel accumulates alone in its own registers and nothing is contended.
 *
 * **The backward pass reduces rather than adds atomically, and that is a determinism decision.**
 * Many pixels contribute to one splat's gradient. WGSL has no floating-point atomic, and the usual
 * workaround — a compare-and-swap loop over the bits — sums in whatever order the lanes happen to
 * arrive; floating-point addition is not associative, so the same cloud would give a different
 * gradient every run. Instead the workgroup steps through its list together, and for each splat the
 * 256 lanes are reduced in a fixed tree into one slot of its own, which `splatTiles.ts`'s `pairOf`
 * allocates. A second pass sums each splat's contiguous run. Same answer, every run, every device.
 *
 * **The frame is written premultiplied, as the reference writes it**: three channels of colour
 * already multiplied by the light that reached them, and the coverage beside it.
 */

/**
 * Numbers a splat occupies on the device: centre, screen covariance, opacity, colour, reach.
 *
 * **The reach is in the record because a tile is not a splat's footprint.** A workgroup walks every
 * pixel of its tile, and a splat that touches the tile at one corner reaches only part of it — so
 * without the same box the reference loops over, the device draws the splat at pixels the reference
 * never evaluates. Measured before it was there: 6.7 · 10⁻³ of a channel on the worst pixel, which
 * is not a rounding difference but a different picture. Just outside three standard deviations a
 * Gaussian is still worth about a hundredth of its opacity, far above the faint cutoff.
 */
export const SPLAT_RASTER_FLOATS = 10;

/** Numbers a splat's screen gradient occupies, in `@driftengine/capture`'s own order. */
export const SPLAT_GRADIENT_FLOATS = 9;

/** One workgroup covers a tile: the invocations are its pixels. */
export const SPLAT_RASTER_GROUP = 16;

/** Below this a splat contributes less than a quarter of a value of an eight-bit channel. */
const FAINT = '0.0009803921568627451';

/** What every pass needs: the frame's shape and the two record widths. */
const SHARED = /* wgsl */ `
struct Params {
  width: u32,
  height: u32,
  across: u32,
  splats: u32,
};

const FAINT: f32 = ${FAINT};
const FLOATS: u32 = ${SPLAT_RASTER_FLOATS}u;
const GRADS: u32 = ${SPLAT_GRADIENT_FLOATS}u;

`;

/** Reading a splat and evaluating it, for the two passes that touch the cloud itself. */
const SPLAT_READER = /* wgsl */ `
struct Splat {
  centre: vec2f,
  /* The screen covariance, [[a, b], [b, d]], the low-pass already in it. */
  a: f32,
  b: f32,
  d: f32,
  opacity: f32,
  colour: vec3f,
  /* Half the side of the pixel box it is drawn in, which is what bounds it. */
  reach: f32,
};

fn readSplat(index: u32) -> Splat {
  let at = index * FLOATS;
  var one: Splat;
  one.centre = vec2f(splats[at], splats[at + 1u]);
  one.a = splats[at + 2u];
  one.b = splats[at + 3u];
  one.d = splats[at + 4u];
  one.opacity = splats[at + 5u];
  one.colour = vec3f(splats[at + 6u], splats[at + 7u], splats[at + 8u]);
  one.reach = splats[at + 9u];
  return one;
}

/* The pixel box the binning bins by, asked of one pixel: the rasteriser's own bound. */
fn insideBox(one: Splat, pixel: vec2f) -> bool {
  return pixel.x >= floor(one.centre.x - one.reach)
    && pixel.x <= ceil(one.centre.x + one.reach)
    && pixel.y >= floor(one.centre.y - one.reach)
    && pixel.y <= ceil(one.centre.y + one.reach);
}

/* The inverse of the screen covariance, which is what the exponent is written in. */
fn conicOf(one: Splat) -> vec3f {
  let determinant = one.a * one.d - one.b * one.b;
  return vec3f(one.d / determinant, -one.b / determinant, one.a / determinant);
}

/* How much of a splat reaches a pixel, from the pixel's own centre. */
fn weightAt(conic: vec3f, offset: vec2f) -> f32 {
  let power = -0.5 * (conic.x * offset.x * offset.x
    + 2.0 * conic.y * offset.x * offset.y
    + conic.z * offset.y * offset.y);
  return exp(power);
}
`;

/** The two together, which is what the tiled passes include. */
const COMMON = SHARED + SPLAT_READER;

/**
 * The frame, and the light left at every pixel after the whole cloud — which the backward pass
 * needs and cannot recover, because it walks the list the other way.
 *
 * Bindings: `params`, `splats`, `offsets`, `counts`, `lists`, `frame`, `light`.
 */
export const SPLAT_FORWARD_WGSL = /* wgsl */ `
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> splats: array<f32>;
@group(0) @binding(2) var<storage, read> offsets: array<u32>;
@group(0) @binding(3) var<storage, read> counts: array<u32>;
@group(0) @binding(4) var<storage, read> lists: array<u32>;
@group(0) @binding(5) var<storage, read_write> frame: array<f32>;
@group(0) @binding(6) var<storage, read_write> light: array<f32>;
${COMMON}

@compute @workgroup_size(${SPLAT_RASTER_GROUP}, ${SPLAT_RASTER_GROUP}, 1)
fn main(@builtin(global_invocation_id) id: vec3u, @builtin(workgroup_id) group: vec3u) {
  if (id.x >= params.width || id.y >= params.height) { return; }
  let tile = group.y * params.across + group.x;
  let start = offsets[tile];
  let held = counts[tile];
  let centre = vec2f(f32(id.x) + 0.5, f32(id.y) + 0.5);

  var transmit = 1.0;
  var colour = vec3f(0.0);
  var covered = 0.0;
  for (var slot = 0u; slot < held; slot = slot + 1u) {
    let one = readSplat(lists[start + slot]);
    if (!insideBox(one, vec2f(f32(id.x), f32(id.y)))) { continue; }
    let alpha = one.opacity * weightAt(conicOf(one), centre - one.centre);
    if (alpha < FAINT) { continue; }
    let share = alpha * transmit;
    colour = colour + share * one.colour;
    covered = covered + share;
    transmit = transmit * (1.0 - alpha);
  }

  let pixel = id.y * params.width + id.x;
  frame[pixel * 4u] = colour.x;
  frame[pixel * 4u + 1u] = colour.y;
  frame[pixel * 4u + 2u] = colour.z;
  frame[pixel * 4u + 3u] = covered;
  light[pixel] = transmit;
}
`;

/**
 * The gradients of one tile's splats, each into a slot of its own.
 *
 * The workgroup walks its list furthest first, in step: every lane holds the light in front of the
 * splat it has reached and the colour accumulated behind it, and after each splat the lanes are
 * reduced in a fixed tree so the sum is the same on every device and every run.
 *
 * Bindings: `params`, `splats`, `offsets`, `counts`, `lists`, `pairOf`, `dPixels`, `light`,
 * `partials`.
 */
export const SPLAT_BACKWARD_WGSL = /* wgsl */ `
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> splats: array<f32>;
@group(0) @binding(2) var<storage, read> offsets: array<u32>;
@group(0) @binding(3) var<storage, read> counts: array<u32>;
@group(0) @binding(4) var<storage, read> lists: array<u32>;
@group(0) @binding(5) var<storage, read> pairOf: array<u32>;
@group(0) @binding(6) var<storage, read> dPixels: array<f32>;
@group(0) @binding(7) var<storage, read> light: array<f32>;
@group(0) @binding(8) var<storage, read_write> partials: array<f32>;
${COMMON}

const LANES: u32 = ${SPLAT_RASTER_GROUP * SPLAT_RASTER_GROUP}u;
var<workgroup> gathered: array<array<f32, ${SPLAT_GRADIENT_FLOATS}>, ${SPLAT_RASTER_GROUP * SPLAT_RASTER_GROUP}>;

@compute @workgroup_size(${SPLAT_RASTER_GROUP}, ${SPLAT_RASTER_GROUP}, 1)
fn main(
  @builtin(global_invocation_id) id: vec3u,
  @builtin(workgroup_id) group: vec3u,
  @builtin(local_invocation_index) lane: u32,
) {
  let tile = group.y * params.across + group.x;
  let start = offsets[tile];
  let held = counts[tile];
  /* Off the edge of the frame there is no pixel, and the lane still meets every barrier below. */
  let inside = id.x < params.width && id.y < params.height;
  let pixel = select(0u, id.y * params.width + id.x, inside);
  let centre = vec2f(f32(id.x) + 0.5, f32(id.y) + 0.5);

  var transmit = select(1.0, light[pixel], inside);
  var behind = vec3f(0.0);
  var behindCover = 0.0;
  var dPixel = vec4f(0.0);
  if (inside) {
    dPixel = vec4f(dPixels[pixel * 4u], dPixels[pixel * 4u + 1u],
      dPixels[pixel * 4u + 2u], dPixels[pixel * 4u + 3u]);
  }

  for (var step = 0u; step < held; step = step + 1u) {
    let slot = held - 1u - step;
    let index = lists[start + slot];
    let one = readSplat(index);
    let conic = conicOf(one);
    let offset = centre - one.centre;
    let weight = weightAt(conic, offset);
    let alpha = one.opacity * weight;
    let contributes = inside && alpha >= FAINT
      && insideBox(one, vec2f(f32(id.x), f32(id.y)));

    var mine: array<f32, GRADS>;
    for (var k = 0u; k < GRADS; k = k + 1u) { mine[k] = 0.0; }
    if (contributes) {
      /* Undo this splat's own share to recover the light that reached it. */
      /* Divided by what is left of the light, and by one where nothing is. */
      let left = select(1.0 - alpha, 1.0, alpha == 1.0);
      let before = transmit / left;
      var dAlpha = 0.0;
      for (var c = 0u; c < 3u; c = c + 1u) {
        let grad = dPixel[c];
        mine[6u + c] = grad * alpha * before;
        dAlpha = dAlpha + grad * before * (one.colour[c] - behind[c]);
      }
      dAlpha = dAlpha + dPixel.w * before * (1.0 - behindCover);
      mine[5u] = dAlpha * weight;

      /* Through the exponent to the centre and the covariance, as the reference has it. */
      let dPower = dAlpha * one.opacity * weight;
      mine[0u] = dPower * (conic.x * offset.x + conic.y * offset.y);
      mine[1u] = dPower * (conic.y * offset.x + conic.z * offset.y);
      let dInverse = vec3f(
        -0.5 * dPower * offset.x * offset.x,
        -0.5 * dPower * offset.x * offset.y,
        -0.5 * dPower * offset.y * offset.y);
      mine[2u] = -(conic.x * dInverse.x * conic.x + 2.0 * conic.x * conic.y * dInverse.y
        + conic.y * dInverse.z * conic.y);
      mine[3u] = -2.0 * (conic.x * dInverse.x * conic.y + conic.y * dInverse.y * conic.y
        + conic.x * dInverse.y * conic.z + conic.y * dInverse.z * conic.z);
      mine[4u] = -(conic.y * dInverse.x * conic.y + 2.0 * conic.y * conic.z * dInverse.y
        + conic.z * dInverse.z * conic.z);

      /* And carry this splat into what stands behind the next one. */
      behind = alpha * one.colour + (1.0 - alpha) * behind;
      behindCover = alpha + (1.0 - alpha) * behindCover;
      transmit = before;
    }

    /* The lanes, reduced in a fixed tree: the same sum in the same order on every device. */
    for (var k = 0u; k < GRADS; k = k + 1u) { gathered[lane][k] = mine[k]; }
    workgroupBarrier();
    for (var half = LANES / 2u; half > 0u; half = half / 2u) {
      if (lane < half) {
        for (var k = 0u; k < GRADS; k = k + 1u) {
          gathered[lane][k] = gathered[lane][k] + gathered[lane + half][k];
        }
      }
      workgroupBarrier();
    }
    if (lane == 0u) {
      let pair = pairOf[start + slot] * GRADS;
      for (var k = 0u; k < GRADS; k = k + 1u) { partials[pair + k] = gathered[0][k]; }
    }
    workgroupBarrier();
  }
}
`;

/**
 * Each splat's own run of partial gradients, summed in index order.
 *
 * Bindings: `params`, `pairOffsets`, `tilesPerSplat`, `partials`, `gradients`.
 */
export const SPLAT_REDUCE_WGSL = /* wgsl */ `
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> pairOffsets: array<u32>;
@group(0) @binding(2) var<storage, read> tilesPerSplat: array<u32>;
@group(0) @binding(3) var<storage, read> partials: array<f32>;
@group(0) @binding(4) var<storage, read_write> gradients: array<f32>;
${SHARED}

@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let splat = id.x;
  if (splat >= params.splats) { return; }
  let start = pairOffsets[splat];
  let held = tilesPerSplat[splat];
  for (var k = 0u; k < GRADS; k = k + 1u) {
    var total = 0.0;
    for (var slot = 0u; slot < held; slot = slot + 1u) {
      total = total + partials[(start + slot) * GRADS + k];
    }
    gradients[splat * GRADS + k] = total;
  }
}
`;

/**
 * One Adam step over one family of parameters.
 *
 * The bias corrections arrive already computed, because they are a running product on the host —
 * `β₁ⁿ` raised on the device would be a second definition of the same decay and would drift from
 * the reference's in the last bits for no gain.
 *
 * Bindings: `settings` (count, rate, correction1, correction2), `values`, `gradient`, `moment`,
 * `second`.
 */
export const SPLAT_ADAM_WGSL = /* wgsl */ `
struct Settings {
  count: u32,
  rate: f32,
  correction1: f32,
  correction2: f32,
};

const BETA1: f32 = 0.9;
const BETA2: f32 = 0.999;
const EPSILON: f32 = 1e-8;

@group(0) @binding(0) var<uniform> settings: Settings;
@group(0) @binding(1) var<storage, read_write> values: array<f32>;
@group(0) @binding(2) var<storage, read> gradient: array<f32>;
@group(0) @binding(3) var<storage, read_write> moment: array<f32>;
@group(0) @binding(4) var<storage, read_write> second: array<f32>;

@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let at = id.x;
  if (at >= settings.count) { return; }
  let g = gradient[at];
  let m = BETA1 * moment[at] + (1.0 - BETA1) * g;
  let v = BETA2 * second[at] + (1.0 - BETA2) * g * g;
  moment[at] = m;
  second[at] = v;
  values[at] = values[at]
    - (settings.rate * (m / settings.correction1)) / (sqrt(v / settings.correction2) + EPSILON);
}
`;
