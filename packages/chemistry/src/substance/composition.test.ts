import { beforeEach, describe, expect, it } from 'vitest';
import { PHASE_GAS, PHASE_LIQUID, PHASE_SOLID } from '../species/species.ts';
import { SpeciesRegistry } from '../species/registry.ts';
import { massFractions } from './composition.ts';

describe('massFractions', () => {
  let registry: SpeciesRegistry;
  beforeEach(() => {
    registry = new SpeciesRegistry();
    registry.register({
      id: 'cellulose',
      formula: { C: 6, H: 10, O: 5 },
      phase: PHASE_SOLID,
      formationEnthalpy: -963000,
      cpA: 1340,
    });
    registry.register({
      id: 'lignin',
      formula: { C: 9, H: 10, O: 2 },
      phase: PHASE_SOLID,
      formationEnthalpy: -155000,
      cpA: 1250,
    });
    registry.register({
      id: 'H2O(l)',
      formula: { H: 2, O: 1 },
      phase: PHASE_LIQUID,
      formationEnthalpy: -285830,
      cpA: 4182,
    });
    registry.register({
      id: 'O2',
      formula: { O: 2 },
      phase: PHASE_GAS,
      formationEnthalpy: 0,
      cpA: 918,
    });
  });

  it('accepts fractions that sum to one', () => {
    const wood = massFractions(registry, { cellulose: 0.6, lignin: 0.3, 'H2O(l)': 0.1 });
    expect(wood.species.length).toBe(3);
    expect(wood.fraction.length).toBe(3);
    let total = 0;
    for (const f of wood.fraction) total += f;
    expect(total).toBeCloseTo(1, 12);
  });

  it('stores entries sorted by species index, so two orderings reduce identically', () => {
    // Summing doubles is not associative, so a composition whose storage order followed the
    // author's typing would make two spellings of the same material differ in the last bit — and a
    // conservation assertion is exactly where a last bit shows.
    const a = massFractions(registry, { cellulose: 0.6, lignin: 0.3, 'H2O(l)': 0.1 });
    const b = massFractions(registry, { 'H2O(l)': 0.1, cellulose: 0.6, lignin: 0.3 });
    expect([...a.species]).toEqual([...b.species]);
    expect([...a.fraction]).toEqual([...b.fraction]);
    expect([...a.species]).toEqual([0, 1, 2]);
  });

  it('refuses a sum that is not one, naming the sum it actually got', () => {
    // The message carries the real sum rather than a rounded one, and this assertion is written
    // against 0.8999999999999999 to prove it: 0.6 + 0.3 is not 0.9 in binary, and a message that
    // rounded would hide exactly the digits a person chasing a 1e-9 imbalance needs.
    expect(() => massFractions(registry, { cellulose: 0.6, lignin: 0.3 })).toThrow(
      /sums to 0\.8999999999999999 rather than 1/,
    );
  });

  it('refuses a species the registry does not hold, naming it', () => {
    expect(() => massFractions(registry, { unobtainium: 1 })).toThrow(/unobtainium/);
  });

  it('refuses a negative or non-finite fraction, naming the species', () => {
    expect(() => massFractions(registry, { cellulose: 1.2, lignin: -0.2 })).toThrow(/lignin/);
    expect(() => massFractions(registry, { cellulose: Number.NaN })).toThrow(/cellulose/);
  });

  it('refuses a composition of nothing', () => {
    expect(() => massFractions(registry, {})).toThrow(/empty/);
  });

  it('accepts a single species at one', () => {
    const water = massFractions(registry, { 'H2O(l)': 1 });
    expect([...water.species]).toEqual([2]);
    expect([...water.fraction]).toEqual([1]);
  });
});
