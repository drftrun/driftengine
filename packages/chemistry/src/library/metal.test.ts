import { describe, expect, it } from 'vitest';
import { SpeciesRegistry } from '../species/registry.ts';
import { registerStandardSpecies } from '../species/standard.ts';
import { ReactionRegistry } from '../reaction/registry.ts';
import { SubstanceRegistry } from '../substance/registry.ts';
import { installLibrary } from './library.ts';
import { METAL } from './metal.ts';

function world(): {
  species: SpeciesRegistry;
  reactions: ReactionRegistry;
  substances: SubstanceRegistry;
} {
  const species = new SpeciesRegistry();
  registerStandardSpecies(species);
  const reactions = new ReactionRegistry(species);
  const substances = new SubstanceRegistry(species, reactions);
  installLibrary(METAL, species, reactions, substances);
  return { species, reactions, substances };
}

/** MJ released per kilogram of the metal a reaction consumes. */
function perKilogram(
  reactions: ReactionRegistry,
  species: SpeciesRegistry,
  id: string,
  metal: string,
): number {
  const index = reactions.indexOf(id);
  const target = species.indexOf(metal);
  const list = reactions.reactantSpecies(index);
  let moles = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i] === target) moles = reactions.reactantMoles(index)[i] as number;
  }
  return -reactions.enthalpyOf(index) / (moles * species.molarMass(target)) / 1e6;
}

describe('the metal library', () => {
  it('installs: every reaction balances and every substance resolves', () => {
    const { substances } = world();
    for (const id of ['iron', 'steel', 'aluminium', 'copper', 'magnesium']) {
      expect(substances.indexOf(id)).toBeGreaterThanOrEqual(0);
    }
  });

  it('DERIVES ALL THREE PUBLISHED HEATS OF COMBUSTION, and stores none of them', () => {
    /*
     * Magnesium 24.7 MJ/kg, aluminium 31.0, iron 7.4 — three published figures, none of them
     * anywhere in this repository. What is stored is the formation enthalpy of each oxide, and Hess's
     * law over those and a metal at zero gives all three.
     *
     * That magnesium releases more per kilogram than petrol releases per kilogram of *carbon* is why
     * a magnesium fire cannot be put out with water: it is hot enough to take the oxygen back out.
     */
    const { reactions, species } = world();
    expect(perKilogram(reactions, species, 'burn-magnesium', 'Mg')).toBeCloseTo(24.75, 1);
    expect(perKilogram(reactions, species, 'oxidise-aluminium', 'Al')).toBeCloseTo(31.05, 1);
    expect(perKilogram(reactions, species, 'rust-iron', 'Fe')).toBeCloseTo(7.38, 1);
  });

  it('PASSIVATES ALUMINIUM WITH A TEMPERATURE, which is the honest proxy', () => {
    /*
     * Aluminium releases more energy per kilogram than almost anything, and does not burn — because
     * its oxide is coherent and seals the surface. `§8.7` wanted that gated on an oxide-layer
     * thickness, and this model has no such field.
     *
     * So it is gated at the **melting point**, 933.5 K, which is where the coherent layer genuinely
     * stops being coherent. Below it, foil in a fire does nothing; above it, molten aluminium
     * oxidises, which is what molten aluminium does. A proxy, said out loud, rather than a gate that
     * was left off because it was inconvenient.
     */
    const { reactions } = world();
    expect(reactions.minTemperatureOf(reactions.indexOf('oxidise-aluminium'))).toBeCloseTo(
      933.15,
      1,
    );
    /* Magnesium's is 973 K, forty kelvin above its own melting point: it burns before it boils. */
    expect(reactions.minTemperatureOf(reactions.indexOf('burn-magnesium'))).toBeCloseTo(973.15, 1);
  });

  it('makes rusting slow enough to measure in months', () => {
    /*
     * The slowest reaction in the model by orders of magnitude, and it has to be: an iron object
     * left out gains a red surface over a season, not over a tick. Back-derived from the measured
     * atmospheric corrosion rate — about a percent of a kilogram bar a year.
     *
     * **The humidity gate is absent**, and this is the honest note about it: `ReactionGates` is
     * temperature only, so nothing here reproduces the 60% relative humidity below which atmospheric
     * rusting effectively stops. A gate on a species fraction would fix it, and it is a change to
     * `reaction/` rather than to a library.
     */
    const { reactions } = world();
    expect(reactions.rateOf(reactions.indexOf('rust-iron'), 293.15)).toBeLessThan(1e-8);
    expect(reactions.rateOf(reactions.indexOf('rust-iron'), 293.15)).toBeGreaterThan(0);
  });

  it('REFLECTS RATHER THAN ABSORBS, which is why metal heats slowly beside a fire', () => {
    /*
     * The number that decides most of what a metal object does near a fire, and it is not a
     * conductivity. Polished copper's emissivity is 0.05 against oak's 0.90, and a radiative term is
     * linear in it — so eighteen times less of the same fire arrives. That is why a poker's handle
     * stays cool and a wooden one chars.
     */
    const { substances } = world();
    expect(substances.emissivityOf(substances.indexOf('copper'))).toBeLessThan(0.1);
    expect(substances.emissivityOf(substances.indexOf('aluminium'))).toBeLessThan(0.15);
    /* Steel, which is not polished, sits far higher — and rusted steel higher still. */
    expect(substances.emissivityOf(substances.indexOf('steel'))).toBeGreaterThan(0.2);
  });
});
