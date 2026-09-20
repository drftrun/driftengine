/**
 * DriftTR's resolve on the device: `recon/resolve.ts`, operation for operation.
 *
 * **One core, two modules**, the arrangement `network.wgsl.ts` uses. The arithmetic below reads
 * every texel through functions the including module defines, so the production module can read the
 * renderer's reversed depth through a converting accessor while the parity check reads plain float
 * textures of the numbers the reference was given. A second copy of the arithmetic — one for the
 * frame and one for the check — is two sets of rounding decisions to keep in step, which is the
 * thing this repository refuses everywhere else.
 *
 * **`floor(x + 0.5)`, never `round`.** JavaScript rounds a half away from zero and WGSL's `round`
 * rounds a half to even, and this resolve rounds at every texel it picks: the nearest render texel
 * to an output pixel, and the previous frame's texel under a reprojection. A half lands there
 * whenever the ratio is two, or the jitter is zero, or an object moved by a whole texel — which is
 * to say constantly, not rarely.
 *
 * **Rows flip in the accessors, not here.** The reference's images are rows from `v = 0` upward and
 * a WebGPU texture's row 0 is the top one, so the production module's accessors subtract the
 * texel's row from the height. The check's accessors do not, because its textures are written in
 * the reference's own order.
 *
 * **Everything here is `f32` where the reference is `f64`.** The world positions a depth unprojects
 * to, and the normals differenced from them, are where that costs the most: a cross product of two
 * neighbouring positions is a subtraction of nearly equal numbers. `scripts/recon-parity.mjs`
 * measures what it costs and states the bound it holds.
 *
 * The accessors an including module must define, before including the core:
 *
 * ```wgsl
 * fn reconScene(x: i32, y: i32) -> vec3<f32>          // render size, linear, clamped
 * fn reconSceneBilinear(p: vec2<f32>) -> vec3<f32>    // at continuous texel coordinates, clamped
 * fn reconDepth(x: i32, y: i32) -> f32                // this frame's clip depth, the matrices' sense
 * fn reconPreviousDepth(x: i32, y: i32) -> f32        // last frame's
 * fn reconMotion(x: i32, y: i32) -> vec4<f32>         // uv, previous view depth, flag
 * fn reconHistory(x: i32, y: i32) -> vec4<f32>        // output size, colour and gathered weight
 * fn reconHistoryBilinear(p: vec2<f32>) -> vec4<f32>
 * ```
 *
 * and the uniform `recon: ReconParams`, whose struct this module declares.
 */
import { wgslSceneDepthToNdc } from '../../depthConvention.ts';

/**
 * The parameters one resolve reads, as `ResolveFrame` minus its images.
 *
 * `hasHistory` is a `u32` because a uniform buffer has no `bool`. The three matrices are the
 * unjittered ones, in the same convention as the depths the accessors return.
 */
export const RECON_PARAMS_WGSL = /* wgsl */ `
struct ReconParams {
  renderSize: vec2<u32>,
  outputSize: vec2<u32>,
  jitter: vec2<f32>,
  previousJitter: vec2<f32>,
  inverseViewProj: mat4x4<f32>,
  previousViewProj: mat4x4<f32>,
  previousInverseViewProj: mat4x4<f32>,
  eye: vec4<f32>,
  previousEye: vec4<f32>,
  alpha: f32,
  sharpenAmount: f32,
  clampGamma: f32,
  hasHistory: u32,
  depthTolerance: f32,
  motionScale: f32,
  normalFloor: f32,
  normalCeiling: f32,
}
`;

/** Floats in `ReconParams`, which is what a caller sizes its uniform buffer by. */
export const RECON_PARAM_FLOATS = 72;

/** `SAMPLE_SPREAD` and `CONFIDENT_WEIGHT`, which the reference exports and this must not restate. */
export const RECON_SAMPLE_SPREAD = 0.47;
export const RECON_CONFIDENT_WEIGHT = 1;

/** The workgroup edge both entry points dispatch over. */
export const RECON_WORKGROUP = 8;

/**
 * What the histories and the shown picture are stored in.
 *
 * **Half float, and the alpha carries a weight rather than an opacity.** The gathered weight is
 * capped at `(1 - alpha) / alpha` plus one frame's gathering — about twelve at the default — and
 * eleven bits of mantissa hold that to a part in two thousand, which is far inside what the
 * disocclusion smoothstep can tell apart. Filterable, which the five-tap Catmull-Rom needs and no
 * 32-bit float format offers, and storage-capable, which the dispatch writing it needs.
 */
