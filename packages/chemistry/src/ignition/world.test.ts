import { beforeEach, describe, expect, it } from 'vitest';
import { SpeciesRegistry } from '../species/registry.ts';
import { registerStandardSpecies } from '../species/standard.ts';
import { KIND_PYROLYSIS, ReactionRegistry } from '../reaction/registry.ts';
import { massFractions } from '../substance/composition.ts';
import { SubstanceRegistry } from '../substance/registry.ts';
import { SHAPE_SLAB } from '../parcel/shells.ts';
import { ParcelStore } from '../parcel/store.ts';
import { AtmosphereField } from '../field/atmosphere.ts';
import { STANDARD_AIR } from '../field/ambient.ts';
import { ChemistryWorld } from '../transport/world.ts';
import { EVENT_IGNITED } from './events.ts';

describe('ignition through the world', () => {
  let species: SpeciesRegistry;
  let substances: SubstanceRegistry;
  let parcels: ParcelStore;
  let field: AtmosphereField;
  let world: ChemistryWorld;
  let oak: number;
  let glass: number;

  beforeEach(() => {
    species = new SpeciesRegistry();
    registerStandardSpecies(species);
    const reactions = new ReactionRegistry(species);
    /*
     * **Wood pyrolysis has to make something that burns**, and the first version of this test used
     * a charring reaction that produced only carbon and steam. Neither is a combustible gas, so the
     * mixture above the surface never entered its flammability limits and nothing ever caught — the
     * criterion was right and the fuel was wrong.
     *
     * `C6H10O5 → 3 C(char) + 2 CO + CH4 + 3 H2O(g)` balances and is a real gasification route: the
     * carbon monoxide and methane are what the flame over a log is actually burning.
     */
    reactions.register({
      id: 'gasify-cellulose',
      reactants: [{ species: 'cellulose', moles: 1 }],
      products: [
        { species: 'C(char)', moles: 3 },
        { species: 'CO', moles: 2 },
        { species: 'CH4', moles: 1 },
        { species: 'H2O(g)', moles: 3 },
      ],
      kinetics: { type: 'arrhenius', A: 1.3e10, activationEnergy: 150500 },
      kind: KIND_PYROLYSIS,
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
      reactions: ['gasify-cellulose'],
      ignition: { pilotedSurfaceK: 623, autoSurfaceK: 773, criticalMassFlux: 0.0035 },
    });
    glass = substances.define({
      id: 'glass',
      composition: massFractions(species, { SiO2: 1 }),
      density: 2500,
      conductivity: { k0: 1, k1: 0 },
      shells: 2,
      shape: SHAPE_SLAB,
    });
    parcels = new ParcelStore(substances);
    field = new AtmosphereField(species, { cellSize: 1, ambient: STANDARD_AIR });
    world = new ChemistryWorld(parcels, field);
  });

  const log = (temperature: number): number =>
    parcels.spawn({ substance: oak, mass: 2, temperature, area: 0.2, x: 0.5, y: 0.5, z: 0.5 });

  const run = (parcel: number, ticks: number, pilot: boolean): void => {
    for (let i = 0; i < ticks; i++) {
      world.sources.clear();
      world.contacts.clear();
      if (pilot) parcels.ignite(parcel);
      world.simulate(1 / 60);
    }
  };

  it('A MATCH HELD TO COLD WOOD DOES NOTHING AT ALL', () => {
    /*
     * `§11`, end to end. `ignite` supplies a pilot and does not start a fire — five conditions do,
     * and a cold surface fails three of them. This is the API telling the truth about what a match
     * is, and it is the assertion the whole criterion machinery exists to make possible.
     */
    const cold = log(293.15);
    run(cold, 600, true);
    expect(parcels.burning(cold)).toBe(false);
    expect(world.ignitionProgressOf(cold)).toBeLessThan(0.5);
  });

  it('and held to wood already hot enough, it catches', () => {
    const hot = log(900);
    run(hot, 120, true);
    expect(parcels.burning(hot)).toBe(true);
  });

  it('says so, in the event buffer, on the tick it happens', () => {
    const hot = log(900);
    let ignitions = 0;
    for (let i = 0; i < 120; i++) {
      world.sources.clear();
      world.contacts.clear();
      parcels.ignite(hot);
      world.simulate(1 / 60);
      for (let e = 0; e < world.events.count; e++) {
        if (world.events.kindOf(e) === EVENT_IGNITED) {
          ignitions++;
          expect(world.events.parcelOf(e)).toBe(hot);
        }
      }
    }
    /* Once, on the tick the conditions came true — not on every tick after. */
    expect(ignitions).toBe(1);
  });

  it('needs the pilot every tick, because a match is not a state', () => {
    /*
     * 700 K: above oak's piloted threshold of 623 and below its autoignition point of 773, which is
     * the only band where the pilot is what decides. The first version of this test used 900 and
     * watched it catch on its own — correctly, since 900 is past the point where a spark is needed
     * at all, and the 150 K between the two is exactly what that gap is for.
     */
    const withoutPilot = log(700);
    run(withoutPilot, 60, false);
    expect(parcels.burning(withoutPilot)).toBe(false);

    const withPilot = log(700);
    run(withPilot, 60, true);
    expect(parcels.burning(withPilot)).toBe(true);
  });

  it('catches with no pilot at all once it is hot enough for that', () => {
    const blazing = log(1100);
    run(blazing, 120, false);
    expect(parcels.burning(blazing)).toBe(true);
  });

  it('never catches something nobody said was flammable', () => {
    const pane = parcels.spawn({
      substance: glass,
      mass: 2,
      temperature: 1200,
      area: 0.2,
      x: 0.5,
      y: 0.5,
      z: 0.5,
    });
    run(pane, 300, true);
    expect(parcels.burning(pane)).toBe(false);
    expect(world.ignitionProgressOf(pane)).toBe(0);
  });

  it('reports progress rising as a log heats, without ever branching on it', () => {
    const warm = log(500);
    run(warm, 60, true);
    const early = world.ignitionProgressOf(warm);
    parcels.setTemperature(warm, 620);
    run(warm, 60, true);
    expect(world.ignitionProgressOf(warm)).toBeGreaterThan(early);
  });

  it('goes out when its fuel stops coming off', () => {
    const hot = log(950);
    run(hot, 120, true);
    expect(parcels.burning(hot)).toBe(true);
    /* Chill it: the surface cools, pyrolysis stops, and there is nothing left to burn. */
    parcels.setTemperature(hot, 300);
    run(hot, 120, false);
    expect(parcels.burning(hot)).toBe(false);
  });
});
