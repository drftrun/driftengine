/**
 * `@driftengine/chemistry/library/polymer` — six plastics, and what each one does in a fire.
 *
 * **The interesting numbers here are the two that are not enthalpies.** PVC's limiting oxygen index
 * is 0.45, more than twice what air provides, so it burns only while something else holds a flame to
 * it — which is the whole reason it goes in walls. And PVC's chlorine and polyurethane's nitrogen
 * come out as HCl and HCN because their formulas say so, which is why a burning sofa is the
 * dangerous one and why nothing here had to be told that.
 *
 * **The per-kilogram gasification endotherms run high**, and `library.ts`'s header says why: this
 * species set stops at C₂ where real polyolefin volatiles are C₁₀-C₄₀ waxes. Polyethylene's *molar*
 * depolymerisation enthalpy is right — 106.6 kJ/mol against a published 92-108 — and per kilogram it
 * is 3.8 MJ against a measured 1.8-2.2. The total heat released once the volatiles burn is exact
 * either way; the cap moves where it is released, not how much.
 */
import { KIND_PYROLYSIS, type Reaction } from '../reaction/reaction.ts';
import { SHAPE_SLAB } from '../parcel/shells.ts';
import { massFractions } from '../substance/composition.ts';
import type { SubstanceThermal } from '../substance/substance.ts';
import type { SubstanceLibrary } from './library.ts';
import { COMMON_REACTIONS, GAS_REACTIONS, OXIDISE_CHAR, OXIDISE_CHAR_RICH } from './common.ts';

/** Nothing new: everything these polymers give off is already in the common set. */
export const POLYMER_GAS_REACTIONS: readonly string[] = GAS_REACTIONS;

const REACTIONS: readonly Reaction[] = [
  ...COMMON_REACTIONS,
  {
    /* Unzips to its own monomer and leaves nothing behind — measured char yield zero, and the
       stoichiometry has no way to produce any. */
    id: 'pyrolyse-polyethylene',
    reactants: [{ species: 'polyethylene', moles: 1 }],
    products: [{ species: 'C2H4', moles: 1 }],
    kinetics: { type: 'arrhenius', A: 1e16, activationEnergy: 250000 },
    kind: KIND_PYROLYSIS,
  },
  {
    /* Forty kelvin below polyethylene, because a tertiary carbon is easier to break. */
    id: 'pyrolyse-polypropylene',
    reactants: [{ species: 'polypropylene', moles: 1 }],
    products: [{ species: 'C2H4', moles: 1.5 }],
    kinetics: { type: 'arrhenius', A: 1e16, activationEnergy: 235000 },
    kind: KIND_PYROLYSIS,
  },
  {
    /*
     * Dehydrochlorination at about 275 °C, and what is left is a carbon backbone that chars.
     * Modelled as one step rather than the real two, because the second one — the polyene charring
     * at 400 °C — has the same products and nothing here distinguishes them.
     */
    id: 'pyrolyse-pvc',
    reactants: [{ species: 'PVC', moles: 1 }],
    products: [
      { species: 'HCl', moles: 1 },
      { species: 'C(char)', moles: 2 },
      { species: 'H2', moles: 1 },
    ],
    kinetics: { type: 'arrhenius', A: 1e9, activationEnergy: 130000 },
    kind: KIND_PYROLYSIS,
  },
  {
    /* The aromatic ring survives depolymerisation and becomes char and soot, which is why a
       polystyrene fire is the black one. */
    id: 'pyrolyse-polystyrene',
    reactants: [{ species: 'polystyrene', moles: 1 }],
    products: [
      { species: 'C2H4', moles: 2 },
      { species: 'C(char)', moles: 4 },
    ],
    kinetics: { type: 'arrhenius', A: 1e13, activationEnergy: 200000 },
    kind: KIND_PYROLYSIS,
  },
  {
    /* The one polyolefin whose derived heat of gasification lands on the measurement — 1.99 MJ/kg
       against 1.6 — because its ester group leaves as CO₂ and takes the oxygen with it. */
    id: 'pyrolyse-pmma',
    reactants: [{ species: 'PMMA', moles: 1 }],
    products: [
      { species: 'C2H4', moles: 2 },
      { species: 'CO2', moles: 1 },
    ],
    kinetics: { type: 'arrhenius', A: 1e13, activationEnergy: 190000 },
    kind: KIND_PYROLYSIS,
  },
  {
    /* Two nitrogens per repeat unit, and they leave as cyanide and ammonia. Foam decomposes at
       250-350 °C, far below any of the others, which is why furniture is the first thing to go. */
    id: 'pyrolyse-polyurethane',
    reactants: [{ species: 'polyurethane', moles: 1 }],
    products: [
      { species: 'C(char)', moles: 12 },
      { species: 'CO', moles: 0.8 },
      { species: 'CO2', moles: 2 },
      { species: 'CH4', moles: 9 },
      { species: 'HCN', moles: 1.2 },
      { species: 'NH3', moles: 0.8 },
      { species: 'H2O(g)', moles: 1.2 },
    ],
    kinetics: { type: 'arrhenius', A: 1e12, activationEnergy: 160000 },
    kind: KIND_PYROLYSIS,
  },
];

