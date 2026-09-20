/**
 * A probe's own bake, on the device: trace a sphere of rays, convolve them into an octahedral map.
 *
 * **Two dispatches rather than one, and the split is what makes it affordable.** A probe's texel
 * is a cosine-weighted sum over every direction, so one invocation a texel that also traced would
 * trace the same `PROBE_DIRECTIONS` rays once per texel — 256 rays becoming 256 × edge², which for
 * an edge of 16 is sixty-five thousand marches for a probe that needs 256. So `traceMain` casts
 * the rays once and writes them down, and `convolveMain` reads them back.
 *
 * **The octahedral mapping is a third spelling and that is a hazard this file states rather than
 * hides.** `octahedral.ts` holds it in TypeScript and in GLSL; this is WGSL, because a hand-written
 * compute shader cannot include the generated one. `scripts/probe-bake-parity.mjs` is what holds
 * the three together, over the texels and the directions both.
 *
 * **A probe's normal is its ray's own direction, which is right here and wrong on a surface.**
 * `probeTraceField` lifts the start along the normal to keep a ray from immediately hitting the
 * surface it left, and its header says lifting along the ray as well double-counts — for a *surface*
 * sample, where the normal and the ray are different things. A probe stands in open space and has
 * no surface and no normal, so the only thing to lift along is the ray, and what it buys is a probe
 * that has come to rest inside a wall casting rays that leave it rather than all reporting a hit at
 * zero distance.
 *
 * The accessors an including module must define, before including the core, are `probeIndirect`'s
 * — see `probeTrace.wgsl.ts` — plus `bake: ProbeBake` as a uniform.
 */

import { FRAME_TURN, GOLDEN_ANGLE, PROBE_DIRECTIONS } from '../../gi/probeTrace.ts';
import { PROBE_MARCH_WGSL, PROBE_TRACE_CORE_WGSL } from './probeTrace.wgsl.ts';
import { PROBE_VOLUME_CORE_WGSL, PROBE_VOLUME_STRUCT_WGSL } from './probeVolume.wgsl.ts';
import { SAMPLE_FIELD_WGSL } from './sampleField.wgsl.ts';

/**
 * Floats in the bake block, and where each field of it starts.
 *
 * **A `vec3<f32>` is sixteen-byte *aligned* and twelve bytes *long*, and an `f32` after one fills
 * the gap rather than starting a new row.** So `counts` occupies floats 8 to 10 and `edge` is float
 * **11**, not 12 — which cost an afternoon: written at 12, the shader read `edge` as `frame` and
 * every direction came back rotated by the difference, at exactly the right radius. The radius
 * matching is what said it was the angle and not the set.
 *
 * Exported as named offsets for that reason. A caller that counts rows gets this wrong; a caller
 * that names the field cannot.
 */
export const BAKE_ORIGIN = 0;
export const BAKE_SPACING = 4;
export const BAKE_COUNTS = 8;
export const BAKE_EDGE = 11;
export const BAKE_FRAME = 12;
export const BAKE_SCHEDULED = 13;
/** The sun, which the trace evaluates itself so a light that moves changes the bounce. */
export const BAKE_SUN_DIR = 16;
export const BAKE_SUN_COLOUR = 20;
/** What a ray that left the world finds. The frame's ambient, so nothing rasterised is read. */
export const BAKE_SKY_COLOUR = 24;

/** Rounded up to the struct's own sixteen-byte alignment, with two vec3 rows for the sun. */
export const PROBE_BAKE_FLOATS = 28;

/** Invocations a workgroup, for both entry points. 64 is this backend's default everywhere. */
export const PROBE_BAKE_WORKGROUP = 64;

/** Floats a ray's radiance takes in the intermediate buffer. */
export const PROBE_RAY_FLOATS = 3;

/** Floats a baked texel takes. Three and not four: the alpha of an irradiance map means nothing. */
export const PROBE_TEXEL_FLOATS = 3;

