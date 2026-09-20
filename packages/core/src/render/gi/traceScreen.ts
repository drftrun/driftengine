/** The first level of the chain: trace the frame, which is exact wherever the frame has the answer. */

import { traceScreenSpaceRay } from '../screenSpaceReflection.ts';

import type { ReadonlyVec3 } from 'gl-matrix';
import type { ScreenSpaceHit, ScreenSpaceMarch } from '../screenSpaceReflection.ts';

/**
 * **This module is thin, and that is the finding rather than a shortcut.**
 *
 * The plan for this wave asked for a screen-space first hit whose hardest requirement is that *a
 * ray leaving the screen returns a miss, never a clamped edge hit* — because a clamped edge hit is
 * exactly the unbounded error `ROADMAP.md` refused screen-space global illumination over.
 * `screenSpaceReflection.ts` already makes that refusal, in `projectToUv`, with the reasoning
 * written out and a test beside it: a point behind the eye has a negative `w` and divides into a
 * perfectly ordinary screen position somewhere else in the frame, and a point outside the frame
 * has no pixel at all. `traceScreenSpaceRay` already treats a hit as a *crossing* rather than a
 * comparison, which is the second requirement, and already carries a ray over a gap in the
 * geometry rather than stopping at its edge, which is the third.
 *
 * So writing a second march would be a second thing to be wrong, and the two would disagree about
 * a frame the day one of them was changed. What is here is the part global illumination owns that
 * a reflection does not: **where the ray starts.**
 *
 * A reflection begins at a surface a caller declared reflective and leaves it at the mirror angle,
 * so it moves away from that surface immediately. An indirect ray begins at whatever pixel is being
 * shaded and leaves it in a direction drawn from the hemisphere — which means a good fraction of
 * them leave nearly tangent, stay inside the depth buffer's own rounding of the surface for their
 * whole length, and find a crossing made of quantisation noise. That is a hit on the surface the
 * ray is standing on, taken by every pixel of a floor at once.
 */

/**
 * How far along the normal an indirect ray starts, in metres.
 *
 * **It has to be larger than the depth buffer's quantum and smaller than anything it could hide.**
 * Two centimetres is about twenty times the rounding of a 24-bit buffer over a hundred-metre range
 * at close quarters, and is below the contact detail a viewer reads — the gap where an object meets
 * a floor, which is the first thing indirect light is judged on.
 *
 * **What would make it wrong** is a scene whose unit is not the metre, which this engine's is; and
 * a depth range far enough that the quantum grows past it, which is a reason to bias by a fraction
 * of the sampled depth rather than by a constant. Nothing measured yet asks for that.
 */
export const SCREEN_TRACE_BIAS_M = 0.02;

/**
 * The march an indirect ray takes, which is not the one a mirror takes.
 *
 * **Shorter and coarser on purpose.** A reflection is read as a picture and wants the crossing
 * placed precisely; indirect light is integrated over a hemisphere and then filtered, so a step
 * that lands a few centimetres out is invisible and a step that is not taken at all is a miss that
 * costs a whole fallback. The reach is short because what is further away than a few metres is the
 * world-space field's question — that is the whole architecture of the chain.
 */
export const GI_SCREEN_MARCH: ScreenSpaceMarch = { steps: 16, reachM: 4, thicknessM: 0.5 };

/** Scratch, so a per-pixel trace allocates nothing. */
const ORIGIN = new Float32Array(3);

/**
 * Lift a point off the surface it stands on, along that surface's normal.
 *
 * A normal that is not unit length is normalised, because an interpolated one rarely is. A normal
 * of zero length has no direction to lift along, so the point is returned unmoved rather than as
 * three `NaN`s — which would reach the projection and come back as a miss for the wrong reason.
 */
export function screenRayOrigin(
  point: ReadonlyVec3,
  normal: ReadonlyVec3,
  biasM: number,
  out: Float32Array,
): Float32Array {
  const nx = normal[0] ?? 0;
  const ny = normal[1] ?? 0;
  const nz = normal[2] ?? 0;
  const length = Math.hypot(nx, ny, nz);
  const scale = length > 0 ? biasM / length : 0;
  out[0] = (point[0] ?? 0) + nx * scale;
  out[1] = (point[1] ?? 0) + ny * scale;
  out[2] = (point[2] ?? 0) + nz * scale;
  return out;
}

/**
 * Trace an indirect ray against the frame the renderer has already drawn.
 *
 * Returns whether the screen could answer. **A false here is the chain's instruction to keep
 * going**, not a statement that there is nothing there: the ray may have left the frame, gone
 * behind something, or simply run out of reach, and in every one of those cases the world-space
 * field has the next word. That is what makes this an accelerator rather than an answer, and it is
 * the distinction the refusal in `ROADMAP.md` rests on.
 */
export function traceScreen(
  point: ReadonlyVec3,
  normal: ReadonlyVec3,
  direction: ReadonlyVec3,
  eye: ReadonlyVec3,
  march: ScreenSpaceMarch,
  project: (x: number, y: number, z: number, uv: Float32Array) => boolean,
  sceneDistance: (u: number, v: number) => number,
  out: ScreenSpaceHit,
): boolean {
  screenRayOrigin(point, normal, SCREEN_TRACE_BIAS_M, ORIGIN);
  return traceScreenSpaceRay(ORIGIN, direction, eye, march, project, sceneDistance, out);
}
