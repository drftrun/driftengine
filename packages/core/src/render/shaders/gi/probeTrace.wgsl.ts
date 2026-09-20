/**
 * A probe's own rays, on the device: `gi/chain.ts` minus its screen level.
 *
 * **A probe has no use for screen space, and including it would be a defect rather than a cost.**
 * The screen level is an accelerator for rays cast from the camera's own view, where the frame
 * already holds the answer. A probe stands in the world and its rays go everywhere, so most of them
 * leave the frame — and the few that do not would make a *cached* probe depend on where the camera
 * happens to be, so a probe would change its contents as the viewer turned and every surface it
 * lights would shimmer. So the chain is entered with a projector that answers "off screen" for
 * every point, which makes level 0 contribute exactly nothing and levels 1 and 2 take the whole
 * ray. The reference stays one function; this is that function with one input pinned.
 *
 * **What a field hit is worth comes from the probes**, which is the maintainer's answer of
 * 2026-09-17 and the reason `GiResources.fieldRadiance` is a function rather than a texture: a
 * probe traced against radiance that is itself probe radiance converges on several bounces over a
 * few refreshes. The direction it is read along is back down the ray — the light leaving that
 * surface *towards* the probe is what the probe is measuring — which the chain's own signature
 * leaves to the caller because it takes no direction.
 *
 * **One core, two modules**, as `shaders/recon/resolve.wgsl.ts` and `network.wgsl.ts` are. The
 * arithmetic reads the field and the probes through functions the including module defines, so the
 * production module can read the renderer's own buffers and the parity check can read plain ones of
 * the same numbers.
 *
 * The accessors an including module must define, before including the core:
 *
 * ```wgsl
 * fn probeFieldAt(p: vec3<f32>) -> f32          // the composed field's distance at a world point
 * fn probeFieldInside(p: vec3<f32>) -> f32      // how far inside the outermost cascade, negative outside
 * fn probeSurfaceRadiance(p: vec3<f32>, towards: vec3<f32>) -> vec3<f32>
 * fn probeDistantRadiance(p: vec3<f32>, towards: vec3<f32>) -> vec3<f32>
 * ```
 *
 * **Two, and it used to be one.** A ray that struck a wall and a ray that left the world need
 * different answers and the single accessor could not tell them apart: what leaves a wall is its
 * albedo times the light reaching it, and what a ray finds having left is whatever the probe
 * volume coarsely says is out there. Measured with one accessor, a red wall and a white wall
 * returned the same colour — `demo/dev/bounce.html`, and `plans/2026-09-17-indirect-light.md`
 * Task 8.
 *
 * and `march: ProbeMarch` as a uniform.
 */

import { GLOBAL_FIELD_BLEND } from '../../gi/globalField.ts';
import { FIELD_MARCH, FIELD_START_VOXELS } from '../../gi/traceField.ts';
import { SAMPLE_FIELD_WGSL } from './sampleField.wgsl.ts';

/**
 * Floats in the march block, which is sixteen because of how a uniform aligns rather than how many
 * numbers it holds: four counts, four lengths, and two `vec3`s that each take a whole four-float row.
 */
export const PROBE_MARCH_FLOATS = 16;

/** The workgroup a trace dispatches over: one invocation a direction. */
export const PROBE_TRACE_WORKGROUP = 64;

/** A number as WGSL always reads it as a float, so an integer constant is not an `i32`. */
function f(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : String(value);
}

export const PROBE_MARCH_WGSL = /* wgsl */ `
struct ProbeMarch {
  /* Steps a ray may take, the cascades it may read, and how many samples a cascade is a side. */
  steps: u32,
  levels: u32,
  side: u32,
  rayCount: u32,
  /* How far a ray may travel, how close to a surface counts as arriving, the finest voxel. */
  reachM: f32,
  hitEpsilonM: f32,
  finestStep: f32,
  coneAngle: f32,
  /* The outermost cascade's corners, for the confidence the last level is faded by. */
  outerLow: vec3<f32>,
  outerHigh: vec3<f32>,
}
`;

/**
 * The march and the two levels, as text.
 *
 * Defines `probeIndirect(point, normal, direction, coneAngle) -> vec3<f32>`, which is what one of a
 * probe's rays is worth.
 */
