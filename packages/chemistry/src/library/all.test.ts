import { describe, expect, it } from 'vitest';
import { SpeciesRegistry } from '../species/registry.ts';
import { registerStandardSpecies } from '../species/standard.ts';
import { ReactionRegistry } from '../reaction/registry.ts';
import { SubstanceRegistry } from '../substance/registry.ts';
import { ELEMENT_COUNT } from '../element/elements.ts';
import { installLibrary, type SubstanceLibrary } from './library.ts';
import { ORGANIC } from './organic.ts';
import { FOOD } from './food.ts';
import { FUEL } from './fuel.ts';
import { POLYMER } from './polymer.ts';
import { MINERAL } from './mineral.ts';
import { METAL } from './metal.ts';
import { BIOLOGICAL } from './biological.ts';

const ALL: readonly SubstanceLibrary[] = [ORGANIC, FOOD, FUEL, POLYMER, MINERAL, METAL, BIOLOGICAL];

describe('all seven libraries at once', () => {
  it('INSTALL TOGETHER, sharing every reaction they have in common', () => {
    /*
     * The case `installLibrary` exists for. Six of the seven declare gas-phase combustion and char
     * oxidation, and five of them declare boiling water — so a consumer assembling a world out of
     * several families would hit a duplicate id on the first shared reaction, at init, with a
     * message about something they did not write.
     */
    const species = new SpeciesRegistry();
    registerStandardSpecies(species);
    const reactions = new ReactionRegistry(species);
    const substances = new SubstanceRegistry(species, reactions);
    for (const library of ALL) installLibrary(library, species, reactions, substances);

    /* Thirty-nine substances across seven families, and every one of them resolved. */
    expect(substances.count).toBe(39);
    expect(species.count).toBeGreaterThan(68);
  });

  it('gives every substance a composition that reduces to real elements', () => {
    /*
     * The check `elementTotals` was built for, run over the whole library at init rather than over a
     * burning log at tick ten thousand. A composition that named a species wrongly, or a mass
     * fraction typed with a transposed digit, is a substance whose element vector is wrong from the
     * first frame — and this reduces all thirty-eight.
     */
    const species = new SpeciesRegistry();
    registerStandardSpecies(species);
    const reactions = new ReactionRegistry(species);
    const substances = new SubstanceRegistry(species, reactions);
    for (const library of ALL) installLibrary(library, species, reactions, substances);

    const out = new Float64Array(ELEMENT_COUNT);
    for (let i = 0; i < substances.count; i++) {
      const composition = substances.definitionOf(i).composition;
      out.fill(0);
      let total = 0;
      for (let k = 0; k < composition.species.length; k++) {
        const s = composition.species[k] as number;
        species.elements.addScaledRow(
          s,
          (composition.fraction[k] as number) / species.molarMass(s),
          out,
        );
        total += composition.fraction[k] as number;
      }
      expect(total).toBeCloseTo(1, 6);
      let elements = 0;
      for (let e = 0; e < ELEMENT_COUNT; e++) elements += out[e] as number;
      expect(elements).toBeGreaterThan(0);
    }
  });

  it("LETS TWO FAMILIES MEET: must ferments into the fuel library's ethanol", () => {
    /*
     * Nothing joins these files. `biological` produces ethanol because that is what fermentation
     * produces, and `fuel` vaporises and burns ethanol because that is what ethanol does — so a
     * cellar that ferments and then catches fire is two libraries agreeing about one species, with
     * no seam between them at all.
     */
    const species = new SpeciesRegistry();
    registerStandardSpecies(species);
    const reactions = new ReactionRegistry(species);
    const substances = new SubstanceRegistry(species, reactions);
    installLibrary(BIOLOGICAL, species, reactions, substances);
    installLibrary(FUEL, species, reactions, substances);

    const ethanol = species.indexOf('ethanol');
    expect([...reactions.productSpecies(reactions.indexOf('ferment'))]).toContain(ethanol);
    expect([...reactions.reactantSpecies(reactions.indexOf('vaporise-ethanol'))]).toContain(
      ethanol,
    );
  });
});
