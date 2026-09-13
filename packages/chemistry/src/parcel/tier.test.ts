import { beforeEach, describe, expect, it } from 'vitest';
import { SpeciesRegistry } from '../species/registry.ts';
import { registerStandardSpecies } from '../species/standard.ts';
import { ReactionRegistry } from '../reaction/registry.ts';
import { SubstanceRegistry } from '../substance/registry.ts';
import { ELEMENT_COUNT } from '../element/elements.ts';
import { maxElementDrift } from '../testing/drift.ts';
import { installLibrary } from '../library/library.ts';
import { ORGANIC } from '../library/organic.ts';
import { ParcelStore } from './store.ts';
import { TIER_DISTANT, TIER_FAR, TIER_HERO, TIER_NEAR, type Tier } from './tier.ts';

describe('level of detail, and every tier conserves', () => {
  let species: SpeciesRegistry;
  let substances: SubstanceRegistry;
  let parcels: ParcelStore;

  beforeEach(() => {
    species = new SpeciesRegistry();
    registerStandardSpecies(species);
    const reactions = new ReactionRegistry(species);
    substances = new SubstanceRegistry(species, reactions);
    installLibrary(ORGANIC, species, reactions, substances);
    parcels = new ParcelStore(substances);
  });

  const log = (): number =>
    parcels.spawn({
      substance: substances.indexOf('oak'),
      mass: 4,
      temperature: 293.15,
      area: 0.4,
    });

  it('starts at HERO, which is the resolution the substance declared', () => {
    const p = log();
    expect(parcels.tierOf(p)).toBe(TIER_HERO);
    expect(parcels.shellCount(p)).toBe(4);
  });

  it('FOLDS AND UNFOLDS WITHOUT LOSING OR INVENTING ANYTHING', () => {
    /*
     * **The property that makes a tier change safe mid-burn**, and `§14` says so: a tier change does
     * not lose or gain mass or energy. Shells are equal-mass by construction, so folding `n` into
     * `m` is a proportional redistribution and the targets come out equal-mass too — which matters
     * because equal mass is the invariant `conduction.ts` rests on.
     */
    const p = log();
    /* Make the shells genuinely different from each other first, or this proves nothing. */
    parcels.addShellHeat(p, 0, 400000);
    parcels.addShellHeat(p, 3, -50000);

    const before = new Float64Array(ELEMENT_COUNT);
    const after = new Float64Array(ELEMENT_COUNT);
    parcels.elementTotalsOf(p, before);
    const massBefore = parcels.massOf(p);
    const enthalpyBefore = parcels.enthalpyOf(p);

    for (const tier of [TIER_NEAR, TIER_FAR, TIER_DISTANT, TIER_FAR, TIER_HERO] as Tier[]) {
      parcels.setTier(p, tier);
      parcels.elementTotalsOf(p, after);
      expect(maxElementDrift(before, after), `elements at tier ${tier}`).toBeLessThan(1e-12);
      expect(parcels.massOf(p), `mass at tier ${tier}`).toBeCloseTo(massBefore, 9);
      expect(parcels.enthalpyOf(p), `enthalpy at tier ${tier}`).toBeCloseTo(enthalpyBefore, 6);
    }
  });

  it('KEEPS THE SHELLS EQUAL-MASS, which is what conduction rests on', () => {
    const p = log();
    for (const tier of [TIER_NEAR, TIER_FAR, TIER_DISTANT, TIER_HERO] as Tier[]) {
      parcels.setTier(p, tier);
      const count = parcels.shellCount(p);
      const expected = parcels.massOf(p) / count;
      for (let shell = 0; shell < count; shell++) {
        expect(parcels.shellMassOf(p, shell), `tier ${tier} shell ${shell}`).toBeCloseTo(
          expected,
          9,
        );
      }
    }
  });

  it('LOSES THE PROFILE INSIDE A FOLD, which is the point of a tier', () => {
    /*
     * Two shells at different temperatures become one at their mass-weighted mean. That is a real
     * loss of resolution and it is what a lower tier is *for* — and it is the one thing that must be
     * true alongside the conservation above, or a tier would be free and there would be no tiers.
     */
    const p = log();
    parcels.addShellHeat(p, 0, 600000);
    const hot = parcels.shellTemperatureOf(p, 0);
    const cold = parcels.shellTemperatureOf(p, 3);
    expect(hot - cold).toBeGreaterThan(100);

    parcels.setTier(p, TIER_DISTANT);
    expect(parcels.shellCount(p)).toBe(1);
    /* One shell, somewhere between the two it replaced. */
    const merged = parcels.shellTemperatureOf(p, 0);
    expect(merged).toBeLessThan(hot);
    expect(merged).toBeGreaterThan(cold);
  });

  it('gives each tier its own cadence and substep ceiling', () => {
    const p = log();
    parcels.setTier(p, TIER_HERO);
    expect(parcels.cadenceOf(p)).toBe(1);
    parcels.setTier(p, TIER_FAR);
    expect(parcels.cadenceOf(p)).toBe(4);
    parcels.setTier(p, TIER_DISTANT);
    expect(parcels.cadenceOf(p)).toBe(16);
  });

  it('will not fold past what the substance declared', () => {
    /* A tier only ever *reduces* resolution. `Hero` is what the author asked for, and a tier that
       invented shells would be inventing a depth profile nobody measured. */
    const p = log();
    parcels.setTier(p, TIER_HERO);
    expect(parcels.shellCount(p)).toBe(4);
    parcels.setTier(p, TIER_NEAR);
    /* Near is four, and this substance declared four, so nothing moved. */
    expect(parcels.shellCount(p)).toBe(4);
  });
});
