/**
 * A scene capture: a texture the world is drawn into from a camera of the caller's, which a material
 * then shows like any image — a screen in the world showing what a camera elsewhere sees, a monitor,
 * a security feed. The planar reflection's pass, for a caller's camera rather than a mirrored one.
 *
 * **It holds radiance, not display pixels**, as a probe does: drawn with the output transform held
 * off, at the colour format a probe takes — half floats under `hdrScene`, bytes otherwise — and
 * sampled linear, so a material showing it as its `emissive` emits the light the capture saw and the
 * frame's grade then applies once, to the screen as to everything around it.
 *
 * **What it gives up**: it is the mesh pass alone, as a probe bake is — the sky, water, particles and
 * anything else a scene draws after its world are in the capture only if the callback draws them;
 * no temporal resolve, bloom or other effect after the world runs on it; and it has no mip chain, so
 * a screen seen small and far shimmers where a mipmapped image would not.
 */

/** What a capture's texture is made from, in place of an image: its size and colour format. */
export interface SceneCaptureTexels {
  readonly kind: 'scene-capture';
  readonly width: number;
  readonly height: number;
  /** Half floats, which hold light past one; bytes otherwise. */
  readonly float: boolean;
}

/** The largest side a capture may have, the size every WebGL2 device must take. */
export const MAX_SCENE_CAPTURE_SIZE = 4096;

/** A capture's description, refused by name where a side is not a whole number of pixels it can be. */
export function sceneCaptureTexels(
  width: number,
  height: number,
  float: boolean,
): SceneCaptureTexels {
  for (const [name, side] of [
    ['width', width],
    ['height', height],
  ] as const) {
    if (!Number.isInteger(side) || side < 1 || side > MAX_SCENE_CAPTURE_SIZE) {
      throw new Error(
        `createSceneCapture: ${name} must be a whole number from 1 to ${MAX_SCENE_CAPTURE_SIZE}, ` +
          `not ${String(side)}`,
      );
    }
  }
  return { kind: 'scene-capture', width, height, float };
}

/** Whether a texture source is a capture's description rather than an image. */
export function isSceneCaptureTexels(source: unknown): source is SceneCaptureTexels {
  return (
    typeof source === 'object' &&
    source !== null &&
    (source as { kind?: unknown }).kind === 'scene-capture'
  );
}
