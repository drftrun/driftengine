/** A reflection is an indirect ray with a narrow cone, so it goes down the same chain. */

import { GI_SOURCE_SCREEN, traceIndirect } from './chain.ts';

import type { ReadonlyVec3 } from 'gl-matrix';
import type { GiResources, IndirectResult } from './chain.ts';

/**
 * **The plan asked for a fallback bolted onto `screenSpaceReflection.ts`, and this is beside it
 * instead.** That module is in `render/` and the chain is in `render/gi/`; importing upward would
 * put the whole global-illumination tree behind every scene that draws a mirror, which is the
 * opposite of the "off by default" this wave is built around. The dependency runs the other way
 * and `screenSpaceReflection.ts` is untouched — a scene that never asks for the fallback imports
 * none of this and renders exactly the frame it rendered before.
 *
 * What is left once the chain exists is small, and that is the point: **a reflection is an
 * indirect ray whose direction is the mirror of the view and whose cone is the roughness.** Writing
 * a second fallback for it would be a second thing to disagree with the first.
 */

/** A reflective surface, as a shading path holds one. */
export interface ReflectiveSample {
  readonly point: ReadonlyVec3;
  readonly normal: ReadonlyVec3;
  /** Which way the eye is looking, toward the surface. Need not be unit length. */
  readonly view: ReadonlyVec3;
  /** 0 is a mirror, 1 is fully diffuse. See `reflectionCone`. */
  readonly roughness: number;
}

export interface ReflectionOptions {
  /**
   * Whether a ray the frame cannot answer continues into the world.
   *
   * **Off is the shipped behaviour and off is the default a caller should assume.** With it off
   * this is `traceScreenSpaceRay` and nothing else: a miss is a miss, the surface keeps whatever
   * the existing fade leaves it, and every scene renders the frame it rendered before this file
   * existed. That is this wave's first global constraint, and it is asserted in the test rather
   * than trusted.
   */
  readonly fallback: boolean;
}

/**
 * Mirror a direction about a normal.
 *
 * `d - 2 (d . n) n`, with `n` normalised first because an interpolated normal is rarely unit — and
 * a normal of length 1.01 mirrors to a direction that is not unit either, which a march then takes
 * as a step length.
 *
 * **A direction already leaving the surface is mirrored back into it**, and that is not
 * special-cased into something else. A caller that hands over a view vector pointing away from the
 * surface has a bug one level up, and answering plausibly would hide it.
 */
export function reflectDirection(
  direction: ReadonlyVec3,
  normal: ReadonlyVec3,
  out: Float32Array,
): Float32Array {
  const dx = direction[0] ?? 0;
  const dy = direction[1] ?? 0;
  const dz = direction[2] ?? 0;
  let nx = normal[0] ?? 0;
  let ny = normal[1] ?? 0;
  let nz = normal[2] ?? 0;
  const length = Math.hypot(nx, ny, nz);
  if (length > 0) {
    nx /= length;
    ny /= length;
    nz /= length;
  }
  const along = 2 * (dx * nx + dy * ny + dz * nz);
  out[0] = dx - along * nx;
  out[1] = dy - along * ny;
  out[2] = dz - along * nz;
  return out;
}

/**
 * The cone half-angle a roughness reflects through.
 *
 * **`atan(roughness^2)`, which is the GGX lobe's own width rather than a curve chosen to look
 * right.** The distribution's half-angle at half its peak is close to `atan(alpha)` and `alpha` is
 * `roughness^2` in the parameterisation this engine uses everywhere else — `roughnessForLevel` in
 * `prefilterEnvMap.ts` maps a mip chain by the same square, so a surface that samples level three
 * of the prefiltered cube and a surface that cone-traces the world field agree about how blurred
 * they are. Two curves here would be two blurs that diverge with distance.
 *
 * Zero is exactly zero, so a mirror traces a pencil ray and no epsilon creeps into the one case a
 * viewer inspects most closely. One is `atan(1)`, a quarter turn's half — wide, and still short of
 * the hemisphere a fully diffuse surface gathers over, which is `traceIndirect`'s job and not this.
 */
export function reflectionCone(roughness: number): number {
  const clamped = roughness <= 0 ? 0 : roughness >= 1 ? 1 : roughness;
  return Math.atan(clamped * clamped);
}

/** Scratch, because this runs per reflective pixel. */
const MIRRORED = new Float32Array(3);

/**
 * Trace a reflection down the chain, or down its first level alone.
 *
 * With `fallback` off, only the screen answers and a miss stays a miss — which is what
 * `screenSpaceReflection.ts` has always done and what keeps every published scene where it is.
 * With it on, a ray leaving the frame continues into the world's distance field and, behind that,
 * the probes: a mirror at the edge of the picture reflects the world rather than fading to a matte
 * surface as the camera turns.
 */
export function traceReflection(
  surface: ReflectiveSample,
  resources: GiResources,
  options: ReflectionOptions,
  out: IndirectResult,
): IndirectResult {
  reflectDirection(surface.view, surface.normal, MIRRORED);
  const ray = {
    point: surface.point,
    normal: surface.normal,
    direction: MIRRORED,
    coneAngle: reflectionCone(surface.roughness),
  };

  if (options.fallback) return traceIndirect(ray, resources, out);

  /*
   * The screen alone. Reached by handing the chain a resource set whose other two levels cannot
   * contribute — rather than by a second copy of the march — so the frame's own answer is
   * byte-identical either way and cannot drift from the fallback path's.
   */
  traceIndirect(ray, { ...resources, ...SCREEN_ONLY }, out);
  if (out.blend[0] === 0) {
    out.hit = false;
    out.radiance.fill(0);
    out.blend.fill(0);
    out.source = GI_SOURCE_SCREEN;
  } else {
    /* What the frame could not answer is left unanswered rather than handed downward. */
    out.radiance[0] = (out.radiance[0] as number) / (out.blend[0] as number);
    out.radiance[1] = (out.radiance[1] as number) / (out.blend[0] as number);
    out.radiance[2] = (out.radiance[2] as number) / (out.blend[0] as number);
    out.blend[0] = 1;
    out.blend[1] = 0;
    out.blend[2] = 0;
    out.source = GI_SOURCE_SCREEN;
  }
  return out;
}

/**
 * The two levels below the screen, silenced.
 *
 * A field whose march can never hit and a probe set that carries nothing, so `traceIndirect` runs
 * its ordinary path and the screen's share is all there is to normalise. Frozen at module scope
 * because this is a per-pixel call and the rule about allocating in one is absolute.
 */
const SCREEN_ONLY = {
  fieldRadiance: (_x: number, _y: number, _z: number, out: Float32Array): void => {
    out.fill(0);
  },
  probeValues: new Float32Array(0),
  probeChannels: 0,
} as const;