export const PROBE_BAKE_STRUCT_WGSL = /* wgsl */ `
struct ProbeBake {
  /* Where the grid's first probe stands, and how far apart they are. */
  origin: vec3<f32>,
  spacing: vec3<f32>,
  /* How many probes along each axis. Whole numbers carried as floats, as every block here does. */
  counts: vec3<f32>,
  /* Texels across one probe's map, gutter included. */
  edge: f32,
  /* Which frame this is, which turns the direction set so a probe converges rather than repeats. */
  frame: f32,
  /* How many probes this dispatch bakes. The schedule says which. */
  scheduled: f32,
  pad: f32,
  /* Towards the sun, and what colour it is. The trace shades what it hits rather than reading a
     capture, which is what lets a bounce follow a light that moved. */
  sunDir: vec3<f32>,
  sunColour: vec3<f32>,
  /* And what is outside, for a ray that left. See probeDistantRadiance. */
  skyColour: vec3<f32>,
}
`;

/**
 * The octahedral mapping and the probe lattice, as text.
 *
 * Defines `bakeOctInsetDir(u, v, edge)` and `bakeProbePosition(layer)`.
 */
export const PROBE_BAKE_CORE_WGSL = /* wgsl */ `
const PROBE_BAKE_DIRECTIONS: u32 = ${String(PROBE_DIRECTIONS)}u;
/* Both interpolated from "gi/probeTrace.ts" rather than restated, so the two cannot drift. */
const PROBE_BAKE_GOLDEN_ANGLE: f32 = ${String(GOLDEN_ANGLE)};
const PROBE_BAKE_FRAME_TURN: f32 = ${String(FRAME_TURN)};
const PROBE_BAKE_TWO_PI: f32 = ${String(Math.PI * 2)};

fn bakeOctDecode(uv: vec2<f32>) -> vec3<f32> {
  let f = uv * 2.0 - 1.0;
  var n = vec3<f32>(f.x, f.y, 1.0 - abs(f.x) - abs(f.y));
  let t = max(-n.z, 0.0);
  n.x = n.x + select(t, -t, n.x >= 0.0);
  n.y = n.y + select(t, -t, n.y >= 0.0);
  return normalize(n);
}

/* The fold that makes the gutter hold the direction across the seam rather than the far side. */
fn bakeOctWrapUv(uv: vec2<f32>) -> vec2<f32> {
  var f = uv * 2.0 - 1.0;
  if (f.x < -1.0 || f.x > 1.0) {
    f.x = select(-2.0, 2.0, f.x > 0.0) - f.x;
    f.y = -f.y;
  }
  if (f.y < -1.0 || f.y > 1.0) {
    f.y = select(-2.0, 2.0, f.y > 0.0) - f.y;
    f.x = -f.x;
  }
  return f * 0.5 + 0.5;
}

/* The direction one texel of an inset map must hold. "octInsetDir", exactly. */
fn bakeOctInsetDir(uv: vec2<f32>, edge: f32) -> vec3<f32> {
  return bakeOctDecode(bakeOctWrapUv((uv * edge - 1.0) / (edge - 2.0)));
}

/*
 * Where a layer's probe stands.
 *
 * **x fastest, then y, then z** — "ProbeGrid.layerAt" writes that order down for this reason, and
 * the two disagreeing would light every surface from the wrong corner of the room.
 *
 * **In integers, and the first version was in floats, and it was wrong on a real device.** Written
 * as "floor(index / nx) % ny" over whole numbers carried as f32, this GPU answered 3 for 3.0 % 3.0
 * and 0 for floor(12.0 / 12.0). The cause is the shader compiler implementing a division as a
 * multiplication by a reciprocal: 1/3 and 1/12 are not exact in single precision, so 3 * (1/3) is
 * 0.99999994, its truncation is 0, and the remainder is the whole numerator. An index lattice is
 * integer arithmetic and has to be written as integer arithmetic; a float that happens to hold a
 * whole number is not a whole number once a compiler is allowed to reassociate it.
 */
fn bakeProbePosition(layer: u32) -> vec3<f32> {
  let nx = max(1u, u32(bake.counts.x));
  let ny = max(1u, u32(bake.counts.y));
  let x = layer % nx;
  let y = (layer / nx) % ny;
  let z = layer / (nx * ny);
  return bake.origin + vec3<f32>(f32(x), f32(y), f32(z)) * bake.spacing;
}

/*
 * The direction a ray takes, as a Fibonacci spiral turned by the frame.
 *
 * "probeDirection" is the reference and this is the same arithmetic. The
 * turn is what makes a probe *converge*: an unturned set samples the same 256 directions for ever,
 * so whatever falls between them is never seen however long the probe runs.
 */
fn bakeDirection(index: u32, frame: f32) -> vec3<f32> {
  let i = f32(index % PROBE_BAKE_DIRECTIONS);
  /* Offset by a half step at each end, so no direction lands exactly on a pole — where the turn
     has no effect and two frames would trace the same ray. */
  let z = 1.0 - (2.0 * i + 1.0) / f32(PROBE_BAKE_DIRECTIONS);
  let radius = sqrt(max(0.0, 1.0 - z * z));
  let angle = i * PROBE_BAKE_GOLDEN_ANGLE + frame * PROBE_BAKE_FRAME_TURN * PROBE_BAKE_TWO_PI;
  return vec3<f32>(cos(angle) * radius, sin(angle) * radius, z);
}
`;

