/**
 * Where each pixel's surface was last frame.
 *
 * **A motion vector is the offset from this frame's pixel to where its surface was, in the
 * coordinates of an unjittered frame**, and every step of the reconstruction after this reads it
 * that way. The history is a picture of the unjittered scene; a vector that carried either frame's
 * jitter would look every sample up a fraction of a pixel away, in a pattern that repeats with the
 * jitter period — which reads as shimmer and is diagnosed as everything except its cause. So the
 * jitter is taken out of where a pixel was *observed* (`unjitteredUv`) and never put into the
 * matrices a vector is built from.
 *
 * **Two sources, one meaning.** Most of a frame did not move: its motion is the camera's, derived in
 * the resolve from depth through the reprojection matrix both renderers already build
 * (`cameraMotion`). A draw that states where it was last frame — a previous model matrix, a
 * previous skin palette — is drawn again into a motion target, and there the vector is the
 * difference of the vertex's two clip positions (`objectMotion`). A skinned vertex's previous
 * position comes from its previous *pose*, not from its previous model matrix: a character standing
 * still and swinging an arm has the same model both frames.
 *
 * **What this does not follow**: wind bending (`channelBend`) and morph targets move vertices by the
 * clock and by weights nothing keeps a previous value of. Their surfaces take the model's motion,
 * and the neighbourhood clip catches what is left.
 *
 * Coordinates are clip-up throughout: `u` and `v` run 0 to 1, with `v = 0` where clip y is -1.
 */

/** The motion target's format: the vector in two channels, and a flag where a draw wrote one. */
export const MOTION_FORMAT = 'rgba16float' as const;

/**
 * The camera's motion at a pixel: where the surface at `(u, v)` and `clipDepth` was last frame,
 * less where it is. `reprojection` is `previousViewProj × inverse(currentViewProj)`, unjittered,
 * in whatever depth convention `clipDepth` is given in.
 *
 * Returns false, and a zero vector, where the surface was behind last frame's eye: there is no
 * position to have been at, and a vector through the eye points anywhere.
 */
export function cameraMotion(
  reprojection: ArrayLike<number>,
  u: number,
  v: number,
  clipDepth: number,
  out: Float32Array,
): boolean {
  const x = u * 2 - 1;
  const y = v * 2 - 1;
  const m = reprojection;
  const w =
    (m[3] as number) * x + (m[7] as number) * y + (m[11] as number) * clipDepth + (m[15] as number);
  if (!(w > 0)) {
    out[0] = 0;
    out[1] = 0;
    return false;
  }
  const px =
    (m[0] as number) * x + (m[4] as number) * y + (m[8] as number) * clipDepth + (m[12] as number);
  const py =
    (m[1] as number) * x + (m[5] as number) * y + (m[9] as number) * clipDepth + (m[13] as number);
  out[0] = (px / w) * 0.5 + 0.5 - u;
  out[1] = (py / w) * 0.5 + 0.5 - v;
  return true;
}

/**
 * A drawn vertex's motion: its previous clip position less its current one, in uv units.
 *
 * Both positions are unjittered — the motion pass draws with the frame's unjittered matrices and
 * the vertex's two transforms. Returns false, and a zero vector, where either is behind its eye.
 */
export function objectMotion(
  currentClip: ArrayLike<number>,
  previousClip: ArrayLike<number>,
  out: Float32Array,
): boolean {
  const cw = currentClip[3] as number;
  const pw = previousClip[3] as number;
  if (!(cw > 0) || !(pw > 0)) {
    out[0] = 0;
    out[1] = 0;
    return false;
  }
  out[0] = ((previousClip[0] as number) / pw - (currentClip[0] as number) / cw) * 0.5;
  out[1] = ((previousClip[1] as number) / pw - (currentClip[1] as number) / cw) * 0.5;
  return true;
}

/**
 * A vertex through a skin palette: the four joints' matrices weighted and summed, then applied —
 * `SKINNING_GLSL`'s `skinMatrix()` times the position, in model space, before the model matrix.
 * `palette` is sixteen floats a joint, column-major. Written into `out`, four values.
 */
export function skinVertex(
  palette: ArrayLike<number>,
  joints: ArrayLike<number>,
  weights: ArrayLike<number>,
  position: ArrayLike<number>,
  out: Float64Array,
): void {
  const px = position[0] as number;
  const py = position[1] as number;
  const pz = position[2] as number;
  out[0] = 0;
  out[1] = 0;
  out[2] = 0;
  out[3] = 0;
  for (let influence = 0; influence < 4; influence += 1) {
    const weight = weights[influence] as number;
    if (weight === 0) continue;
    const at = (joints[influence] as number) * 16;
    for (let row = 0; row < 4; row += 1) {
      out[row] =
        (out[row] as number) +
        weight *
          ((palette[at + row] as number) * px +
            (palette[at + 4 + row] as number) * py +
            (palette[at + 8 + row] as number) * pz +
            (palette[at + 12 + row] as number));
    }
  }
}

/**
 * Where a sample observed at `(u, v)` in a frame jittered by `jitterX`, `jitterY` pixels of a
 * `width` by `height` target stands in the unjittered frame. `jitterProjection` moved the picture by
 * the jitter; this moves the observation back.
 */
export function unjitteredUv(
  u: number,
  v: number,
  jitterX: number,
  jitterY: number,
  width: number,
  height: number,
  out: Float32Array,
): void {
  out[0] = u - jitterX / width;
  out[1] = v - jitterY / height;
}
