import { expect, it } from 'vitest';

import { anisotropicAlphas, anisotropicLobe, anisotropicPhysicalLobe } from './anisotropicLobe.ts';
import { specularLobe } from './gpudriven/lit.ts';

/*
 * **At strength 0 the anisotropic lobe is the standard one**, at every half vector: a material that
 * turns its anisotropy down to nothing must draw what it drew without the model. Swept over half
 * vectors tilted every way from the normal, at three roughnesses including the floor.
 */
it('IS THE STANDARD LOBE AT STRENGTH 0, AT EVERY HALF VECTOR', () => {
  const alphas = new Float64Array(2);
  for (const roughness of [0.05, 0.35, 0.8]) {
    anisotropicAlphas(roughness, 0, alphas);
    for (let k = 0; k < 64; k++) {
      const tilt = (k / 63) * 1.4;
      const turn = k * 2.399963;
      const th = Math.sin(tilt) * Math.cos(turn);
      const bh = Math.sin(tilt) * Math.sin(turn);
      const nh = Math.cos(tilt);
      const lobe = anisotropicLobe(th, bh, nh, alphas[0] as number, alphas[1] as number);
      expect(lobe).toBeCloseTo(specularLobe(nh, roughness), 9);
    }
  }
});

/*
 * **The highlight is stretched along the direction by the widths' own ratio.** Where the lobe falls
 * to half its peak, tilted from the normal by s along one axis: 1/(s²/α² + 1 − s²)² = ½, so
 * s² = (√2 − 1)/(1/α² − 1). At roughness ≈ 0.316 (α 0.1) and strength 0.5, αT = 0.1 + 0.9 × 0.25 =
 * 0.325 and αB = 0.1, so the stretch is √((1/0.01 − 1)/(1/0.105625 − 1)) = √(99 / 8.4675) = 3.4194 —
 * found here by bisection on the lobe itself, along each axis.
 */
it('STRETCHES THE HIGHLIGHT ALONG ITS DIRECTION BY THE WIDTHS’ OWN RATIO', () => {
  const alphas = new Float64Array(2);
  anisotropicAlphas(Math.sqrt(0.1), 0.5, alphas);
  expect(alphas[0]).toBeCloseTo(0.325, 12);
  expect(alphas[1]).toBeCloseTo(0.1, 12);
  const halfWidth = (along: boolean): number => {
    let low = 0;
    let high = 1;
    for (let k = 0; k < 60; k++) {
      const s = (low + high) / 2;
      const c = Math.sqrt(1 - s * s);
      const lobe = anisotropicLobe(
        along ? s : 0,
        along ? 0 : s,
        c,
        alphas[0] as number,
        alphas[1] as number,
      );
      if (lobe > 0.5) low = s;
      else high = s;
    }
    return low;
  };
  expect(halfWidth(true) / halfWidth(false)).toBeCloseTo(3.4194, 3);
  expect(anisotropicLobe(0, 0, 1, alphas[0] as number, alphas[1] as number)).toBe(1);
});

/*
 * **The physical lobe peaks at 1 / (4 αT αB) of the light, head-on**, which is what makes a polished
 * surface's highlight brighter than the look's peak of one: GGX's D at the mirror direction is
 * 1 / (π αT αB), and Smith's term with the BRDF's 1 / (4 N·L N·V) is 1/4 with light and view both
 * along the normal. Roughness 0.5 is α 0.25: a peak of 4 at strength 0, and at strength 1, αT 1 and
 * αB 0.25, a peak of 1.
 *
 * Off the normal, a lamp and an eye mirrored about it at N·L = N·V = 2/√5: π·D is 1/α² = 16 at the
 * mirror direction, and Smith's term is 0.5 / (2 N·L √(N·V² (1 − α²) + α²)), with N·V² (1 − α²) + α²
 * = 0.8 × 0.9375 + 0.0625 = 0.8125; times N·L, that is 4 / √0.8125.
 */
it('PEAKS AT 1 / (4 αT αB) HEAD-ON, AND IS ISOTROPIC GGX WITH ITS MASKING AT STRENGTH 0', () => {
  const alphas = new Float64Array(2);
  const normal = [0, 0, 1] as const;
  anisotropicAlphas(0.5, 0, alphas);
  expect(
    anisotropicPhysicalLobe(normal, normal, normal, alphas[0] as number, alphas[1] as number),
  ).toBeCloseTo(4, 9);
  const s = 1 / Math.sqrt(5);
  const light = [0, -s, 2 * s] as const;
  const view = [0, s, 2 * s] as const;
  expect(
    anisotropicPhysicalLobe(normal, light, view, alphas[0] as number, alphas[1] as number),
  ).toBeCloseTo(4 / Math.sqrt(0.8125), 9);
  anisotropicAlphas(0.5, 1, alphas);
  expect(alphas[0]).toBe(1);
  expect(
    anisotropicPhysicalLobe(normal, normal, normal, alphas[0] as number, alphas[1] as number),
  ).toBeCloseTo(1, 9);
});
