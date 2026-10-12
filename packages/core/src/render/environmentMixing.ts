/**
 * The environment a surface reflects brought to the light where it stands: `setEnvironmentMixing`'s
 * numbers as the lit stage reads them, `uEnvironmentMixing`. Both backends fill it here and upload
 * it, so a clamp cannot differ between them.
 *
 * **The weight is stored less one**, so a program a binder never wrote, all zeros, reflects exactly
 * as it did before the field existed; the two roughnesses beside it are where the weight is mixed in
 * between, smooth to rough.
 */

/** `uEnvironmentMixing` mixing nothing: a weight of 1, between the default roughnesses. */
export function noEnvironmentMixing(out: Float32Array): Float32Array {
  out[0] = 0;
  out[1] = 0.1;
  out[2] = 0.3;
  out[3] = 0;
  return out;
}

/**
 * A caller's weight and roughnesses, into `out`: a weight that is not a number at or above zero is
 * 1, the roughnesses are held to 0 to 1, and the upper never below the lower.
 */
export function resolveEnvironmentMixing(
  weight: number,
  roughnessLow: number,
  roughnessHigh: number,
  out: Float32Array,
): Float32Array {
  const unit = (value: number, fallback: number): number =>
    Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
  out[0] = (Number.isFinite(weight) && weight >= 0 ? weight : 1) - 1;
  const low = unit(roughnessLow, 0.1);
  out[1] = low;
  out[2] = Math.max(low, unit(roughnessHigh, 0.3));
  out[3] = 0;
  return out;
}

/** The factor a surface of `roughness` reflects by, as the lit stage computes it. */
export function environmentMixingFactor(mixing: ArrayLike<number>, roughness: number): number {
  const less = mixing[0] as number;
  if (less === 0) return 1;
  const low = mixing[1] as number;
  const span = Math.max((mixing[2] as number) - low, 1e-4);
  const t = Math.min(1, Math.max(0, (roughness - low) / span));
  return 1 + less * t * t * (3 - 2 * t);
}
