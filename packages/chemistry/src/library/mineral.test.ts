import { describe, expect, it } from 'vitest';
import { SpeciesRegistry } from '../species/registry.ts';
import { registerStandardSpecies } from '../species/standard.ts';
import { ReactionRegistry } from '../reaction/registry.ts';
import { SubstanceRegistry } from '../substance/registry.ts';
import { installLibrary } from './library.ts';
import { MINERAL } from './mineral.ts';

function world(): {
  species: SpeciesRegistry;
  reactions: ReactionRegistry;
  substances: SubstanceRegistry;
} {
  const species = new SpeciesRegistry();
  registerStandardSpecies(species);
  const reactions = new ReactionRegistry(species);
  const substances = new SubstanceRegistry(species, reactions);
  installLibrary(MINERAL, species, reactions, substances);
  return { species, reactions, substances };
}

describe('the mineral library', () => {
  it('installs: every reaction balances and every substance resolves', () => {
    const { substances } = world();
    for (const id of ['limestone', 'gypsum-board', 'sand', 'clay', 'concrete', 'glass']) {
      expect(substances.indexOf(id)).toBeGreaterThanOrEqual(0);
    }
  });

  it('DERIVES CALCINATION AT THE PUBLISHED +178 kJ/mol, and nothing stores it', () => {
    /* `§8.7` quotes +178.3 kJ/mol. Hess's law over CaCO₃, CaO and CO₂ gives +179.2 — a difference
       of half a percent, which is inside the spread of the published formation enthalpies. */
    const { reactions } = world();
    const perMole = reactions.enthalpyOf(reactions.indexOf('calcine-limestone'));
    expect(perMole).toBeGreaterThan(175000);
    expect(perMole).toBeLessThan(183000);
  });

  it('MAKES PLASTERBOARD A FIRE BARRIER, which is two waters and an endotherm', () => {
    /*
     * `§8.7`'s point, and it is the whole reason gypsum is in the species table. Calcium sulfate
     * dihydrate gives up both its waters at 100-150 °C, absorbing 104 kJ/mol on the way — 607 kJ per
     * kilogram of board — and while that is happening the surface behind it cannot rise past the
     * boiling point. That is a fire-rated wall, and it is one reaction.
     */
    const { reactions } = world();
    const index = reactions.indexOf('dehydrate-gypsum');
    expect(reactions.enthalpyOf(index)).toBeGreaterThan(98000);
    expect(reactions.enthalpyOf(index)).toBeLessThan(112000);
    expect(reactions.minTemperatureOf(index)).toBeLessThan(423.15);
    expect(reactions.minTemperatureOf(index)).toBeGreaterThan(373.15);
  });

  it('gives glass NOTHING TO DO, which is the point of it', () => {
    /*
     * A substance with no reactions is not an unfinished one. Glass in a fire gets hot, conducts,
     * radiates and softens — and softening is mechanical, which `§26` refuses in writing because
     * this package owns no solver. Inventing a chemistry for it would be worse than declining to.
     */
    const { substances } = world();
    const glass = substances.definitionOf(substances.indexOf('glass'));
    expect(glass.reactions ?? []).toHaveLength(0);
    expect(glass.ignition).toBeUndefined();
  });

  it('spalls concrete for two reasons at once, both of which are in it', () => {
    /* Free water flashing to steam at 100 °C, then the limestone in the aggregate calcining at 825
       and releasing CO₂ inside the matrix. A consumer gets both by declaring concrete. */
    const { substances } = world();
    const concrete = substances.definitionOf(substances.indexOf('concrete'));
    expect(concrete.reactions).toContain('boil-water');
    expect(concrete.reactions).toContain('calcine-limestone');
  });
});
