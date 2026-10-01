/**
 * What the lit shader is told about a DriftLight field this pass, decided once for both backends.
 *
 * **Decided here and bound there**, by the 2026-08-13 rule: each backend only uploads these numbers
 * to the names `driftLight.ts` declares, so the two cannot come to disagree about when the field is
 * on or what radius a pass uses. Off, which the shader reads as `light.x` of zero, until a field is
 * whole; and during a probe bake the radius is zero, because the exact lights were chosen for the
 * camera and a probe stands somewhere else: a probe sees every fixed light through the volume.
 *
 * **The radius is handed over measured from the eye**, because the shader measures from the
 * `uCameraPos` it already has rather than spending a uniform on the choice's centre. A point within
 * `r − |eye − centre|` of the eye is within `r` of the centre, so taking the offset off keeps every
 * pixel the shader shades exactly inside the radius the selection promised. A mirror's camera, far
 * from the centre, gets a smaller radius and more of the volume, which is the safe direction.
 */

import type { DriftLightVolumes } from './presence.ts';

export interface DriftLightUniforms {
  /** How much of the summed light is in, the radius, the band, the scale. */
  readonly light: Float32Array;
  /** The first sample, and the metres between samples — negative for a dense volume. */
  readonly origin: Float32Array;
}

export function createDriftLightUniforms(): DriftLightUniforms {
  return {
    light: new Float32Array(4),
    origin: new Float32Array(4),
  };
}

/**
 * Fill `out` for `field`, or for no field, seen from `eye`; `probePass` while a probe's faces are
 * being drawn.
 */
export function resolveDriftLight(
  field: DriftLightVolumes | null,
  probePass: boolean,
  eye: ArrayLike<number>,
  out: DriftLightUniforms,
): void {
  if (field === null || !field.ready || field.presence <= 0 || field.empty) {
    out.light.fill(0);
    return;
  }
  const offset = Math.hypot(
    (eye[0] ?? 0) - (field.centre[0] as number),
    (eye[1] ?? 0) - (field.centre[1] as number),
    (eye[2] ?? 0) - (field.centre[2] as number),
  );
  out.light[0] = field.presence;
  out.light[1] = probePass ? 0 : Math.max(0, field.radius - offset);
  out.light[2] = field.band;
  out.light[3] = field.scale;
  out.origin[0] = field.sampleOrigin[0];
  out.origin[1] = field.sampleOrigin[1];
  out.origin[2] = field.sampleOrigin[2];
  out.origin[3] = field.signedSpacing;
}
