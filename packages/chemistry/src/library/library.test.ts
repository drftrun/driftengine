import { describe, expect, it } from 'vitest';
import { SpeciesRegistry } from '../species/registry.ts';
import { registerStandardSpecies } from '../species/standard.ts';
import { ReactionRegistry } from '../reaction/registry.ts';
import { SubstanceRegistry } from '../substance/registry.ts';
import { PHASE_GAS } from '../species/species.ts';
import { massFractions } from '../substance/composition.ts';
import { KIND_PYROLYSIS } from '../reaction/reaction.ts';
import { type SubstanceLibrary, installLibrary } from './library.ts';

const world = (): {
  species: SpeciesRegistry;
  reactions: ReactionRegistry;
  substances: SubstanceRegistry;
} => {
  const species = new SpeciesRegistry();
  registerStandardSpecies(species);
  const reactions = new ReactionRegistry(species);
  const substances = new SubstanceRegistry(species, reactions);
  return { species, reactions, substances };
};

const ONE: SubstanceLibrary = {
  id: 'one',
  species: [
    {
      id: 'widget',
      formula: { C: 1 },
      phase: PHASE_GAS,
      formationEnthalpy: 0,
      cpA: 900,
      pseudo: true,
    },
  ],
  reactions: [
    {
      id: 'unwidget',
      reactants: [{ species: 'widget', moles: 1 }],
      products: [{ species: 'C(char)', moles: 1 }],
      kinetics: { type: 'arrhenius', A: 1, activationEnergy: 100000 },
      kind: KIND_PYROLYSIS,
    },
  ],
  substances: (s) => [
    {
      id: 'widgetry',
      composition: massFractions(s, { widget: 1 }),
      density: 500,
      reactions: ['unwidget'],
    },
  ],
};

const TWO: SubstanceLibrary = {
  id: 'two',
  species: ONE.species,
  reactions: ONE.reactions,
  substances: (s) => [
    {
      id: 'more-widgetry',
      composition: massFractions(s, { widget: 0.5, 'C(char)': 0.5 }),
      density: 900,
      reactions: ['unwidget'],
    },
  ],
};

describe('installing a library', () => {
  it('registers its species, its reactions and its substances, in that order', () => {
    const { species, reactions, substances } = world();
    installLibrary(ONE, species, reactions, substances);
    expect(species.indexOf('widget')).toBeGreaterThanOrEqual(0);
    expect(reactions.indexOf('unwidget')).toBeGreaterThanOrEqual(0);
    expect(substances.indexOf('widgetry')).toBeGreaterThanOrEqual(0);
  });

  it('SKIPS what is already there, so two families may share a reaction', () => {
    /*
     * The whole reason this is not a loop of `register` calls. Gas-phase combustion belongs to
     * every family that burns, and a second `register` of the same id throws — so a consumer
     * installing `organic` and `fuel` together would fail at init on the first shared reaction.
     */
    const { species, reactions, substances } = world();
    installLibrary(ONE, species, reactions, substances);
    installLibrary(TWO, species, reactions, substances);
    expect(species.indexOf('widget')).toBeGreaterThanOrEqual(0);
    expect(reactions.count).toBe(1);
    expect(substances.indexOf('more-widgetry')).toBeGreaterThanOrEqual(0);
  });

  it('is idempotent, so installing the same family twice is not an error', () => {
    const { species, reactions, substances } = world();
    installLibrary(ONE, species, reactions, substances);
    const before = substances.count;
    installLibrary(ONE, species, reactions, substances);
    expect(substances.count).toBe(before);
  });
});