export const RECON_HISTORY_FORMAT: GPUTextureFormat = 'rgba16float';

/**
 * The arithmetic, as text. Defines `reconResolvePixel(ox, oy) -> vec4<f32>` — the next history's
 * colour and the weight it has gathered — and `reconSharpenAt(ox, oy) -> vec3<f32>`, the picture
 * shown, which reads the history the first has already written.
 */
export const RECON_RESOLVE_CORE_WGSL = /* wgsl */ `
const RECON_SAMPLE_SPREAD: f32 = ${RECON_SAMPLE_SPREAD};
const RECON_CONFIDENT_WEIGHT: f32 = ${RECON_CONFIDENT_WEIGHT}.0;

fn reconClampTexel(value: i32, size: i32) -> i32 {
  return clamp(value, 0, size - 1);
}

/* JavaScript's Math.round, which is not WGSL's round: a half goes up, not to even. */
fn reconRound(value: f32) -> f32 {
  return floor(value + 0.5);
}

/* Written out rather than the built-in, whose result is undefined where the edges are equal. */
fn reconSmoothstep(edge0: f32, edge1: f32, x: f32) -> f32 {
  let t = clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

fn reconWeightAt(dx: f32, dy: f32) -> f32 {
  return exp(-(dx * dx + dy * dy) / (2.0 * RECON_SAMPLE_SPREAD * RECON_SAMPLE_SPREAD));
}

fn reconToYCoCg(c: vec3<f32>) -> vec3<f32> {
  return vec3<f32>(
    c.r * 0.25 + c.g * 0.5 + c.b * 0.25,
    c.r * 0.5 - c.b * 0.5,
    -c.r * 0.25 + c.g * 0.5 - c.b * 0.25,
  );
}

fn reconFromYCoCg(c: vec3<f32>) -> vec3<f32> {
  let base = c.x - c.z;
  return vec3<f32>(base + c.y, c.x + c.z, base - c.y);
}

struct ReconBox {
  low: vec3<f32>,
  high: vec3<f32>,
}

/*
 * Each channel's mean plus or minus gamma of its standard deviation — and a channel whose nine
 * samples all agree is that value exactly, because a mean of nine equal floats is not always one
 * of them and a box a rounding wide lets a history through by a rounding.
 */
fn reconVarianceBox(samples: array<vec3<f32>, 9>, gamma: f32) -> ReconBox {
  var s = samples;
  var box: ReconBox;
  for (var c = 0u; c < 3u; c = c + 1u) {
    let first = s[0][c];
    var same = true;
    var sum = 0.0;
    for (var i = 0u; i < 9u; i = i + 1u) {
      let value = s[i][c];
      sum = sum + value;
      if (value != first) { same = false; }
    }
    if (same) {
      box.low[c] = first;
      box.high[c] = first;
      continue;
    }
    let mean = sum / 9.0;
    var spread = 0.0;
    for (var i = 0u; i < 9u; i = i + 1u) {
      let d = s[i][c] - mean;
      spread = spread + d * d;
    }
    let deviation = sqrt(spread / 9.0);
    box.low[c] = mean - gamma * deviation;
    box.high[c] = mean + gamma * deviation;
  }
  return box;
}

/*
 * The history pulled towards the box's centre until it is inside, by one ratio for all three
 * channels — a clamp per channel would land it on a corner and change its hue, which is coloured
 * fringing on every moving edge. A channel with no extent bounds anything that differs from it
 * infinitely, so such a history collapses onto the centre.
 */
fn reconClipToBox(history: vec3<f32>, low: vec3<f32>, high: vec3<f32>) -> vec3<f32> {
  let centre = (low + high) * 0.5;
  var offset = history - centre;
  var extent = (high - low) * 0.5;
  var ratio = 0.0;
  var infinite = false;
  for (var c = 0u; c < 3u; c = c + 1u) {
    if (extent[c] > 1e-7) {
      ratio = max(ratio, abs(offset[c]) / extent[c]);
    } else if (abs(offset[c]) > 1e-7) {
      infinite = true;
    }
  }
  if (!infinite && !(ratio > 1.0)) { return history; }
  var scale = 0.0;
  if (!infinite) { scale = 1.0 / ratio; }
  return centre + offset * scale;
}

fn reconAccumulate(current: vec3<f32>, history: vec3<f32>, weight: f32, alpha: f32) -> vec3<f32> {
  let kept = clamp(weight, 0.0, 1.0) * (1.0 - clamp(alpha, 0.0, 1.0));
  return current * (1.0 - kept) + history * kept;
}

fn reconCatmullRom(t: f32) -> vec4<f32> {
  let t2 = t * t;
  let t3 = t2 * t;
  return vec4<f32>(
    -0.5 * t3 + t2 - 0.5 * t,
    1.5 * t3 - 2.5 * t2 + 1.0,
    -1.5 * t3 + 2.0 * t2 + 0.5 * t,
    0.5 * t3 - 0.5 * t2,
  );
}

/*
 * Five bilinear taps standing for the sixteen-texel Catmull-Rom: each axis's middle pair folded
 * into one tap placed between them, the corners dropped, the five weights renormalised. It is the
 * five-tap form because the taps are the expensive part — which is only true while the bilinear is
 * the sampler's, so the production module's accessor is a filtered sample and the check's is the
 * reference's own arithmetic over loaded texels.
 */
struct ReconTaps {
  at0: vec2<f32>,
  at1: vec2<f32>,
  at2: vec2<f32>,
  at3: vec2<f32>,
  at4: vec2<f32>,
  weights: array<f32, 5>,
  total: f32,
}

fn reconBicubicTaps(x: f32, y: f32) -> ReconTaps {
  let x1 = floor(x);
  let y1 = floor(y);
  let wx = reconCatmullRom(x - x1);
  let wy = reconCatmullRom(y - y1);
  let wx12 = wx[1] + wx[2];
  let wy12 = wy[1] + wy[2];
  let x12 = x1 + wx[2] / wx12;
  let y12 = y1 + wy[2] / wy12;
  var taps: ReconTaps;
  taps.at0 = vec2<f32>(x12, y1 - 1.0);
  taps.at1 = vec2<f32>(x1 - 1.0, y12);
  taps.at2 = vec2<f32>(x12, y12);
  taps.at3 = vec2<f32>(x1 + 2.0, y12);
  taps.at4 = vec2<f32>(x12, y1 + 2.0);
  taps.weights[0] = wx12 * wy[0];
  taps.weights[1] = wx[0] * wy12;
  taps.weights[2] = wx12 * wy12;
  taps.weights[3] = wx[3] * wy12;
  taps.weights[4] = wx12 * wy[3];
  taps.total =
    taps.weights[0] + taps.weights[1] + taps.weights[2] + taps.weights[3] + taps.weights[4];
  return taps;
}

/* A colour cannot be negative, and Catmull-Rom's negative lobes undershoot beside a bright edge. */
fn reconSceneBicubic5(x: f32, y: f32) -> vec3<f32> {
  let taps = reconBicubicTaps(x, y);
  var sum = reconSceneBilinear(taps.at0) * taps.weights[0];
  sum = sum + reconSceneBilinear(taps.at1) * taps.weights[1];
  sum = sum + reconSceneBilinear(taps.at2) * taps.weights[2];
  sum = sum + reconSceneBilinear(taps.at3) * taps.weights[3];
  sum = sum + reconSceneBilinear(taps.at4) * taps.weights[4];
  return max(sum / taps.total, vec3<f32>(0.0));
}

fn reconHistoryBicubic5(x: f32, y: f32) -> vec4<f32> {
  let taps = reconBicubicTaps(x, y);
  var sum = reconHistoryBilinear(taps.at0) * taps.weights[0];
  sum = sum + reconHistoryBilinear(taps.at1) * taps.weights[1];
  sum = sum + reconHistoryBilinear(taps.at2) * taps.weights[2];
  sum = sum + reconHistoryBilinear(taps.at3) * taps.weights[3];
  sum = sum + reconHistoryBilinear(taps.at4) * taps.weights[4];
  return max(sum / taps.total, vec4<f32>(0.0));
}

struct ReconWorld {
  ok: bool,
  position: vec3<f32>,
}

/* The world position a clip depth stands for, and nothing where the matrix has no answer there. */
fn reconWorldFromDepth(m: mat4x4<f32>, u: f32, v: f32, clipDepth: f32) -> ReconWorld {
  var out: ReconWorld;
  out.position = vec3<f32>(0.0);
  out.ok = false;
  let x = u * 2.0 - 1.0;
  let y = v * 2.0 - 1.0;
  let w = m[0][3] * x + m[1][3] * y + m[2][3] * clipDepth + m[3][3];
  if (!(abs(w) > 1e-12)) { return out; }
  let p = m * vec4<f32>(x, y, clipDepth, 1.0);
  out.position = p.xyz / w;
  out.ok = all(abs(out.position) < vec3<f32>(3.4e38));
  return out;
}

struct ReconNormal {
  ok: bool,
  normal: vec3<f32>,
}

/* Turned to face the eye, so the answer is the same whichever way the target's rows run. */
fn reconNormalFrom(
  centre: vec3<f32>,
  right: vec3<f32>,
  up: vec3<f32>,
  eye: vec3<f32>,
) -> ReconNormal {
  var out: ReconNormal;
  out.normal = vec3<f32>(0.0);
  out.ok = false;
  let a = right - centre;
  let b = up - centre;
  let n = cross(a, b);
  let length2 = dot(n, n);
  let scale2 = dot(a, a) * dot(b, b);
  if (!(length2 > 1e-12 * scale2)) { return out; }
  let toEye = dot(n, eye - centre);
  var sign = 1.0;
  if (toEye < 0.0) { sign = -1.0; }
  out.normal = n * (sign / sqrt(length2));
  out.ok = true;
  return out;
}

fn reconDisocclusion(
  currDepth: f32,
  histDepth: f32,
  motionLength: f32,
  normalDot: f32,
) -> f32 {
  if (!(currDepth > 0.0) || !(histDepth > 0.0) || !(motionLength >= 0.0)) { return 0.0; }
  let disagreement = abs(currDepth - histDepth) / currDepth;
  let tolerance = recon.depthTolerance + recon.motionScale * motionLength;
  let depth = 1.0 - reconSmoothstep(tolerance, 2.0 * tolerance, disagreement);
  let normal = reconSmoothstep(recon.normalFloor, recon.normalCeiling, normalDot);
  return depth * normal;
}

struct ReconAt {
  depth: f32,
  position: vec3<f32>,
}

/* A texel's world position at its unjittered uv, and the view depth it stands at, or zero. */
fn reconWorldAt(previous: bool, x: i32, y: i32) -> ReconAt {
  let w = i32(recon.renderSize.x);
  let h = i32(recon.renderSize.y);
  let tx = reconClampTexel(x, w);
  let ty = reconClampTexel(y, h);
  var jitter = recon.jitter;
  var m = recon.inverseViewProj;
  var z = reconDepth(tx, ty);
  if (previous) {
    jitter = recon.previousJitter;
    m = recon.previousInverseViewProj;
    z = reconPreviousDepth(tx, ty);
  }
  let u = (f32(tx) + 0.5 - jitter.x) / f32(w);
  let v = (f32(ty) + 0.5 - jitter.y) / f32(h);
  var out: ReconAt;
  out.depth = 0.0;
  out.position = vec3<f32>(0.0);
  let world = reconWorldFromDepth(m, u, v, z);
  if (!world.ok) { return out; }
  out.position = world.position;
  /* The view depth is the clip w, which the inverse's w is the reciprocal of. */
  let cw = m[0][3] * (u * 2.0 - 1.0) + m[1][3] * (v * 2.0 - 1.0) + m[2][3] * z + m[3][3];
  out.depth = 1.0 / cw;
  return out;
}

/* The neighbour on the inside of the border, so the edge texels have a normal too. */
fn reconNormalAt(previous: bool, x: i32, y: i32) -> ReconNormal {
  var out: ReconNormal;
  out.normal = vec3<f32>(0.0);
  out.ok = false;
  let w = i32(recon.renderSize.x);
  let h = i32(recon.renderSize.y);
  let centre = reconWorldAt(previous, x, y);
  if (!(centre.depth > 0.0)) { return out; }
  var dx = -1;
  if (x + 1 < w) { dx = 1; }
  var dy = -1;
  if (y + 1 < h) { dy = 1; }
  let right = reconWorldAt(previous, x + dx, y);
  if (!(right.depth > 0.0)) { return out; }
  let up = reconWorldAt(previous, x, y + dy);
  if (!(up.depth > 0.0)) { return out; }
  var eye = recon.eye.xyz;
  if (previous) { eye = recon.previousEye.xyz; }
  return reconNormalFrom(centre.position, right.position, up.position, eye);
}

struct ReconHistory {
  weight: f32,
  colour: vec4<f32>,
}

/*
 * The weight a pixel's history still deserves: none on the first frame, none where the surface was
 * behind last frame's eye or off its picture, and otherwise what it gathered, scaled by whether it
 * is the same surface.
 */
fn reconHistoryWeight(u: f32, v: f32, dx: i32, dy: i32) -> ReconHistory {
  var out: ReconHistory;
  out.weight = 0.0;
  out.colour = vec4<f32>(0.0);
  if (recon.hasHistory == 0u) { return out; }
  let rw = f32(recon.renderSize.x);
  let rh = f32(recon.renderSize.y);
  let motion = reconMotion(dx, dy);
  var mu = 0.0;
  var mv = 0.0;
  var expected = 0.0;
  if (motion.w > 0.5) {
    mu = motion.x;
    mv = motion.y;
    expected = motion.z;
  } else {
    let here = reconWorldAt(false, dx, dy);
    if (!(here.depth > 0.0)) { return out; }
    let clip = recon.previousViewProj * vec4<f32>(here.position, 1.0);
    /*
     * A surface behind last frame's eye has a w that is not positive: the disocclusion trusts no
     * such depth, so it needs no refusal of its own here.
     */
    expected = clip.w;
    let du = (f32(dx) + 0.5 - recon.jitter.x) / rw;
    let dv = (f32(dy) + 0.5 - recon.jitter.y) / rh;
    mu = (clip.x / expected) * 0.5 + 0.5 - du;
    mv = (clip.y / expected) * 0.5 + 0.5 - dv;
  }

  let pu = u + mu;
  let pv = v + mv;
  if (!(pu >= 0.0 && pu <= 1.0 && pv >= 0.0 && pv <= 1.0)) { return out; }
  out.colour = reconHistoryBicubic5(
    pu * f32(recon.outputSize.x) - 0.5,
    pv * f32(recon.outputSize.y) - 0.5,
  );
  let px = reconClampTexel(i32(reconRound(pu * rw + recon.previousJitter.x - 0.5)), i32(rw));
  let py = reconClampTexel(i32(reconRound(pv * rh + recon.previousJitter.y - 0.5)), i32(rh));
  let held = reconWorldAt(true, px, py).depth;
  var normalDot = 1.0;
  let here = reconNormalAt(false, dx, dy);
  let there = reconNormalAt(true, px, py);
  if (here.ok && there.ok) { normalDot = dot(here.normal, there.normal); }
  let trust = reconDisocclusion(expected, held, length(vec2<f32>(mu, mv)), normalDot);
  out.weight = out.colour.w * trust;
  return out;
}

/* One output pixel: the history's next colour, before sharpening, and the weight it has gathered. */
fn reconResolvePixel(ox: i32, oy: i32) -> vec4<f32> {
  let rw = i32(recon.renderSize.x);
  let rh = i32(recon.renderSize.y);
  let ow = i32(recon.outputSize.x);
  let oh = i32(recon.outputSize.y);
  let u = (f32(ox) + 0.5) / f32(ow);
  let v = (f32(oy) + 0.5) / f32(oh);
  let jx = recon.jitter.x;
  let jy = recon.jitter.y;

  /* Where this frame observed the pixel, and the render read there for the gaps. */
  let rx = u * f32(rw) + jx - 0.5;
  let ry = v * f32(rh) + jy - 0.5;
  let sample = reconSceneBicubic5(rx, ry);
  let nx = reconClampTexel(i32(reconRound(rx)), rw);
  let ny = reconClampTexel(i32(reconRound(ry)), rh);

  /* Each texel around: its weight, its colour in the box, and its depth. */
  var nearest = reconDepth(nx, ny);
  var dx = nx;
  var dy = ny;
  var gathered = 0.0;
  var accum = vec3<f32>(0.0);
  var neighbours: array<vec3<f32>, 9>;
  for (var j = -1; j <= 1; j = j + 1) {
    for (var i = -1; i <= 1; i = i + 1) {
      let tx = reconClampTexel(nx + i, rw);
      let ty = reconClampTexel(ny + j, rh);
      let colour = reconScene(tx, ty);
      let weight = reconWeightAt(
        ((f32(tx) + 0.5 - jx) / f32(rw)) * f32(ow) - (f32(ox) + 0.5),
        ((f32(ty) + 0.5 - jy) / f32(rh)) * f32(oh) - (f32(oy) + 0.5),
      );
      gathered = gathered + weight;
      accum = accum + colour * weight;
      neighbours[(j + 1) * 3 + (i + 1)] = reconToYCoCg(colour);
      let z = reconDepth(tx, ty);
      if (z < nearest) {
        nearest = z;
        dx = tx;
        dy = ty;
      }
    }
  }
  let box = reconVarianceBox(neighbours, recon.clampGamma);
  accum = accum / gathered;

  /* The history, and the weight it still deserves; a tenth of each frame is always new. */
  let cap = (1.0 - recon.alpha) / recon.alpha;
  let history = reconHistoryWeight(u, v, dx, dy);
  let kept = min(cap, history.weight);

  let total = kept + gathered;
  var mixed = accum;
  if (kept > 0.0) {
    let clipped = reconClipToBox(reconToYCoCg(history.colour.xyz), box.low, box.high);
    mixed = reconAccumulate(accum, reconFromYCoCg(clipped), 1.0, gathered / total);
  }
  let known = min(1.0, total / RECON_CONFIDENT_WEIGHT);
  return vec4<f32>(sample * (1.0 - known) + mixed * known, total);
}

/*
 * The centre pushed away from its four neighbours' mean, and held inside the range of the five —
 * the halo a plain unsharp mask draws beside every edge is a value outside that range.
 */
fn reconSharpenAt(ox: i32, oy: i32) -> vec3<f32> {
  let ow = i32(recon.outputSize.x);
  let oh = i32(recon.outputSize.y);
  let centre = reconHistory(reconClampTexel(ox, ow), reconClampTexel(oy, oh)).xyz;
  var offsets = array<vec2<i32>, 4>(
    vec2<i32>(-1, 0),
    vec2<i32>(1, 0),
    vec2<i32>(0, -1),
    vec2<i32>(0, 1),
  );
  var low = centre;
  var high = centre;
  var sum = vec3<f32>(0.0);
  for (var n = 0; n < 4; n = n + 1) {
    let at = offsets[n];
    let value = reconHistory(
      reconClampTexel(ox + at.x, ow),
      reconClampTexel(oy + at.y, oh),
    ).xyz;
    sum = sum + value;
    low = min(low, value);
    high = max(high, value);
  }
  let pushed = centre + recon.sharpenAmount * (centre - sum / 4.0);
  return min(high, max(low, pushed));
}
`;

