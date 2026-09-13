import { mat4, vec3 } from 'gl-matrix';
import type { Vec3 } from '../math/color.ts';

/**
 * Orthographic view-projection for a directional light, covering a sphere of
 * `radius` around a focus point — normally the viewer or the player character.
 *
 * Focusing on the viewer rather than the whole world is what buys shadow
 * resolution: fitting the entire scene spends most of the depth map on geometry
 * nobody is looking at, which is what makes edges read as pixelated.
 *
 * The cost of a moving frustum is swimming edges, so the projection is snapped
 * to whole texel increments. That only works if the light's *view basis* is
 * fixed — it depends on the light direction alone, with every bit of focus
 * movement expressed through the snapped ortho bounds. Anchoring the eye to the
 * focus instead would shift light space underneath the snap and cancel it.
 */
const ORIGIN: vec3 = [0, 0, 0];
const scratchTarget = vec3.create();
const scratchFocus = vec3.create();
const scratchView = mat4.create();
const scratchProj = mat4.create();

const UP: vec3 = [0, 1, 0];
/** Used when the light is near-vertical and `UP` would be degenerate. */
const UP_FALLBACK: vec3 = [0, 0, 1];

export function computeLightMatrix(
  lightDir: Vec3,
  focusX: number,
  focusY: number,
  focusZ: number,
  radius: number,
  shadowMapSize: number,
  out: mat4,
): number {
  const up = Math.abs(lightDir[1]) > 0.999 ? UP_FALLBACK : UP;

  // View basis only — eye pinned at the origin, looking along -lightDir.
  vec3.set(scratchTarget, -lightDir[0], -lightDir[1], -lightDir[2]);
  mat4.lookAt(scratchView, ORIGIN, scratchTarget, up);

  // Where the focus lands in that fixed light space.
  vec3.set(scratchFocus, focusX, focusY, focusZ);
  vec3.transformMat4(scratchFocus, scratchFocus, scratchView);

  // Snap the frustum centre to the texel grid so edges stay put frame to frame.
  const texelWorldSize = (radius * 2) / shadowMapSize;
  const cx = Math.round(scratchFocus[0] / texelWorldSize) * texelWorldSize;
  const cy = Math.round(scratchFocus[1] / texelWorldSize) * texelWorldSize;
  // View space looks down -Z, so distance in front of the eye is -z. Snapped
  // like x and y: an unsnapped depth range leaves the matrix drifting every
  // frame, which defeats the point even though depth alone does not swim.
  const cz = Math.round(-scratchFocus[2] / texelWorldSize) * texelWorldSize;

  mat4.ortho(
    scratchProj,
    cx - radius,
    cx + radius,
    cy - radius,
    cy + radius,
    cz - radius * 3,
    cz + radius * 3,
  );
  mat4.multiply(out, scratchProj, scratchView);
  // Orthographic depth is linear. The receiving shader uses this exact span
  // to express its residual depth tolerance in stable world-space metres.
  return radius * 6;
}
