import type { Camera } from './camera.ts';

/**
 * What a planar reflection *is*, before any of it touches a device.
 *
 * Three decisions, none of which is a binding: where the mirrored camera stands, which half of
 * the world it may draw, and how large the target may be. A second copy of any of them is a
 * mirror that disagrees with itself — a reflection shot from a slightly different place, or one
 * that leaks the near bank of a pool into the water in front of it — and every one of those
 * reads as a shading problem rather than as a camera one. That is the 2026-08-13 rule in
 * `AGENTS.md`, applied to the pass with the most arithmetic in it.
 */

/**
 * Keeps fragments crossing the resting plane from opening a hairline seam.
 *
 * The clip is a plane test on a *displaced* surface, so geometry that touches the waterline
 * lands on both sides of it by a fraction of a millimetre depending on the wave. Three
 * centimetres of tolerance keeps the shoreline welded; more than that starts showing the
 * underside of things standing in the water.
 */
const CLIP_TOLERANCE = 0.03;

/**
 * Stand the camera on the other side of the plane, looking back.
 *
 * A mirror across a horizontal plane negates height about it and negates pitch, and leaves yaw
 * and the lens alone. **The aspect is the target's rather than the canvas's**: a reflection is
 * rendered at a scale, and projecting it at the canvas's aspect stretches the mirror against
 * the surface it is sampled onto.
 */
export function mirrorCamera(source: Camera, planeY: number, aspect: number, out: Camera): void {
  out.position[0] = source.position[0] ?? 0;
  out.position[1] = planeY * 2 - (source.position[1] ?? 0);
  out.position[2] = source.position[2] ?? 0;
  out.yaw = source.yaw;
  out.pitch = -source.pitch;
  out.fovYDeg = source.fovYDeg;
  out.near = source.near;
  out.far = source.far;
  out.updateMatrices(aspect);
}

/**
 * The half-space the mirrored pass may draw, as `dot(vec4(worldPos, 1), plane) >= 0`.
 *
 * **A mirror reflects the scene on the viewer's side of the plane**, so which side that is
 * follows the camera: above water it keeps y ≥ plane, below it keeps y ≤ plane. Deciding it
 * from a constant instead is a reflection that inverts the moment a swimmer's head goes under.
 */
export function reflectionClipPlane(sourceY: number, planeY: number, out: Float32Array): void {
  const side = sourceY >= planeY ? 1 : -1;
  out[0] = 0;
  out[1] = side;
  out[2] = 0;
  out[3] = -side * planeY + CLIP_TOLERANCE;
}

/** How large a reflection target may be, given the drawing buffer and the device's ceiling. */
export interface ReflectionSize {
  width: number;
  height: number;
}

/**
 * Size the target, clamped by **one shared factor** rather than per axis.
 *
 * Clamping each axis independently squashes the reflection on a drawing buffer wider than the
 * GPU's texture limit, because the mirror is then rendered at one aspect and sampled at
 * another. Scaling both by the tighter of the two ratios keeps it square and merely smaller.
 */
export function reflectionTargetSize(
  canvasWidth: number,
  canvasHeight: number,
  scale: number,
  maxTextureSize: number,
  out: ReflectionSize,
): ReflectionSize {
  const targetScale = Math.min(
    scale,
    maxTextureSize / Math.max(canvasWidth, 1),
    maxTextureSize / Math.max(canvasHeight, 1),
  );
  out.width = Math.max(Math.round(canvasWidth * targetScale), 1);
  out.height = Math.max(Math.round(canvasHeight * targetScale), 1);
  return out;
}
