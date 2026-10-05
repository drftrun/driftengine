import { describe, expect, it } from 'vitest';

import { EYE_MIN_DESCENT, eyeRefractionShift, irisMask } from './eyeRefraction.ts';

const AXIS: [number, number, number] = [0, 0, 1];

describe('eye refraction', () => {
  /* **Head-on, the iris is where it is painted**: the ray goes straight down the axis. */
  it('DOES NOT MOVE THE IRIS SEEN HEAD-ON', () => {
    const out = new Float64Array(3);
    eyeRefractionShift(AXIS, AXIS, AXIS, 1.336, 0.003, out);
    expect(Math.hypot(out[0] as number, out[1] as number, out[2] as number)).toBeLessThan(1e-12);
  });

  /*
   * **At 30° to a flat cornea the shift is `height · tan(asin(sin 30° / ior))`**: the ray bends to
   * asin(0.5 / 1.336) = 21.98° and crosses 0.4036 of the height, away from the eye's side — 1.211 mm
   * under a cornea 3 mm above the iris. Greater at 60°, and never out of the plane.
   */
  it('MOVES IT BY THE REFRACTED RAY’S CROSSING, AWAY FROM THE EYE, GROWING WITH THE ANGLE', () => {
    const out = new Float64Array(3);
    const at = (degrees: number): [number, number, number] => {
      const r = (degrees * Math.PI) / 180;
      return [Math.sin(r), 0, Math.cos(r)];
    };
    eyeRefractionShift(at(30), AXIS, AXIS, 1.336, 0.003, out);
    expect(out[0]).toBeCloseTo(-0.003 * 0.40358, 7);
    expect(out[1]).toBeCloseTo(0, 12);
    expect(out[2]).toBeCloseTo(0, 12);
    const thirty = Math.abs(out[0] as number);
    eyeRefractionShift(at(60), AXIS, AXIS, 1.336, 0.003, out);
    expect(Math.abs(out[0] as number)).toBeGreaterThan(thirty);
  });

  /*
   * **Seen almost edge-on the shift is bounded**, by the floored descent: at most the height over
   * `EYE_MIN_DESCENT`, rather than a ray running along the plane forever.
   */
  it('STAYS BOUNDED WHERE THE CORNEA IS SEEN EDGE-ON', () => {
    const out = new Float64Array(3);
    eyeRefractionShift([1, 0, 0], AXIS, AXIS, 1, 0.003, out);
    const shift = Math.hypot(out[0] as number, out[1] as number, out[2] as number);
    expect(Number.isFinite(shift)).toBe(true);
    expect(shift).toBeLessThanOrEqual(0.003 / EYE_MIN_DESCENT + 1e-9);
  });

  /*
   * **Without a map the iris is a disc of `irisRadius` about the texture's centre**, with a soft
   * limbus: whole inside, nothing outside, half at the radius itself.
   */
  it('FINDS THE IRIS WITHOUT A MAP AS A DISC ABOUT THE CENTRE', () => {
    expect(irisMask(0.5, 0.5, 0.15, 0.01)).toBe(1);
    expect(irisMask(0.5 + 0.15, 0.5, 0.15, 0.01)).toBeCloseTo(0.5, 12);
    expect(irisMask(0.5, 0.5 + 0.3, 0.15, 0.01)).toBe(0);
  });
});
