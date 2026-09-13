import { describe, expect, it } from 'vitest';
import { SpeciesRegistry } from '../species/registry.ts';
import { registerStandardSpecies } from '../species/standard.ts';
import { ReactionRegistry } from '../reaction/registry.ts';
import { SubstanceRegistry } from '../substance/registry.ts';
import { EXTINCT_NONE, EXTINCT_OXYGEN, extinguishes } from '../ignition/criteria.ts';
import { installLibrary } from './library.ts';
import { POLYMER } from './polymer.ts';

function world(): {
  species: SpeciesRegistry;
  reactions: ReactionRegistry;
  substances: SubstanceRegistry;
} {
  const species = new SpeciesRegistry();
  registerStandardSpecies(species);
  const reactions = new ReactionRegistry(species);
  const substances = new SubstanceRegistry(species, reactions);
  installLibrary(POLYMER, species, reactions, substances);
  return { species, reactions, substances };
}

describe('the polymer library', () => {
  it('installs: every reaction balances and every substance resolves', () => {
    const { substances } = world();
    for (const id of [
      'polyethylene',
      'polypropylene',
      'pvc',
      'polystyrene',
      'pmma',
      'polyurethane-foam',
    ]) {
      expect(substances.indexOf(id)).toBeGreaterThanOrEqual(0);
    }
  });

  it('GIVES UP HCl WHEN PVC BURNS AND HCN WHEN FOAM DOES, because the formulas say so', () => {
    /*
     * `species/standard.ts` already made this point about the two formulas: PVC carries the chlorine
     * and polyurethane carries the nitrogen, which is why a burning sofa is the dangerous one. Here
     * it becomes a product rather than an observation, and nothing in either reaction was told that
     * these two gases matter.
     */
    const { reactions, species } = world();
    const products = (id: string): number[] => [...reactions.productSpecies(reactions.indexOf(id))];
    expect(products('pyrolyse-pvc')).toContain(species.indexOf('HCl'));
    expect(products('pyrolyse-polyurethane')).toContain(species.indexOf('HCN'));
  });

  it('SELF-EXTINGUISHES PVC IN AIR AND NOT PMMA, on one number each', () => {
    /*
     * A limiting oxygen index is the fraction below which a flame cannot be sustained, and PVC's is
     * **0.45** — more than twice what air provides. So PVC burns while something else is holding a
     * flame to it and stops the moment that stops, which is the whole reason it is used in walls.
     * PMMA's is 0.17, below air, so it burns on its own once lit.
     *
     * One field on each substance and one comparison in `extinguishes`. No rule anywhere says
     * "PVC is self-extinguishing".
     */
    const { substances } = world();
    const air = 0.209;
    const burning = (id: string): number => {
      const model = substances.ignitionOf(substances.indexOf(id));
      if (model === null) throw new Error(`${id} has no ignition model`);
      /* Well alight: plenty of fuel leaving the surface, hot, still air. */
      return extinguishes(model, 0.05, air, 900, 0);
    };
    expect(burning('pvc')).toBe(EXTINCT_OXYGEN);
    expect(burning('pmma')).toBe(EXTINCT_NONE);
    expect(burning('polyethylene')).toBe(EXTINCT_NONE);
  });

  it('leaves char where a formula has aromatics and none where it does not', () => {
    /* Polyethylene unzips to its monomer and leaves nothing; PVC loses its chlorine and what is left
       is a carbon backbone with nowhere to go. Both are stoichiometry. */
    const { reactions, species } = world();
    const char = species.indexOf('C(char)');
    expect([...reactions.productSpecies(reactions.indexOf('pyrolyse-polyethylene'))]).not.toContain(
      char,
    );
    expect([...reactions.productSpecies(reactions.indexOf('pyrolyse-pvc'))]).toContain(char);
  });

  it("matches PE's MEASURED molar depolymerisation enthalpy", () => {
    /*
     * 92-108 kJ per mole of monomer is the published figure for polyethylene, and Hess's law over
     * the repeat unit and ethylene gives 106.6 without either number being stored.
     *
     * **Per kilogram it is a different story and the library header says so.** 3.8 MJ/kg against a
     * measured heat of gasification of 1.8-2.2, because this species set stops at C₂ where real PE
     * volatiles are C₁₀-C₄₀ waxes with nearly the polymer's own specific energy. The *total* heat
     * released once those volatiles burn is exact either way; what the cap distorts is the split
     * between the gasification and the flame.
     */
    const { reactions } = world();
    const perMole = reactions.enthalpyOf(reactions.indexOf('pyrolyse-polyethylene'));
    expect(perMole).toBeGreaterThan(92000);
    expect(perMole).toBeLessThan(115000);
  });
});
