import { describe, expect, it } from 'vitest';
import { boilingPoint } from './boiling.ts';

/* Water at its normal boiling point: 2,256.4 kJ/kg over 18.015 g/mol. */
const T_BOIL = 373.15;
const L_WATER = 2256400;
const M_WATER = 0.018015;

describe('boilingPoint', () => {
  it('is the reference temperature at the reference pressure', () => {
    expect(boilingPoint(T_BOIL, L_WATER, M_WATER, 101325)).toBeCloseTo(T_BOIL, 9);
  });

  it('falls at altitude, which is why a stew at 3,000 m never browns', () => {
    /* 70 kPa is about 3,000 m. Water boils there at roughly 90 C, and a pot of liquid therefore
       cannot exceed 363 K — below the 413 K that Maillard browning needs. */
    const t = boilingPoint(T_BOIL, L_WATER, M_WATER, 70000);
    expect(t).toBeGreaterThan(360);
    expect(t).toBeLessThan(365);
    expect(t - 273.15).toBeCloseTo(90, 0);
  });

  it('rises under pressure, which is what a pressure cooker is', () => {
    /* Two atmospheres: about 121 C, which is also why an autoclave sterilises at that number. */
    const t = boilingPoint(T_BOIL, L_WATER, M_WATER, 2 * 101325);
    expect(t - 273.15).toBeCloseTo(121, 0);
  });

  it('moves monotonically with pressure', () => {
    let previous = 0;
    for (const p of [20000, 50000, 70000, 101325, 150000, 202650, 400000]) {
      const t = boilingPoint(T_BOIL, L_WATER, M_WATER, p);
      expect(t).toBeGreaterThan(previous);
      previous = t;
    }
  });

  it('refuses a pressure that is not positive, naming it', () => {
    expect(() => boilingPoint(T_BOIL, L_WATER, M_WATER, 0)).toThrow(/0/);
    expect(() => boilingPoint(T_BOIL, L_WATER, M_WATER, -1)).toThrow(/-1/);
  });

  it('refuses a latent heat or molar mass that is not positive', () => {
    expect(() => boilingPoint(T_BOIL, 0, M_WATER, 101325)).toThrow(/latent/);
    expect(() => boilingPoint(T_BOIL, L_WATER, 0, 101325)).toThrow(/molar/);
  });
});
