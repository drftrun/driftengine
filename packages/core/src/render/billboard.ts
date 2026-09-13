/** Model matrices for geometry that turns to face the viewer. */

import { mat4 } from 'gl-matrix';
import type { Camera } from './camera.ts';

/**
 * Orient a mesh so its +Z faces the camera, writing the model matrix in place.
 *
 * The two variants are a real distinction rather than a convenience pair, and picking
 * the wrong one is the classic billboard mistake:
 *
 * - **Cylindrical** (`billboardMatrixY`) spins about the world Y axis only. Anything
 *   standing on the ground uses this — a figure, a sign, a tree. Look down at it from
 *   above and it stays upright, because a thing with feet does not tilt to face you.
 * - **Spherical** (`billboardMatrix`) faces the camera on every axis. For something with
 *   no up of its own: a spark, a puff of smoke, a glow.
 *
 * Allocation-free: the caller owns the matrix and it is overwritten, so a frame drawing
 * a hundred of these allocates nothing.
 */
export function billboardMatrixY(
  out: mat4,
  x: number,
  y: number,
  z: number,
  cameraX: number,
  cameraZ: number,
  scaleX = 1,
  scaleY = 1,
): void {
  /*
   * Yaw from the camera's *horizontal* offset only. Using the full 3D direction is what
   * makes a standing figure lean back as the camera rises above it.
   */
  const angle = Math.atan2(cameraX - x, cameraZ - z);
  const sin = Math.sin(angle);
  const cos = Math.cos(angle);

  out[0] = cos * scaleX;
  out[1] = 0;
  out[2] = -sin * scaleX;
  out[3] = 0;

  out[4] = 0;
  out[5] = scaleY;
  out[6] = 0;
  out[7] = 0;

  out[8] = sin;
  out[9] = 0;
  out[10] = cos;
  out[11] = 0;

  out[12] = x;
  out[13] = y;
  out[14] = z;
  out[15] = 1;
}

/**
 * Face the camera on every axis, for geometry with no up of its own.
 *
 * Built from the camera's own basis rather than from the direction to the eye, so a row
 * of these stays mutually parallel instead of fanning out toward the viewer — the
 * difference is obvious the moment two are near each other at the screen edge.
 */
export function billboardMatrix(
  out: mat4,
  x: number,
  y: number,
  z: number,
  camera: Camera,
  scaleX = 1,
  scaleY = 1,
): void {
  // The view matrix's upper 3x3 is the camera basis, transposed; its rows are the
  // world-space right/up/forward we want the quad's axes to be.
  const view = camera.view;
  const rightX = view[0];
  const rightY = view[4];
  const rightZ = view[8];
  const upX = view[1];
  const upY = view[5];
  const upZ = view[9];
  const forwardX = view[2];
  const forwardY = view[6];
  const forwardZ = view[10];

  out[0] = rightX * scaleX;
  out[1] = rightY * scaleX;
  out[2] = rightZ * scaleX;
  out[3] = 0;

  out[4] = upX * scaleY;
  out[5] = upY * scaleY;
  out[6] = upZ * scaleY;
  out[7] = 0;

  out[8] = forwardX;
  out[9] = forwardY;
  out[10] = forwardZ;
  out[11] = 0;

  out[12] = x;
  out[13] = y;
  out[14] = z;
  out[15] = 1;
}
