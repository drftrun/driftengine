/**
 * `@driftengine/chemistry/library/biological` — decay, fermentation and the heat they make.
 *
 * **Every rate here is peaked rather than monotonic, and `§8.6` refuses Arrhenius structurally.** An
 * enzyme-catalysed rate rises to an optimum and then collapses as the enzyme denatures; modelling
 * decay with Arrhenius gives compost that gets hotter forever, which is the single most common
 * mistake in this area and is worth making impossible rather than discouraged.
 *
 * **The two enthalpies are the published ones and neither is stored.** Aerobic respiration comes out
 * at −2,802.7 kJ/mol against `§8.6`'s quoted 2,803, and fermentation at −68.9 against a textbook
 * −68. That the ratio is forty is the whole reason fermentation is a survival strategy and
 * respiration is a fire hazard.
 *
 * **Nothing decides the aerobic/anaerobic branch.** Aerobic decay has oxygen as a reactant, so a
 * submerged parcel cannot run it and runs the methane path instead. A fallen log rots one way and a
 * drowned one rots the other, out of mass action.
 */
import { KIND_BIOLOGICAL, type Reaction } from '../reaction/reaction.ts';
import { SHAPE_CYLINDER, SHAPE_SPHERE } from '../parcel/shells.ts';
import { massFractions } from '../substance/composition.ts';
import { wetComposition } from '../substance/substance.ts';
import type { SubstanceThermal } from '../substance/substance.ts';
import type { SubstanceLibrary } from './library.ts';
import { BOIL_WATER, COMMON_REACTIONS } from './common.ts';

export const DECAY_MESOPHILIC = 'decay-mesophilic';
export const DECAY_THERMOPHILIC = 'decay-thermophilic';
export const DECAY_ANAEROBIC = 'decay-anaerobic';
export const FERMENT = 'ferment';

/**
 * The rate at the optimum, per second, and it is **back-derived from a measured self-heating rate**.
 *
 * A wet bale or a fresh heap warms at roughly twenty to thirty kelvin a day in its mesophilic phase,
 * which is a measurement anyone with a compost thermometer can make. Working back through the
 * enthalpy of respiration, the labile sugar fraction and the heat capacity of wet organic matter
 * gives this. There is no published pre-exponential for "decay"; there is a published temperature.
 */
const MESOPHILIC_PEAK = 6e-5;

const REACTIONS: readonly Reaction[] = [
  ...COMMON_REACTIONS,
  {
    /*
     * `C₆H₁₂O₆ + 6 O₂ → 6 CO₂ + 6 H₂O`, and the water is **liquid** because a compost heap is wet.
     * That is what makes the derived enthalpy 2,803 kJ/mol rather than the 2,539 it would be if the
     * water left as steam — and 2,803 is the figure `§8.6` quotes.
     */
    id: DECAY_MESOPHILIC,
    reactants: [
      { species: 'glucose', moles: 1 },
      { species: 'O2', moles: 6 },
    ],
    products: [
      { species: 'CO2', moles: 6 },
      { species: 'H2O(l)', moles: 6 },
    ],
    kinetics: {
      type: 'cardinal',
      peak: MESOPHILIC_PEAK,
      minimum: 273.15,
      optimum: 308.15,
      maximum: 318.15,
    },
    kind: KIND_BIOLOGICAL,
  },
  {
    /*
     * The same reaction, a different population. **It takes over exactly where the first one dies**,
     * which is why a heap steams: the mesophiles heat it past their own maximum and hand it on.
     * Nothing hands it on; two bands overlap by five kelvin and the rates do the rest.
     */
    id: DECAY_THERMOPHILIC,
    reactants: [
      { species: 'glucose', moles: 1 },
      { species: 'O2', moles: 6 },
    ],
    products: [
      { species: 'CO2', moles: 6 },
      { species: 'H2O(l)', moles: 6 },
    ],
    kinetics: {
      type: 'cardinal',
      peak: MESOPHILIC_PEAK * 3,
      minimum: 313.15,
      optimum: 328.15,
      maximum: 343.15,
    },
    kind: KIND_BIOLOGICAL,
  },
  {
    /* The swamp-gas path: no oxygen consumed, so it is the only one a submerged parcel can run, and
       it releases a fortieth of the heat — which is why a bog does not catch fire. */
    id: DECAY_ANAEROBIC,
    reactants: [{ species: 'glucose', moles: 1 }],
    products: [
      { species: 'CH4', moles: 3 },
      { species: 'CO2', moles: 3 },
    ],
    kinetics: {
      type: 'cardinal',
      peak: 5e-6,
      minimum: 283.15,
      optimum: 310.15,
      maximum: 318.15,
    },
    kind: KIND_BIOLOGICAL,
  },
  {
    /* Yeast, and it dies above 40 °C. The ethanol it makes is the fuel library's fuel, so a cellar
       that ferments and then catches is two libraries meeting with nothing between them. */
    id: FERMENT,
    reactants: [{ species: 'glucose', moles: 1 }],
    products: [
      { species: 'ethanol', moles: 2 },
      { species: 'CO2', moles: 2 },
    ],
    kinetics: {
      type: 'cardinal',
      peak: 3e-4,
      minimum: 278.15,
      optimum: 303.15,
      maximum: 313.15,
    },
    kind: KIND_BIOLOGICAL,
  },
];

