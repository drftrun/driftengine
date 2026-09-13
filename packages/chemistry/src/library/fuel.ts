/**
 * `@driftengine/chemistry/library/fuel` — the liquids and the gas, and what they do before they burn.
 *
 * **A liquid fuel does not burn; its vapour does.** That is why a pool fire's burning rate is a
 * heat-transfer number rather than a chemical one, why a cold pool of diesel will not light from a
 * match and a cold pool of petrol will, and why throwing sand on one works. So every liquid here
 * carries a vaporisation before it carries a combustion, and the two are ordinary gated reactions.
 *
 * **Six species, and each is an existing liquid plus a measured enthalpy of vaporisation.** Nothing
 * about combustion went into any of them, so the heating values that come out of the burn reactions
 * are predictions — and `fuel.test.ts` checks each against its published figure.
 */
import { PHASE_GAS, PHASE_LIQUID, type SpeciesDefinition } from '../species/species.ts';
import { KIND_COMBUSTION, type Reaction, phaseChange } from '../reaction/reaction.ts';
import { SHAPE_CYLINDER, SHAPE_SLAB } from '../parcel/shells.ts';
import { massFractions } from '../substance/composition.ts';
import type { SubstanceThermal } from '../substance/substance.ts';
import type { SubstanceLibrary } from './library.ts';
import { COMMON_REACTIONS, GAS_REACTIONS } from './common.ts';

export const BURN_ETHANOL = 'burn-ethanol';
export const BURN_PETROL = 'burn-petrol';
export const BURN_DIESEL = 'burn-diesel';
export const BURN_KEROSENE = 'burn-kerosene';
export const BURN_PROPANE = 'burn-propane';
export const BURN_WAX = 'burn-wax';

/** What an `AtmosphereField` is given where any of these fuels is in play. */
export const FUEL_GAS_REACTIONS: readonly string[] = [
  ...GAS_REACTIONS,
  BURN_ETHANOL,
  BURN_PETROL,
  BURN_DIESEL,
  BURN_KEROSENE,
  BURN_PROPANE,
  BURN_WAX,
];

/*
 * The vapours. Each formation enthalpy is the liquid's plus that liquid's measured enthalpy of
 * vaporisation at 298.15 K, and three of the four with a published gas-phase value land within
 * 0.6% of it — ethanol −235,300 against −234,800, octane −208,600 against −208,750, dodecane
 * −289,400 against −290,900. That agreement is the arithmetic checking itself.
 */
const VAPOURS: readonly SpeciesDefinition[] = [
  {
    id: 'ethanol(g)',
    formula: { C: 2, H: 6, O: 1 },
    phase: PHASE_GAS,
    formationEnthalpy: -235300,
    cpA: 1420,
    cpB: 3.5,
  },
  {
    id: 'octane(g)',
    formula: { C: 8, H: 18 },
    phase: PHASE_GAS,
    formationEnthalpy: -208600,
    cpA: 1650,
    cpB: 4.0,
  },
  {
    id: 'diesel(g)',
    formula: { C: 12, H: 26 },
    phase: PHASE_GAS,
    formationEnthalpy: -289400,
    cpA: 1640,
    cpB: 4.0,
    pseudo: true,
  },
  {
    id: 'kerosene(g)',
    formula: { C: 12, H: 23 },
    phase: PHASE_GAS,
    formationEnthalpy: -219166,
    cpA: 1600,
    cpB: 3.8,
    pseudo: true,
  },
  /*
   * Wax gets two, because a candle is two plateaus in series. Fusion is 200 J/g and vaporisation is
   * 284 J/g, both measured on paraffin; over 352.69 g/mol those are 70,538 and 100,000 J/mol.
   */
  {
    id: 'wax(l)',
    formula: { C: 25, H: 52 },
    phase: PHASE_LIQUID,
    formationEnthalpy: -798661,
    cpA: 2300,
    pseudo: true,
  },
  {
    id: 'wax(g)',
    formula: { C: 25, H: 52 },
    phase: PHASE_GAS,
    formationEnthalpy: -698661,
    cpA: 2400,
    cpB: 3.0,
    pseudo: true,
  },
];