/**
 * The parity module: the core over plain float textures written in the reference's own row order,
 * doing its own bilinear so the comparison is arithmetic rather than a tolerance on the device's
 * sampler.
 *
 * Two entry points over one set of bindings. `resolveMain` writes four floats a pixel — the next
 * history — and `sharpenMain` reads that history back at binding 4 and writes three.
 */
export function reconResolveParityWgsl(): string {
  return /* wgsl */ `
@group(0) @binding(0) var sceneTexture: texture_2d<f32>;
@group(0) @binding(1) var depthTexture: texture_2d<f32>;
@group(0) @binding(2) var motionTexture: texture_2d<f32>;
@group(0) @binding(3) var previousDepthTexture: texture_2d<f32>;
@group(0) @binding(4) var historyTexture: texture_2d<f32>;
${RECON_PARAMS_WGSL}
@group(0) @binding(5) var<uniform> recon: ReconParams;
@group(0) @binding(6) var<storage, read_write> output: array<f32>;

fn reconScene(x: i32, y: i32) -> vec3<f32> {
  return textureLoad(sceneTexture, vec2<i32>(x, y), 0).xyz;
}

fn reconDepth(x: i32, y: i32) -> f32 {
  return textureLoad(depthTexture, vec2<i32>(x, y), 0).x;
}

fn reconPreviousDepth(x: i32, y: i32) -> f32 {
  return textureLoad(previousDepthTexture, vec2<i32>(x, y), 0).x;
}

fn reconMotion(x: i32, y: i32) -> vec4<f32> {
  return textureLoad(motionTexture, vec2<i32>(x, y), 0);
}

fn reconHistory(x: i32, y: i32) -> vec4<f32> {
  return textureLoad(historyTexture, vec2<i32>(x, y), 0);
}

/* sampleBilinear's own arithmetic: floor, fraction, and the four texels clamped at the border. */
fn reconSceneBilinear(p: vec2<f32>) -> vec3<f32> {
  let w = i32(recon.renderSize.x);
  let h = i32(recon.renderSize.y);
  let x0 = i32(floor(p.x));
  let y0 = i32(floor(p.y));
  let f = p - floor(p);
  let a = reconScene(reconClampTexel(x0, w), reconClampTexel(y0, h));
  let b = reconScene(reconClampTexel(x0 + 1, w), reconClampTexel(y0, h));
  let c = reconScene(reconClampTexel(x0, w), reconClampTexel(y0 + 1, h));
  let d = reconScene(reconClampTexel(x0 + 1, w), reconClampTexel(y0 + 1, h));
  let top = a * (1.0 - f.x) + b * f.x;
  let bottom = c * (1.0 - f.x) + d * f.x;
  return top * (1.0 - f.y) + bottom * f.y;
}

fn reconHistoryBilinear(p: vec2<f32>) -> vec4<f32> {
  let w = i32(recon.outputSize.x);
  let h = i32(recon.outputSize.y);
  let x0 = i32(floor(p.x));
  let y0 = i32(floor(p.y));
  let f = p - floor(p);
  let a = reconHistory(reconClampTexel(x0, w), reconClampTexel(y0, h));
  let b = reconHistory(reconClampTexel(x0 + 1, w), reconClampTexel(y0, h));
  let c = reconHistory(reconClampTexel(x0, w), reconClampTexel(y0 + 1, h));
  let d = reconHistory(reconClampTexel(x0 + 1, w), reconClampTexel(y0 + 1, h));
  let top = a * (1.0 - f.x) + b * f.x;
  let bottom = c * (1.0 - f.x) + d * f.x;
  return top * (1.0 - f.y) + bottom * f.y;
}
${RECON_RESOLVE_CORE_WGSL}

@compute @workgroup_size(${RECON_WORKGROUP}, ${RECON_WORKGROUP})
fn resolveMain(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= recon.outputSize.x || id.y >= recon.outputSize.y) { return; }
  let value = reconResolvePixel(i32(id.x), i32(id.y));
  let at = (id.y * recon.outputSize.x + id.x) * 4u;
  output[at] = value.x;
  output[at + 1u] = value.y;
  output[at + 2u] = value.z;
  output[at + 3u] = value.w;
}

@compute @workgroup_size(${RECON_WORKGROUP}, ${RECON_WORKGROUP})
fn sharpenMain(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= recon.outputSize.x || id.y >= recon.outputSize.y) { return; }
  let value = reconSharpenAt(i32(id.x), i32(id.y));
  let at = (id.y * recon.outputSize.x + id.x) * 3u;
  output[at] = value.x;
  output[at + 1u] = value.y;
  output[at + 2u] = value.z;
}

/*
 * The rounding rule on its own, over a sweep that includes every exact half in the range.
 *
 * **A corpus cannot reach this.** The value the resolve rounds is a half only where the geometry
 * puts it exactly on one, and there an f32 shader and an f64 reference land on opposite sides of
 * the tie for reasons that have nothing to do with the tie-break rule. So the rule is checked where
 * the two precisions agree about the input and can only differ about the answer.
 */
@compute @workgroup_size(${RECON_WORKGROUP})
fn roundMain(@builtin(global_invocation_id) id: vec3<u32>) {
  output[id.x] = reconRound(f32(id.x) * 0.5 - 8.0);
}
`;
}