/**
 * The two entry points, over buffers a caller binds.
 *
 * `schedule[i]` is the grid layer that slot `i` of this dispatch bakes, which is
 * `probeUpdateSchedule`'s output — a plain round robin, so every probe is reached and the same
 * frame index asks for the same probes.
 */
/*
 * Not exported, and `scripts/wgsl-handwritten.test.mjs` is why: it validates every exported string
 * that declares an entry point, and this one declares four over bindings a surrounding module
 * supplies. The whole modules are the functions below, and the gate names them.
 */
const PROBE_BAKE_ENTRIES_WGSL = /* wgsl */ `
@compute @workgroup_size(${String(PROBE_BAKE_WORKGROUP)})
fn traceMain(@builtin(global_invocation_id) id: vec3<u32>) {
  let total = u32(bake.scheduled) * PROBE_BAKE_DIRECTIONS;
  if (id.x >= total) { return; }
  let slot = id.x / PROBE_BAKE_DIRECTIONS;
  let ray = id.x % PROBE_BAKE_DIRECTIONS;

  let layer = schedule[slot];
  let point = bakeProbePosition(layer);
  let direction = bakeDirection(ray, bake.frame);
  /* Its own direction as its normal: a probe has no surface. The header says why. */
  let radiance = probeIndirect(point, direction, direction, march.coneAngle);

  let at = id.x * ${String(PROBE_RAY_FLOATS)}u;
  rays[at] = radiance.x;
  rays[at + 1u] = radiance.y;
  rays[at + 2u] = radiance.z;
}

@compute @workgroup_size(${String(PROBE_BAKE_WORKGROUP)})
fn convolveMain(@builtin(global_invocation_id) id: vec3<u32>) {
  let edge = u32(bake.edge);
  let texels = edge * edge;
  let total = u32(bake.scheduled) * texels;
  if (id.x >= total) { return; }
  let slot = id.x / texels;
  let texel = id.x % texels;
  let u = texel % edge;
  let v = texel / edge;

  let normal = bakeOctInsetDir(
    vec2<f32>((f32(u) + 0.5) / bake.edge, (f32(v) + 0.5) / bake.edge),
    bake.edge,
  );

  /*
   * **Normalised by the weights that were actually used**, which is the whole white-furnace
   * property and is "convolveProbe"'s own decision. Dividing by an analytic constant is right only
   * in the limit, so a uniformly white sphere would come back slightly off white and a room would
   * brighten or darken a little at every refresh.
   */
  var weights = 0.0;
  var sum = vec3<f32>(0.0);
  for (var i = 0u; i < PROBE_BAKE_DIRECTIONS; i = i + 1u) {
    let direction = bakeDirection(i, bake.frame);
    let weight = dot(normal, direction);
    if (weight <= 0.0) { continue; }
    let at = (slot * PROBE_BAKE_DIRECTIONS + i) * ${String(PROBE_RAY_FLOATS)}u;
    weights = weights + weight;
    sum = sum + vec3<f32>(rays[at], rays[at + 1u], rays[at + 2u]) * weight;
  }
  /* No weight at all is a texel no sample faced, which this set does not produce — and answering
     zero rather than dividing is what keeps it from being a hole if it ever does. */
  let scale = select(0.0, 1.0 / weights, weights > 0.0);
  let value = max(vec3<f32>(0.0), sum * scale);

  let out = id.x * ${String(PROBE_TEXEL_FLOATS)}u;
  irradiance[out] = value.x;
  irradiance[out + 1u] = value.y;
  irradiance[out + 2u] = value.z;
}
`;

