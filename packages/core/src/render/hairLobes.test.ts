import { describe, expect, it } from 'vitest';

import {
  HAIR_OUT,
  HAIR_SCATTER_SPHERE,
  hairFresnel,
  hairIndirect,
  hairLight,
  hairLongitudinal,
} from './hairLobes.ts';

const TANGENT = [1, 0, 0];
const WHITE: [number, number, number] = [1, 1, 1];

/** A direction at `sinTheta` along the strand, turned `phi` around it from +Y. */
function around(sinTheta: number, phi: number): number[] {
  const c = Math.sqrt(1 - sinTheta * sinTheta);
  return [sinTheta, c * Math.cos(phi), c * Math.sin(phi)];
}

/** The light's `sinθ` in [−0.5, 0.5] at which `lobe` of `hairLight` is brightest, the eye held still. */
function peak(lobe: number, phi: number, shift: number): number {
  const out = new Float64Array(HAIR_OUT.length);
  const eye = around(0, 0);
  let best = -1;
  let at = 0;
  for (let k = 0; k <= 100000; k++) {
    const s = -0.5 + k / 100000;
    hairLight(TANGENT, around(s, phi), eye, WHITE, 0.25, shift, 0.5, 0.7, 1, 0, 0, out);
    const value = out[lobe] as number;
    if (value > best) {
      best = value;
      at = s;
    }
  }
  return at;
}

/**
 * The three lobes of a white strand, integrated over every direction a light can arrive from and
 * divided by π: what the strand returns per unit of what reaches it, in this engine's lamp units.
 */
function returned(roughness: number, view: number, sourceRadius: number, dist: number): number {
  const out = new Float64Array(HAIR_OUT.length);
  const eye = around(Math.sin(view), 0.4);
  const n = 160;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < 2 * n; j++) {
      const l = around(-1 + (2 * (i + 0.5)) / n, (Math.PI * (j + 0.5)) / n);
      hairLight(TANGENT, l, eye, WHITE, roughness, 0.05, 0.5, 0.7, 1, sourceRadius, dist, out);
      sum += (out[HAIR_OUT.r] as number) + (out[HAIR_OUT.tt] as number);
      sum += out[HAIR_OUT.trt] as number;
    }
  }
  return (sum * (4 * Math.PI)) / (2 * n * n) / Math.PI;
}

