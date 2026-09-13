import { beforeEach, describe, expect, it } from 'vitest';
import { SpeciesRegistry } from '../species/registry.ts';
import { registerStandardSpecies } from '../species/standard.ts';
import { massFractions } from '../substance/composition.ts';
import { SubstanceRegistry } from '../substance/registry.ts';
import { ReactionRegistry, phaseChange } from '../reaction/registry.ts';
import { ParcelStore } from './store.ts';

const T_MELT = 273.15;
const T_BOIL = 373.15;
const CP_LIQUID = 4182;
const VAPORISATION = 2256400;

describe('ParcelStore', () => {
  let species: SpeciesRegistry;
  let substances: SubstanceRegistry;
  let water: number;
  let oak: number;
  let parcels: ParcelStore;

  beforeEach(() => {
    species = new SpeciesRegistry();
    registerStandardSpecies(species);
    /*
     * **Water is a liquid that can freeze or boil, not a curve with two plateaus in it.** CH-6
     * retired the per-substance enthalpy curve: the latent heat is already in the formation
     * enthalpies, so a phase change is a reaction with a temperature gate and its plateau emerges
     * from the same solver everything else uses.
     */
    const reactions = new ReactionRegistry(species);
    reactions.register(phaseChange('freeze', 'H2O(l)', 'H2O(s)', T_MELT));
    reactions.register(phaseChange('boil', 'H2O(l)', 'H2O(g)', T_BOIL));
    substances = new SubstanceRegistry(species, reactions);
    water = substances.define({
      id: 'water',
      composition: massFractions(species, { 'H2O(l)': 1 }),
      density: 997,
      reactions: ['boil'],
    });
    oak = substances.define({
      id: 'oak',
      composition: massFractions(species, { cellulose: 0.5, lignin: 0.5 }),
      density: 700,
    });
    parcels = new ParcelStore(substances);
  });

  it('hands back a handle and holds what it was given', () => {
    const kettle = parcels.spawn({ substance: water, mass: 1.5, temperature: 293.15 });
    expect(kettle).toBe(0);
    expect(parcels.count).toBe(1);
    expect(parcels.alive(kettle)).toBe(true);
    expect(parcels.massOf(kettle)).toBe(1.5);
    expect(parcels.substanceOf(kettle)).toBe(water);
    expect(parcels.temperatureOf(kettle)).toBeCloseTo(293.15, 6);
  });

  it('derives volume from mass and density', () => {
    const log = parcels.spawn({ substance: oak, mass: 7, temperature: 293.15 });
    expect(parcels.volumeOf(log)).toBeCloseTo(7 / 700, 12);
  });

  it('holds enthalpy in joules, not joules per kilogram', () => {
    /* Two kilograms at one temperature hold twice the enthalpy of one, which is the whole reason
       the store keeps a total and the curve keeps a specific value. */
    const one = parcels.spawn({ substance: water, mass: 1, temperature: 350 });
    const two = parcels.spawn({ substance: water, mass: 2, temperature: 350 });
    expect(parcels.enthalpyOf(two)).toBeCloseTo(2 * parcels.enthalpyOf(one), 6);
    expect(parcels.temperatureOf(two)).toBeCloseTo(parcels.temperatureOf(one), 9);
  });

  it('raises temperature by exactly the heat capacity it was given', () => {
    const pot = parcels.spawn({ substance: water, mass: 2, temperature: 293.15 });
    /* Two kilograms of liquid water, 10 K, at 4182 J/(kg K). */
    parcels.addHeat(pot, 2 * CP_LIQUID * 10);
    expect(parcels.temperatureOf(pot)).toBeCloseTo(303.15, 6);
  });

  it('HOLDS A BOILING PARCEL AT ITS BOILING POINT, however much heat arrives', () => {
    /*
     * **The acceptance test of CH-1, re-asserted against CH-6's mechanism.** A kettle at 100 °C
     * takes about two and a half megajoules per kilogram before its temperature goes anywhere,
     * which is why a kettle's readout stops at 100 and why a wet surface cannot brown.
     *
     * **Within a band rather than on a point, and that is the honest cost of the reversal.** The
     * plateau is no longer a flat region of a table; it is a gated reaction settling against the
     * heat arriving, so the temperature sits a fraction of a kelvin above the transition rather
     * than exactly on it. The band is stated here rather than tuned away.
     */
    const kettle = parcels.spawn({ substance: water, mass: 1, temperature: T_BOIL - 1 });
    /* Let the controller find its footing: it starts below the transition and has to climb to it. */
    for (let i = 0; i < 400; i++) {
      parcels.addHeat(kettle, 2000 / 60);
      parcels.react(kettle, 1 / 60);
    }
    for (let i = 0; i < 600; i++) {
      /* A two-kilowatt element, which is what a kettle is. */
      parcels.addHeat(kettle, 2000 / 60);
      parcels.react(kettle, 1 / 60);
      const t = parcels.temperatureOf(kettle);
      expect(t, `tick ${i}`).toBeGreaterThan(T_BOIL - 1);
      expect(t, `tick ${i}`).toBeLessThan(T_BOIL + 1);
    }
    /* And it was really boiling: the water is going somewhere. */
    expect(parcels.parcelSpeciesMass(kettle, species.indexOf('H2O(g)'))).toBeGreaterThan(0.005);
    expect(parcels.parcelSpeciesMass(kettle, species.indexOf('H2O(l)'))).toBeLessThan(0.999);
  });

  it('closes its energy budget over ten thousand additions', () => {
    /*
     * The invariant the design puts beside element conservation. Heat in equals enthalpy gained,
     * exactly — not to a tolerance, because addition is the only operation involved and there is
     * nowhere for a joule to go.
     */
    const log = parcels.spawn({ substance: oak, mass: 3, temperature: 293.15 });
    const start = parcels.enthalpyOf(log);
    let added = 0;
    for (let i = 0; i < 10000; i++) {
      /* Deterministic rather than random, so a failure is reproducible. */
      const joules = 1 + ((i * 7919) % 1000);
      parcels.addHeat(log, joules);
      added += joules;
    }
    expect(parcels.enthalpyOf(log) - start).toBeCloseTo(added, 6);
  });

  it('sets a temperature by writing the enthalpy that produces it', () => {
    const pot = parcels.spawn({ substance: water, mass: 1.25, temperature: 293.15 });
    parcels.setTemperature(pot, 350);
    expect(parcels.temperatureOf(pot)).toBeCloseTo(350, 6);
  });

  it('reports a destroyed parcel as dead and refuses to read it', () => {
    const gone = parcels.spawn({ substance: oak, mass: 1, temperature: 293.15 });
    parcels.destroy(gone);
    expect(parcels.alive(gone)).toBe(false);
    expect(() => parcels.temperatureOf(gone)).toThrow(/0/);
  });

  it('refuses a handle it never issued, naming it', () => {
    expect(() => parcels.temperatureOf(7)).toThrow(/7/);
    expect(() => parcels.temperatureOf(-1)).toThrow(/-1/);
  });

  it('refuses a mass that is not positive, naming it', () => {
    expect(() => parcels.spawn({ substance: oak, mass: 0, temperature: 293.15 })).toThrow(/0/);
    expect(() => parcels.spawn({ substance: oak, mass: -2, temperature: 293.15 })).toThrow(/-2/);
  });

  it('grows past its initial capacity without losing a parcel', () => {
    const handles: number[] = [];
    for (let i = 0; i < 500; i++)
      handles.push(parcels.spawn({ substance: oak, mass: 1 + i, temperature: 293.15 + i * 0.1 }));
    expect(parcels.count).toBe(500);
    for (let i = 0; i < 500; i++) {
      expect(parcels.massOf(handles[i] as number)).toBe(1 + i);
    }
  });

  it('allocates nothing per addHeat', async () => {
    /*
     * Counted by garbage collections, never by `heapUsed` — which reads the live heap, so garbage
     * made and dropped does not move it. The control allocates one object per iteration; the
     * assertion is the separation between the two, not either number on its own.
     */
    const log = parcels.spawn({ substance: oak, mass: 3, temperature: 293.15 });

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
    const ROUNDS = 200000;
    const noisy = await collections(() => {
      for (let i = 0; i < ROUNDS * 10; i++) sink = { at: i, of: [i] };
    });
    const quiet = await collections(() => {
      for (let i = 0; i < ROUNDS; i++) {
        parcels.addHeat(log, 1);
        parcels.temperatureOf(log);
      }
    });

    expect(noisy, 'the control must separate the two states').toBeGreaterThan(3);
    expect(quiet).toBeLessThan(noisy / 4);
    expect(sink).not.toBe(undefined);
  });
});