const REACTIONS: readonly Reaction[] = [
  ...COMMON_REACTIONS,

  /*
   * The boiling points, and the **widths are the interesting half**: ethanol is one molecule and
   * boils at a point, where diesel and kerosene are distillation cuts and boil over tens of kelvin.
   * Same gate, different width, and the consequence is that a cut keeps giving off vapour across a
   * range of surface temperatures instead of all at once.
   */
  phaseChange('vaporise-ethanol', 'ethanol', 'ethanol(g)', 351.45, 0.5),
  phaseChange('vaporise-petrol', 'octane', 'octane(g)', 398.75, 1),
  phaseChange('vaporise-diesel', 'diesel', 'diesel(g)', 489.15, 20),
  phaseChange('vaporise-kerosene', 'kerosene', 'kerosene(g)', 470.15, 20),
  phaseChange('melt-wax', 'wax', 'wax(l)', 330.15, 8),
  phaseChange('vaporise-wax', 'wax(l)', 'wax(g)', 660.15, 10),

  {
    id: BURN_ETHANOL,
    reactants: [
      { species: 'ethanol(g)', moles: 1 },
      { species: 'O2', moles: 3 },
    ],
    products: [
      { species: 'CO2', moles: 2 },
      { species: 'H2O(g)', moles: 3 },
    ],
    kinetics: { type: 'arrhenius', A: 1e12, activationEnergy: 125500 },
    kind: KIND_COMBUSTION,
  },
  {
    id: BURN_PETROL,
    reactants: [
      { species: 'octane(g)', moles: 1 },
      { species: 'O2', moles: 12.5 },
    ],
    products: [
      { species: 'CO2', moles: 8 },
      { species: 'H2O(g)', moles: 9 },
    ],
    kinetics: { type: 'arrhenius', A: 4e11, activationEnergy: 125500 },
    kind: KIND_COMBUSTION,
  },
  {
    id: BURN_DIESEL,
    reactants: [
      { species: 'diesel(g)', moles: 1 },
      { species: 'O2', moles: 18.5 },
    ],
    products: [
      { species: 'CO2', moles: 12 },
      { species: 'H2O(g)', moles: 13 },
    ],
    kinetics: { type: 'arrhenius', A: 3e11, activationEnergy: 125500 },
    kind: KIND_COMBUSTION,
  },
  {
    id: BURN_KEROSENE,
    reactants: [
      { species: 'kerosene(g)', moles: 1 },
      { species: 'O2', moles: 17.75 },
    ],
    products: [
      { species: 'CO2', moles: 12 },
      { species: 'H2O(g)', moles: 11.5 },
    ],
    kinetics: { type: 'arrhenius', A: 3e11, activationEnergy: 125500 },
    kind: KIND_COMBUSTION,
  },
  {
    /* Already a gas, so it has no vaporisation and no flash point — which is exactly why a leak is
       dangerous at any temperature and a diesel spill is not. */
    id: BURN_PROPANE,
    reactants: [
      { species: 'propane', moles: 1 },
      { species: 'O2', moles: 5 },
    ],
    products: [
      { species: 'CO2', moles: 3 },
      { species: 'H2O(g)', moles: 4 },
    ],
    kinetics: { type: 'arrhenius', A: 8e11, activationEnergy: 125500 },
    kind: KIND_COMBUSTION,
  },
  {
    id: BURN_WAX,
    reactants: [
      { species: 'wax(g)', moles: 1 },
      { species: 'O2', moles: 38 },
    ],
    products: [
      { species: 'CO2', moles: 25 },
      { species: 'H2O(g)', moles: 26 },
    ],
    kinetics: { type: 'arrhenius', A: 2e11, activationEnergy: 125500 },
    kind: KIND_COMBUSTION,
  },
];

