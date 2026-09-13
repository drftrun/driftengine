import { describe, expect, it } from 'vitest';
import { SpeciesRegistry } from '../species/registry.ts';
import { registerStandardSpecies } from '../species/standard.ts';
import { ReactionRegistry } from '../reaction/registry.ts';
import { COMMON_REACTIONS, OXIDISE_CHAR, OXIDISE_CHAR_RICH, arthurRatio } from './common.ts';

const registry = (): ReactionRegistry => {
  const species = new SpeciesRegistry();
  registerStandardSpecies(species);
  const reactions = new ReactionRegistry(species);
  for (const reaction of COMMON_REACTIONS) reactions.register(reaction);
  return reactions;
};

describe('the reactions every family reaches through', () => {
  it('all register, which means all of them balance', () => {
    /* The balance check names the element and the gap, and it is how three of these were found. */
    expect(registry().count).toBe(COMMON_REACTIONS.length);
  });

  it("derives methane's heating value without it being written down", () => {
    /* 50.0 MJ/kg lower heating value, which is the design's §8.4 figure and is not stored. */
    const reactions = registry();
    const perMole = -reactions.enthalpyOf(reactions.indexOf('burn-methane'));
    expect(perMole / 0.0160425).toBeGreaterThan(49.5e6);
    expect(perMole / 0.0160425).toBeLessThan(50.5e6);
  });

  it("REPRODUCES ARTHUR'S RELATION, which nothing stores", () => {
    /*
     * `CO/CO₂ = 2500·exp(−6240/T)` is the measured split between the two ways carbon meets oxygen,
     * and `§8.5` leans on it: a cool smoulder makes CO₂ and a hot one makes CO, which is why a
     * smouldering fire in a closed space is the dangerous one.
     *
     * **It is not tabulated.** The two paths are ordinary Arrhenius reactions whose pre-exponentials
     * differ by 2500 and whose activation energies differ by `6240·R` — so their *ratio* is Arthur's
     * relation exactly, and the consequence falls out of two numbers rather than a rule.
     *
     * Read off the rate tables rather than the closed form, so the interpolation error is inside the
     * assertion: 2% covers the tabulated half-percent with room to spare.
     */
    const reactions = registry();
    const lean = reactions.indexOf(OXIDISE_CHAR);
    const rich = reactions.indexOf(OXIDISE_CHAR_RICH);
    for (const temperature of [700, 900, 1200]) {
      const measured = reactions.rateOf(rich, temperature) / reactions.rateOf(lean, temperature);
      expect(measured).toBeGreaterThan(arthurRatio(temperature) * 0.98);
      expect(measured).toBeLessThan(arthurRatio(temperature) * 1.02);
    }
    /* And the consequence, stated as the numbers the design quotes: 0.3 at 700 K, 15 at 1200. */
    expect(arthurRatio(700)).toBeCloseTo(0.336, 2);
    expect(arthurRatio(1200)).toBeGreaterThan(13);
    expect(arthurRatio(1200)).toBeLessThan(15);
  });

  it('costs a char that oxidises to CO more than one that goes all the way', () => {
    /* −110.5 kJ/mol against −393.5: burning to CO releases a quarter of the energy, which is why a
       starved fire is both hotter at the surface and poorer at heating a room. */
    const reactions = registry();
    expect(reactions.enthalpyOf(reactions.indexOf(OXIDISE_CHAR))).toBeCloseTo(-393510, 0);
    expect(reactions.enthalpyOf(reactions.indexOf(OXIDISE_CHAR_RICH))).toBeCloseTo(-110530, 0);
  });

  it('melts ice and boils water at their own latent heats, derived', () => {
    const reactions = registry();
    /* Per kilogram: 333.6 kJ against a literature 333.55, and 2,442.6 against 2,442 at 298.15 K. */
    expect(reactions.enthalpyOf(reactions.indexOf('melt-ice')) / 0.0180153).toBeCloseTo(333611, -2);
    expect(reactions.enthalpyOf(reactions.indexOf('boil-water')) / 0.0180153).toBeCloseTo(
      2442631,
      -3,
    );
  });
});
