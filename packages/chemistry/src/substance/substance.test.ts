import { beforeEach, describe, expect, it } from 'vitest';
import { SpeciesRegistry } from '../species/registry.ts';
import { registerStandardSpecies } from '../species/standard.ts';
import { massFractions } from './composition.ts';
import { wetComposition } from './substance.ts';

describe('wetComposition', () => {
  let registry: SpeciesRegistry;
  beforeEach(() => {
    registry = new SpeciesRegistry();
    registerStandardSpecies(registry);
  });

  const dryOak = () =>
    massFractions(registry, {
      cellulose: 0.43,
      hemicellulose: 0.26,
      lignin: 0.26,
      extractives: 0.04,
      ash: 0.01,
    });

  it('folds dry-basis moisture in, which is not the same as a wet-basis fraction', () => {
    /*
     * The correction the design needed. "12% moisture content" is 12 kg of water per 100 kg of
     * *dry* wood, so water is 0.12/1.12 = 0.107143 of the whole and every dry component is scaled
     * by 1/1.12. Treating 0.12 as a wet-basis fraction is wrong by 1.4 points here and by 33 for
     * green wood at 60%, where it decides whether the log catches at all.
     */
    const wet = wetComposition(registry, dryOak(), 0.12);
    const water = registry.indexOf('H2O(l)');
    const cellulose = registry.indexOf('cellulose');

    const fractionOf = (species: number): number => {
      const at = wet.species.indexOf(species);
      return at < 0 ? 0 : (wet.fraction[at] as number);
    };

    expect(fractionOf(water)).toBeCloseTo(0.12 / 1.12, 12);
    expect(fractionOf(cellulose)).toBeCloseTo(0.43 / 1.12, 12);
  });

  it('still sums to one', () => {
    for (const moisture of [0, 0.06, 0.12, 0.35, 0.6, 2]) {
      const wet = wetComposition(registry, dryOak(), moisture);
      let total = 0;
      for (const f of wet.fraction) total += f;
      expect(total, `moisture ${moisture}`).toBeCloseTo(1, 12);
    }
  });

  it('is the dry composition unchanged at zero moisture', () => {
    const dry = dryOak();
    const wet = wetComposition(registry, dry, 0);
    expect([...wet.species]).toEqual([...dry.species]);
    expect([...wet.fraction]).toEqual([...dry.fraction]);
  });

  it('adds to water the composition already held rather than replacing it', () => {
    // A substance can be authored wet — a stew is mostly water before anybody adds moisture to it.
    const stew = massFractions(registry, { 'H2O(l)': 0.8, protein: 0.15, starch: 0.05 });
    const wetter = wetComposition(registry, stew, 0.25);
    const water = registry.indexOf('H2O(l)');
    const at = wetter.species.indexOf(water);
    expect(wetter.fraction[at]).toBeCloseTo((0.8 + 0.25) / 1.25, 12);
  });

  it('refuses a negative or non-finite moisture, naming it', () => {
    expect(() => wetComposition(registry, dryOak(), -0.1)).toThrow(/-0\.1/);
    expect(() => wetComposition(registry, dryOak(), Number.NaN)).toThrow(/NaN/);
  });
});