/**
 * A liquid fuel's `pilotedSurfaceK` is its **flash point** and `autoSurfaceK` its autoignition
 * temperature, and the gap between them is enormous where it matters.
 *
 * Petrol flashes at −43 °C and autoignites at 280; diesel flashes at 52 °C and autoignites at 210.
 * That is the whole difference between the two in a garage: petrol is above its flash point on the
 * coldest day of the year and diesel is below it on the hottest, so one needs a spark it will
 * certainly find and the other needs a spark it may not.
 */
export const FUEL: SubstanceLibrary = {
  id: 'fuel',
  species: VAPOURS,
  reactions: REACTIONS,
  substances: (species): readonly SubstanceThermal[] => [
    {
      id: 'ethanol',
      composition: massFractions(species, { ethanol: 1 }),
      density: 789,
      conductivity: { k0: 0.17, k1: 0 },
      shells: 2,
      shape: SHAPE_SLAB,
      emissivity: 0.95,
      reactions: ['vaporise-ethanol'],
      /* And its flame is nearly invisible, because there is no soot in it at all — one of the two
         ends of `§8.4`'s sooting scale, and a genuine hazard in a real spirit fire. */
      ignition: { pilotedSurfaceK: 286, autoSurfaceK: 636, criticalMassFlux: 0.001 },
      appearance: {
        albedo: [0.03, 0.04, 0.05],
        charAlbedo: [0.03, 0.04, 0.05],
        sootYield: 0.008,
      },
    },
    {
      id: 'petrol',
      composition: massFractions(species, { octane: 1 }),
      density: 745,
      conductivity: { k0: 0.14, k1: 0 },
      shells: 2,
      shape: SHAPE_SLAB,
      emissivity: 0.95,
      reactions: ['vaporise-petrol'],
      ignition: { pilotedSurfaceK: 230, autoSurfaceK: 553, criticalMassFlux: 0.001 },
      appearance: {
        albedo: [0.3, 0.26, 0.1],
        charAlbedo: [0.3, 0.26, 0.1],
        sootYield: 0.1,
      },
    },
    {
      id: 'diesel',
      composition: massFractions(species, { diesel: 1 }),
      density: 832,
      conductivity: { k0: 0.13, k1: 0 },
      shells: 2,
      shape: SHAPE_SLAB,
      emissivity: 0.95,
      reactions: ['vaporise-diesel'],
      ignition: { pilotedSurfaceK: 325, autoSurfaceK: 483, criticalMassFlux: 0.0012 },
      appearance: {
        albedo: [0.2, 0.17, 0.1],
        charAlbedo: [0.2, 0.17, 0.1],
        sootYield: 0.13,
      },
    },
    {
      id: 'kerosene',
      composition: massFractions(species, { kerosene: 1 }),
      density: 810,
      conductivity: { k0: 0.13, k1: 0 },
      shells: 2,
      shape: SHAPE_SLAB,
      emissivity: 0.95,
      reactions: ['vaporise-kerosene'],
      ignition: { pilotedSurfaceK: 311, autoSurfaceK: 493, criticalMassFlux: 0.0012 },
      appearance: {
        albedo: [0.24, 0.22, 0.16],
        charAlbedo: [0.24, 0.22, 0.16],
        sootYield: 0.12,
      },
    },
    {
      /* Solid, and it has to melt and then boil before anything burns. That is a candle. */
      id: 'paraffin-wax',
      composition: massFractions(species, { wax: 1 }),
      density: 900,
      conductivity: { k0: 0.25, k1: 0 },
      shells: 3,
      shape: SHAPE_CYLINDER,
      emissivity: 0.93,
      reactions: ['melt-wax', 'vaporise-wax'],
      ignition: { pilotedSurfaceK: 472, autoSurfaceK: 573, criticalMassFlux: 0.002 },
      appearance: {
        albedo: [0.86, 0.85, 0.8],
        charAlbedo: [0.1, 0.09, 0.08],
        sootYield: 0.06,
      },
    },
  ],
};
