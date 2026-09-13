/**
 * `@driftengine/chemistry/library/food` — water, fat, protein, starch, sugar, and cooking.
 *
 * **Nothing here is a cooking rule.** Every claim a cook makes about searing is a consequence of one
 * fact the model already had: a wet surface is pinned at the boiling point by CH-6's vaporisation
 * plateau, and Maillard needs forty degrees more than that. So browning is not forbidden while the
 * surface is wet — it is *unreachable*, which is a much stronger statement and costs nothing.
 *
 * The one species this library adds is molten fat, because fat melting is a phase change between two
 * states of one material and this model expresses a phase change as a reaction between two species.
 */
import { PHASE_LIQUID, type SpeciesDefinition } from '../species/species.ts';
import {
  KIND_BROWNING,
  KIND_DENATURATION,
  type Reaction,
  phaseChange,
} from '../reaction/reaction.ts';
import { SHAPE_SLAB, SHAPE_SPHERE } from '../parcel/shells.ts';
import { massFractions } from '../substance/composition.ts';
import { wetComposition } from '../substance/substance.ts';
import type { SubstanceThermal } from '../substance/substance.ts';
import type { SubstanceLibrary } from './library.ts';
import { BOIL_WATER, COMMON_REACTIONS, MELT_ICE } from './common.ts';

export const MELT_FAT = 'melt-fat';
export const DENATURE_MYOSIN = 'denature-myosin';
export const DENATURE_ALBUMEN = 'denature-albumen';
export const GELATINISE_COLLAGEN = 'gelatinise-collagen';
export const HYDROLYSE_STARCH = 'hydrolyse-starch';
export const BROWN_MAILLARD = 'brown-maillard';
export const CARAMELISE = 'caramelise';

/**
 * Molten fat: the same molecule as `triglyceride(saturated)`, one heat of fusion above it.
 *
 * 190 J/g, which is tristearin's measured enthalpy of fusion, and it is **stored** rather than
 * derived — unavoidably, because a phase pair is two species and the gap between their formation
 * enthalpies *is* the latent heat. Water's two transitions are derived only because CH-0 happened to
 * have published formation enthalpies for ice, water and steam separately; nobody has published one
 * for molten tristearin.
 */
const MOLTEN_FAT: SpeciesDefinition = {
  id: 'fat(liquid)',
  formula: { C: 57, H: 110, O: 6 },
  phase: PHASE_LIQUID,
  formationEnthalpy: -2024313,
  cpA: 2100,
  pseudo: true,
};

/** K over which butter softens. `§8.1`: a mixture of triglycerides, so a band and not a point. */
const FAT_BAND = 3;

