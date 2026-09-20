/** The matrix operations this package needs, written once so no two callers disagree. */

import { jitterClip } from '@driftengine/core';

/**
 * `out = a * b`, column-major, sixteen multiply-adds and no dependency.
 *
 * **Written here rather than pulling in `gl-matrix`**: this package needs one matrix product, a
 * few times a frame, and a runtime dependency is the thing `AGENTS.md` sets a high bar for. It is
 * in its own module rather than beside either caller because there are two of them — the pass
 * folding the clip correction into a projection, and the cull building a clip matrix — and two
 * copies of one decision is the 2026-08-17 rule however short the decision is.
 */
export function multiplyMat4(out: Float32Array, a: ArrayLike<number>, b: ArrayLike<number>): void {
  for (let column = 0; column < 4; column++) {
    const b0 = b[column * 4] ?? 0;
    const b1 = b[column * 4 + 1] ?? 0;
    const b2 = b[column * 4 + 2] ?? 0;
    const b3 = b[column * 4 + 3] ?? 0;
    for (let row = 0; row < 4; row++) {
      out[column * 4 + row] =
        (a[row] ?? 0) * b0 +
        (a[4 + row] ?? 0) * b1 +
        (a[8 + row] ?? 0) * b2 +
        (a[12 + row] ?? 0) * b3;
    }
  }
}

/**
 * Where the camera sits in a capture's own space, from the view and the model matrices.
 *
 * **View-dependent colour needs the direction in the frame the coefficients were trained in**, not
 * in world space: a capture turned, moved or scaled into a scene by `model` has had its whole
 * lighting rotated with it, and evaluating the harmonics against a world-space direction produces
 * a sheen that stays put while the capture turns underneath it.
 *
 * The camera is the origin of view space, so the point wanted is `inverse(view * model)` applied
 * to the origin — which is `−inverse(M3) · t` for the product's 3x3 part and its translation
 * column, and needs no full 4x4 inverse. A singular 3x3 means a model matrix that collapses the
 * capture to a plane, and the answer is then the origin rather than a division by zero: a capture
 * with no volume draws nothing whose colour anybody sees.
 *
 * Called once a frame per capture, which is what keeps it off the vertex stage where it would be
 * once per splat times six.
 */
export function cameraInCaptureSpace(
  out: Float32Array,
  view: ArrayLike<number>,
  model: ArrayLike<number>,
): void {
  multiplyMat4(PRODUCT, view, model);
  const m = PRODUCT;
  const a = m[0] ?? 0,
    b = m[4] ?? 0,
    c = m[8] ?? 0;
  const d = m[1] ?? 0,
    e = m[5] ?? 0,
    f = m[9] ?? 0;
  const g = m[2] ?? 0,
    h = m[6] ?? 0,
    i = m[10] ?? 0;
  const cofactor0 = e * i - f * h;
  const cofactor1 = f * g - d * i;
  const cofactor2 = d * h - e * g;
  const determinant = a * cofactor0 + b * cofactor1 + c * cofactor2;
  if (determinant === 0 || !Number.isFinite(determinant)) {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    return;
  }
  const inverse = 1 / determinant;
  const tx = m[12] ?? 0;
  const ty = m[13] ?? 0;
  const tz = m[14] ?? 0;
  out[0] = -(cofactor0 * tx + (c * h - b * i) * ty + (b * f - c * e) * tz) * inverse;
  out[1] = -(cofactor1 * tx + (a * i - c * g) * ty + (c * d - a * f) * tz) * inverse;
  out[2] = -(cofactor2 * tx + (b * g - a * h) * ty + (a * e - b * d) * tz) * inverse;
}

/** Scratch for the product above, so a frame allocates nothing. */
const PRODUCT = new Float32Array(16);

/**
 * The projection a frame draws a capture with: the caller's, moved by the frame's jitter, then
 * corrected for the backend. `scratch` holds sixteen floats and is overwritten.
 *
 * **In that order, because the jitter is stated in the camera's own convention** — see
 * `PrepareContext.jitter`. A reconstructed frame un-jitters every sample it takes, so a capture
 * drawn without the offset is placed up to half a render pixel from where the resolve looks for it,
 * differently each frame; and the correction negates y, so the same offset applied after it lands
 * on the other side of the pixel. A frame that is not reconstructed hands a zero jitter, and the
 * result is the corrected projection it always was.
 */
export function projectionForFrame(
  out: Float32Array,
  correction: ArrayLike<number>,
  projection: ArrayLike<number>,
  jitter: ArrayLike<number>,
  scratch: Float32Array,
): void {
  jitterClip(scratch, projection, jitter);
  multiplyMat4(out, correction, scratch);
}
