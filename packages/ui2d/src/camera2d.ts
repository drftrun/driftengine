/** The affine that takes a point in a 2D world, or a CSS pixel, to normalised device coordinates. */

/**
 * Six numbers, laid out the way a 2D graphics API has laid them out for thirty years:
 *
 * ```
 * ndc.x = m[0] * x + m[2] * y + m[4]
 * ndc.y = m[1] * x + m[3] * y + m[5]
 * ```
 *
 * A `Float32Array` rather than six fields because it is uploaded as two `vec4`s and read by the
 * vertex stage every frame; an object would be repacked on the way.
 */
export type Affine2D = Float32Array;

export function createAffine2D(): Affine2D {
  return new Float32Array(6);
}

/** A 2D camera: where it is, how far in, and which way up. */
export interface Camera2D {
  /** World units. The point that lands on the middle of the viewport. */
  readonly x: number;
  readonly y: number;
  /**
   * Pixels per world unit, and it is the same on both axes on purpose.
   *
   * A separate x and y zoom is a non-uniform scale, which turns a circle into an ellipse and a
   * square tile into a rectangle — the caller who wants that has asked for a stretched picture and
   * can say so in the sprite's own size, where it is visible.
   */
  readonly zoom: number;
  /** Radians, anticlockwise. The world turns the other way; see `worldToNdc`. */
  readonly rotation?: number;
}

/**
 * The affine for a 2D world seen through a camera.
 *
 * **y counts upward**, which is the opposite of `screenToNdc` below and is deliberate: a 2D world is
 * a world, and a caller placing a platform above a floor should not have to subtract. A screen-space
 * overlay is the other convention because that is the one every layout system already uses, and the
 * two are different enough that sharing one would make each caller wrong half the time.
 *
 * Rotation turns the *camera*, so the world turns the other way: at `rotation = +π/2` the camera has
 * tilted its head anticlockwise and what was to its right is now above it.
 */
export function worldToNdc(
  camera: Camera2D,
  viewportWidth: number,
  viewportHeight: number,
  out: Affine2D,
): Affine2D {
  const rotation = camera.rotation ?? 0;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const perPixelX = 2 / viewportWidth;
  const perPixelY = 2 / viewportHeight;
  const a = camera.zoom * cos * perPixelX;
  const c = camera.zoom * sin * perPixelX;
  const b = -camera.zoom * sin * perPixelY;
  const d = camera.zoom * cos * perPixelY;
  out[0] = a;
  out[1] = b;
  out[2] = c;
  out[3] = d;
  out[4] = -(a * camera.x + c * camera.y);
  out[5] = -(b * camera.x + d * camera.y);
  return out;
}

/**
 * The affine for CSS pixels with a top-left origin — the convention `InsetRect` and `fillPanel`
 * already use, and the one a caller laying out an overlay already has.
 */
export function screenToNdc(
  viewportWidth: number,
  viewportHeight: number,
  out: Affine2D,
): Affine2D {
  out[0] = 2 / viewportWidth;
  out[1] = 0;
  out[2] = 0;
  out[3] = -2 / viewportHeight;
  out[4] = -1;
  out[5] = 1;
  return out;
}