const CHAR = [OXIDISE_CHAR, OXIDISE_CHAR_RICH];

export const POLYMER: SubstanceLibrary = {
  id: 'polymer',
  species: [],
  reactions: REACTIONS,
  substances: (species): readonly SubstanceThermal[] => [
    {
      id: 'polyethylene',
      composition: massFractions(species, { polyethylene: 1 }),
      density: 940,
      conductivity: { k0: 0.4, k1: 0 },
      shells: 3,
      shape: SHAPE_SLAB,
      emissivity: 0.92,
      reactions: ['pyrolyse-polyethylene'],
      ignition: {
        pilotedSurfaceK: 613,
        autoSurfaceK: 623,
        criticalMassFlux: 0.011,
        limitingOxygen: 0.174,
      },
      appearance: {
        albedo: [0.78, 0.78, 0.76],
        charAlbedo: [0.05, 0.05, 0.05],
        sootYield: 0.06,
      },
    },
    {
      id: 'polypropylene',
      composition: massFractions(species, { polypropylene: 1 }),
      density: 905,
      conductivity: { k0: 0.22, k1: 0 },
      shells: 3,
      shape: SHAPE_SLAB,
      emissivity: 0.92,
      reactions: ['pyrolyse-polypropylene'],
      ignition: {
        pilotedSurfaceK: 610,
        autoSurfaceK: 660,
        criticalMassFlux: 0.011,
        limitingOxygen: 0.175,
      },
      appearance: {
        albedo: [0.76, 0.76, 0.74],
        charAlbedo: [0.05, 0.05, 0.05],
        sootYield: 0.06,
      },
    },
    {
      /* **The limiting oxygen index is the whole substance.** 0.45 against air's 0.209, so a flame
         cannot be sustained on it at all and it stops the moment the pilot does. */
      id: 'pvc',
      composition: massFractions(species, { PVC: 1 }),
      density: 1400,
      conductivity: { k0: 0.19, k1: 0 },
      shells: 3,
      shape: SHAPE_SLAB,
      emissivity: 0.93,
      reactions: ['pyrolyse-pvc', ...CHAR],
      ignition: {
        pilotedSurfaceK: 664,
        autoSurfaceK: 727,
        criticalMassFlux: 0.016,
        limitingOxygen: 0.45,
      },
      appearance: {
        albedo: [0.6, 0.6, 0.58],
        charAlbedo: [0.03, 0.03, 0.03],
        sootYield: 0.17,
      },
    },
    {
      id: 'polystyrene',
      composition: massFractions(species, { polystyrene: 1 }),
      density: 1050,
      conductivity: { k0: 0.16, k1: 0 },
      shells: 3,
      shape: SHAPE_SLAB,
      emissivity: 0.92,
      reactions: ['pyrolyse-polystyrene', ...CHAR],
      ignition: {
        pilotedSurfaceK: 630,
        autoSurfaceK: 763,
        criticalMassFlux: 0.013,
        limitingOxygen: 0.18,
      },
      appearance: {
        albedo: [0.84, 0.84, 0.82],
        charAlbedo: [0.03, 0.03, 0.03],
        sootYield: 0.16,
      },
    },
    {
      id: 'pmma',
      composition: massFractions(species, { PMMA: 1 }),
      density: 1180,
      conductivity: { k0: 0.19, k1: 0 },
      shells: 3,
      shape: SHAPE_SLAB,
      emissivity: 0.93,
      reactions: ['pyrolyse-pmma'],
      ignition: {
        pilotedSurfaceK: 651,
        autoSurfaceK: 723,
        criticalMassFlux: 0.0044,
        limitingOxygen: 0.173,
      },
      appearance: {
        albedo: [0.88, 0.88, 0.88],
        charAlbedo: [0.1, 0.1, 0.1],
        sootYield: 0.022,
      },
    },
    {
      /* Thirty kilograms a cubic metre and a conductivity ten times lower than the solid: a foam is
         mostly air, which is why it heats through in seconds and why a sofa goes up so fast. */
      id: 'polyurethane-foam',
      composition: massFractions(species, { polyurethane: 1 }),
      density: 30,
      conductivity: { k0: 0.026, k1: 0.00005 },
      shells: 3,
      shape: SHAPE_SLAB,
      porosity: 0.95,
      emissivity: 0.9,
      reactions: ['pyrolyse-polyurethane', ...CHAR],
      ignition: {
        pilotedSurfaceK: 553,
        autoSurfaceK: 673,
        criticalMassFlux: 0.0045,
        limitingOxygen: 0.165,
      },
      appearance: {
        albedo: [0.8, 0.74, 0.55],
        charAlbedo: [0.03, 0.03, 0.03],
        sootYield: 0.19,
      },
    },
  ],
};
