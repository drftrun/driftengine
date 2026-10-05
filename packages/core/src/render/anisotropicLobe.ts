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

/** Three components in the lobe's frame: along the direction, across it, along the normal. */
export type FrameVector = readonly [number, number, number];

/**
 * The physical form of the same lobe, `π · D · Vis · N·L`, for a surface whose highlight is GGX's
 * own (`SurfaceMaterial.physicalSpecular`): the stretched distribution normalised as a BRDF's, and
 * Smith's height-correlated masking stretched with it (Heitz 2014, as Filament writes it), Fresnel
 * left to the caller. The half vector, the light and the view are each in the lobe's frame. At
 * strength 0 it is isotropic GGX, the term skin's and the eye's highlights are.
 */
export function anisotropicPhysicalLobe(
  half: FrameVector,
  light: FrameVector,
  view: FrameVector,
  alphaT: number,
  alphaB: number,
): number {
  const x = half[0] / alphaT;
  const y = half[1] / alphaB;
  const d = x * x + y * y + half[2] * half[2];
  const distribution = 1 / (Math.PI * alphaT * alphaB * d * d);
  const ndl = light[2];
  const ndv = view[2];
  const lambdaView = ndl * Math.hypot(alphaT * view[0], alphaB * view[1], ndv);
  const lambdaLight = ndv * Math.hypot(alphaT * light[0], alphaB * light[1], ndl);
  const visibility = 0.5 / Math.max(lambdaView + lambdaLight, 1e-5);
  return Math.PI * distribution * visibility * ndl;
}
