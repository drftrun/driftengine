/**
 * `@driftengine/chemistry/library/metal` — five metals, and the one number that decides most of it.
 *
 * **It is the emissivity, not the conductivity.** Polished copper's is 0.05 against oak's 0.90, and
 * a radiative term is linear in it, so eighteen times less of the same fire arrives at the same
 * distance. That is why a metal poker's handle stays cool beside a fire that chars a wooden one, and
 * it is one field.
 *
 * **Three published heats of combustion fall out and none is stored**: magnesium 24.7 MJ/kg,
 * aluminium 31.0, iron 7.4. What the table holds is the formation enthalpy of each oxide.
 */
import { KIND_CORROSION, type Reaction } from '../reaction/reaction.ts';
import { SHAPE_CYLINDER, SHAPE_SLAB } from '../parcel/shells.ts';
import { massFractions } from '../substance/composition.ts';
import type { SubstanceThermal } from '../substance/substance.ts';
import type { SubstanceLibrary } from './library.ts';
import { COMMON_REACTIONS } from './common.ts';

export const RUST_IRON = 'rust-iron';
export const OXIDISE_ALUMINIUM = 'oxidise-aluminium';
export const OXIDISE_COPPER = 'oxidise-copper';
export const BURN_MAGNESIUM = 'burn-magnesium';

const REACTIONS: readonly Reaction[] = [
  ...COMMON_REACTIONS,
  {
    /*
     * The slowest reaction in the model by orders of magnitude, back-derived from the measured
     * atmospheric corrosion rate — roughly a percent of a kilogram bar in a year.
     *
     * **The humidity gate `§8.7` asks for is absent.** `ReactionGates` is temperature only, so
     * nothing here reproduces the 60% relative humidity below which atmospheric rusting effectively
     * stops, and a bar in a desert corrodes as fast as one in a bog. Fixing it means a gate on a
     * species fraction, which is a change to `reaction/` rather than to this file.
     */
    id: RUST_IRON,
    reactants: [
      { species: 'Fe', moles: 4 },
      { species: 'O2', moles: 3 },
    ],
    products: [{ species: 'Fe2O3', moles: 2 }],
    kinetics: { type: 'arrhenius', A: 5.6e-4, activationEnergy: 35000 },
    kind: KIND_CORROSION,
  },
  {
    /*
     * **Gated at the melting point, which is the honest proxy for passivation.** Aluminium releases
     * 31 MJ/kg and does not burn, because its oxide is coherent and seals the surface — and the
     * temperature at which that layer stops being coherent is the temperature at which the metal
     * under it is no longer solid. `§8.7` wanted an oxide-thickness gate; this is a gate that gets
     * the same two answers right, said out loud rather than left off.
     */
    id: OXIDISE_ALUMINIUM,
    reactants: [
      { species: 'Al', moles: 4 },
      { species: 'O2', moles: 3 },
    ],
    products: [{ species: 'Al2O3', moles: 2 }],
    kinetics: { type: 'arrhenius', A: 1e6, activationEnergy: 120000 },
    kind: KIND_CORROSION,
    gates: { minTemperature: 933.15, width: 10 },
  },
  {
    /* Slower than iron and green rather than red, which is a `§17` decision and not one here. */
    id: OXIDISE_COPPER,
    reactants: [
      { species: 'Cu', moles: 2 },
      { species: 'O2', moles: 1 },
    ],
    products: [{ species: 'CuO', moles: 2 }],
    kinetics: { type: 'arrhenius', A: 1e-4, activationEnergy: 45000 },
    kind: KIND_CORROSION,
  },
  {
    /*
     * The one metal a fire can actually light. It ignites at 973 K, fifty kelvin above its own
     * melting point and eight hundred below its boiling one — so it burns as a liquid, which is why
     * a magnesium fire runs.
     */
    id: BURN_MAGNESIUM,
    reactants: [
      { species: 'Mg', moles: 2 },
      { species: 'O2', moles: 1 },
    ],
    products: [{ species: 'MgO', moles: 2 }],
    kinetics: { type: 'arrhenius', A: 1e8, activationEnergy: 100000 },
    kind: KIND_CORROSION,
    gates: { minTemperature: 973.15, width: 10 },
  },
];

export const METAL: SubstanceLibrary = {
  id: 'metal',
  species: [],
  reactions: REACTIONS,
  substances: (species): readonly SubstanceThermal[] => [
    {
      id: 'iron',
      composition: massFractions(species, { Fe: 1 }),
      density: 7870,
      conductivity: { k0: 80.4, k1: -0.03 },
      shells: 3,
      shape: SHAPE_CYLINDER,
      /* Oxidised rather than polished, which is what iron actually is after a week outdoors. */
      emissivity: 0.65,
      reactions: [RUST_IRON],
      appearance: {
        albedo: [0.28, 0.22, 0.18],
        charAlbedo: [0.28, 0.22, 0.18],
        sootYield: 0,
      },
    },
    {
      /* A little carbon and a little silicon, which is what makes it steel and not iron. */
      id: 'steel',
      composition: massFractions(species, { Fe: 0.98, 'C(graphite)': 0.008, SiO2: 0.012 }),
      density: 7850,
      conductivity: { k0: 45, k1: -0.02 },
      shells: 3,
      shape: SHAPE_SLAB,
      emissivity: 0.28,
      reactions: [RUST_IRON],
      appearance: {
        albedo: [0.56, 0.57, 0.58],
        charAlbedo: [0.56, 0.57, 0.58],
        sootYield: 0,
      },
    },
    {
      id: 'aluminium',
      composition: massFractions(species, { Al: 1 }),
      density: 2700,
      conductivity: { k0: 237, k1: -0.04 },
      shells: 3,
      shape: SHAPE_SLAB,
      emissivity: 0.09,
      reactions: [OXIDISE_ALUMINIUM],
      appearance: {
        albedo: [0.91, 0.92, 0.92],
        charAlbedo: [0.91, 0.92, 0.92],
        sootYield: 0,
      },
    },
    {
      id: 'copper',
      composition: massFractions(species, { Cu: 1 }),
      density: 8960,
      conductivity: { k0: 401, k1: -0.07 },
      shells: 3,
      shape: SHAPE_CYLINDER,
      emissivity: 0.05,
      reactions: [OXIDISE_COPPER],
      appearance: {
        albedo: [0.95, 0.64, 0.54],
        charAlbedo: [0.2, 0.34, 0.28],
        sootYield: 0,
      },
    },
    {
      id: 'magnesium',
      composition: massFractions(species, { Mg: 1 }),
      density: 1740,
      conductivity: { k0: 156, k1: -0.02 },
      shells: 3,
      shape: SHAPE_CYLINDER,
      emissivity: 0.13,
      reactions: [BURN_MAGNESIUM],
      /*
       * A metal that genuinely catches, and the two temperatures are far apart from everything else
       * in the library. Its flame is also the one water makes worse, which falls out of the
       * enthalpy: 24.7 MJ/kg is enough to take the oxygen back out of steam.
       */
      ignition: {
        pilotedSurfaceK: 973,
        autoSurfaceK: 1023,
        criticalMassFlux: 0.02,
        limitingOxygen: 0.05,
      },
      appearance: {
        albedo: [0.78, 0.78, 0.76],
        charAlbedo: [0.9, 0.9, 0.88],
        sootYield: 0,
      },
    },
  ],
};
