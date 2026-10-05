import { describe, expect, it } from 'vitest';

import { SKIN_MAX_K, skinPenumbra, skinRing, skinTransmission } from './skinScatter.ts';

/** K₀, the modified Bessel function of the second kind: Abramowitz and Stegun 9.8.5 and 9.8.6. */
function besselK0(x: number): number {
  if (x <= 2) {
    const t = (x / 3.75) ** 2;
    const i0 =
      1 +
      t *
        (3.5156229 +
          t * (3.0899424 + t * (1.2067492 + t * (0.2659732 + t * (0.0360768 + t * 0.0045813)))));
    const y = (x * x) / 4;
    return (
      -Math.log(x / 2) * i0 +
      (-0.57721566 +
        y *
          (0.4227842 +
            y * (0.23069756 + y * (0.0348859 + y * (0.00262698 + y * (0.0001075 + y * 7.4e-6))))))
    );
  }
  const y = 2 / x;
  return (
    (Math.exp(-x) / Math.sqrt(x)) *
    (1.25331414 +
      y *
        (-0.07832358 +
          y *
            (0.02189568 +
              y * (-0.01062446 + y * (0.00587872 + y * (-0.0025154 + y * 0.00053208))))))
  );
}

/**
 * **The reference: the ring integral, done numerically.** Burley's profile
 * `(e^(−r/d) + e^(−r/3d)) / r`, projected onto a line — what a cylinder's cross-section receives
 * from the strip along its axis — is `K₀(x/d) + K₀(x/3d)`. Around a ring of radius R, a neighbour
 * at angle x lies a chord `2R sin(x/2)` away and sees the light at `cos(θ + x)`, clamped; the
 * average weights each by the profile. Samples cluster toward x = 0, where `K₀` has its logarithm.
 */
function ringIntegral(c: number, k: number): number {
  if (k === 0) return Math.max(c, 0);
  const theta = Math.acos(c);
  const n = 2000;
  let lit = 0;
  let weight = 0;
  for (let i = 0; i < n; i++) {
    const s = (i + 0.5) / n;
    const x = Math.PI * s * s * s;
    const u = (2 * Math.sin(x / 2)) / k;
    const w = (besselK0(u) + besselK0(u / 3)) * 3 * Math.PI * s * s;
    lit += w * (Math.max(Math.cos(theta + x), 0) + Math.max(Math.cos(theta - x), 0));
    weight += 2 * w;
  }
  return lit / weight;
}

describe('skin', () => {
  /*
   * **The fit is the integral to within 0.011**, everywhere it is used: `N·L` across its range and
   * `k` from 0 to the shader's clamp at 10, spaced more finely where the curve turns fastest. Its
   * worst, measured where the fit was made on a finer grid, is 0.0105, at a gently curved surface's
   * terminator.
   */
  it('IS THE RING INTEGRAL TO WITHIN 0.011, AT EVERY CURVATURE IT IS USED FOR', () => {
    let worst = 0;
    for (let ki = 0; ki <= 40; ki++) {
      const k = SKIN_MAX_K * (ki / 40) ** 2;
      for (let ci = 0; ci <= 80; ci++) {
        const c = -1 + ci / 40;
        worst = Math.max(worst, Math.abs(skinRing(c, k) - ringIntegral(c, k)));
      }
    }
    expect(worst).toBeLessThan(0.011);
    /* Past the clamp, the curvature is held where the fit was held: the shader does the same. */
    for (const c of [-0.5, 0, 0.7]) expect(skinRing(c, 25)).toBe(skinRing(c, SKIN_MAX_K));
  });

  /*
   * **A flat surface, or no scatter, is Lambert in every channel**: at `k = 0` the fit's four terms
   * are 1, 1, 0 and 0 exactly, so `½(c + |c|)` — not approximately.
   */
  it('IS LAMBERT AT NO CURVATURE, EXACTLY', () => {
    for (let ci = 0; ci <= 40; ci++) {
      const c = -1 + ci / 20;
      expect(skinRing(c, 0)).toBe(Math.max(c, 0));
    }
  });

  /*
   * **Light behind a thick part does not come through it.** At the default scatter, red travels
   * 1.02 cm: through an ear's centimetre it keeps exp(−0.98) = 0.375 of the light behind, blue at
   * 0.26 cm keeps exp(−3.85) = 0.021; through a cheek's ten centimetres red keeps exp(−9.8) =
   * 5.6e-5 and the rest nothing that a frame could show.
   */
  it('PASSES RED THROUGH AN EAR AND NOTHING THROUGH A CHEEK', () => {
    expect(skinTransmission(1, 0.01, 0.0102, 1)).toBeCloseTo(Math.exp(-0.01 / 0.0102), 12);
    expect(skinTransmission(1, 0.01, 0.0102, 1)).toBeCloseTo(0.375, 3);
    expect(skinTransmission(1, 0.01, 0.0026, 1)).toBeCloseTo(0.021, 3);
    expect(skinTransmission(1, 0.1, 0.0102, 1)).toBeLessThan(1e-4);
    expect(skinTransmission(-0.5, 0.01, 0.0102, 1)).toBe(0);
  });

  /*
   * **A shadow stays a shadow and light stays light**: the penumbra is reshaped between its ends and
   * never moves them, and a channel that travels further reaches further into it — at the middle of
   * a penumbra, red at 1.02 cm is lifted to 0.5^(1/1.51) = 0.632 and blue at 0.26 cm to 0.5^(1/1.13).
   */
  it('REDDENS A PENUMBRA WITHOUT MOVING ITS ENDS', () => {
    for (const d of [0, 0.0026, 0.0102, 0.05]) {
      expect(skinPenumbra(0, d)).toBe(0);
      expect(skinPenumbra(1, d)).toBe(1);
    }
    expect(skinPenumbra(0.5, 0.0102)).toBeCloseTo(0.5 ** (1 / 1.51), 9);
    expect(skinPenumbra(0.5, 0.0102)).toBeGreaterThan(skinPenumbra(0.5, 0.0026));
    expect(skinPenumbra(0.5, 0)).toBe(0.5);
  });
});
