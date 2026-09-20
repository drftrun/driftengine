/**
 * The colour a Gaussian shows from a direction: its constant term plus the degree-1 band.
 *
 * **This is the splat shader's line, in JavaScript.** A capture fitted here is drawn by
 * `@driftengine/splats`, so the two evaluations have to agree down to the sign of each basis —
 * `SH_C1 * (-direction.y * c0 + direction.z * c1 - direction.x * c2)`, clamped at zero, shaded by
 * the direction from the camera to the Gaussian in the capture's own world. A band evaluated with
 * a different order here fits coefficients that look right in the fitter and wrong in the game,
 * where it reads as a shader fault rather than as a capture that was never right.
 *
 * **Degree 1 and no further**, because that is what a record carries: nine coefficients and a
 * scale in one more texel, and `SPLAT_WORDS_SH1` is what decided it.
 */

/** The l=1 basis constant, as the shader's `SH_C1`. */
export const SH_C1 = 0.4886025119029199;

/** Nine coefficients a Gaussian, interleaved by basis and then by channel. */
export const SH1_COEFFICIENTS = 9;

/** The three degree-1 basis values for a direction, the band constant folded in, into `out`. */
export function sh1Basis(direction: ArrayLike<number>, out: Float64Array): void {
  out[0] = -SH_C1 * (direction[1] as number);
  out[1] = SH_C1 * (direction[2] as number);
  out[2] = -SH_C1 * (direction[0] as number);
}

/** Where a camera stands in the world, from a 3 × 4 world-to-camera: −Rᵀ · t. */
export function cameraCentre(worldToCamera: ArrayLike<number>, out: Float64Array): void {
  out[0] = 0;
  out[1] = 0;
  out[2] = 0;
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      out[c] =
        (out[c] as number) -
        (worldToCamera[r * 4 + c] as number) * (worldToCamera[r * 4 + 3] as number);
    }
  }
}

/**
 * The direction the band is shaded by: from `centre` to the Gaussian at `at`, normalised.
 *
 * A Gaussian standing exactly where the camera does has no direction to give. It answers with the
 * camera's own forward axis rather than a division by zero — which costs nothing, because a
 * Gaussian at the camera is behind the near plane and is not drawn.
 *
 * Answers the distance as well, because the gradient below divides by it: a direction is a
 * normalisation, and how much a step moves it depends on how far away the thing is.
 */
export function viewDirection(
  positions: ArrayLike<number>,
  at: number,
  centre: ArrayLike<number>,
  out: Float64Array,
): number {
  const x = (positions[at * 3] as number) - (centre[0] as number);
  const y = (positions[at * 3 + 1] as number) - (centre[1] as number);
  const z = (positions[at * 3 + 2] as number) - (centre[2] as number);
  const length = Math.sqrt(x * x + y * y + z * z);
  if (!(length > 0)) {
    out[0] = 0;
    out[1] = 0;
    out[2] = 1;
    return 0;
  }
  out[0] = x / length;
  out[1] = y / length;
  out[2] = z / length;
  return length;
}

/** A Gaussian's colour from a direction whose basis is already resolved, clamped at zero. */
export function splatColour(
  colors: ArrayLike<number>,
  sh1: ArrayLike<number> | undefined,
  at: number,
  basis: ArrayLike<number>,
  out: Float64Array,
): void {
  for (let c = 0; c < 3; c += 1) {
    let value = colors[at * 3 + c] as number;
    if (sh1 !== undefined) {
      for (let band = 0; band < 3; band += 1) {
        value += (basis[band] as number) * (sh1[at * SH1_COEFFICIENTS + band * 3 + c] as number);
      }
    }
    out[c] = value > 0 ? value : 0;
  }
}

/**
 * The band's own gradient by the **direction** it was shaded from, into `out`.
 *
 * The colour is `−C·u_y·c₀ + C·u_z·c₁ − C·u_x·c₂` a channel, so each axis of the direction gathers
 * one basis's coefficients. A channel the clamp flattened contributes nothing, exactly as it
 * contributes nothing to the constant term.
 *
 * What the caller still owes is the step from a direction to a position: a direction is a
 * normalisation, so only the part of a move across the line of sight turns it, and the amount it
 * turns by falls off with distance.
 */
export function sh1DirectionGradient(
  sh1: ArrayLike<number>,
  at: number,
  colour: ArrayLike<number>,
  dColour: ArrayLike<number>,
  out: Float64Array,
): void {
  out[0] = 0;
  out[1] = 0;
  out[2] = 0;
  for (let c = 0; c < 3; c += 1) {
    if (!((colour[c] as number) > 0)) continue;
    const weight = (dColour[c] as number) * SH_C1;
    const base = at * SH1_COEFFICIENTS;
    out[0] = (out[0] as number) - weight * (sh1[base + 6 + c] as number);
    out[1] = (out[1] as number) - weight * (sh1[base + c] as number);
    out[2] = (out[2] as number) + weight * (sh1[base + 3 + c] as number);
  }
}
