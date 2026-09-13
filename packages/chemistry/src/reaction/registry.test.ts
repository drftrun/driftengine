import { beforeEach, describe, expect, it } from 'vitest';
import { SpeciesRegistry } from '../species/registry.ts';
import { registerStandardSpecies } from '../species/standard.ts';
import { KIND_COMBUSTION, KIND_PYROLYSIS, ReactionRegistry } from './registry.ts';

describe('ReactionRegistry', () => {
  let species: SpeciesRegistry;
  let reactions: ReactionRegistry;

  beforeEach(() => {
    species = new SpeciesRegistry();
    registerStandardSpecies(species);
    reactions = new ReactionRegistry(species);
  });

  const methane = {
    id: 'burn-methane',
    reactants: [
      { species: 'CH4', moles: 1 },
      { species: 'O2', moles: 2 },
    ],
    products: [
      { species: 'CO2', moles: 1 },
      { species: 'H2O(g)', moles: 2 },
    ],
    kinetics: { type: 'arrhenius', A: 1.3e9, activationEnergy: 202000 },
    kind: KIND_COMBUSTION,
  } as const;

  it('registers a balanced reaction and hands back an index', () => {
    expect(reactions.register(methane)).toBe(0);
    expect(reactions.count).toBe(1);
    expect(reactions.indexOf('burn-methane')).toBe(0);
    expect(reactions.idOf(0)).toBe('burn-methane');
    expect(reactions.kindOf(0)).toBe(KIND_COMBUSTION);
  });

  it('derives the reaction enthalpy by Hess’s law rather than taking one', () => {
    /*
     * The whole reason CH-0 stores formation enthalpies. A typed-in `ΔH` that disagreed with its
     * own species would conserve energy *in the code* and lose it *against the world*, with no
     * symptom anywhere. Derived, the two cannot disagree.
     *
     * Methane in air: −802.6 kJ/mol to steam, −890.6 to liquid water. Both are the published
     * lower and higher heating values of methane, and neither was typed in.
     */
    reactions.register(methane);
    expect(reactions.enthalpyOf(0)).toBeCloseTo(-802562, 0);

    const higher = reactions.register({
      ...methane,
      id: 'burn-methane-hhv',
      products: [
        { species: 'CO2', moles: 1 },
        { species: 'H2O(l)', moles: 2 },
      ],
    });
    expect(reactions.enthalpyOf(higher)).toBeCloseTo(-890570, 0);
  });

  it('gets an endothermic reaction’s sign right', () => {
    /* Calcination: +178 kJ/mol, which is why limestone in a fire absorbs heat and spalls. */
    const calcine = reactions.register({
      id: 'calcine',
      reactants: [{ species: 'CaCO3', moles: 1 }],
      products: [
        { species: 'CaO', moles: 1 },
        { species: 'CO2', moles: 1 },
      ],
      kinetics: { type: 'arrhenius', A: 1e8, activationEnergy: 180000 },
      kind: KIND_PYROLYSIS,
    });
    expect(reactions.enthalpyOf(calcine)).toBeGreaterThan(0);
    expect(reactions.enthalpyOf(calcine)).toBeCloseTo(179190, 0);
  });

  it('reproduces char’s heat of combustion, which is where an ember’s heat comes from', () => {
    const burn = reactions.register({
      id: 'burn-char',
      reactants: [
        { species: 'C(char)', moles: 1 },
        { species: 'O2', moles: 1 },
      ],
      products: [{ species: 'CO2', moles: 1 }],
      kinetics: { type: 'arrhenius', A: 1e7, activationEnergy: 140000 },
      kind: KIND_COMBUSTION,
    });
    expect(reactions.enthalpyOf(burn)).toBeCloseTo(-393510, 0);
    /* 32.8 MJ per kilogram of carbon. */
    expect(
      -reactions.enthalpyOf(burn) / species.molarMass(species.indexOf('C(char)')) / 1e6,
    ).toBeCloseTo(32.8, 1);
  });

  it('refuses a reaction that does not balance, naming the element and the gap', () => {
    /*
     * **Refused at registration rather than warned about**, per `AGENTS.md`'s fail-fast rule. An
     * unbalanced reaction invents or destroys matter every time it runs, and every symptom of that
     * is subtle: a fire that will not go out, a mass that quietly grows.
     */
    expect(() =>
      reactions.register({
        ...methane,
        id: 'wrong',
        products: [
          { species: 'CO2', moles: 1 },
          { species: 'H2O(g)', moles: 1 },
        ],
      }),
    ).toThrow(/H/);
  });

  it('names the size of the imbalance, not merely its existence', () => {
    let message = '';
    try {
      reactions.register({
        ...methane,
        id: 'wrong2',
        products: [
          { species: 'CO2', moles: 2 },
          { species: 'H2O(g)', moles: 2 },
        ],
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/C/);
    expect(message).toMatch(/1/);
  });

  it('balances a reaction whose stoichiometry is fractional', () => {
    /* Protein is an average residue, so anything consuming it has fractional coefficients — and
       rounding them to integers is what would break the balance. */
    const denature = reactions.register({
      id: 'denature',
      reactants: [{ species: 'protein', moles: 1 }],
      products: [{ species: 'protein(denatured)', moles: 1 }],
      kinetics: { type: 'arrhenius', A: 1e30, activationEnergy: 250000 },
      kind: KIND_PYROLYSIS,
    });
    /* Unfolding costs energy, so this one is endothermic by exactly the gap CH-0 stored. */
    expect(reactions.enthalpyOf(denature)).toBeCloseTo(10000, 6);
  });

  it('refuses a species it does not know, naming it', () => {
    expect(() =>
      reactions.register({
        ...methane,
        id: 'x',
        reactants: [{ species: 'unobtainium', moles: 1 }],
      }),
    ).toThrow(/unobtainium/);
  });

  it('refuses a duplicate id, an empty side, and a non-positive coefficient', () => {
    reactions.register(methane);
    expect(() => reactions.register(methane)).toThrow(/burn-methane/);
    expect(() => reactions.register({ ...methane, id: 'a', reactants: [] })).toThrow(/reactant/);
    expect(() => reactions.register({ ...methane, id: 'b', products: [] })).toThrow(/product/);
    expect(() =>
      reactions.register({ ...methane, id: 'c', reactants: [{ species: 'CH4', moles: 0 }] }),
    ).toThrow(/0/);
  });

  it('hands the solver packed columns rather than objects', () => {
    reactions.register(methane);
    expect([...reactions.reactantSpecies(0)]).toEqual([
      species.indexOf('CH4'),
      species.indexOf('O2'),
    ]);
    expect([...reactions.reactantMoles(0)]).toEqual([1, 2]);
    expect([...reactions.productSpecies(0)]).toEqual([
      species.indexOf('CO2'),
      species.indexOf('H2O(g)'),
    ]);
    expect([...reactions.productMoles(0)]).toEqual([1, 2]);
  });

  it('tabulates the rate at registration, so the tick never evaluates one', () => {
    reactions.register(methane);
    const table = reactions.rateTableOf(0);
    expect(table.knots).toBeGreaterThan(500);
    expect(table.rate.length).toBe(table.knots);
  });
});
