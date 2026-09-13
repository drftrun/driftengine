import { beforeEach, describe, expect, it } from 'vitest';
import { ELEMENT_COUNT, elementIndex } from '../element/elements.ts';
import { SpeciesRegistry } from '../species/registry.ts';
import { registerStandardSpecies } from '../species/standard.ts';
import { massFractions } from '../substance/composition.ts';
import { SubstanceRegistry } from '../substance/registry.ts';
import { SHAPE_SLAB } from '../parcel/shells.ts';
import { ParcelStore } from '../parcel/store.ts';
import { maxElementDrift } from '../testing/drift.ts';
import { KIND_CHAR_OXIDATION, KIND_PYROLYSIS, ReactionRegistry } from './registry.ts';

const C = elementIndex('C');
const O = elementIndex('O');

describe('the reaction solver', () => {
  let species: SpeciesRegistry;
  let reactions: ReactionRegistry;
  let substances: SubstanceRegistry;
  let parcels: ParcelStore;
  let wood: number;

  beforeEach(() => {
    species = new SpeciesRegistry();
    registerStandardSpecies(species);
    reactions = new ReactionRegistry(species);

    /* Charring, idealised so the stoichiometry is integers: cellulose to carbon and steam. */
    reactions.register({
      id: 'char-cellulose',
      reactants: [{ species: 'cellulose', moles: 1 }],
      products: [
        { species: 'C(char)', moles: 6 },
        { species: 'H2O(g)', moles: 5 },
      ],
      kinetics: { type: 'arrhenius', A: 1.3e10, activationEnergy: 150500 },
      kind: KIND_PYROLYSIS,
    });
    reactions.register({
      id: 'burn-char',
      reactants: [
        { species: 'C(char)', moles: 1 },
        { species: 'O2', moles: 1 },
      ],
      products: [{ species: 'CO2', moles: 1 }],
      kinetics: { type: 'arrhenius', A: 1e7, activationEnergy: 140000 },
      kind: KIND_CHAR_OXIDATION,
    });

    substances = new SubstanceRegistry(species, reactions);
    /*
     * A closed parcel carrying its own oxidiser. Unphysical as a *material* — oxygen does not sit
     * inside wood — and exactly what a conservation test needs, because a closed system is the only
     * one where "nothing was created or destroyed" is a statement about the solver rather than
     * about the boundary. CH-4's gas field is what replaces it.
     */
    wood = substances.define({
      id: 'wood',
      composition: massFractions(species, { cellulose: 0.7, 'H2O(l)': 0.1, O2: 0.2 }),
      density: 700,
      conductivity: { k0: 0.16, k1: 0 },
      shells: 4,
      shape: SHAPE_SLAB,
      reactions: ['char-cellulose', 'burn-char'],
    });
    parcels = new ParcelStore(substances);
  });

  const spawn = (temperature: number, mass = 1): number =>
    parcels.spawn({ substance: wood, mass, temperature, area: 0.05 });

  it('starts each shell holding its share of the substance’s composition', () => {
    const p = spawn(293.15, 2);
    const cellulose = species.indexOf('cellulose');
    for (let s = 0; s < 4; s++) {
      /* Four shells of equal mass, so each holds a quarter of two kilograms times 0.7. */
      expect(parcels.speciesMassOf(p, s, cellulose)).toBeCloseTo(0.5 * 0.7, 12);
    }
    expect(parcels.parcelSpeciesMass(p, cellulose)).toBeCloseTo(2 * 0.7, 12);
  });

  it('moves mass from reactants to products', () => {
    const p = spawn(700);
    const cellulose = species.indexOf('cellulose');
    const char = species.indexOf('C(char)');
    const before = parcels.parcelSpeciesMass(p, cellulose);

    for (let i = 0; i < 60; i++) parcels.react(p, 1 / 60);

    expect(parcels.parcelSpeciesMass(p, cellulose)).toBeLessThan(before);
    expect(parcels.parcelSpeciesMass(p, char)).toBeGreaterThan(0);
  });

  it('CONSERVES EVERY ELEMENT over a hundred thousand ticks', () => {
    /*
     * **The acceptance test of this phase**, and `§6` of the design calls it the single most
     * valuable test in the track. A chemistry model that does not conserve elements invents or
     * destroys matter, and every symptom of that is subtle: fires that will not go out, mass that
     * quietly grows, smoke that never clears. One assertion catches all of them.
     *
     * CH-0 built `elementTotals` before there was anything to conserve through, for this moment.
     */
    const p = spawn(900);
    const before = new Float64Array(ELEMENT_COUNT);
    const after = new Float64Array(ELEMENT_COUNT);
    parcels.elementTotalsOf(p, before);

    for (let i = 0; i < 100000; i++) parcels.react(p, 1 / 60);

    parcels.elementTotalsOf(p, after);
    expect(maxElementDrift(before, after)).toBeLessThan(1e-12);
    /* And it actually ran, rather than conserving by doing nothing. */
    expect(after[C]).toBeGreaterThan(0);
    expect(parcels.parcelSpeciesMass(p, species.indexOf('CO2'))).toBeGreaterThan(0);
  });

  it('never lets a species go negative, however hard it is driven', () => {
    /*
     * The failure mode a stiff explicit integrator has: overshoot into negative mass, which in an
     * exponential rate law is where the NaNs come from. The clamp bounds the worst case at
     * "consume everything this substep", which is physical and self-correcting.
     */
    const hot = spawn(2500);
    for (let i = 0; i < 20000; i++) {
      parcels.react(hot, 1 / 60);
      for (let s = 0; s < 4; s++) {
        for (const id of ['cellulose', 'C(char)', 'O2', 'CO2', 'H2O(g)']) {
          expect(
            parcels.speciesMassOf(hot, s, species.indexOf(id)),
            `${id} at tick ${i}`,
          ).toBeGreaterThanOrEqual(0);
        }
      }
      if (i > 200) break;
    }
    for (let i = 0; i < 20000; i++) parcels.react(hot, 1 / 60);
    for (let s = 0; s < 4; s++) {
      for (const id of ['cellulose', 'C(char)', 'O2', 'CO2', 'H2O(g)']) {
        expect(parcels.speciesMassOf(hot, s, species.indexOf(id)), id).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('conserves mass, because element balance and derived molar masses together imply it', () => {
    const p = spawn(1200, 3);
    for (let i = 0; i < 10000; i++) parcels.react(p, 1 / 60);
    let total = 0;
    for (let s = 0; s < 4; s++) total += parcels.shellMassOf(p, s);
    expect(total).toBeCloseTo(3, 9);
  });

  it('closes the chemical and thermal budget together', () => {
    /*
     * Chemical energy converts to thermal and back, and neither is conserved on its own. What is
     * conserved is the sum — which is exact here, because the same number is added to one and
     * subtracted from the other.
     */
    const p = spawn(900);
    const before = parcels.enthalpyOf(p) + parcels.chemicalEnergyOf(p);
    for (let i = 0; i < 50000; i++) parcels.react(p, 1 / 60);
    const after = parcels.enthalpyOf(p) + parcels.chemicalEnergyOf(p);
    expect(Math.abs(after - before) / Math.abs(before)).toBeLessThan(1e-12);
  });

  it('warms itself on an exothermic reaction and cools on an endothermic one', () => {
    /* Char oxidation releases 393.5 kJ/mol. Nothing external adds heat here: the parcel warms
       because chemistry moved energy out of the bonds and into the enthalpy that reads as heat. */
    const p = spawn(900);
    const before = parcels.temperatureOf(p);
    for (let i = 0; i < 6000; i++) parcels.react(p, 1 / 60);
    expect(parcels.temperatureOf(p)).toBeGreaterThan(before);

    const cold = new ReactionRegistry(species);
    cold.register({
      id: 'calcine',
      reactants: [{ species: 'CaCO3', moles: 1 }],
      products: [
        { species: 'CaO', moles: 1 },
        { species: 'CO2', moles: 1 },
      ],
      kinetics: { type: 'arrhenius', A: 1e11, activationEnergy: 160000 },
      kind: KIND_PYROLYSIS,
    });
    const rocks = new SubstanceRegistry(species, cold);
    const limestone = rocks.define({
      id: 'limestone',
      composition: massFractions(species, { CaCO3: 1 }),
      density: 2700,
      conductivity: { k0: 1.3, k1: 0 },
      shells: 1,
      shape: SHAPE_SLAB,
      reactions: ['calcine'],
    });
    const stones = new ParcelStore(rocks);
    const stone = stones.spawn({ substance: limestone, mass: 1, temperature: 1300, area: 0.05 });
    const warm = stones.temperatureOf(stone);
    for (let i = 0; i < 6000; i++) stones.react(stone, 1 / 60);
    expect(stones.temperatureOf(stone)).toBeLessThan(warm);
  });

  it('scales competing reactions by the same factor rather than first come first served', () => {
    /*
     * When two reactions want more of a species than exists, both are cut by the same proportion.
     * First-come would make the answer depend on registration order, which is a determinism hole
     * with no symptom until two consumers register in different orders.
     */
    const forward = new ReactionRegistry(species);
    forward.register({
      id: 'a',
      reactants: [
        { species: 'C(char)', moles: 1 },
        { species: 'O2', moles: 1 },
      ],
      products: [{ species: 'CO2', moles: 1 }],
      kinetics: { type: 'instant' },
      kind: KIND_CHAR_OXIDATION,
    });
    forward.register({
      id: 'b',
      reactants: [
        { species: 'C(char)', moles: 2 },
        { species: 'O2', moles: 1 },
      ],
      products: [{ species: 'CO', moles: 2 }],
      kinetics: { type: 'instant' },
      kind: KIND_CHAR_OXIDATION,
    });

    const backward = new ReactionRegistry(species);
    backward.register({
      id: 'b',
      reactants: [
        { species: 'C(char)', moles: 2 },
        { species: 'O2', moles: 1 },
      ],
      products: [{ species: 'CO', moles: 2 }],
      kinetics: { type: 'instant' },
      kind: KIND_CHAR_OXIDATION,
    });
    backward.register({
      id: 'a',
      reactants: [
        { species: 'C(char)', moles: 1 },
        { species: 'O2', moles: 1 },
      ],
      products: [{ species: 'CO2', moles: 1 }],
      kinetics: { type: 'instant' },
      kind: KIND_CHAR_OXIDATION,
    });

    const run = (registry: ReactionRegistry): readonly number[] => {
      const subs = new SubstanceRegistry(species, registry);
      const ember = subs.define({
        id: 'ember',
        composition: massFractions(species, { 'C(char)': 0.9, O2: 0.1 }),
        density: 400,
        conductivity: { k0: 0.07, k1: 0 },
        shells: 1,
        shape: SHAPE_SLAB,
        reactions: ['a', 'b'],
      });
      const store = new ParcelStore(subs);
      const p = store.spawn({ substance: ember, mass: 1, temperature: 1000, area: 0.05 });
      store.react(p, 1 / 60);
      return [
        store.parcelSpeciesMass(p, species.indexOf('CO2')),
        store.parcelSpeciesMass(p, species.indexOf('CO')),
        store.parcelSpeciesMass(p, species.indexOf('O2')),
      ];
    };

    const first = run(forward);
    const second = run(backward);
    /* Both products form; neither is starved out by having been registered second. */
    expect(first[0] as number).toBeGreaterThan(0);
    expect(first[1] as number).toBeGreaterThan(0);
    for (let i = 0; i < first.length; i++) {
      expect(second[i] as number, `slot ${i}`).toBeCloseTo(first[i] as number, 12);
    }
  });

  it('does nothing to a substance that declares no reactions', () => {
    const inert = substances.define({
      id: 'granite',
      composition: massFractions(species, { SiO2: 1 }),
      density: 2700,
      conductivity: { k0: 2.5, k1: 0 },
      shells: 2,
      shape: SHAPE_SLAB,
    });
    const p = parcels.spawn({ substance: inert, mass: 1, temperature: 1500, area: 0.05 });
    const before = parcels.enthalpyOf(p);
    for (let i = 0; i < 1000; i++) parcels.react(p, 1 / 60);
    expect(parcels.enthalpyOf(p)).toBe(before);
    expect(parcels.parcelSpeciesMass(p, species.indexOf('SiO2'))).toBeCloseTo(1, 12);
  });

  it('refuses a substance naming a reaction the registry does not hold', () => {
    expect(() =>
      substances.define({
        id: 'nonsense',
        composition: massFractions(species, { SiO2: 1 }),
        density: 2700,
        conductivity: { k0: 2.5, k1: 0 },
        reactions: ['transmute'],
      }),
    ).toThrow(/transmute/);
  });

  it('allocates nothing per react', async () => {
    /*
     * **Garbage-collection *count*, never `heapUsed`**, which is `AGENTS.md`'s rule: a heap reading
     * moves for reasons that have nothing to do with the code under it.
     *
     * The count has a noise floor, and this test used to sit in it. A loop that provably allocates
     * nothing — summing integers — still reports two or three collections, because the observer is
     * live across a 50 ms settling window in which the whole isolate's rubbish is fair game. The
     * control was only producing eleven to fourteen, so a quarter of it landed *inside* that floor
     * and the test failed about one run in five with nothing wrong.
     *
     * So the floor is now measured rather than assumed to be zero, and the control is ten times
     * louder. The statement is that `react` sits in the same band as a loop that cannot allocate,
     * and that the band is nowhere near the one that does.
     */
    const p = spawn(900);
    const collections = async (work: () => void): Promise<number> => {
      let n = 0;
      const observer = new PerformanceObserver((list) => {
        n += list.getEntries().length;
      });
      observer.observe({ entryTypes: ['gc'] });
      work();
      await new Promise((resolve) => setTimeout(resolve, 50));
      observer.disconnect();
      return n;
    };
    let sink: unknown;
    let sum = 0;
    const ROUNDS = 100000;

    /* Tiering a hot loop up allocates code objects and deopt data, which is the compiler's rubbish
       rather than this function's. Warm both loops unobserved. */
    for (let i = 0; i < ROUNDS; i++) parcels.react(p, 1 / 60);
    for (let i = 0; i < ROUNDS; i++) sum += i;

    const floor = await collections(() => {
      for (let i = 0; i < ROUNDS; i++) sum += i;
    });
    const quiet = await collections(() => {
      for (let i = 0; i < ROUNDS; i++) parcels.react(p, 1 / 60);
    });
    const noisy = await collections(() => {
      for (let i = 0; i < ROUNDS * 100; i++) sink = { at: i, of: [i] };
    });

    expect(noisy, 'the control must separate the two states').toBeGreaterThan(30);
    expect(floor, 'a loop that cannot allocate sets the floor').toBeLessThan(noisy / 8);
    expect(quiet, 'react must sit at that floor, not above it').toBeLessThan(noisy / 8);
    expect(sink).not.toBe(undefined);
    expect(sum).toBeGreaterThan(0);
  });
});
