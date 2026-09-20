/** The three levels in one place, and the rule that there is never a fourth. */

import { createProbeBlend } from '../probeGrid.ts';
import { REFLECTION_EDGE_FADE, edgeFade, newScreenSpaceHit } from '../screenSpaceReflection.ts';
import { GLOBAL_FIELD_BLEND } from './globalField.ts';
import { sampleProbeVolume, visibleProbes } from './probeVolume.ts';
import { FIELD_MARCH, newFieldHit, traceField } from './traceField.ts';
import { GI_SCREEN_MARCH, traceScreen } from './traceScreen.ts';

import type { ReadonlyVec3 } from 'gl-matrix';
import type { ProbeGrid } from '../probeGrid.ts';
import type { ScreenSpaceMarch } from '../screenSpaceReflection.ts';
import type { GlobalField, GlobalFieldCascade } from './globalField.ts';
import type { ProbeVisibility } from './probeVolume.ts';
import type { FieldMarch } from './traceField.ts';

/**
 * **Three levels, and the architecture is the fallback rather than any one of them.**
 *
 * `ROADMAP.md` refused screen-space global illumination, and this does not reverse that refusal —
 * it satisfies the requirement the refusal was about. Screen space is exact wherever the screen has
 * the answer and has *no* answer where it does not, which as a terminal technique means inventing
 * one from whatever happened to be in frame. Here it is an accelerator with something behind it:
 * a world-space distance field whose error is bounded by its own resolution, and behind that a
 * probe volume which is never wrong and only ever coarse.
 *
 * **The last level cannot fail, and that is the load-bearing sentence.** A ray with no answer
 * leaves a shader nothing to write but what the buffer held, which is the previous frame and reads
 * as a flicker. A probe volume is an interpolation between measurements — no ray to escape, no
 * frame to leave — and `visibleProbes` falls back to the nearest probe even when every visibility
 * weight has crushed to zero. So there are exactly three cases.
 *
 * **And the levels blend rather than switch.** Every boundary between them moves with the camera:
 * the frame's edge does by definition, and the cascades are centred on the camera so their faces do
 * too. A hard switch at a boundary that moves is a seam that sweeps across the picture whenever the
 * camera turns, which is worse than either level's own error — an error that is wrong everywhere
 * reads as a coarse solution, and one that changes abruptly along a surface reads as a crack.
 */

export const GI_SOURCE_SCREEN = 0;
export const GI_SOURCE_FIELD = 1;
export const GI_SOURCE_PROBES = 2;

export type GiSource = 0 | 1 | 2;

/** One indirect ray, as the shading path hands it over. */
export interface IndirectRay {
  /** Where it starts, on the surface being shaded. */
  readonly point: ReadonlyVec3;
  /** That surface's normal, which both traces lift off along. */
  readonly normal: ReadonlyVec3;
  readonly direction: ReadonlyVec3;
  /** Cone half-angle for the world trace. Zero is a mirror; wider is a rougher surface. */
  readonly coneAngle: number;
}

/** Everything the three levels need, gathered so a per-ray call takes one object. */
export interface GiResources {
  readonly eye: ReadonlyVec3;
  readonly project: (x: number, y: number, z: number, uv: Float32Array) => boolean;
  /** How far the eye is from whatever the frame drew, and `Infinity` where it drew nothing. */
  readonly sceneDistance: (u: number, v: number) => number;
  /** The radiance the frame holds at a screen position. */
  readonly screenRadiance: (u: number, v: number, out: Float32Array) => void;
  readonly field: GlobalField;
  /** The radiance at a world point the field trace arrived at. */
  readonly fieldRadiance: (x: number, y: number, z: number, out: Float32Array) => void;
  readonly grid: ProbeGrid;
  /** Null is the off switch, and it lands on the grid's own blend. See `probeVolume.ts`. */
  readonly visibility: ProbeVisibility | null;
  /** `probeChannels` floats a probe, layer-major. */
  readonly probeValues: Float32Array;
  readonly probeChannels: number;
  readonly screenMarch?: ScreenSpaceMarch;
  readonly fieldMarch?: FieldMarch;
}

export interface IndirectResult {
  /** Always true. See the module header: there is no fourth case. */
  hit: boolean;
  /** Which level contributed most. The radiance is the blend, not this level alone. */
  source: GiSource;
  /** Three channels. */
  readonly radiance: Float32Array;
  /** How much of the answer came from each level, summing to one. */
  readonly blend: Float32Array;
}

export function newIndirectResult(): IndirectResult {
  return {
    hit: false,
    source: GI_SOURCE_PROBES,
    radiance: new Float32Array(3),
    blend: new Float32Array(3),
  };
}

/** Scratch, because this runs once per ray per pixel and the rule about that is absolute. */
const SCREEN_HIT = newScreenSpaceHit();
const FIELD_HIT = newFieldHit();
const PROBE_BLEND = createProbeBlend();
const LEVEL = new Float32Array(3);
const PROBE_OUT = new Float32Array(3);