/**
 * The parity module: the bake over plain buffers, with a radiance that is a function of position.
 *
 * **The radiance is positional for the reason `probeTraceParityWgsl` gives**: a march that landed a
 * voxel from where the reference landed would return almost the right answer from a smooth field
 * and exactly the right one from a constant, so a constant would check the convolution and nothing
 * about the trace.
 *
 * What this check is *for*, over and above `indirect-parity.mjs`, is the three pieces of arithmetic
 * that only exist in this file: the octahedral texel-to-direction fold, the layer-to-position
 * lattice, and the Fibonacci direction set. Each is a second spelling of something `octahedral.ts`,
 * `probeGrid.ts` and `probeTrace.ts` already hold, and a second spelling is what this repository
 * has learned to check rather than trust.
 */
export function probeBakeParityWgsl(): string {
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read> cascades: array<f32>;
@group(0) @binding(1) var<storage, read> fields: array<f32>;
${PROBE_MARCH_WGSL}
@group(0) @binding(2) var<uniform> march: ProbeMarch;
${PROBE_BAKE_STRUCT_WGSL}
@group(0) @binding(3) var<uniform> bake: ProbeBake;
@group(0) @binding(4) var<storage, read> schedule: array<u32>;
@group(0) @binding(5) var<storage, read_write> rays: array<f32>;
@group(0) @binding(6) var<storage, read_write> irradiance: array<f32>;
${PROBE_VOLUME_STRUCT_WGSL}
@group(0) @binding(7) var<uniform> volume: ProbeVolume;
/* Three floats a layer, which is what "sampleProbeVolume" blends in the reference. */
@group(0) @binding(8) var<storage, read> probeValues: array<f32>;
/* Six floats a query: a point and a direction. */
@group(0) @binding(9) var<storage, read> queries: array<f32>;
${SAMPLE_FIELD_WGSL}

/*
 * A layer's value, ignoring the texel it was asked for.
 *
 * **Flat on purpose, so the blend is checked and not the sampler.** The reference is
 * "sampleProbeVolume", which takes a fixed number of channels a layer; a parity module that
 * interpolated a map would be comparing a bilinear filter against something that has none. What
 * the octahedral coordinate does is checked separately, by "uvMain" against "octInsetUv".
 */
fn probeLayerSample(layer: u32, uv: vec2<f32>) -> vec3<f32> {
  let at = layer * 3u;
  return vec3<f32>(probeValues[at], probeValues[at + 1u], probeValues[at + 2u]);
}

/* The same flat value: this module checks the blend, and what a production texture holds at its
   two levels is what makes them different. */
fn probeLayerIrradiance(layer: u32, uv: vec2<f32>) -> vec3<f32> {
  return probeLayerSample(layer, uv);
}
${PROBE_VOLUME_CORE_WGSL}

fn probeFieldAt(p: vec3<f32>) -> f32 {
  return sampleField(march.levels, march.side, p);
}

fn probeFieldInside(p: vec3<f32>) -> f32 {
  return insideBy(march.levels - 1u, p);
}

/* The same expression the harness evaluates, and the reason it is a sine of position. */
fn probeParityRadiance(p: vec3<f32>) -> vec3<f32> {
  return vec3<f32>(
    0.5 + 0.4 * sin(p.x * 1.3),
    0.5 + 0.4 * sin(p.y * 1.7 + 1.0),
    0.5 + 0.4 * sin(p.z * 2.3 + 2.0),
  );
}

/* One expression for both, so this module still checks the march and the blend and nothing else. */
fn probeSurfaceRadiance(p: vec3<f32>, towards: vec3<f32>) -> vec3<f32> {
  return probeParityRadiance(p);
}

fn probeDistantRadiance(p: vec3<f32>, towards: vec3<f32>) -> vec3<f32> {
  return probeParityRadiance(p);
}
${PROBE_TRACE_CORE_WGSL}
${PROBE_BAKE_CORE_WGSL}
${PROBE_BAKE_ENTRIES_WGSL}

/*
 * Three probes for the three pieces of arithmetic that exist only in this file, so each is checked
 * on its own rather than through the answer it contributes to.
 *
 * **Without them the check would be end-to-end and could not say which spelling was wrong.** A
 * direction set off by a thousandth and an octahedral fold off by a thousandth produce the same
 * symptom — a texel slightly wrong — and a single number cannot tell a caller which to go and read.
 * They also let the radiance comparison feed the reference the device's *own* direction, which is
 * what keeps a float's last place in an accumulated angle from being reported as a trace failure.
 */
@compute @workgroup_size(${String(PROBE_BAKE_WORKGROUP)})
fn directionMain(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= PROBE_BAKE_DIRECTIONS) { return; }
  let d = bakeDirection(id.x, bake.frame);
  let at = id.x * 3u;
  irradiance[at] = d.x;
  irradiance[at + 1u] = d.y;
  irradiance[at + 2u] = d.z;
}