const REACTIONS: readonly Reaction[] = [
  ...COMMON_REACTIONS,

  /* 33-35 °C, over three kelvin, which is what makes fat render instead of switching state. */
  phaseChange(MELT_FAT, 'triglyceride(saturated)', 'fat(liquid)', 306.15, FAT_BAND),

  {
    /* Myosin, at 50-55 °C: the meat firms and turns opaque. */
    id: DENATURE_MYOSIN,
    reactants: [{ species: 'protein', moles: 1 }],
    products: [{ species: 'protein(denatured)', moles: 1 }],
    kinetics: { type: 'arrhenius', A: 0.4, activationEnergy: 0 },
    kind: KIND_DENATURATION,
    gates: { minTemperature: 323.15, width: 5 },
  },
  {
    /* Egg white sets at 62 °C, and the yolk at 68 — which is why a 63 °C egg is a thing. The two
       bands are two reactions rather than one, because they are two proteins. */
    id: DENATURE_ALBUMEN,
    reactants: [{ species: 'protein', moles: 1 }],
    products: [{ species: 'protein(denatured)', moles: 1 }],
    kinetics: { type: 'arrhenius', A: 0.4, activationEnergy: 0 },
    kind: KIND_DENATURATION,
    gates: { minTemperature: 335.15, width: 3 },
  },
  {
    /*
     * **The rate is back-derived from two measured times**, which is what an activation energy is:
     * many hours at 60 °C and about an hour at 80 °C is a factor of eight over twenty kelvin, and
     * that factor fixes `Ea` at 101.6 kJ/mol. `A` then sets the absolute clock from the second time.
     *
     * The consequence is the whole of slow cooking: this reaction and the ones that dry the meat out
     * are a genuine competition between two rates, and at 80 °C this one is winning.
     */
    id: GELATINISE_COLLAGEN,
    reactants: [
      { species: 'collagen', moles: 1 },
      { species: 'H2O(l)', moles: 1 },
    ],
    products: [{ species: 'gelatin', moles: 1 }],
    kinetics: { type: 'arrhenius', A: 3e11, activationEnergy: 101600 },
    kind: KIND_DENATURATION,
    gates: { minTemperature: 333.15, width: 5 },
  },
  {
    /* Starch to sugar, needing water and warmth. It is what puts a reducing sugar on the surface of
       a potato, and therefore what lets a potato brown at all. */
    id: HYDROLYSE_STARCH,
    reactants: [
      { species: 'starch', moles: 1 },
      { species: 'H2O(l)', moles: 1 },
    ],
    products: [{ species: 'glucose', moles: 1 }],
    kinetics: { type: 'arrhenius', A: 1e11, activationEnergy: 100000 },
    kind: KIND_DENATURATION,
    gates: { minTemperature: 328.15, width: 10 },
  },
  {
    /*
     * Browning, at 140 °C, and the product is carbon because carbon is what a crust is.
     *
     * **The amino donor is not a reactant, and that is a stated simplification.** Maillard needs a
     * reducing sugar and an amino group; the sugar is the scarce one and the protein is always there
     * in the foods where this matters, so making the protein a reactant would have bought nothing
     * and cost a nitrogen path with nowhere to go. What is modelled is the sugar being consumed and
     * a dark surface appearing, which is what `§17` reads.
     */
    id: BROWN_MAILLARD,
    reactants: [{ species: 'glucose', moles: 1 }],
    products: [
      { species: 'C(char)', moles: 6 },
      { species: 'H2O(g)', moles: 6 },
    ],
    kinetics: { type: 'arrhenius', A: 4e12, activationEnergy: 130000 },
    kind: KIND_BROWNING,
    gates: { minTemperature: 413.15, width: 8 },
  },
  {
    /* Sugar alone, twenty degrees higher, and no protein needed. */
    id: CARAMELISE,
    reactants: [{ species: 'sucrose', moles: 1 }],
    products: [
      { species: 'C(char)', moles: 12 },
      { species: 'H2O(g)', moles: 11 },
    ],
    kinetics: { type: 'arrhenius', A: 4e12, activationEnergy: 130000 },
    kind: KIND_BROWNING,
    gates: { minTemperature: 433.15, width: 10 },
  },
];