export const PROBE_TRACE_CORE_WGSL = /* wgsl */ `
const PROBE_FIELD_START_VOXELS: f32 = ${f(FIELD_START_VOXELS)};
const PROBE_FIELD_BLEND: f32 = ${f(GLOBAL_FIELD_BLEND)};

struct ProbeFieldHit {
  hit: bool,
  point: vec3<f32>,
}

/* A cone's radius at a distance. Zero angle is a ray, which is what a probe's rays are. */
fn probeConeRadius(distanceM: f32, coneAngle: f32) -> f32 {
  return select(0.0, distanceM * tan(coneAngle), coneAngle > 0.0);
}

/*
 * March one ray through the composed world field.
 *
 * **Lifted along the normal and only along the normal.** Pushing the start along the ray as well
 * double-counts: a ray leaving along its own normal would begin two offsets out and every distance
 * it reported would carry the second one. And it does not help the case that needs help — a tangent
 * ray pushed along itself is still on the surface, because a surface is what tangent means.
 */
fn probeTraceField(
  point: vec3<f32>,
  normal: vec3<f32>,
  direction: vec3<f32>,
  coneAngle: f32,
) -> ProbeFieldHit {
  var out: ProbeFieldHit;
  out.hit = false;
  out.point = point;

  /* Not named "length": a local of that name shadows the built-in and the next call to it fails. */
  let reach = length(direction);
  if (!(reach > 0.0)) { return out; }
  let unit = direction / reach;

  let start = PROBE_FIELD_START_VOXELS * march.finestStep;
  let normalLength = length(normal);
  let lifted = point + select(vec3<f32>(0.0), normal * (start / normalLength), normalLength > 0.0);

  var travelled = 0.0;
  for (var step = 0u; step < march.steps; step = step + 1u) {
    let at = lifted + unit * travelled;
    /*
     * **Outside the outermost cascade the march stops rather than sampling.** There is no
     * information out there: the sampler clamps to the edge, which is right for a sample and wrong
     * for a march — stepping on clamped values converges on the cascade's boundary and reports a
     * surface made of nothing.
     */
    if (probeFieldInside(at) <= 0.0) { return out; }

    let distance = probeFieldAt(at);
    if (distance <= probeConeRadius(travelled, coneAngle) + march.hitEpsilonM) {
      out.hit = true;
      out.point = at;
      return out;
    }
    /*
     * **Step by the distance, and by at least a quarter of a voxel.** A field whose value is
     * genuinely tiny beside a surface the cone is not wide enough to accept would otherwise take
     * ever-smaller steps and spend the whole budget arriving nowhere, which reads as a miss and
     * costs a fallback anyway. The floor makes that case terminate quickly instead.
     */
    travelled = travelled + max(distance, march.finestStep * 0.25);
    if (travelled > march.reachM) { return out; }
  }
  return out;
}

/*
 * How much of a field hit is trusted, faded across the outer tenth of the outermost cascade.
 *
 * Every boundary in this chain moves with the camera — the cascades are centred on it — and a hard
 * switch at a boundary that moves is a seam sweeping through the picture whenever the camera turns.
 */
fn probeFieldConfidence(p: vec3<f32>) -> f32 {
  let band = PROBE_FIELD_BLEND * (march.outerHigh.x - march.outerLow.x);
  if (band <= 0.0) { return 1.0; }
  let gap = min(p - march.outerLow, march.outerHigh - p);
  return clamp(min(gap.x, min(gap.y, gap.z)) / band, 0.0, 1.0);
}

/*
 * One of a probe's rays, as radiance.
 *
 * Level 1 answers as much as its distance from the outermost cascade's face allows; level 2 takes
 * whatever is left without asking, which is what "never wrong and only ever coarse" buys. There is
 * no case where the probes decline, and no fourth level to fall to.
 */
fn probeIndirect(
  point: vec3<f32>,
  normal: vec3<f32>,
  direction: vec3<f32>,
  coneAngle: f32,
) -> vec3<f32> {
  var radiance = vec3<f32>(0.0);
  var fieldShare = 0.0;

  let hit = probeTraceField(point, normal, direction, coneAngle);
  if (hit.hit) {
    fieldShare = probeFieldConfidence(hit.point);
    if (fieldShare > 0.0) {
      /* Back down the ray: what this surface sends *towards* the probe is what the probe measures. */
      radiance = radiance + probeSurfaceRadiance(hit.point, -direction) * fieldShare;
    }
  }

  let probes = 1.0 - fieldShare;
  if (probes > 0.0) {
    radiance = radiance + probeDistantRadiance(point + direction * march.reachM, -direction) * probes;
  }
  return radiance;
}
`;

/** `FIELD_MARCH`'s own numbers, so a caller fills the block from one place. */
export const PROBE_MARCH_DEFAULTS = FIELD_MARCH;

/**
 * The parity module: the core over plain buffers, with a radiance that is a function of position.
 *
 * **The radiance is positional on purpose.** A march that lands a voxel away from where the
 * reference landed would return almost the right answer from a smooth field and exactly the right
 * one from a constant, so a constant radiance would check the *blend* and nothing about the march.
 * A steep function of the hit's position turns a wrong hit into a wrong colour.
 *
 * `probeRadianceAt` is an accessor by design, so this check is of the march and the level blend
 * alone; what a probe volume answers is the production module's business and `probeVolume.test.ts`
 * is what holds that.
 */
export function probeTraceParityWgsl(): string {
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read> cascades: array<f32>;
@group(0) @binding(1) var<storage, read> fields: array<f32>;
${PROBE_MARCH_WGSL}
@group(0) @binding(2) var<uniform> march: ProbeMarch;
/* Seven floats a ray: the point, the normal, the direction. The cone angle is the march's. */
@group(0) @binding(3) var<storage, read> rays: array<f32>;
@group(0) @binding(4) var<storage, read_write> radiance: array<f32>;
${SAMPLE_FIELD_WGSL}

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

/* One expression for both, so this module keeps checking the march and the blend and nothing else. */
fn probeSurfaceRadiance(p: vec3<f32>, towards: vec3<f32>) -> vec3<f32> {
  return probeParityRadiance(p);
}

fn probeDistantRadiance(p: vec3<f32>, towards: vec3<f32>) -> vec3<f32> {
  return probeParityRadiance(p);
}
${PROBE_TRACE_CORE_WGSL}

@compute @workgroup_size(${PROBE_TRACE_WORKGROUP})
fn traceMain(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= march.rayCount) { return; }
  let at = id.x * 9u;
  let point = vec3<f32>(rays[at], rays[at + 1u], rays[at + 2u]);
  let normal = vec3<f32>(rays[at + 3u], rays[at + 4u], rays[at + 5u]);
  let direction = vec3<f32>(rays[at + 6u], rays[at + 7u], rays[at + 8u]);
  let value = probeIndirect(point, normal, direction, march.coneAngle);
  let out = id.x * 3u;
  radiance[out] = value.x;
  radiance[out + 1u] = value.y;
  radiance[out + 2u] = value.z;
}
`;
}
