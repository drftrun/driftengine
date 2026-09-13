import { beforeEach, describe, expect, it } from 'vitest';
import { ELEMENT_COUNT } from '../element/elements.ts';
import { SpeciesRegistry } from '../species/registry.ts';
import { registerStandardSpecies } from '../species/standard.ts';
import { KIND_CHAR_OXIDATION, KIND_PYROLYSIS, ReactionRegistry } from '../reaction/registry.ts';
import { massFractions } from '../substance/composition.ts';
import { SubstanceRegistry } from '../substance/registry.ts';
import { SHAPE_SLAB } from '../parcel/shells.ts';
import { ParcelStore } from '../parcel/store.ts';
import { AtmosphereField } from '../field/atmosphere.ts';
import { STANDARD_AIR } from '../field/ambient.ts';
import { maxElementDrift } from '../testing/drift.ts';
import { ChemistryWorld } from './world.ts';

describe('ChemistryWorld', () => {
  let species: SpeciesRegistry;
  let reactions: ReactionRegistry;
  let substances: SubstanceRegistry;
  let parcels: ParcelStore;
  let field: AtmosphereField;
  let world: ChemistryWorld;
  let oak: number;

  beforeEach(() => {
    species = new SpeciesRegistry();
    registerStandardSpecies(species);
    reactions = new ReactionRegistry(species);
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
    oak = substances.define({
      id: 'oak',
      composition: massFractions(species, { cellulose: 0.6, lignin: 0.4 }),
      density: 700,
      conductivity: { k0: 0.16, k1: 0 },
      shells: 4,
      shape: SHAPE_SLAB,
      porosity: 0.5,
      reactions: ['char-cellulose', 'burn-char'],
    });
    parcels = new ParcelStore(substances);
    field = new AtmosphereField(species, {
      cellSize: 1,
      ambient: STANDARD_AIR,
      reactions,
      reactionIds: [],
    });
    world = new ChemistryWorld(parcels, field);
  });

  const log = (x: number): number =>
    parcels.spawn({ substance: oak, mass: 3.5, temperature: 293.15, area: 0.1, x, y: 0.5, z: 0.5 });

  const burnFor = (ticks: number): void => {
    for (let i = 0; i < ticks; i++) {
      world.sources.clear();
      /* A 60 kW campfire at the origin, a square metre of flame at 1200 K. */
      world.sources.add(0, 0.5, 0.5, 1200, 1, 60000);
      world.simulate(1 / 60);
    }
  };

  it('WARMS WHAT IS NEAR THE FIRE AND BARELY TOUCHES WHAT IS FAR', () => {
    /*
     * **The end-to-end form of the relationship the track is built on.** Nothing here applies a
     * flux: a source is declared, and each parcel works out what reaches it from where it is.
     * `§10`'s `1/r²` is the whole difference between the two.
     */
    const near = log(0.4);
    const far = log(1.6);
    burnFor(600);

    const nearRise = parcels.surfaceTemperatureOf(near) - 293.15;
    const farRise = parcels.surfaceTemperatureOf(far) - 293.15;
    expect(nearRise).toBeGreaterThan(50);
    expect(nearRise / farRise).toBeGreaterThan(5);
  });

  it('lets a wall between them stop it', () => {
    const shaded = log(0.4);
    world.occluded = () => true;
    burnFor(600);
    /* Convection from the surrounding air is all that is left, and the air is cold. */
    expect(parcels.surfaceTemperatureOf(shaded) - 293.15).toBeLessThan(2);
  });

  it('heats the surface far more than the core, because that is where the flux lands', () => {
    const near = log(0.4);
    burnFor(600);
    expect(parcels.surfaceTemperatureOf(near)).toBeGreaterThan(
      parcels.coreTemperatureOf(near) + 20,
    );
  });

  it('pushes the gas its reactions make out into the air', () => {
    /*
     * Charring cellulose makes steam, and a porous parcel cannot keep it.
     *
     * The cell has to be sealed and inboard for the signal to survive being measured. Air already
     * carries water vapour — the default ambient is 50% relative humidity — so an open cell relaxes
     * whatever the parcel adds straight back to that, and a corner cell vents to three chunks that
     * do not exist however thoroughly its neighbours are blocked. Both of those swamped the first
     * version of this test, which read a decrease.
     */
    for (let x = 0; x < 8; x++) {
      for (let y = 0; y < 8; y++) {
        for (let z = 0; z < 8; z++) {
          if (x !== 3 || y !== 3 || z !== 3) field.setBlocked(x + 0.5, y + 0.5, z + 0.5, true);
        }
      }
    }
    const hot = parcels.spawn({
      substance: oak,
      mass: 3.5,
      temperature: 900,
      area: 0.1,
      x: 3.5,
      y: 3.5,
      z: 3.5,
    });
    const steam = species.indexOf('H2O(g)');
    const before = field.speciesMassAt(3.5, 3.5, 3.5, steam);
    for (let i = 0; i < 600; i++) {
      world.sources.clear();
      world.simulate(1 / 60);
    }
    expect(field.speciesMassAt(3.5, 3.5, 3.5, steam)).toBeGreaterThan(before);
    /* And it came from the wood: the cellulose is going away. */
    expect(parcels.parcelSpeciesMass(hot, species.indexOf('C(char)'))).toBeGreaterThan(0);
  });

  it('draws the oxygen its reactions want out of the air around it', () => {
    const ember = log(0.4);
    parcels.setTemperature(ember, 1100);
    const oxygen = species.indexOf('O2');
    const before = field.speciesMassAt(0.4, 0.5, 0.5, oxygen);
    for (let i = 0; i < 1200; i++) {
      world.sources.clear();
      world.simulate(1 / 60);
    }
    expect(field.speciesMassAt(0.4, 0.5, 0.5, oxygen)).toBeLessThan(before);
    /* And it made carbon dioxide doing it. */
    expect(field.speciesMassAt(0.4, 0.5, 0.5, species.indexOf('CO2'))).toBeGreaterThan(0);
  });

  it('CONSERVES EVERY ELEMENT across the parcels and the air together', () => {
    /*
     * Neither side conserves on its own any more — that is the point of the coupling. What is
     * conserved is the pair, and it is exact because every exchange is one number taken from one
     * and given to the other.
     *
     * **Measured against the magnitudes involved, not against the net**, and the difference is the
     * whole test. `world.elementTotals` adds the field's live chunks to its far-field ledger, and
     * the ledger records a new chunk's air as having come from outside — so for nitrogen, which
     * nothing here reacts, the two are about 16,800 moles of opposite sign and the net is
     * essentially zero. A relative measure then divides by one and reports the last bits of a
     * cancellation as though they were a leak. They are not: 1.8e-7 mol against 16,800 is 1e-11,
     * which is where double precision lives.
     *
     * The first version of this test measured the net and read 3.6e-9 rising to 1.1e-7, and a
     * follow-up assertion that the drift was rounding rather than a leak duly failed — correctly,
     * because what it was measuring was neither.
     */
    const hot = log(0.4);
    parcels.setTemperature(hot, 1000);

    const before = new Float64Array(ELEMENT_COUNT);
    const after = new Float64Array(ELEMENT_COUNT);
    const scale = new Float64Array(ELEMENT_COUNT);
    world.elementTotals(before);

    for (let i = 0; i < 2000; i++) {
      world.sources.clear();
      world.simulate(1 / 60);
    }
    world.elementTotals(after);
    /* Taken after, because the field has no chunks at all until the parcel breathes into one —
       and a scale read from an empty field is a scale of zero, which is how the previous attempt
       ended up dividing by one again. */
    field.elementTotals(scale);

    for (let e = 0; e < ELEMENT_COUNT; e++) {
      const moved = Math.abs((after[e] as number) - (before[e] as number));
      const magnitude = Math.max(1, Math.abs(scale[e] as number), Math.abs(before[e] as number));
      expect(moved / magnitude, `element ${e}`).toBeLessThan(1e-10);
    }

    /* And it ran rather than conserving by idling: the wood charred and the air took the smoke. */
    expect(parcels.parcelSpeciesMass(hot, species.indexOf('C(char)'))).toBeGreaterThan(0);
  }, 60000);

  it('conducts between parcels the caller says are touching', () => {
    /*
     * Two hundred seconds, and it needs them. Wood on wood through 0.05 m² moves about 0.6 W per
     * kelvin of difference — measured at 294.3 K after ten seconds, 299.6 after fifty and 314.5
     * after two hundred. A test that ran for ten simulated seconds and expected a hot steak would
     * be asserting that wood conducts like copper.
     */
    const pan = log(0.4);
    const steak = log(0.6);
    parcels.setTemperature(pan, 500);
    for (let i = 0; i < 12000; i++) {
      world.sources.clear();
      world.contacts.clear();
      world.contacts.add(pan, steak, 0.05);
      world.simulate(1 / 60);
    }
    expect(parcels.surfaceTemperatureOf(steak)).toBeGreaterThan(310);
    expect(parcels.surfaceTemperatureOf(pan)).toBeLessThan(480);
  }, 60000);

  it('touches nothing that is not in contact', () => {
    const hot = log(0.4);
    const cold = log(3.0);
    parcels.setTemperature(hot, 500);
    const before = parcels.surfaceTemperatureOf(cold);
    for (let i = 0; i < 300; i++) {
      world.sources.clear();
      world.simulate(1 / 60);
    }
    expect(parcels.surfaceTemperatureOf(cold)).toBeCloseTo(before, 1);
  });

  it('warms a parcel sitting in hot gas, by convection rather than radiation', () => {
    /*
     * The cell has to be sealed for this to be a test of convection at all. An open cell relaxes to
     * the far field in about three seconds — measured, and the first version of this test read a
     * parcel sitting in air that had already gone cold, then blamed the convection.
     */
    for (let x = 0; x < 8; x++) {
      for (let y = 0; y < 8; y++) {
        for (let z = 0; z < 8; z++) {
          if (x !== 3 || y !== 3 || z !== 3) field.setBlocked(x + 0.5, y + 0.5, z + 0.5, true);
        }
      }
    }
    /*
     * The free cell is in the middle of the chunk rather than at its corner, and that matters. A
     * corner cell's backward neighbours are in chunks that do not exist, so it vents to the far
     * field on three faces however thoroughly the cells inside the chunk are blocked — measured,
     * after the first version of this test sealed the corner and read a parcel sitting in air that
     * had gone cold in three seconds.
     */
    const inside = parcels.spawn({
      substance: oak,
      mass: 3.5,
      temperature: 293.15,
      area: 0.1,
      x: 3.5,
      y: 3.5,
      z: 3.5,
    });
    field.addHeat(3.5, 3.5, 3.5, 900000);
    const gasBefore = field.temperatureAt(3.5, 3.5, 3.5);
    const before = parcels.surfaceTemperatureOf(inside);
    for (let i = 0; i < 2000; i++) {
      world.sources.clear();
      world.simulate(1 / 60);
    }
    expect(parcels.surfaceTemperatureOf(inside)).toBeGreaterThan(before + 2);
    /* And the air paid for it: the heat came out of the cell rather than from nowhere. */
    expect(field.temperatureAt(3.5, 3.5, 3.5)).toBeLessThan(gasBefore);
  });

  it('runs without a field at all, and only loses what a field was for', () => {
    const lonely = new ChemistryWorld(parcels, null);
    const p = log(0.4);
    for (let i = 0; i < 300; i++) {
      lonely.sources.clear();
      lonely.sources.add(0, 0.5, 0.5, 1200, 1, 60000);
      lonely.simulate(1 / 60);
    }
    expect(parcels.surfaceTemperatureOf(p)).toBeGreaterThan(293.15);
  });
});
