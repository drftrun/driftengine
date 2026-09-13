import { beforeEach, describe, expect, it } from 'vitest';
import { PHASE_GAS, PHASE_LIQUID, PHASE_SOLID } from './species.ts';
import { SpeciesRegistry } from './registry.ts';

const WATER = {
  id: 'H2O(l)',
  formula: { H: 2, O: 1 },
  phase: PHASE_LIQUID,
  formationEnthalpy: -285830,
  cpA: 4182,
} as const;

const METHANE = {
  id: 'CH4',
  formula: { C: 1, H: 4 },
  phase: PHASE_GAS,
  formationEnthalpy: -74600,
  cpA: 2220,
  cpB: 5.2,
} as const;

describe('SpeciesRegistry', () => {
  let registry: SpeciesRegistry;
  beforeEach(() => {
    registry = new SpeciesRegistry();
  });

  it('hands back an index and resolves it by id', () => {
    const water = registry.register(WATER);
    expect(water).toBe(0);
    expect(registry.count).toBe(1);
    expect(registry.indexOf('H2O(l)')).toBe(0);
    expect(registry.idOf(water)).toBe('H2O(l)');
  });

  it('answers -1 for a species it does not hold', () => {
    expect(registry.indexOf('C8H18')).toBe(-1);
  });

  it('derives molar mass from the formula rather than storing one', () => {
    const water = registry.register(WATER);
    // 2 x 1.008 + 15.999 = 18.015 g/mol, and the registry speaks kilograms.
    expect(registry.molarMass(water)).toBeCloseTo(0.018015, 9);
  });

  it('derives a mass for a formula with a fractional subscript', () => {
    // An average protein residue is a real quantity; rounding it to integers would break element
    // balance by percent-scale amounts across a whole body.
    const protein = registry.register({
      id: 'protein',
      formula: { C: 4.4, H: 7.7, N: 1.2, O: 1.4, S: 0.04 },
      phase: PHASE_SOLID,
      formationEnthalpy: -420000,
      cpA: 1600,
      pseudo: true,
    });
    expect(registry.molarMass(protein)).toBeCloseTo(
      (4.4 * 12.011 + 7.7 * 1.008 + 1.2 * 14.007 + 1.4 * 15.999 + 0.04 * 32.06) / 1000,
      9,
    );
    expect(registry.isPseudo(protein)).toBe(true);
  });

  it('keeps the phase and the formation enthalpy it was given', () => {
    const methane = registry.register(METHANE);
    expect(registry.phaseOf(methane)).toBe(PHASE_GAS);
    expect(registry.formationEnthalpyOf(methane)).toBe(-74600);
  });

  it('evaluates heat capacity as a linear function of temperature about 298.15 K', () => {
    const methane = registry.register(METHANE);
    expect(registry.heatCapacityOf(methane, 298.15)).toBeCloseTo(2220, 6);
    expect(registry.heatCapacityOf(methane, 398.15)).toBeCloseTo(2220 + 520, 6);
  });

  it('refuses a duplicate id, naming it', () => {
    registry.register(WATER);
    expect(() => registry.register(WATER)).toThrow(/H2O\(l\)/);
  });

  it('refuses an element it does not carry, naming the symbol', () => {
    expect(() => registry.register({ ...WATER, id: 'UO2', formula: { U: 1, O: 2 } })).toThrow(
      /\bU\b/,
    );
  });

  it('refuses a negative or non-finite subscript, naming the element', () => {
    expect(() => registry.register({ ...WATER, id: 'bad', formula: { H: -2, O: 1 } })).toThrow(/H/);
    expect(() =>
      registry.register({ ...WATER, id: 'worse', formula: { H: Number.NaN, O: 1 } }),
    ).toThrow(/H/);
  });

  it('refuses a formula with no elements at all', () => {
    expect(() => registry.register({ ...WATER, id: 'nothing', formula: {} })).toThrow(/nothing/);
  });

  it('refuses an index that was never registered', () => {
    registry.register(WATER);
    expect(() => registry.molarMass(1)).toThrow(/1/);
    expect(() => registry.molarMass(-1)).toThrow(/-1/);
  });
});
