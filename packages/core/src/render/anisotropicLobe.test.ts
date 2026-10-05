import { expect, it } from 'vitest';

import { anisotropicAlphas, anisotropicLobe } from './anisotropicLobe.ts';
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
