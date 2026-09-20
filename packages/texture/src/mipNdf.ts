/**
 * Mip levels for a normal map that get rougher instead of sparkling.
 *
 * **Averaging four normals and renormalising throws away how much they disagreed — and that
 * disagreement *is* roughness at the smaller scale.** What comes back is a distant surface whose
 * highlight flickers as the camera moves, which reads as an aliasing problem in the renderer and
 * is a mip chain problem in the asset.
 *
 * Every engine can do this and almost none does it by default, because it needs the mip chain to
 * write roughness as well as normals — which needs the two to live in one object. In a
 * DriftTexture they do, which is why this is the default here rather than an option.
 *
 * **The reduction adds variance and never removes it.** A surface already rough at the finer level
 * cannot become smoother by being viewed from further away.
 */

/**
 * How much roughness a shortened average normal implies.
 *
 * The averaged normal's length falls as the normals it averaged disagree, so `1 - length` is a
 * direct measure of the variance lost to averaging. Added in variance rather than in roughness,
 * because variances of independent sources add and roughnesses do not.
 */
export function toksvigRoughness(normalLength: number, roughness: number): number {
  const length = Math.min(1, Math.max(0, normalLength));
  const added = 1 - length;
  return Math.sqrt(Math.min(1, roughness * roughness + added));
}

/**
 * Reduce a block of normals to one, writing both the direction and the roughness it implies.
 *
 * `src` holds `width * height` normals as xyz triples, already unbiased into -1..1.
 */
export function reduceNormalMip(
  src: Float32Array,
  width: number,
  height: number,
  outNormal: Float32Array,
  outRoughness: Float32Array,
  baseRoughness = 0,
): void {
  let x = 0;
  let y = 0;
  let z = 0;
  const count = width * height;
  for (let i = 0; i < count; i += 1) {
    x += src[i * 3] as number;
    y += src[i * 3 + 1] as number;
    z += src[i * 3 + 2] as number;
  }
  x /= count;
  y /= count;
  z /= count;

  /* The length before normalising is the whole signal. Normalising first discards it. */
  const length = Math.hypot(x, y, z);
  const k = length > 0 ? 1 / length : 0;
  outNormal[0] = x * k;
  outNormal[1] = y * k;
  outNormal[2] = z * k;
  outRoughness[0] = toksvigRoughness(length, baseRoughness);
}
