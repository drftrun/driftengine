/**
 * The chemistry model with no engine at all.
 *
 * **This is what the package's independence is worth**, and it is measured rather than claimed: it
 * imports no `@driftengine/*`, so a consumer who wants matter and no renderer pays for matter and
 * no renderer. `boundaries.test.mjs` asserts the import graph; this asserts the consequence, which
 * is the number.
 *
 * It is also the baseline every later phase of Track P measures against: parcels, the reaction
 * network, the atmosphere field and the transport all land in this package, and each phase's cost
 * is this figure's growth rather than an estimate.
 *
 * The standard species table is reached deliberately, because it is the largest single thing in the
 * package today and the one a consumer might reasonably want to shake out. If it ever needs to be
 * droppable on its own, this fixture is where that shows up first.
 */
import {
  ELEMENT_COUNT,
  ParcelStore,
  SpeciesRegistry,
  SubstanceRegistry,
  boilingPoint,
  elementTotals,
  massFractions,
  AtmosphereField,
  ChemistryWorld,
  KIND_CHAR_OXIDATION,
  KIND_PYROLYSIS,
  ReactionRegistry,
  SHAPE_SLAB,
  STANDARD_AIR,
  phaseChange,
  registerStandardSpecies,
  wetComposition,
} from '@driftengine/chemistry';

/** A registry, a composition and one conservation reduction: the whole of CH-0 on one path. */
export function totals(): number {
  const registry = new SpeciesRegistry();
  registerStandardSpecies(registry);

  const wood = massFractions(registry, { cellulose: 0.5, lignin: 0.3, 'H2O(l)': 0.2 });
  const mass = new Float64Array(registry.count);
  for (let i = 0; i < wood.species.length; i++) {
    mass[wood.species[i] as number] = (wood.fraction[i] as number) * 10;
  }

  const out = new Float64Array(ELEMENT_COUNT);
  elementTotals(registry, mass, out);
  return out[0] as number;
}

/** And CH-1: a substance, its enthalpy curve, a parcel, and heat going in. */
export function boil(): number {
  const species = new SpeciesRegistry();
  registerStandardSpecies(species);

  const reactions = new ReactionRegistry(species);
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

  const substances = new SubstanceRegistry(species, reactions);
  const water = substances.define({
    id: 'water',
    composition: massFractions(species, { 'H2O(l)': 1 }),
    density: 997,
    reactions: ['boil'],
  });
  const oak = substances.define({
    id: 'oak',
    composition: wetComposition(
      species,
      massFractions(species, { cellulose: 0.6, lignin: 0.4 }),
      0.12,
    ),
    density: 700,
    conductivity: { k0: 0.16, k1: 0.0002 },
    shells: 4,
    shape: SHAPE_SLAB,
    reactions: ['char-cellulose', 'burn-char'],
  });

  const parcels = new ParcelStore(substances);
  const kettle = parcels.spawn({ substance: water, mass: 1, temperature: 373.15 });
  const log = parcels.spawn({
    substance: oak,
    mass: 8,
    temperature: 293.15,
    area: 0.2,
    x: 0.4,
    y: 0,
    z: 0,
  });
  parcels.addHeat(kettle, 1e6);
  for (let i = 0; i < 10; i++) {
    parcels.addSurfaceHeat(log, 4000);
    parcels.conduct(log, 1 / 60);
    parcels.react(log, 1 / 60);
  }
  return (
    parcels.temperatureOf(kettle) +
    parcels.chemicalEnergyOf(log) +
    parcels.surfaceTemperatureOf(log) -
    parcels.coreTemperatureOf(log) +
    parcels.volumeOf(log) +
    boilingPoint(373.15, 2256400, 0.018015, 70000)
  );
}

/** And CH-4: one atmosphere, with a fire's oxygen coming out of it and its smoke going in. */
export function breathe(): number {
  const species = new SpeciesRegistry();
  registerStandardSpecies(species);
  const reactions = new ReactionRegistry(species);
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
    kind: KIND_CHAR_OXIDATION,
  });

  const air = new AtmosphereField(species, {
    cellSize: 1,
    ambient: STANDARD_AIR,
    reactions,
    reactionIds: ['burn-methane'],
  });
  air.addSpecies(0.5, 0.5, 0.5, species.indexOf('CH4'), 0.05);
  air.addHeat(0.5, 0.5, 0.5, 400000);
  air.addSoot(0.5, 0.5, 0.5, 1e-5);
  for (let i = 0; i < 20; i++) air.step(1 / 60, 2, 0);
  return (
    air.oxygenFractionAt(0.5, 0.5, 0.5) +
    air.visibilityAt(0.5, 1.5, 0.5) +
    air.temperatureAt(0.5, 0.5, 0.5) +
    air.pressureAt(0.5, 0.5, 0.5)
  );
}

/** And CH-5: a log near a fire, working out for itself what reaches it. */
export function warm(): number {
  const species = new SpeciesRegistry();
  registerStandardSpecies(species);
  const reactions = new ReactionRegistry(species);
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

  const substances = new SubstanceRegistry(species, reactions);
  const oak = substances.define({
    id: 'oak',
    composition: wetComposition(
      species,
      massFractions(species, { cellulose: 0.6, lignin: 0.4 }),
      0.12,
    ),
    density: 700,
    conductivity: { k0: 0.16, k1: 0.0002 },
    shells: 4,
    shape: SHAPE_SLAB,
    porosity: 0.5,
    reactions: ['char-cellulose'],
    ignition: { pilotedSurfaceK: 623, autoSurfaceK: 773, criticalMassFlux: 0.0035 },
  });

  const parcels = new ParcelStore(substances);
  const air = new AtmosphereField(species, { cellSize: 1, ambient: STANDARD_AIR });
  const world = new ChemistryWorld(parcels, air);
  const log = parcels.spawn({
    substance: oak,
    mass: 8,
    temperature: 293.15,
    area: 0.2,
    x: 0.4,
    y: 0.5,
    z: 0.5,
  });

  for (let i = 0; i < 20; i++) {
    world.sources.clear();
    world.sources.add(0, 0.5, 0.5, 1200, 1, 60000);
    world.contacts.clear();
    parcels.ignite(log);
    world.simulate(1 / 60, 2, 0);
  }
  return (
    parcels.surfaceTemperatureOf(log) -
    parcels.coreTemperatureOf(log) +
    world.ignitionProgressOf(log) +
    world.events.count +
    (parcels.burning(log) ? 1 : 0)
  );
}
