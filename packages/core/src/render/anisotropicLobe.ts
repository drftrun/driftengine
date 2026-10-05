/**
 * The anisotropic model's lobe, as `shaders/flat/anisotropic.ts` computes it: the reference its
 * tests hold the arithmetic to, and nothing at run time calls it.
 *
 * **GGX stretched along a direction in the surface**, after glTF's `KHR_materials_anisotropy`: the
 * roughness across the direction is the material's, and along it is raised toward 1 by the
 * strength squared — `alphaT = mix(alpha, 1, strength²)`, `alphaB = alpha` — so a brushed disc's
 * highlight is a streak across its grooves.
 *
 * **Divided by its own peak, as `specularLobe` is**, because this engine's highlights are in those
 * units: a look control that peaks at 1 whatever its width, rather than an energy-conserving BRDF
 * (`lobes.ts` says why). So at strength 0 this *is* `specularLobe`, which is the property a material
 * that turns anisotropy down to nothing must have, and which the tests hold. **What it gives up** is
 * the Smith masking a physically based anisotropic lobe carries at grazing angles; the standard lobe
 * carries none either, and the two must agree at strength 0.
 */
import { MIN_LOBE_ALPHA } from './shaders/flat/lobes.ts';

/** The two widths, along the direction and across it, into `out` as [alongT, acrossB]. */
export function anisotropicAlphas(roughness: number, strength: number, out: Float64Array): void {
  const alpha = Math.max(roughness * roughness, MIN_LOBE_ALPHA);
  out[0] = alpha + (1 - alpha) * strength * strength;
  out[1] = alpha;
}

/**
 * The lobe at a half vector whose components along the direction, across it and along the normal
 * are `th`, `bh` and `nh`. 1 at the mirror direction.
 */
export function anisotropicLobe(
  th: number,
  bh: number,
  nh: number,
  alphaT: number,
  alphaB: number,
): number {
  const x = th / alphaT;
  const y = bh / alphaB;
  const d = x * x + y * y + nh * nh;
  return 1 / Math.max(d * d, 1e-8);
}
