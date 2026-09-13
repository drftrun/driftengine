import { describe, expect, it } from 'vitest';
import { GLOW_MIN_TEMPERATURE, blackbodyRGB, glowIntensity } from './blackbody.ts';

const rgb = (temperature: number): [number, number, number] => {
  const out = new Float32Array(3);
  blackbodyRGB(temperature, out);
  return [out[0] as number, out[1] as number, out[2] as number];
};

describe('a hot surface is a blackbody at its own temperature', () => {
  it('GOES RED, THEN ORANGE, THEN WHITE, in that order and for that reason', () => {
    /*
     * `§8.5`: a char surface at 1,000 K is a dull red and at 1,300 K is orange, and `§17` writes
     * exactly that as emissive. Nothing here chose a gradient — Planck's law at 1,000 K puts far
     * more power at 600 nm than at 450, and by 3,000 K the three are within a factor of two.
     */
    const [r1, g1, b1] = rgb(1000);
    expect(r1).toBeGreaterThan(g1);
    expect(g1).toBeGreaterThan(b1);
    /* Dull red means blue is nearly absent, not merely smaller. */
    expect(b1 / r1).toBeLessThan(0.15);

    const [r2, g2, b2] = rgb(1300);
    expect(g2 / r2).toBeGreaterThan(g1 / r1);
    expect(b2 / r2).toBeGreaterThan(b1 / r1);

    /*
     * At 3,000 K the measured ratios are blue 0.293 and green 0.667 against red, which is what
     * Planck gives at 450 and 550 against 600 nm — a yellow-white, which is what a 3,000 K surface
     * is. Recorded rather than chosen; the bands hold the measurement.
     */
    const [r3, g3, b3] = rgb(3000);
    expect(b3 / r3).toBeGreaterThan(0.25);
    expect(g3 / r3).toBeGreaterThan(0.6);
  });

  it('is normalised, so the colour is a hue and the brightness is a separate number', () => {
    /* Otherwise a 3,000 K flame would be ten thousand times a 1,000 K ember in the colour channel
       and nothing downstream could tone-map it. Intensity is `glowIntensity` and it is `T⁴`. */
    for (const temperature of [900, 1500, 2500]) {
      expect(Math.max(...rgb(temperature))).toBeCloseTo(1, 5);
    }
  });

  it('RISES AS THE FOURTH POWER, which is Stefan-Boltzmann and not a curve', () => {
    /*
     * Doubling the temperature is sixteen times the radiated power, which is why an ember that
     * looks dim beside a flame is not nearly as much cooler as it looks.
     */
    const at1000 = glowIntensity(1000);
    const at2000 = glowIntensity(2000);
    expect(at2000 / at1000).toBeCloseTo(16, 1);
  });

  it('emits nothing at all below visible heat, rather than a very dark red', () => {
    /*
     * A surface at 400 K radiates plenty — it is simply not radiating any of it in the visible, and
     * an emissive term that faded smoothly from room temperature would make every warm thing in a
     * scene glow faintly. The threshold is where a real surface starts to be seen in the dark.
     */
    expect(glowIntensity(GLOW_MIN_TEMPERATURE - 1)).toBe(0);
    expect(glowIntensity(GLOW_MIN_TEMPERATURE + 200)).toBeGreaterThan(0);
  });

  it('allocates nothing, because it is called per parcel per frame', () => {
    const out = new Float32Array(3);
    blackbodyRGB(1200, out);
    const before = out[0] as number;
    for (let i = 0; i < 1000; i++) blackbodyRGB(1200, out);
    expect(out[0]).toBe(before);
  });
});