export const FOOD: SubstanceLibrary = {
  id: 'food',
  species: [MOLTEN_FAT],
  reactions: REACTIONS,
  substances: (species): readonly SubstanceThermal[] => [
    {
      id: 'water',
      composition: massFractions(species, { 'H2O(l)': 1 }),
      density: 997,
      conductivity: { k0: 0.6, k1: 0 },
      shells: 2,
      shape: SHAPE_SPHERE,
      emissivity: 0.96,
      reactions: [BOIL_WATER],
      appearance: {
        albedo: [0.02, 0.03, 0.04],
        charAlbedo: [0.02, 0.03, 0.04],
        sootYield: 0,
      },
    },
    {
      /* Authored as the coldest form, per `SubstanceThermal`: ice with two transitions rather than
         water with one in each direction, because a reaction runs one way. */
      id: 'ice',
      composition: massFractions(species, { 'H2O(s)': 1 }),
      density: 917,
      conductivity: { k0: 2.2, k1: -0.01 },
      shells: 3,
      shape: SHAPE_SPHERE,
      emissivity: 0.97,
      reactions: [MELT_ICE, BOIL_WATER],
      appearance: {
        albedo: [0.72, 0.78, 0.82],
        charAlbedo: [0.72, 0.78, 0.82],
        sootYield: 0,
      },
    },
    {
      /* Eighty percent fat, sixteen water, and the water is why it spits. */
      id: 'butter',
      composition: wetComposition(
        species,
        massFractions(species, {
          'triglyceride(saturated)': 0.94,
          protein: 0.04,
          ash: 0.02,
        }),
        0.19,
      ),
      density: 911,
      conductivity: { k0: 0.2, k1: 0 },
      shells: 2,
      shape: SHAPE_SLAB,
      emissivity: 0.93,
      reactions: [MELT_FAT, BOIL_WATER, DENATURE_MYOSIN],
      appearance: {
        albedo: [0.86, 0.76, 0.42],
        charAlbedo: [0.1, 0.06, 0.03],
        sootYield: 0.05,
      },
    },
    {
      /* Seventy-two percent water by mass, which is `moisture: 2.571` on a dry basis — and getting
         that conversion wrong is the mistake `wetComposition` exists to prevent. */
      id: 'beef-muscle',
      composition: wetComposition(
        species,
        massFractions(species, {
          protein: 0.74,
          'triglyceride(saturated)': 0.15,
          collagen: 0.08,
          glucose: 0.01,
          ash: 0.02,
        }),
        2.571,
      ),
      density: 1050,
      conductivity: { k0: 0.45, k1: 0.0005 },
      shells: 4,
      shape: SHAPE_SLAB,
      porosity: 0.1,
      emissivity: 0.95,
      reactions: [BOIL_WATER, MELT_FAT, DENATURE_MYOSIN, GELATINISE_COLLAGEN, BROWN_MAILLARD],
      appearance: {
        albedo: [0.42, 0.12, 0.11],
        charAlbedo: [0.05, 0.03, 0.02],
        sootYield: 0.04,
      },
    },
    {
      /* Starch, and the free sugar that lets it brown. A potato browns because starch hydrolyses
         first — which is why a blanched chip browns and a raw one goes grey. */
      id: 'potato',
      composition: wetComposition(
        species,
        massFractions(species, {
          starch: 0.8,
          protein: 0.09,
          glucose: 0.05,
          ash: 0.06,
        }),
        3.762,
      ),
      density: 1080,
      conductivity: { k0: 0.55, k1: 0.0005 },
      shells: 4,
      shape: SHAPE_SPHERE,
      porosity: 0.15,
      emissivity: 0.93,
      reactions: [BOIL_WATER, HYDROLYSE_STARCH, DENATURE_MYOSIN, BROWN_MAILLARD],
      appearance: {
        albedo: [0.72, 0.62, 0.38],
        charAlbedo: [0.06, 0.04, 0.02],
        sootYield: 0.02,
      },
    },
    {
      /* Eighty-eight percent water, and it sets twelve degrees above where muscle firms. */
      id: 'egg-white',
      composition: wetComposition(
        species,
        massFractions(species, {
          protein: 0.92,
          glucose: 0.02,
          ash: 0.06,
        }),
        7.333,
      ),
      density: 1040,
      conductivity: { k0: 0.6, k1: 0.0005 },
      shells: 3,
      shape: SHAPE_SPHERE,
      emissivity: 0.95,
      reactions: [BOIL_WATER, DENATURE_ALBUMEN, BROWN_MAILLARD],
      appearance: {
        albedo: [0.88, 0.87, 0.82],
        charAlbedo: [0.08, 0.06, 0.04],
        sootYield: 0.02,
      },
    },
    {
      id: 'sugar',
      composition: massFractions(species, { sucrose: 1 }),
      density: 1590,
      conductivity: { k0: 0.15, k1: 0 },
      shells: 2,
      shape: SHAPE_SLAB,
      emissivity: 0.9,
      reactions: [CARAMELISE],
      appearance: {
        albedo: [0.92, 0.9, 0.86],
        charAlbedo: [0.08, 0.04, 0.02],
        sootYield: 0.03,
      },
    },
  ],
};