@compute @workgroup_size(${String(PROBE_BAKE_WORKGROUP)})
fn positionMain(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= u32(bake.scheduled)) { return; }
  let p = bakeProbePosition(schedule[id.x]);
  let at = id.x * 3u;
  irradiance[at] = p.x;
  irradiance[at + 1u] = p.y;
  irradiance[at + 2u] = p.z;
}

/* The block as the device unpacked it, so a layout argument is settled by reading rather than
   reasoning. "BAKE_*" names the offsets a caller writes; this is what the struct made of them. */
@compute @workgroup_size(${String(PROBE_BAKE_WORKGROUP)})
fn echoMain(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x != 0u) { return; }
  irradiance[0] = bake.origin.x;
  irradiance[1] = bake.origin.y;
  irradiance[2] = bake.origin.z;
  irradiance[3] = bake.spacing.x;
  irradiance[4] = bake.spacing.y;
  irradiance[5] = bake.spacing.z;
  irradiance[6] = bake.counts.x;
  irradiance[7] = bake.counts.y;
  irradiance[8] = bake.counts.z;
  irradiance[9] = bake.edge;
  irradiance[10] = bake.frame;
  irradiance[11] = bake.scheduled;
}

/* The encode, which is a different function from the fold "texelMain" checks and needs its own. */
@compute @workgroup_size(${String(PROBE_BAKE_WORKGROUP)})
fn uvMain(@builtin(global_invocation_id) id: vec3<u32>) {
  let at = id.x * 6u;
  if (at + 5u >= arrayLength(&queries)) { return; }
  let direction = vec3<f32>(queries[at + 3u], queries[at + 4u], queries[at + 5u]);
  let uv = probeOctInsetUv(direction, volume.edge);
  let out = id.x * 3u;
  irradiance[out] = uv.x;
  irradiance[out + 1u] = uv.y;
  irradiance[out + 2u] = 0.0;
}

/* And the eight-probe blend, against "nearestProbes" and "sampleProbeVolume" together. */
@compute @workgroup_size(${String(PROBE_BAKE_WORKGROUP)})
fn volumeMain(@builtin(global_invocation_id) id: vec3<u32>) {
  let at = id.x * 6u;
  if (at + 5u >= arrayLength(&queries)) { return; }
  let point = vec3<f32>(queries[at], queries[at + 1u], queries[at + 2u]);
  let value = probeVolumeRadianceAt(point);
  let out = id.x * 3u;
  irradiance[out] = value.x;
  irradiance[out + 1u] = value.y;
  irradiance[out + 2u] = value.z;
}

