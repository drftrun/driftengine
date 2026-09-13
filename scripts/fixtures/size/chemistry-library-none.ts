/**
 * The consumer `§2` is written about: **three substances of their own, and none of the libraries.**
 *
 * "A consumer who defines three substances of their own imports none of the libraries and pays for
 * none of them" is the payload rule applied to data, and it is a claim about a number. This fixture
 * is the number it is claimed against: every `chemistry-library-*` fixture does exactly this work
 * with a family installed instead, so the difference between the two figures is what that family
 * costs and nothing else.
 */
import {
  KIND_PYROLYSIS,
  ParcelStore,
  ReactionRegistry,
  SpeciesRegistry,
  SubstanceRegistry,
  installLibrary,
  massFractions,
  registerStandardSpecies,
  wetComposition,
  type SubstanceLibrary,
} from '@driftengine/chemistry';

/** What a game with three materials of its own writes. */
const MINE: SubstanceLibrary = {
  id: 'mine',
  species: [],
  reactions: [
    {
      id: 'char',
      reactants: [{ species: 'cellulose', moles: 1 }],
      products: [
        { species: 'C(char)', moles: 6 },
        { species: 'H2O(g)', moles: 5 },
      ],
      kinetics: { type: 'arrhenius', A: 1.3e10, activationEnergy: 150500 },
      kind: KIND_PYROLYSIS,
    },
  ],
  substances: (species) => [
    {
      id: 'plank',
      composition: wetComposition(
        species,
        massFractions(species, { cellulose: 0.6, lignin: 0.4 }),
        0.12,
      ),
      density: 700,
      conductivity: { k0: 0.16, k1: 0.0002 },
      shells: 4,
      reactions: ['char'],
      ignition: { pilotedSurfaceK: 623, autoSurfaceK: 773, criticalMassFlux: 0.0035 },
    },
    {
      id: 'stone',
      composition: massFractions(species, { SiO2: 1 }),
      density: 2600,
      conductivity: { k0: 2, k1: 0 },
    },
    {
      id: 'iron-bar',
      composition: massFractions(species, { Fe: 1 }),
      density: 7870,
      conductivity: { k0: 80, k1: -0.03 },
    },
  ],
};

export function none(): number {
  const species = new SpeciesRegistry();
  registerStandardSpecies(species);
  const reactions = new ReactionRegistry(species);
  const substances = new SubstanceRegistry(species, reactions);
  installLibrary(MINE, species, reactions, substances);

  const parcels = new ParcelStore(substances);
  let total = 0;
  for (let i = 0; i < substances.count; i++) {
    const parcel = parcels.spawn({ substance: i, mass: 1, temperature: 293.15, area: 0.1 });
    parcels.addSurfaceHeat(parcel, 5000);
    parcels.conduct(parcel, 1 / 60);
    parcels.react(parcel, 1 / 60);
    total += parcels.surfaceTemperatureOf(parcel) + parcels.massFluxOf(parcel);
  }
  return total;
}