/**
 * Trace one indirect ray down the chain, and always answer.
 *
 * The screen answers as much as its distance from the edge of the frame allows; what is left goes
 * to the world field, as much as *its* distance from the edge of the outermost cascade allows; and
 * whatever is left after that goes to the probes, which have nothing behind them and take it all.
 */
export function traceIndirect(
  ray: IndirectRay,
  resources: GiResources,
  out: IndirectResult,
): IndirectResult {
  out.radiance.fill(0);
  out.blend.fill(0);
  out.hit = true;

  /* Level 0. Weighted by how far the hit landed from the edge of the frame, which is the one
     boundary a viewer is guaranteed to see move. */
  let screen = 0;
  if (
    traceScreen(
      ray.point,
      ray.normal,
      ray.direction,
      resources.eye,
      resources.screenMarch ?? GI_SCREEN_MARCH,
      resources.project,
      resources.sceneDistance,
      SCREEN_HIT,
    )
  ) {
    /*
     * **The *path*'s margin, not the hit's.** Fading only the hit leaves the seam exactly where it
     * was: a ray that grazes the border and lands is faded, and the ray one pixel over leaves the
     * frame and answers nothing at all, so the weight still steps from one to zero across a line
     * that sweeps as the camera turns. See `ScreenSpaceHit.margin`.
     */
    screen = edgeFade(SCREEN_HIT.margin, REFLECTION_EDGE_FADE);
    if (screen > 0) {
      resources.screenRadiance(SCREEN_HIT.u, SCREEN_HIT.v, LEVEL);
      add(out.radiance, LEVEL, screen);
    }
  }

  /* Level 1, for whatever the screen did not answer. Weighted the same way against the outermost
     cascade's face, because that face is centred on the camera and therefore moves with it too. */
  let fieldShare = 0;
  const remaining = 1 - screen;
  if (remaining > 0) {
    const march = resources.fieldMarch ?? FIELD_MARCH;
    const coned =
      march.coneAngle === ray.coneAngle ? march : { ...march, coneAngle: ray.coneAngle };
    if (traceField(resources.field, ray.point, ray.normal, ray.direction, coned, FIELD_HIT)) {
      fieldShare =
        remaining * fieldConfidence(resources.field, FIELD_HIT.x, FIELD_HIT.y, FIELD_HIT.z);
      if (fieldShare > 0) {
        resources.fieldRadiance(FIELD_HIT.x, FIELD_HIT.y, FIELD_HIT.z, LEVEL);
        add(out.radiance, LEVEL, fieldShare);
      }
    }
  }

  /*
   * Level 2, for everything still unanswered. **It takes whatever is left without asking**, which
   * is what "never wrong and only ever coarse" buys: there is no case where this declines.
   */
  const probes = 1 - screen - fieldShare;
  if (probes > 0) {
    visibleProbes(
      resources.grid,
      resources.visibility,
      ray.point[0] ?? 0,
      ray.point[1] ?? 0,
      ray.point[2] ?? 0,
      PROBE_BLEND,
    );
    sampleProbeVolume(PROBE_BLEND, resources.probeValues, resources.probeChannels, PROBE_OUT);
    add(out.radiance, PROBE_OUT, probes);
  }

  out.blend[0] = screen;
  out.blend[1] = fieldShare;
  out.blend[2] = probes;
  out.source =
    screen >= fieldShare && screen >= probes
      ? GI_SOURCE_SCREEN
      : fieldShare >= probes
        ? GI_SOURCE_FIELD
        : GI_SOURCE_PROBES;
  return out;
}

/**
 * How much a world-field hit is trusted, by how far inside the outermost cascade it landed.
 *
 * **The same band `sampleGlobalField` fades its own cascades over**, so the two do not disagree
 * about where the field stops being the answer. A hit right on the outer face is a hit the field
 * barely had the information for, and the probes are what carry it the rest of the way.
 */
function fieldConfidence(field: GlobalField, x: number, y: number, z: number): number {
  const outer = field.cascades[field.cascades.length - 1] as GlobalFieldCascade;
  const band = GLOBAL_FIELD_BLEND * ((outer.bounds[3] as number) - (outer.bounds[0] as number));
  if (band <= 0) return 1;
  const p = [x, y, z];
  let inside = Infinity;
  for (let axis = 0; axis < 3; axis++) {
    inside = Math.min(
      inside,
      (p[axis] as number) - (outer.bounds[axis] as number),
      (outer.bounds[axis + 3] as number) - (p[axis] as number),
    );
  }
  return Math.min(1, Math.max(0, inside / band));
}

/** `target += source * weight`, three channels. */
function add(target: Float32Array, source: Float32Array, weight: number): void {
  for (let channel = 0; channel < 3; channel++) {
    target[channel] = (target[channel] as number) + (source[channel] as number) * weight;
  }
}