@compute @workgroup_size(${String(PROBE_BAKE_WORKGROUP)})
fn texelMain(@builtin(global_invocation_id) id: vec3<u32>) {
  let edge = u32(bake.edge);
  if (id.x >= edge * edge) { return; }
  let u = id.x % edge;
  let v = id.x / edge;
  let d = bakeOctInsetDir(
    vec2<f32>((f32(u) + 0.5) / bake.edge, (f32(v) + 0.5) / bake.edge),
    bake.edge,
  );
  let at = id.x * 3u;
  irradiance[at] = d.x;
  irradiance[at + 1u] = d.y;
  irradiance[at + 2u] = d.z;
}
`;
}

/**
 * The production module: the same core, reading the renderer's composed field and probe array.
 *
 * **`probeRadianceAt` is the probe volume here and a sine of position in the parity module**, which
 * is the whole reason the core takes it as an accessor. A probe traced against radiance that is
 * itself probe radiance converges on several bounces over a few refreshes — the maintainer's answer
 * of 2026-09-17 — and that is a property of what is bound rather than of the arithmetic.
 *
 * **The probe array is sampled while a later pass writes a mip of it, and that is legal.** WebGPU
 * forbids a texture being read and written inside one pass, not across two on one encoder: the
 * dispatches here read the array as it stood, and the blit that follows writes the levels the next
 * frame's dispatches will read. What that costs is a frame of latency in the bounce, which is what
 * a probe volume has anyway because it accumulates.
 */
export function probeBakeWgsl(): string {
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read> cascades: array<f32>;
@group(0) @binding(1) var<storage, read> fields: array<f32>;
${PROBE_MARCH_WGSL}
@group(0) @binding(2) var<uniform> march: ProbeMarch;
${PROBE_BAKE_STRUCT_WGSL}
@group(0) @binding(3) var<uniform> bake: ProbeBake;
@group(0) @binding(4) var<storage, read> schedule: array<u32>;
@group(0) @binding(5) var<storage, read_write> rays: array<f32>;
@group(0) @binding(6) var<storage, read_write> irradiance: array<f32>;
${PROBE_VOLUME_STRUCT_WGSL}
@group(0) @binding(7) var<uniform> volume: ProbeVolume;
@group(0) @binding(8) var probeArray: texture_2d_array<f32>;
@group(0) @binding(9) var probeSampler: sampler;
/* The colour of whatever won the union at each sample, three floats, same layout as the field. */
@group(0) @binding(10) var<storage, read> albedoField: array<f32>;
${SAMPLE_FIELD_WGSL}

/*
 * The albedo at a world point, from the finest cascade that holds it, by nearest sample.
 *
 * **Nearest and not trilinear, which the distance beside it is.** A distance is continuous and
 * interpolating it is the whole reason a field works; a colour is not. Blending across the seam
 * where a red wall meets a white one produces a pink that exists nowhere in the room, and it
 * produces it in exactly the band a bounce is most visible in. The nearest sample is a colour some
 * surface actually has.
 */
fn probeAlbedoAt(p: vec3<f32>) -> vec3<f32> {
  let last = march.levels - 1u;
  var level = last;
  for (var i = 0u; i <= last; i = i + 1u) {
    if (insideBy(i, p) > 0.0) {
      level = i;
      break;
    }
  }
  let base = level * ${String(8)}u;
  let low = vec3<f32>(cascades[base], cascades[base + 1u], cascades[base + 2u]);
  let step = cascades[base + 6u];
  let side = march.side;
  let count = f32(side);
  var index = vec3<u32>(0u, 0u, 0u);
  for (var axis = 0u; axis < 3u; axis = axis + 1u) {
    let local = (p[axis] - low[axis]) / step;
    index[axis] = u32(clamp(round(local), 0.0, count - 1.0));
  }
  let samples = side * side * side;
  let at = (level * samples + index.x + side * (index.y + side * index.z)) * 3u;
  return vec3<f32>(albedoField[at], albedoField[at + 1u], albedoField[at + 2u]);
}

fn probeFieldAt(p: vec3<f32>) -> f32 {
  return sampleField(march.levels, march.side, p);
}

fn probeFieldInside(p: vec3<f32>) -> f32 {
  return insideBy(march.levels - 1u, p);
}

/*
 * One probe's map, filtered.
 *
 * "textureSampleLevel" rather than "textureSample" because a compute shader has no derivatives to
 * pick a level from, and the level this wants is named rather than chosen: the irradiance level is
 * the cosine convolution and every other level is a roughness the bounce has no use for.
 */
fn probeLayerSample(layer: u32, uv: vec2<f32>) -> vec3<f32> {
  return textureSampleLevel(probeArray, probeSampler, uv, layer, volume.radianceLevel).rgb;
}

/* And the level this bake writes, which is where the second bounce comes from. */
fn probeLayerIrradiance(layer: u32, uv: vec2<f32>) -> vec3<f32> {
  return textureSampleLevel(probeArray, probeSampler, uv, layer, volume.level).rgb;
}
${PROBE_VOLUME_CORE_WGSL}

/*
 * The surface normal at a point on the field, as the field's own gradient.
 *
 * Central differences at one voxel, which is the coarsest spacing that is not the sampler's own
 * interpolation error: a narrower stencil on a trilinear field measures the tetrahedron the point
 * happens to sit in rather than the surface it belongs to.
 */
fn probeFieldNormal(p: vec3<f32>) -> vec3<f32> {
  let h = march.finestStep;
  let gradient = vec3<f32>(
    probeFieldAt(p + vec3<f32>(h, 0.0, 0.0)) - probeFieldAt(p - vec3<f32>(h, 0.0, 0.0)),
    probeFieldAt(p + vec3<f32>(0.0, h, 0.0)) - probeFieldAt(p - vec3<f32>(0.0, h, 0.0)),
    probeFieldAt(p + vec3<f32>(0.0, 0.0, h)) - probeFieldAt(p - vec3<f32>(0.0, 0.0, h)),
  );
  let reach = length(gradient);
  return select(vec3<f32>(0.0, 1.0, 0.0), gradient / reach, reach > 0.0);
}

/*
 * Whether the sun reaches a point, by marching the field towards it.
 *
 * **This is what makes the bounce follow a light that moves**, and it is the one thing a rasterised
 * probe bake cannot do without redrawing six faces per probe. A ray that leaves along the normal
 * and travels its whole reach without striking anything is lit.
 */
fn probeSunVisible(p: vec3<f32>, n: vec3<f32>) -> f32 {
  let hit = probeTraceField(p, n, bake.sunDir, 0.0);
  return select(1.0, 0.0, hit.hit);
}

/*
 * What a surface the ray struck sends back towards the probe.
 *
 * **Its albedo times the light reaching it**, which is the whole of Task 8 and the reason the
 * composed field carries a colour at all. A version of this that returned the probe volume's
 * irradiance gave a red wall and a white wall the same answer, because irradiance is light
 * arriving and what leaves a surface is that times its own colour.
 *
 * **The sun is evaluated here rather than read from a capture**, so a light that moves changes the
 * bounce at the next refresh. That is the thing a rasterised bake cannot do and the whole reason
 * this feature exists — see Task 8 of the indirect-light plan for the measurement that said so.
 *
 * Divided by pi because a Lambertian surface spreads what it receives over a hemisphere, and the
 * convolution that consumes these rays is a cosine integral expecting radiance.
 */
fn probeSurfaceRadiance(p: vec3<f32>, towards: vec3<f32>) -> vec3<f32> {
  let n = probeFieldNormal(p);
  let albedo = probeAlbedoAt(p);
  let facing = max(0.0, dot(n, bake.sunDir));
  let direct = bake.sunColour * facing * probeSunVisible(p, n);
  /*
   * And what has already bounced, which is the level this bake writes — so the loop closes.
   *
   * **Divided by pi once and not twice.** "convolveProbe" normalises by the cosine weights it
   * actually used, so what a probe stores is the cosine-weighted *mean radiance*, which is already
   * the irradiance over pi — the convention a Lambertian's outgoing radiance multiplies directly
   * by its albedo. Only the sun's own irradiance needs the division.
   */
  let bounced = probeVolumeIrradianceAt(p, n);
  return albedo * (direct * ${String(1 / Math.PI)} + bounced);
}

/*
 * And what a ray that left the world finds: the sky the frame is lit under.
 *
 * **Not the probe array's own level 0, and that was measured rather than reasoned.** Level 0 is a
 * *rasterised* capture taken once, so a ray reading it gathers the light the room had when the
 * capture was made — and a room whose red wall was repainted blue went on bouncing red, because
 * most of its rays escaped through the opening and read the capture. With the sky here instead,
 * **nothing in the trace reads anything rasterised**, which is what lets the whole solution follow
 * a scene that changes and is the sentence Wave 4's criterion asks for.
 *
 * No albedo and no sun: nothing was struck, so there is no surface to shade.
 */
fn probeDistantRadiance(p: vec3<f32>, towards: vec3<f32>) -> vec3<f32> {
  return bake.skyColour;
}
${PROBE_TRACE_CORE_WGSL}
${PROBE_BAKE_CORE_WGSL}
${PROBE_BAKE_ENTRIES_WGSL}
`;
}

