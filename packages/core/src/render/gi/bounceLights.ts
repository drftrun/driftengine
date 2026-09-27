/**
 * The frame's exact lights as DriftRay's probe bake reads them: what a surface a probe's ray
 * strikes is lit by, besides the sun, the bounce already in the grid and a DriftLight field.
 *
 * **Why the trace needs them at all.** A probe ray shades what it hits itself rather than reading
 * a capture, which is what lets the bounce follow a light that moves; but it shaded with the sun
 * alone, so a courtyard at night bounced no firelight into the corners the fires could not see. A
 * field carries the many fixed lights; these are the rest, the lights the frame shades one by one,
 * flickering and moving as they do in the frame.
 *
 * **Decided here and bound there**, by the 2026-08-13 rule: which lights, in what order and at what
 * weight is one decision for any backend that traces. A light a field sums carries a negative
 * weight and is left out, because the field already brings it to the bounce; a fading light goes in
 * at its weight, as the lit shader scales it.
 *
 * **At most `MAX_BOUNCE_LIGHTS`, the first the selection chose**, which is nearest the camera: each
 * one is a march per ray that reaches it, and a probe far from the camera is lit by lights further
 * down the list that this leaves out. What would change that is a scene whose bounce is dominated
 * by lights far from where it is looked at, which would want the selection run again from the grid.
 *
 * What it gives up against the frame: a photometric profile and a cookie, which the bounce reads as
 * a plain cone, and a light's specular, which a diffuse bounce has no use for.
 */

import type { PointLightSet } from '../lightBudget.ts';
import { POINT_LIGHT_COS_INNER, POINT_LIGHT_COS_OUTER } from '../clusteredLights.ts';

/** Lights the probe bake shades a hit with. */
export const MAX_BOUNCE_LIGHTS = 32;
/**
 * Floats a light takes: where it is and how far it reaches; its colour at its weight and the cosine
 * of its inner cone; the way it points and the cosine of its outer cone.
 */
export const BOUNCE_LIGHT_FLOATS = 12;

export function createBounceLights(): Float32Array {
  return new Float32Array(MAX_BOUNCE_LIGHTS * BOUNCE_LIGHT_FLOATS);
}

/** Pack the lights of `lights` the bounce reads into `out`, and answer how many. */
export function resolveBounceLights(lights: PointLightSet | null, out: Float32Array): number {
  if (lights === null) return 0;
  let count = 0;
  for (let i = 0; i < lights.lightCount && count < MAX_BOUNCE_LIGHTS; i++) {
    const weight = lights.lightWeights[i] ?? 0;
    const radius = lights.lightRadii[i] ?? 0;
    if (!(weight > 0) || !(radius > 0)) continue;
    const r = lights.lightColors[i * 3] ?? 0;
    const g = lights.lightColors[i * 3 + 1] ?? 0;
    const b = lights.lightColors[i * 3 + 2] ?? 0;
    if (!(r + g + b > 0)) continue;
    const at = count * BOUNCE_LIGHT_FLOATS;
    out[at] = lights.lightPositions[i * 3] ?? 0;
    out[at + 1] = lights.lightPositions[i * 3 + 1] ?? 0;
    out[at + 2] = lights.lightPositions[i * 3 + 2] ?? 0;
    out[at + 3] = radius;
    out[at + 4] = r * weight;
    out[at + 5] = g * weight;
    out[at + 6] = b * weight;
    out[at + 7] = lights.lightConeCos?.[i * 2] ?? POINT_LIGHT_COS_INNER;
    out[at + 8] = lights.lightDirections?.[i * 3] ?? 0;
    out[at + 9] = lights.lightDirections?.[i * 3 + 1] ?? 0;
    out[at + 10] = lights.lightDirections?.[i * 3 + 2] ?? 0;
    out[at + 11] = lights.lightConeCos?.[i * 2 + 1] ?? POINT_LIGHT_COS_OUTER;
    count++;
  }
  return count;
}