describe('hair', () => {
  /*
   * **Each lobe sits where the cuticle's tilt puts it**, in `sinθi + sinθo`: R at −2s, toward the
   * root; TT at +s and TRT at +3s, toward the tip. With the eye in the plane normal to the strand
   * (`sinθo` 0) and a tilt of 0.05, the peaks are at −0.1, 0.05 and 0.15 — found by sweeping the
   * light through the whole model, R and TRT with the light beside the eye (φ 0), TT with it behind
   * the strand (φ π). TRT is twice as wide, so the Fresnel and the difference angle lean on it
   * enough to move its peak by 0.001: held to two places, which still separates 3s from the 2s and
   * 4s either side of it.
   */
  it('PUTS R AT −2s, TT AT +s AND TRT AT +3s ALONG THE STRAND', () => {
    expect(peak(HAIR_OUT.r, 0, 0.05)).toBeCloseTo(-0.1, 3);
    expect(peak(HAIR_OUT.tt, Math.PI, 0.05)).toBeCloseTo(0.05, 3);
    expect(peak(HAIR_OUT.trt, 0, 0.05)).toBeCloseTo(0.15, 2);
  });

  /*
   * **The transmitted lobe is the backlight's, and nearly nothing in front.** Its azimuthal term is
   * `exp(−3.65 cosφ − 3.98)`, so light beside the eye (cosφ 1) against light behind the strand
   * (cosφ −1) is exp(−7.3) = 6.75e-4 of it before Fresnel, which moves it to about 6.3e-4. The
   * glow itself is asserted to be more than the reflection, which it is by an order of magnitude.
   */
  it('GLOWS WITH THE LIGHT BEHIND AND NEARLY NOT AT ALL IN FRONT', () => {
    const out = new Float64Array(HAIR_OUT.length);
    const eye = around(0, 0);
    hairLight(TANGENT, around(0.05, 0), eye, WHITE, 0.3, 0.05, 0.5, 0.7, 1, 0, 0, out);
    const front = out[HAIR_OUT.tt] as number;
    hairLight(TANGENT, around(0.05, Math.PI), eye, WHITE, 0.3, 0.05, 0.5, 0.7, 1, 0, 0, out);
    const behind = out[HAIR_OUT.tt] as number;
    hairLight(TANGENT, around(-0.1, 0), eye, WHITE, 0.3, 0.05, 0.5, 0.7, 1, 0, 0, out);
    const reflection = out[HAIR_OUT.r] as number;
    expect(front / behind).toBeCloseTo(6.3e-4, 4);
    expect(behind).toBeGreaterThan(10 * reflection);
  });

  /* **Light and eye swapped, the same answer**: every term is symmetric in the two, as a BSDF is. */
  it('IS THE SAME WITH THE LIGHT AND THE EYE SWAPPED', () => {
    const forward = new Float64Array(HAIR_OUT.length);
    const back = new Float64Array(HAIR_OUT.length);
    const fibre: [number, number, number] = [0.4, 0.22, 0.1];
    for (let k = 0; k < 40; k++) {
      const l = around(Math.sin(k * 1.3) * 0.9, k * 0.7);
      const v = around(Math.cos(k * 0.9) * 0.8, k * 2.1);
      hairLight(TANGENT, l, v, fibre, 0.35, 0.05, 0.5, 0.7, 1, 0, 0, forward);
      hairLight(TANGENT, v, l, fibre, 0.35, 0.05, 0.5, 0.7, 1, 0, 0, back);
      for (const lobe of [HAIR_OUT.r, HAIR_OUT.tt, HAIR_OUT.trt]) {
        for (let c = 0; c < (lobe === HAIR_OUT.r ? 1 : 3); c++) {
          expect(back[lobe + c]).toBeCloseTo(forward[lobe + c] as number, 9);
        }
      }
    }
  });

  /*
   * **A white strand returns what it receives, to within the fit.** The three lobes integrated over
   * every direction of arrival, divided by π for this engine's lamp units: 0.99 with the eye normal
   * to the strand, rising to 1.07 at 0.9 radians along it and falling to 0.91 when it is rough as
   * well. Doubling a lobe, or dropping the π, leaves this band.
   */
  it('RETURNS WHAT A WHITE STRAND RECEIVES, TO WITHIN THE FIT', () => {
    for (const roughness of [0.2, 0.6]) {
      for (const view of [0, 0.5, 0.9]) {
        const received = returned(roughness, view, 0, 0);
        expect(received).toBeGreaterThan(0.9);
        expect(received).toBeLessThan(1.08);
      }
    }
  });

  /*
   * **A lamp with a size spreads its highlight and returns the same light.** A source 0.4 across at
   * a metre subtends 0.2, added to every lobe's width: the reflected peak falls — at roughness 0.25
   * its width goes from 0.0625 to 0.2625, so to about a quarter — and the light returned over the
   * sphere moves by under one percent, which is the wider Gaussians' tails past the poles.
   */
  it('SPREADS A LARGE LAMP’S HIGHLIGHT WITHOUT BRIGHTENING IT', () => {
    expect(returned(0.25, 0.3, 0.4, 1) / returned(0.25, 0.3, 0, 0)).toBeCloseTo(1, 2);
    const out = new Float64Array(HAIR_OUT.length);
    hairLight(TANGENT, around(-0.1, 0), around(0, 0), WHITE, 0.25, 0.05, 0.5, 0.7, 1, 0, 0, out);
    const point = out[HAIR_OUT.r] as number;
    hairLight(TANGENT, around(-0.1, 0), around(0, 0), WHITE, 0.25, 0.05, 0.5, 0.7, 1, 0.4, 1, out);
    expect((out[HAIR_OUT.r] as number) / point).toBeCloseTo(0.0625 / 0.2625, 2);
  });

  /*
   * **The scatter's answer to an even sky is `HAIR_SCATTER_SPHERE`**, which light from every side
   * holds the scatter to: its shape integrated over the sphere and divided by π, here by quadrature,
   * for any eye. The constant's derivation is in its comment; this is the integral it stands for.
   */
  it('SCATTERS AN EVEN SKY BY THE CONSTANT LIGHT FROM EVERY SIDE IS HELD TO', () => {
    const out = new Float64Array(HAIR_OUT.length);
    const n = 160;
    for (const view of [0, 0.7]) {
      const eye = around(Math.sin(view), 1.1);
      let sum = 0;
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < 2 * n; j++) {
          const l = around(-1 + (2 * (i + 0.5)) / n, (Math.PI * (j + 0.5)) / n);
          hairLight(TANGENT, l, eye, WHITE, 0.3, 0.05, 0.5, 1, 1, 0, 0, out);
          sum += out[HAIR_OUT.scatter] as number;
        }
      }
      expect((sum * (4 * Math.PI)) / (2 * n * n) / Math.PI).toBeCloseTo(HAIR_SCATTER_SPHERE, 3);
    }
  });

  /*
   * **Finite and never negative where the geometry degenerates**: a tangent that could not be made
   * (zeros, as a mesh with none can give), light or eye along the strand, the two at its opposite
   * ends — where the half difference angle reaches 90° and the transmitted powers divide by its
   * cosine — a black fibre, and a roughness of 0.
   */
  it('STAYS FINITE WHERE THE GEOMETRY DEGENERATES', () => {
    const out = new Float64Array(HAIR_OUT.length);
    const cases: [number[], number[], number[], [number, number, number], number][] = [
      [[0, 0, 0], around(0.3, 0.2), around(0, 0), WHITE, 0.3],
      [TANGENT, [1, 0, 0], around(0, 0), WHITE, 0.3],
      [TANGENT, around(0, 0), [1, 0, 0], WHITE, 0.3],
      [TANGENT, [1, 0, 0], [-1, 0, 0], [0.4, 0.22, 0.1], 0.3],
      [TANGENT, [1, 0, 0], [1, 0, 0], WHITE, 0.3],
      [TANGENT, around(0.1, Math.PI), around(0, 0), [0, 0, 0], 0.3],
      [TANGENT, around(-0.1, 0), around(0, 0), WHITE, 0],
    ];
    for (const [t, l, v, fibre, roughness] of cases) {
      hairLight(t, l, v, fibre, roughness, 0.05, 0.5, 0.7, 1, 0, 0, out);
      for (let k = 0; k < HAIR_OUT.length; k++) {
        expect(Number.isFinite(out[k])).toBe(true);
        expect(out[k]).toBeGreaterThanOrEqual(0);
      }
    }
  });

  /*
   * **Light from every side, through the lobes along the flattened eye.** The eye in the plane
   * normal to the strand, so the light along it is the eye itself: `sinθi` and `sinθo` 0, the half
   * difference angle 0, and `cosφ` 1 but for the regulariser, `1/√(1 + 1e-4)`. A white fibre at
   * roughness 0.5 (β 0.25), no tilt, scatter 0.2, worked by hand from the formulas:
   *
   * - R: a Gaussian of width 0.25 + 0.2 at 0, times 0.25 cos(φ/2), times F(1) = F0 0.0465206:
   *   0.886524 · 0.25 · 0.999988 · 0.0465206 = 0.0103105, and π of it 0.0323912;
   * - TRT: width 0.5 + 0.2, `exp(17 cosφ − 16.78)` 1.24503, F(0.5) 0.0763168 so (1 − f)² f 0.0651128:
   *   0.569917 · 1.24503 · 0.0651128 = 0.0462013, and π of it 0.145146;
   * - the scatter: `mix(1/2, 1, 0.33)` 0.665 times 0.2, 0.133;
   *
   * twice their sum 0.621074. The report's fibre, (1, 0.43, 0.115), tints TRT by its 0.8th power and
   * the scatter by its root: 0.386988 and 0.206438 in green and blue — gold, where the scatter
   * alone would answer the same light with (0.266, 0.174, 0.090).
   */
  it('LIGHTS A STRAND FROM EVERY SIDE THROUGH R, TRT AND THE SCATTER ALONG THE FLATTENED EYE', () => {
    const lobes = new Float64Array(HAIR_OUT.length);
    const out = new Float64Array(3);
    const eye = around(0, 0.4);
    hairIndirect(TANGENT, eye, eye, WHITE, 0.5, 0, 0.5, 0.2, lobes, out);
    expect(lobes[HAIR_OUT.r]).toBeCloseTo(0.0323912, 6);
    expect(lobes[HAIR_OUT.trt]).toBeCloseTo(0.145146, 5);
    expect(lobes[HAIR_OUT.scatter]).toBeCloseTo(0.133, 9);
    expect(out[0]).toBeCloseTo(0.621074, 5);
    hairIndirect(TANGENT, eye, eye, [1, 0.43, 0.115], 0.5, 0, 0.5, 0.2, lobes, out);
    expect(out[0]).toBeCloseTo(0.621074, 5);
    expect(out[1]).toBeCloseTo(0.386988, 5);
    expect(out[2]).toBeCloseTo(0.206438, 5);
  });

  /*
   * **Nothing from behind, and never more than arrives.** The direction stands for the eye's side,
   * so the transmitted lobe is not in it at all. And a strand scattering everything, 1, would answer
   * with its scatter alone 1.33 of what reaches it, so the share stops at 1.
   */
  it('TAKES NO TRANSMITTED LOBE AND RETURNS AT MOST WHAT ARRIVES', () => {
    const lobes = new Float64Array(HAIR_OUT.length);
    const out = new Float64Array(3);
    for (const view of [0, 0.5, 1.2]) {
      const eye = around(Math.sin(view), 2);
      hairIndirect(TANGENT, eye, eye, WHITE, 0.3, 0.05, 0.5, 1, lobes, out);
      for (let c = 0; c < 3; c++) {
        expect(lobes[HAIR_OUT.tt + c]).toBe(0);
        expect(out[c]).toBe(1);
      }
    }
  });

  /*
   * **Twice, because the scatter's half is then its average over the sphere**: along the flattened
   * eye, for any eye, the scatter answers with half of `HAIR_SCATTER_SPHERE` — the constant the
   * quadrature above holds to — so doubling the one direction leaves the scatter as an even sky
   * gives it, and R and TRT are what the direction adds.
   */
  it('DOUBLES ONE DIRECTION SO ITS SCATTER IS WHAT AN EVEN SKY GIVES', () => {
    const lobes = new Float64Array(HAIR_OUT.length);
    const out = new Float64Array(3);
    const fibre: [number, number, number] = [0.64, 0.25, 0.09];
    for (const view of [0, 0.7, -1.1]) {
      const eye = around(Math.sin(view), 0.9);
      hairIndirect(TANGENT, eye, eye, fibre, 0.4, 0.05, 0.5, 0.6, lobes, out);
      for (let c = 0; c < 3; c++) {
        expect(2 * (lobes[HAIR_OUT.scatter + c] as number)).toBeCloseTo(
          HAIR_SCATTER_SPHERE * Math.sqrt(fibre[c]) * 0.6,
          9,
        );
      }
    }
  });

  /*
   * **The eye along the strand** has no direction across it, and the surface's normal stands in, as
   * the shader's `hairAcross` has it; a black fibre and no tangent stay finite too.
   */
  it('STAYS FINITE FROM EVERY SIDE WHERE THE EYE RUNS ALONG THE STRAND', () => {
    const lobes = new Float64Array(HAIR_OUT.length);
    const out = new Float64Array(3);
    const normal = [0, 1, 0];
    const cases: [number[], number[], [number, number, number]][] = [
      [TANGENT, [1, 0, 0], WHITE],
      [TANGENT, [-1, 0, 0], [0, 0, 0]],
      [[0, 0, 0], around(0.3, 0.2), WHITE],
    ];
    for (const [t, v, fibre] of cases) {
      hairIndirect(t, v, normal, fibre, 0.3, 0.05, 0.5, 0.7, lobes, out);
      for (let c = 0; c < 3; c++) {
        expect(Number.isFinite(out[c])).toBe(true);
        expect(out[c]).toBeGreaterThanOrEqual(0);
      }
    }
  });

  /*
   * **The strand's specular scales the reflected lobe by twice it, and nothing else**, in a lamp's
   * lobes and in light from every side alike: at 0.5 the lobe is the fit's, 0.0323912 in the case
   * worked above; at 0.25 half that and at 0 none, a root that reflects nothing; at 1 twice. TRT
   * and the scatter do not move, so the share from every side loses exactly twice R's difference.
   */
  it('SCALES ONLY THE REFLECTED LOBE BY TWICE THE STRAND’S SPECULAR', () => {
    const lobes = new Float64Array(HAIR_OUT.length);
    const out = new Float64Array(3);
    const lamp = new Float64Array(HAIR_OUT.length);
    const eye = around(0, 0.4);
    const light = around(-0.1, 0.2);
    hairLight(TANGENT, light, eye, WHITE, 0.5, 0, 0.5, 0.2, 1, 0, 0, lamp);
    const r = lamp[HAIR_OUT.r] as number;
    const trt = lamp[HAIR_OUT.trt] as number;
    for (const [specular, share] of [
      [0, 0],
      [0.25, 0.5],
      [1, 2],
    ] as const) {
      hairLight(TANGENT, light, eye, WHITE, 0.5, 0, specular, 0.2, 1, 0, 0, lamp);
      expect(lamp[HAIR_OUT.r]).toBeCloseTo(r * share, 12);
      expect(lamp[HAIR_OUT.trt]).toBe(trt);
      hairIndirect(TANGENT, eye, eye, WHITE, 0.5, 0, specular, 0.2, lobes, out);
      expect(lobes[HAIR_OUT.r]).toBeCloseTo(0.0323912 * share, 6);
      expect(lobes[HAIR_OUT.trt]).toBeCloseTo(0.145146, 5);
      expect(out[0]).toBeCloseTo(0.621074 + 2 * 0.0323912 * (share - 1), 5);
    }
  });

  /* The two pieces the lobes are built from, at points their formulas give by hand. */
  it('BUILDS ITS LOBES FROM A NORMALISED GAUSSIAN AND THE STRAND’S FRESNEL', () => {
    expect(hairLongitudinal(0.1, 0)).toBeCloseTo(1 / (Math.sqrt(2 * Math.PI) * 0.1), 12);
    expect(hairLongitudinal(0.1, 0.1)).toBeCloseTo(
      Math.exp(-0.5) / (Math.sqrt(2 * Math.PI) * 0.1),
      12,
    );
    expect(hairFresnel(1)).toBeCloseTo(0.046520569, 9);
    expect(hairFresnel(0)).toBe(1);
  });
});
