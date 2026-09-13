/**
 * `@driftengine/chemistry/library/mineral` — stone, board, sand and glass.
 *
 * **Two reactions, and both matter for the same reason: they are endothermic and they release gas.**
 * Gypsum gives up two waters at 120 °C, which is why plasterboard is a fire barrier. Limestone gives
 * up carbon dioxide at 825 °C, which is why stone spalls in a fire and why a concrete wall in a
 * serious one loses its surface explosively.
 *
 * Both enthalpies are Hess's law over the standard table and neither is written down: +179.2 kJ/mol
 * for calcination against a published +178.3, and +104.4 for gypsum against a published +104.
 */
import { KIND_CALCINATION, type Reaction } from '../reaction/reaction.ts';
import { SHAPE_SLAB } from '../parcel/shells.ts';
import { massFractions } from '../substance/composition.ts';
import { wetComposition } from '../substance/substance.ts';
import type { SubstanceThermal } from '../substance/substance.ts';
import type { SubstanceLibrary } from './library.ts';
import { BOIL_WATER, COMMON_REACTIONS } from './common.ts';

export const CALCINE_LIMESTONE = 'calcine-limestone';
export const DEHYDRATE_GYPSUM = 'dehydrate-gypsum';

const REACTIONS: readonly Reaction[] = [
  ...COMMON_REACTIONS,
  {
    /* Onset near 825 °C at one atmosphere. Endothermic and gas-releasing, so a limestone block in a
       fire is both a heat sink and, eventually, a thing that comes apart. */
    id: CALCINE_LIMESTONE,
    reactants: [{ species: 'CaCO3', moles: 1 }],
    products: [
      { species: 'CaO', moles: 1 },
      { species: 'CO2', moles: 1 },
    ],
    kinetics: { type: 'arrhenius', A: 1e8, activationEnergy: 190000 },
    kind: KIND_CALCINATION,
    gates: { minTemperature: 1098.15, width: 20 },
  },
  {
    /*
     * **The same idea four hundred degrees lower, and it is what a fire-rated wall is.** A kilogram
     * of board holds 607 kJ of latent heat in two waters of crystallisation, and it will not let the
     * far side past the boiling point until every one of them has gone.
     */
    id: DEHYDRATE_GYPSUM,
    reactants: [{ species: 'gypsum', moles: 1 }],
    products: [
      { species: 'anhydrite', moles: 1 },
      { species: 'H2O(g)', moles: 2 },
    ],
    kinetics: { type: 'arrhenius', A: 1e6, activationEnergy: 80000 },
    kind: KIND_CALCINATION,
    gates: { minTemperature: 393.15, width: 20 },
  },
];

export const MINERAL: SubstanceLibrary = {
  id: 'mineral',
  species: [],
  reactions: REACTIONS,
  substances: (species): readonly SubstanceThermal[] => [
    {
      id: 'limestone',
      composition: massFractions(species, { CaCO3: 1 }),
      density: 2700,
      conductivity: { k0: 2.2, k1: -0.0005 },
      shells: 4,
      shape: SHAPE_SLAB,
      emissivity: 0.93,
      reactions: [CALCINE_LIMESTONE],
      appearance: {
        albedo: [0.68, 0.66, 0.6],
        charAlbedo: [0.68, 0.66, 0.6],
        sootYield: 0,
      },
    },
    {
      /* Light, because it is foamed, and thermally poor — which together with the dehydration is the
         whole of its fire rating. */
      id: 'gypsum-board',
      composition: wetComposition(
        species,
        massFractions(species, {
          gypsum: 0.95,
          SiO2: 0.05,
        }),
        0.01,
      ),
      density: 700,
      conductivity: { k0: 0.25, k1: 0.0002 },
      shells: 4,
      shape: SHAPE_SLAB,
      porosity: 0.3,
      emissivity: 0.9,
      reactions: [BOIL_WATER, DEHYDRATE_GYPSUM],
      appearance: {
        albedo: [0.82, 0.81, 0.78],
        charAlbedo: [0.82, 0.81, 0.78],
        sootYield: 0,
      },
    },
    {
      id: 'sand',
      composition: massFractions(species, { SiO2: 1 }),
      density: 1600,
      conductivity: { k0: 0.3, k1: 0.0003 },
      shells: 3,
      shape: SHAPE_SLAB,
      porosity: 0.4,
      emissivity: 0.9,
      /* No reactions, which is why throwing it on a fire works: it is a blanket and a heat sink. */
      appearance: {
        albedo: [0.6, 0.52, 0.36],
        charAlbedo: [0.6, 0.52, 0.36],
        sootYield: 0,
      },
    },
    {
      /* Fifteen percent water, and it is the water that makes wet clay near a fire crack. */
      id: 'clay',
      composition: wetComposition(
        species,
        massFractions(species, {
          SiO2: 0.55,
          Al2O3: 0.4,
          Fe2O3: 0.05,
        }),
        0.15,
      ),
      density: 1700,
      conductivity: { k0: 1.0, k1: 0.0002 },
      shells: 4,
      shape: SHAPE_SLAB,
      porosity: 0.25,
      emissivity: 0.91,
      reactions: [BOIL_WATER],
      appearance: {
        albedo: [0.48, 0.34, 0.24],
        charAlbedo: [0.48, 0.34, 0.24],
        sootYield: 0,
      },
    },
    {
      /*
       * **Spalls for two reasons at once and gets both by being declared.** Free water flashing to
       * steam inside a matrix that cannot vent it, and then the limestone in the aggregate calcining
       * and releasing carbon dioxide in the same place.
       */
      id: 'concrete',
      composition: wetComposition(
        species,
        massFractions(species, {
          SiO2: 0.62,
          CaCO3: 0.2,
          Al2O3: 0.1,
          CaO: 0.05,
          Fe2O3: 0.03,
        }),
        0.04,
      ),
      density: 2300,
      conductivity: { k0: 1.7, k1: -0.0003 },
      shells: 4,
      shape: SHAPE_SLAB,
      porosity: 0.12,
      emissivity: 0.92,
      reactions: [BOIL_WATER, CALCINE_LIMESTONE],
      appearance: {
        albedo: [0.52, 0.52, 0.5],
        charAlbedo: [0.52, 0.52, 0.5],
        sootYield: 0,
      },
    },
    {
      /*
       * **Nothing at all, and that is the point of it.** Glass in a fire gets hot, conducts,
       * radiates and eventually softens — and softening is mechanical, which `§26` refuses in
       * writing because this package owns no solver. A chemistry invented so the entry would not
       * look empty would be worse than the empty entry.
       */
      id: 'glass',
      composition: massFractions(species, { SiO2: 0.8, CaO: 0.13, Al2O3: 0.07 }),
      density: 2500,
      conductivity: { k0: 1.0, k1: 0.0005 },
      shells: 3,
      shape: SHAPE_SLAB,
      emissivity: 0.94,
      appearance: {
        albedo: [0.1, 0.12, 0.11],
        charAlbedo: [0.1, 0.12, 0.11],
        sootYield: 0,
      },
    },
  ],
};