const DECAY = [DECAY_MESOPHILIC, DECAY_THERMOPHILIC, DECAY_ANAEROBIC];

export const BIOLOGICAL: SubstanceLibrary = {
  id: 'biological',
  species: [],
  reactions: REACTIONS,
  substances: (species): readonly SubstanceThermal[] => [
    {
      /* Half water by mass, which is what a heap has to be for anything to live in it. */
      id: 'compost',
      composition: wetComposition(
        species,
        massFractions(species, {
          cellulose: 0.35,
          hemicellulose: 0.2,
          lignin: 0.2,
          glucose: 0.1,
          protein: 0.05,
          ash: 0.1,
        }),
        1.0,
      ),
      density: 400,
      conductivity: { k0: 0.15, k1: 0.0003 },
      shells: 3,
      shape: SHAPE_SPHERE,
      porosity: 0.6,
      emissivity: 0.92,
      reactions: [BOIL_WATER, ...DECAY],
      appearance: {
        albedo: [0.18, 0.14, 0.1],
        charAlbedo: [0.03, 0.03, 0.03],
        sootYield: 0.02,
      },
    },
    {
      /*
       * **The one the design points at.** Twenty-five percent moisture is the dangerous band: wet
       * enough to respire and dry enough that the water is not itself the heat sink that stops it.
       * Low conductivity and low density mean a large bale keeps what it makes.
       */
      id: 'hay',
      composition: wetComposition(
        species,
        massFractions(species, {
          cellulose: 0.36,
          hemicellulose: 0.26,
          lignin: 0.16,
          glucose: 0.06,
          protein: 0.06,
          ash: 0.1,
        }),
        0.25,
      ),
      density: 130,
      conductivity: { k0: 0.05, k1: 0.0001 },
      shells: 3,
      shape: SHAPE_CYLINDER,
      porosity: 0.75,
      emissivity: 0.9,
      reactions: [BOIL_WATER, ...DECAY],
      /* Cellulosic, so it catches on cellulosic terms once something gets it there. */
      ignition: { pilotedSurfaceK: 623, autoSurfaceK: 773, criticalMassFlux: 0.0035 },
      appearance: {
        albedo: [0.58, 0.5, 0.28],
        charAlbedo: [0.04, 0.04, 0.04],
        sootYield: 0.015,
      },
    },
    {
      /* Living tissue, which is the same reactions running slowly enough to be called being alive. */
      id: 'flesh',
      composition: wetComposition(
        species,
        massFractions(species, {
          protein: 0.7,
          'triglyceride(saturated)': 0.15,
          collagen: 0.08,
          glucose: 0.05,
          ash: 0.02,
        }),
        2.33,
      ),
      density: 1010,
      conductivity: { k0: 0.49, k1: 0.0005 },
      shells: 4,
      shape: SHAPE_SPHERE,
      porosity: 0.05,
      emissivity: 0.98,
      reactions: [BOIL_WATER, ...DECAY],
      appearance: {
        albedo: [0.44, 0.16, 0.14],
        charAlbedo: [0.05, 0.03, 0.02],
        sootYield: 0.04,
      },
    },
    {
      /* Grape must: mostly sugar and water, and it ferments rather than decays because that is what
         the rates say at cellar temperature with no air getting in. */
      id: 'must',
      composition: wetComposition(
        species,
        massFractions(species, {
          glucose: 0.85,
          fructose: 0.1,
          protein: 0.02,
          ash: 0.03,
        }),
        4.0,
      ),
      density: 1080,
      conductivity: { k0: 0.55, k1: 0.0005 },
      shells: 2,
      shape: SHAPE_SPHERE,
      emissivity: 0.96,
      reactions: [BOIL_WATER, FERMENT, DECAY_MESOPHILIC],
      appearance: {
        albedo: [0.32, 0.1, 0.16],
        charAlbedo: [0.32, 0.1, 0.16],
        sootYield: 0.01,
      },
    },
  ],
};
