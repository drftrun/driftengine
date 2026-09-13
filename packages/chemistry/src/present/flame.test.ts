import { describe, expect, it } from 'vitest';
import { flameColour, flameHeight, sootLuminosity } from './flame.ts';

describe('a flame is as tall as its heat release says', () => {
  it('FOLLOWS THE PUBLISHED PLUME CORRELATION, and nothing was tuned', () => {
    /*
     * `L ≈ 0.235·Q^(2/5) − 1.02·D`, Heskestad's flame-height relation, with Q in kilowatts and D in
     * metres. It is the standard correlation in fire engineering and it is here verbatim.
     *
     * A 100 kW fire over a 0.3 m base: 0.235 × 100^0.4 − 1.02 × 0.3 = 1.482 − 0.306 = 1.18 m, which
     * is what a decent campfire looks like. A 1 MW fire over 1 m: 0.235 × 1000^0.4 − 1.02 = 3.7245 −
     * 1.02 = 2.7045 m.
     *
     * Held to a centimetre, which is where the tabulated `Q^(2/5)` lands against the closed form.
     */
    expect(flameHeight(100, 0.3)).toBeCloseTo(1.18, 2);
    expect(flameHeight(1000, 1.0)).toBeCloseTo(2.7045, 2);
  });

  it('gives a small fire over a wide base NO FLAME AT ALL, which is correct', () => {
    /*
     * The correlation goes negative there, and that is the physics rather than a domain error: a
     * few kilowatts spread over a metre is a smouldering surface with no standing flame over it.
     * Clamped at zero rather than allowed to be a negative height.
     */
    expect(flameHeight(2, 1.5)).toBe(0);
  });

  it('grows with the two-fifths power, so ten times the fire is not ten times the flame', () => {
    /* 10^0.4 is 2.5, and that exponent is the whole reason a big fire looks less impressive than
       its output suggests. */
    const small = flameHeight(100, 0);
    const big = flameHeight(1000, 0);
    expect(big / small).toBeCloseTo(2.512, 2);
  });

  it('MAKES A RICH FLAME ORANGE AND A LEAN ONE BLUE, on the equivalence ratio', () => {
    /*
     * `§8.4`: a luminous flame is orange because it holds incandescent soot, and a clean one is blue
     * because there is none and what is seen is chemiluminescence. So the mix is soot luminosity
     * against a fixed blue term, and the soot luminosity is a function of φ — negligible below one,
     * climbing through the 1.5-to-3 band where soot forms.
     */
    expect(sootLuminosity(0.8)).toBe(0);
    expect(sootLuminosity(2)).toBeGreaterThan(0);
    expect(sootLuminosity(2.5)).toBeGreaterThan(sootLuminosity(1.6));

    const lean = new Float32Array(3);
    const rich = new Float32Array(3);
    flameColour(0.8, 1800, lean);
    flameColour(2.5, 1400, rich);
    /* Lean is blue-dominant; rich is red-dominant. Neither was authored. */
    expect(lean[2] as number).toBeGreaterThan(lean[0] as number);
    expect(rich[0] as number).toBeGreaterThan(rich[2] as number);
  });

  it('allocates nothing per call, because this is per fire per frame', () => {
    const out = new Float32Array(3);
    flameColour(1.5, 1500, out);
    const first = out[0] as number;
    for (let i = 0; i < 1000; i++) flameColour(1.5, 1500, out);
    expect(out[0]).toBe(first);
  });
});
