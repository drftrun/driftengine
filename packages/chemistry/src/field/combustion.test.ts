import { beforeEach, describe, expect, it } from 'vitest';
import { ELEMENT_COUNT } from '../element/elements.ts';
import { SpeciesRegistry } from '../species/registry.ts';
import { registerStandardSpecies } from '../species/standard.ts';
import { KIND_COMBUSTION, ReactionRegistry } from '../reaction/registry.ts';
import { maxElementDrift } from '../testing/drift.ts';
import { STANDARD_AIR } from './ambient.ts';
import { AtmosphereField } from './atmosphere.ts';

/** Below about this, a flame cannot be sustained. `§12`. */
const LIMITING_OXYGEN = 0.14;

describe('combustion in the field', () => {
  let species: SpeciesRegistry;
  let reactions: ReactionRegistry;
  let methane: number;

  beforeEach(() => {
    species = new SpeciesRegistry();
    registerStandardSpecies(species);
    reactions = new ReactionRegistry(species);
    reactions.register({
      id: 'burn-methane',
      reactants: [
        { species: 'CH4', moles: 1 },
        { species: 'O2', moles: 2 },
      ],
      products: [
        { species: 'CO2', moles: 1 },
        { species: 'H2O(g)', moles: 2 },
      ],
      kinetics: { type: 'arrhenius', A: 1.3e9, activationEnergy: 160000 },
      kind: KIND_COMBUSTION,
    });
    methane = species.indexOf('CH4');
  });

  const make = (): AtmosphereField =>
    new AtmosphereField(species, {
      cellSize: 1,
      ambient: STANDARD_AIR,
      reactions,
      reactionIds: ['burn-methane'],
    });

  /**
   * A room of exactly one free cell inside chunk (0,0,0); everything else is solid.
   *
   * One cell rather than eight, and that is what makes the assertion about the *chemistry*. A
   * larger sealed room stratifies — fuel added on top of a full atmosphere makes its cell denser
   * than the air around it, so it sinks and concentrates, and a reading taken at one point is then
   * about where the gas went rather than about what burned. With a single cell nothing can move at
   * all and the only thing left is the reaction.
   */
  const sealCell = (field: AtmosphereField): void => {
    for (let x = 0; x < 8; x++) {
      for (let y = 0; y < 8; y++) {
        for (let z = 0; z < 8; z++) {
          if (x !== 3 || y !== 3 || z !== 3) field.setBlocked(x + 0.5, y + 0.5, z + 0.5, true);
        }
      }
    }
  };

  /** Fuel and a spark. 0.2 kg of methane needs 0.8 kg of oxygen; a cubic metre of air holds 0.28. */
  const light = (field: AtmosphereField): void => {
    field.addSpecies(3.5, 3.5, 3.5, methane, 0.2);
    field.addHeat(3.5, 3.5, 3.5, 900000);
  };

  it('burns what it is given, and the products are the ones the reaction names', () => {
    const field = make();
    sealCell(field);
    light(field);
    const before = field.speciesMassAt(3.5, 3.5, 3.5, methane);
    for (let i = 0; i < 600; i++) field.step(1 / 60);
    expect(field.speciesMassAt(3.5, 3.5, 3.5, methane)).toBeLessThan(before);
    expect(field.speciesMassAt(3.5, 3.5, 3.5, species.indexOf('CO2'))).toBeGreaterThan(0);
    expect(field.speciesMassAt(3.5, 3.5, 3.5, species.indexOf('H2O(g)'))).toBeGreaterThan(0);
  });

  it('A SEALED ROOM RUNS OUT OF OXYGEN AND THE BURNING STOPS', () => {
    /*
     * **The acceptance test of this phase.** Nothing tells the fire to stop. It stops because the
     * oxygen is gone, and the rate of a reaction with no oxidiser left is zero by mass action —
     * which is the whole argument for modelling the air rather than scripting a fire.
     *
     * What is left is below the limiting index of `§12`, which is where CH-5's extinction criterion
     * will read it. This phase reports the number; the next one acts on it.
     */
    const field = make();
    sealCell(field);
    light(field);
    /*
     * 15.9%, not 20.7%, and the drop is dilution rather than consumption: 0.2 kg of methane is
     * 12.5 moles against the air's 41, so simply adding the fuel pushes the oxygen fraction down
     * by a fifth before anything has burned. Worth asserting, because a criterion that reads the
     * oxygen fraction — which `§12`'s is — sees a rich mixture as partly starved already.
     */
    expect(field.oxygenFractionAt(3.5, 3.5, 3.5)).toBeCloseTo(0.159, 2);

    for (let i = 0; i < 1200; i++) field.step(1 / 60);

    expect(field.oxygenFractionAt(3.5, 3.5, 3.5)).toBeLessThan(LIMITING_OXYGEN);

    /* And it has genuinely stopped rather than merely slowed: another thousand ticks move nothing. */
    const settled = field.speciesMassAt(3.5, 3.5, 3.5, methane);
    for (let i = 0; i < 1000; i++) field.step(1 / 60);
    expect(field.speciesMassAt(3.5, 3.5, 3.5, methane)).toBeCloseTo(settled, 9);

    /* Unburnt fuel is left over, which is what an oxygen-starved fire leaves behind. */
    expect(settled).toBeGreaterThan(0);
  });

  it('and a ventilated one keeps more of its oxygen, because the air around it resupplies', () => {
    /* The same cell with nothing sealing it. Its neighbours are air, and they feed it. */
    const open = make();
    open.addSpecies(3.5, 3.5, 3.5, methane, 0.2);
    open.addHeat(3.5, 3.5, 3.5, 900000);

    const sealed = make();
    sealCell(sealed);
    light(sealed);

    for (let i = 0; i < 1200; i++) {
      open.step(1 / 60);
      sealed.step(1 / 60);
    }
    expect(open.oxygenFractionAt(3.5, 3.5, 3.5)).toBeGreaterThan(
      sealed.oxygenFractionAt(3.5, 3.5, 3.5),
    );
  }, 60000);

  it('conserves every element through the whole burn', () => {
    const field = make();
    sealCell(field);
    light(field);
    const before = new Float64Array(ELEMENT_COUNT);
    const after = new Float64Array(ELEMENT_COUNT);
    field.elementTotals(before);
    for (let i = 0; i < 1200; i++) field.step(1 / 60);
    field.elementTotals(after);
    expect(maxElementDrift(before, after)).toBeLessThan(1e-12);
  });

  it('gets hot doing it, and that is the heat the reaction released', () => {
    const field = make();
    sealCell(field);
    const cold = field.temperatureAt(3.5, 3.5, 3.5);
    light(field);
    const lit = field.temperatureAt(3.5, 3.5, 3.5);
    for (let i = 0; i < 1200; i++) field.step(1 / 60);
    expect(field.temperatureAt(3.5, 3.5, 3.5)).toBeGreaterThan(lit);
    expect(lit).toBeGreaterThan(cold);
  });

  it('does nothing at all where no reactions were declared', () => {
    const inert = new AtmosphereField(species, { cellSize: 1, ambient: STANDARD_AIR });
    sealCell(inert);
    inert.addSpecies(3.5, 3.5, 3.5, methane, 0.2);
    inert.addHeat(3.5, 3.5, 3.5, 900000);
    const before = inert.speciesMassAt(3.5, 3.5, 3.5, methane);
    const oxygenBefore = inert.oxygenFractionAt(3.5, 3.5, 3.5);
    for (let i = 0; i < 600; i++) inert.step(1 / 60);
    expect(inert.speciesMassAt(3.5, 3.5, 3.5, methane)).toBeCloseTo(before, 9);
    expect(inert.oxygenFractionAt(3.5, 3.5, 3.5)).toBeCloseTo(oxygenBefore, 9);
  });

  it('refuses a reaction naming a species the field does not carry', () => {
    reactions.register({
      id: 'char',
      reactants: [
        { species: 'C(char)', moles: 1 },
        { species: 'O2', moles: 1 },
      ],
      products: [{ species: 'CO2', moles: 1 }],
      kinetics: { type: 'arrhenius', A: 1e7, activationEnergy: 140000 },
      kind: KIND_COMBUSTION,
    });
    expect(
      () =>
        new AtmosphereField(species, {
          cellSize: 1,
          ambient: STANDARD_AIR,
          reactions,
          reactionIds: ['char'],
        }),
    ).toThrow(/C\(char\)/);
  });
});