/**
 * The production module: the core over the renderer's own attachments.
 *
 * **Three things differ from the check, and all three are in the accessors.** The depth textures
 * hold the renderer's reversed depth, which `wgslSceneDepthToNdc` turns into the sense the matrices
 * were built for — the resolve picks the *nearest* of nine depths, and under reversed-Z the nearest
 * is the largest, so an unconverted accessor would dilate the motion of the furthest surface at
 * every silhouette. A texture's row 0 is the top one and the reference's images run from `v = 0`
 * upward, so every accessor mirrors the row. And the bilinear reads are the sampler's, which is
 * what makes the five-tap form cheaper than the sixteen.
 */
export function reconResolveWgsl(): string {
  return /* wgsl */ `
@group(0) @binding(0) var sceneTexture: texture_2d<f32>;
@group(0) @binding(1) var depthTexture: texture_2d<f32>;
@group(0) @binding(2) var motionTexture: texture_2d<f32>;
@group(0) @binding(3) var previousDepthTexture: texture_2d<f32>;
@group(0) @binding(4) var historyTexture: texture_2d<f32>;
@group(0) @binding(5) var linearSampler: sampler;
${RECON_PARAMS_WGSL}
@group(0) @binding(6) var<uniform> recon: ReconParams;
@group(0) @binding(7) var resolved: texture_storage_2d<rgba16float, write>;
/* Not "target": it is a reserved keyword in WGSL, as "meta" was in the cluster cull. */

/* Rows flip here: the reference's row 0 is the bottom one and a texture's is the top. */
fn reconRenderRow(y: i32) -> i32 {
  return i32(recon.renderSize.y) - 1 - y;
}

fn reconOutputRow(y: i32) -> i32 {
  return i32(recon.outputSize.y) - 1 - y;
}

fn reconScene(x: i32, y: i32) -> vec3<f32> {
  return textureLoad(sceneTexture, vec2<i32>(x, reconRenderRow(y)), 0).xyz;
}

fn reconDepth(x: i32, y: i32) -> f32 {
  let stored = textureLoad(depthTexture, vec2<i32>(x, reconRenderRow(y)), 0).x;
  return ${wgslSceneDepthToNdc('stored')};
}

fn reconPreviousDepth(x: i32, y: i32) -> f32 {
  let stored = textureLoad(previousDepthTexture, vec2<i32>(x, reconRenderRow(y)), 0).x;
  return ${wgslSceneDepthToNdc('stored')};
}

fn reconMotion(x: i32, y: i32) -> vec4<f32> {
  return textureLoad(motionTexture, vec2<i32>(x, reconRenderRow(y)), 0);
}

fn reconHistory(x: i32, y: i32) -> vec4<f32> {
  return textureLoad(historyTexture, vec2<i32>(x, reconOutputRow(y)), 0);
}

/* A texel coordinate becomes the uv of its centre, with the row taken from the other end. */
fn reconSceneBilinear(p: vec2<f32>) -> vec3<f32> {
  let size = vec2<f32>(f32(recon.renderSize.x), f32(recon.renderSize.y));
  let uv = vec2<f32>(p.x + 0.5, size.y - 0.5 - p.y) / size;
  return textureSampleLevel(sceneTexture, linearSampler, uv, 0.0).xyz;
}

fn reconHistoryBilinear(p: vec2<f32>) -> vec4<f32> {
  let size = vec2<f32>(f32(recon.outputSize.x), f32(recon.outputSize.y));
  let uv = vec2<f32>(p.x + 0.5, size.y - 0.5 - p.y) / size;
  return textureSampleLevel(historyTexture, linearSampler, uv, 0.0);
}
${RECON_RESOLVE_CORE_WGSL}

@compute @workgroup_size(${RECON_WORKGROUP}, ${RECON_WORKGROUP})
fn resolveMain(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= recon.outputSize.x || id.y >= recon.outputSize.y) { return; }
  let y = i32(recon.outputSize.y) - 1 - i32(id.y);
  let value = reconResolvePixel(i32(id.x), y);
  textureStore(resolved, vec2<i32>(i32(id.x), i32(id.y)), value);
}

@compute @workgroup_size(${RECON_WORKGROUP}, ${RECON_WORKGROUP})
fn sharpenMain(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= recon.outputSize.x || id.y >= recon.outputSize.y) { return; }
  let y = i32(recon.outputSize.y) - 1 - i32(id.y);
  let value = reconSharpenAt(i32(id.x), y);
  textureStore(resolved, vec2<i32>(i32(id.x), i32(id.y)), vec4<f32>(value, 1.0));
}
`;
}
