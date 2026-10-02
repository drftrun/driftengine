/**
 * Chemistry without a scene: a material as mass fractions, reduced to its elements; a parcel
 * heated directly through a plateau; and the world's fingerprint, for a replay.
 *
 * A snippet, typechecked with the examples and quoted by the manual's chemistry chapter.
 */
import {
  ChemistryWorld,
  ELEMENTS,
  ELEMENT_COUNT,
  ParcelStore,
  ReactionRegistry,
  SpeciesRegistry,
  SubstanceRegistry,
  elementTotals,
  fingerprintChemistry,
  installLibrary,
  massFractions,
  registerStandardSpecies,
} from '@driftengine/chemistry';
import { FOOD } from '@driftengine/chemistry/library/food';

// #region elements
/** Seasoned oak, dry basis, as mass fractions that must sum to one. */
const species = new SpeciesRegistry();
registerStandardSpecies(species);
const oak = massFractions(species, {
  cellulose: 0.43,
  hemicellulose: 0.26,
  lignin: 0.26,
  extractives: 0.04,
  ash: 0.01,
});

/** Ten kilograms of it, reduced to moles of each of the fifteen elements. */
export function carbonInTenKilograms(): number {
  const mass = new Float64Array(species.count);
  oak.species.forEach((s, i) => {
    mass[s] = (oak.fraction[i] ?? 0) * 10;
  });
  const elements = new Float64Array(ELEMENT_COUNT);
  elementTotals(species, mass, elements);
  return elements[ELEMENTS.indexOf('C')] ?? 0;
}
// #endregion

// #region plateau
/**
 * A litre of water on a kilowatt, in a world with no air: the registries and the parcels wired by
 * hand, which is the part of `installChemistry` that comes before the atmosphere.
 */
const reactions = new ReactionRegistry(species);
const substances = new SubstanceRegistry(species, reactions);
installLibrary(FOOD, species, reactions, substances);
const parcels = new ParcelStore(substances);
const kitchen = new ChemistryWorld(parcels, null);
const water = parcels.spawn({
  substance: substances.indexOf('water'),
  mass: 1,
  temperature: 293.15,
  area: 0.05,
});

/** It climbs to boiling, then stays at a hundred while the kilowatt goes into boiling it away. */
export function heatFor(seconds: number): number {
  for (let t = 0; t < seconds; t += 1) {
    parcels.addHeat(water, 1000);
    kitchen.simulate(1);
  }
  return parcels.temperatureOf(water) - 273.15;
}
// #endregion

// #region fingerprint
/**
 * Sixteen hex digits over every parcel, and the air where there is one: two runs that agree print
 * the same.
 */
export function fingerprint(): string {
  return fingerprintChemistry(kitchen);
}
// #endregion