/** Bytes between one blit's parameters and the next. A dynamic offset must be 256-aligned. */
export const PROBE_BLIT_STRIDE = 256;

/** Floats a blit's parameters hold: the slot, the map's edge, and the target level's edge. */
export const PROBE_BLIT_FLOATS = 4;

/**
 * Carrying a baked map into the probe array the shading already samples.
 *
 * **A render pass rather than a storage write, because the probe array is not a storage texture.**
 * It is created with `RENDER_ATTACHMENT | TEXTURE_BINDING` and its format is the surface's, which
 * needs a device feature before it can be written from compute. Rendering into one mip of one layer
 * needs neither, and the array already carries the usage for it.
 *
 * **The target edge is a parameter because not every level is the irradiance level.** A layer the
 * scene has never rasterised holds undefined contents in its roughness chain, and a fragment
 * sampling that is worse than a fragment sampling a flat colour. So a layer being filled for the
 * first time has every level written from the same map — blocky at level 0, which is the honest
 * thing a diffuse solution can say about a mirror — and every frame after that writes only the
 * irradiance level.
 */
export const PROBE_BLIT_WGSL = /* wgsl */ `
struct Blit {
  /* Which slot of this frame's dispatch, which is where its map starts in the buffer. */
  slot: f32,
  /* Texels across the baked map. */
  edge: f32,
  /* Texels across the level being written. Not named "target": WGSL reserves that word. */
  levelEdge: f32,
  pad: f32,
}

@group(0) @binding(0) var<uniform> blit: Blit;
@group(0) @binding(1) var<storage, read> irradiance: array<f32>;

@vertex
fn blitVert(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
  /* One triangle that covers the target, which needs no vertex buffer and no index buffer. */
  let x = f32((index << 1u) & 2u) * 2.0 - 1.0;
  let y = f32(index & 2u) * 2.0 - 1.0;
  return vec4<f32>(x, y, 0.0, 1.0);
}

@fragment
fn blitFrag(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  let edge = u32(blit.edge);
  /* Nearest rather than filtered: the source is eight texels and the seams are the octahedron's. */
  let u = min(u32(position.x * blit.edge / blit.levelEdge), edge - 1u);
  let v = min(u32(position.y * blit.edge / blit.levelEdge), edge - 1u);
  let at = (u32(blit.slot) * edge * edge + v * edge + u) * ${String(PROBE_TEXEL_FLOATS)}u;
  return vec4<f32>(irradiance[at], irradiance[at + 1u], irradiance[at + 2u], 1.0);
}
`;
