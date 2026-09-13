/**
 * The species a world starts knowing about: sixty-eight of them, in thirteen groups.
 *
 * **Every formation enthalpy is J/mol at 298.15 K and every heat capacity is J/(kg·K).** Real
 * molecules carry published values. Pseudo-species — a lumped repeat unit, an average residue, a
 * fuel surrogate — carry a value **back-derived from a measured higher heating value**, so that
 * Hess's law over this table reproduces the heat the world actually releases. `standard.test.ts`
 * asserts eighteen of them against published figures to within two percent, which is inside the
 * spread of the published figures themselves.
 *
 * That derivation is the honest way round. A pseudo-species has no measured formation enthalpy,
 * because it is not a substance anyone has put in a calorimeter; what *has* been measured is what
 * a kilogram of it gives off. Deriving from the latter makes the table agree with the world at the
 * only point the world was ever asked.
 *
 * **Argon is not here, and the design's §6 listed it.** It is 0.93% of air and chemically inert, so
 * the only thing it contributes is heat capacity and dilution — and carrying it would have meant a
 * sixteenth element for nothing else. It is lumped into N2, which is inert in the same way and
 * makes up 78%.
 *
 * **Char and soot are graphite thermochemically**, all three at zero, because they are the same
 * element in the same standard state. What separates them is density, conductivity, porosity and
 * which reactions they take part in — every one of which is a property of a *substance* or a
 * reaction rather than of a species.
 */
import { PHASE_GAS, PHASE_LIQUID, PHASE_SOLID, type SpeciesDefinition } from './species.ts';
import type { SpeciesRegistry } from './registry.ts';

export const STANDARD_SPECIES: readonly SpeciesDefinition[] = [
  /* Atmospheric gases. The far field is these four plus whatever a fire has put into it. */
  { id: 'O2', formula: { O: 2 }, phase: PHASE_GAS, formationEnthalpy: 0, cpA: 918 },
  { id: 'N2', formula: { N: 2 }, phase: PHASE_GAS, formationEnthalpy: 0, cpA: 1040 },
  {
    id: 'CO2',
    formula: { C: 1, O: 2 },
    phase: PHASE_GAS,
    formationEnthalpy: -393510,
    cpA: 844,
    cpB: 0.6,
  },
  {
    id: 'H2O(g)',
    formula: { H: 2, O: 1 },
    phase: PHASE_GAS,
    formationEnthalpy: -241826,
    cpA: 1996,
    cpB: 0.4,
  },

  /* Combustion gases. CO and HCN are the two that kill; both are reported in ppm, never judged. */
  { id: 'CO', formula: { C: 1, O: 1 }, phase: PHASE_GAS, formationEnthalpy: -110530, cpA: 1040 },
  {
    id: 'CH4',
    formula: { C: 1, H: 4 },
    phase: PHASE_GAS,
    formationEnthalpy: -74600,
    cpA: 2220,
    cpB: 5.2,
  },
  { id: 'H2', formula: { H: 2 }, phase: PHASE_GAS, formationEnthalpy: 0, cpA: 14300 },
  { id: 'C2H4', formula: { C: 2, H: 4 }, phase: PHASE_GAS, formationEnthalpy: 52400, cpA: 1530 },
  { id: 'C2H6', formula: { C: 2, H: 6 }, phase: PHASE_GAS, formationEnthalpy: -84000, cpA: 1750 },
  { id: 'NH3', formula: { N: 1, H: 3 }, phase: PHASE_GAS, formationEnthalpy: -45900, cpA: 2190 },
  {
    id: 'HCN',
    formula: { H: 1, C: 1, N: 1 },
    phase: PHASE_GAS,
    formationEnthalpy: 135100,
    cpA: 1330,
  },
  { id: 'HCl', formula: { H: 1, Cl: 1 }, phase: PHASE_GAS, formationEnthalpy: -92310, cpA: 799 },
  { id: 'SO2', formula: { S: 1, O: 2 }, phase: PHASE_GAS, formationEnthalpy: -296840, cpA: 640 },
  { id: 'NO', formula: { N: 1, O: 1 }, phase: PHASE_GAS, formationEnthalpy: 91290, cpA: 995 },
  { id: 'NO2', formula: { N: 1, O: 2 }, phase: PHASE_GAS, formationEnthalpy: 33200, cpA: 805 },

  /* Condensed water. Ice sits one heat of fusion below liquid, which is where the plateau is. */
  {
    id: 'H2O(l)',
    formula: { H: 2, O: 1 },
    phase: PHASE_LIQUID,
    formationEnthalpy: -285830,
    cpA: 4182,
  },
  {
    id: 'H2O(s)',
    formula: { H: 2, O: 1 },
    phase: PHASE_SOLID,
    formationEnthalpy: -291840,
    cpA: 2108,
  },

  /* Carbon, in the three forms a fire makes. See the header on why all three are zero. */
  { id: 'C(graphite)', formula: { C: 1 }, phase: PHASE_SOLID, formationEnthalpy: 0, cpA: 709 },
  { id: 'C(char)', formula: { C: 1 }, phase: PHASE_SOLID, formationEnthalpy: 0, cpA: 1100 },
  { id: 'C(soot)', formula: { C: 1 }, phase: PHASE_SOLID, formationEnthalpy: 0, cpA: 850 },

  /* Wood, as its three polymers plus the resins. Each pyrolyses on its own kinetics in CH-3, which
     is why the smoke changes character as a log heats rather than arriving all at once. */
  {
    id: 'cellulose',
    formula: { C: 6, H: 10, O: 5 },
    phase: PHASE_SOLID,
    formationEnthalpy: -968957,
    cpA: 1340,
    cpB: 4.9,
    pseudo: true,
  },
  {
    id: 'hemicellulose',
    formula: { C: 5, H: 8, O: 4 },
    phase: PHASE_SOLID,
    formationEnthalpy: -997030,
    cpA: 1380,
    cpB: 4.9,
    pseudo: true,
  },
  {
    id: 'lignin',
    formula: { C: 9, H: 10, O: 3 },
    phase: PHASE_SOLID,
    formationEnthalpy: -982516,
    cpA: 1250,
    cpB: 4.0,
    pseudo: true,
  },
  {
    id: 'extractives',
    formula: { C: 10, H: 16 },
    phase: PHASE_SOLID,
    formationEnthalpy: -91030,
    cpA: 1700,
    pseudo: true,
  },

  /* The other biopolymers, and the two protein states cooking turns on. A denatured protein sits
     *above* its native form, because unfolding costs energy; gelatin sits below collagen plus the
     water it took up, because hydrolysing a peptide bond releases a little. */
  {
    id: 'starch',
    formula: { C: 6, H: 10, O: 5 },
    phase: PHASE_SOLID,
    formationEnthalpy: -952742,
    cpA: 1250,
    pseudo: true,
  },
  {
    id: 'chitin',
    formula: { C: 8, H: 13, N: 1, O: 5 },
    phase: PHASE_SOLID,
    formationEnthalpy: -1450080,
    cpA: 1300,
    pseudo: true,
  },
  {
    id: 'keratin',
    formula: { C: 4.6, H: 7.6, N: 1.3, O: 1.4, S: 0.13 },
    phase: PHASE_SOLID,
    formationEnthalpy: -479628,
    cpA: 1550,
    pseudo: true,
  },
  {
    id: 'collagen',
    formula: { C: 4.3, H: 7.1, N: 1.3, O: 1.5 },
    phase: PHASE_SOLID,
    formationEnthalpy: -484532,
    cpA: 1600,
    pseudo: true,
  },
  {
    id: 'protein',
    formula: { C: 4.4, H: 7.7, N: 1.2, O: 1.4, S: 0.04 },
    phase: PHASE_SOLID,
    formationEnthalpy: -427487,
    cpA: 1600,
    pseudo: true,
  },
  {
    id: 'protein(denatured)',
    formula: { C: 4.4, H: 7.7, N: 1.2, O: 1.4, S: 0.04 },
    phase: PHASE_SOLID,
    formationEnthalpy: -417487,
    cpA: 1600,
    pseudo: true,
  },
  {
    id: 'gelatin',
    formula: { C: 4.3, H: 9.1, N: 1.3, O: 2.5 },
    phase: PHASE_SOLID,
    formationEnthalpy: -780362,
    cpA: 1700,
    pseudo: true,
  },

  /* Small organics: the sugars that caramelise and the liquids that dissolve things. */
  {
    id: 'glucose',
    formula: { C: 6, H: 12, O: 6 },
    phase: PHASE_SOLID,
    formationEnthalpy: -1273300,
    cpA: 1220,
  },
  {
    id: 'fructose',
    formula: { C: 6, H: 12, O: 6 },
    phase: PHASE_SOLID,
    formationEnthalpy: -1265600,
    cpA: 1220,
  },
  {
    id: 'sucrose',
    formula: { C: 12, H: 22, O: 11 },
    phase: PHASE_SOLID,
    formationEnthalpy: -2226100,
    cpA: 1250,
  },
  {
    id: 'ethanol',
    formula: { C: 2, H: 6, O: 1 },
    phase: PHASE_LIQUID,
    formationEnthalpy: -277600,
    cpA: 2440,
  },
  {
    id: 'methanol',
    formula: { C: 1, H: 4, O: 1 },
    phase: PHASE_LIQUID,
    formationEnthalpy: -239200,
    cpA: 2530,
  },
  {
    id: 'acetic-acid',
    formula: { C: 2, H: 4, O: 2 },
    phase: PHASE_LIQUID,
    formationEnthalpy: -484300,
    cpA: 2050,
  },
  {
    id: 'glycerol',
    formula: { C: 3, H: 8, O: 3 },
    phase: PHASE_LIQUID,
    formationEnthalpy: -669600,
    cpA: 2430,
  },

  /* Lipids. Saturated is tristearin and unsaturated is triolein, which is the difference between a
     fat that is solid at room temperature and an oil that is not — a melting point rather than a
     reaction, so it lives on the substance in CH-1. */
  {
    id: 'triglyceride(saturated)',
    formula: { C: 57, H: 110, O: 6 },
    phase: PHASE_SOLID,
    formationEnthalpy: -2193700,
    cpA: 1900,
  },
  {
    id: 'triglyceride(unsaturated)',
    formula: { C: 57, H: 104, O: 6 },
    phase: PHASE_LIQUID,
    formationEnthalpy: -2005000,
    cpA: 2000,
  },
  {
    id: 'fatty-acid',
    formula: { C: 18, H: 36, O: 2 },
    phase: PHASE_SOLID,
    formationEnthalpy: -947700,
    cpA: 1600,
  },
  {
    id: 'wax',
    formula: { C: 25, H: 52 },
    phase: PHASE_SOLID,
    formationEnthalpy: -869199,
    cpA: 2100,
    pseudo: true,
  },

  /* Fuel surrogates. Petrol is octane and diesel is dodecane — real molecules standing in for a
     distillation cut, which is what a surrogate is. Kerosene has no integer formula at all. */
  {
    id: 'octane',
    formula: { C: 8, H: 18 },
    phase: PHASE_LIQUID,
    formationEnthalpy: -250100,
    cpA: 2230,
  },
  {
    id: 'diesel',
    formula: { C: 12, H: 26 },
    phase: PHASE_LIQUID,
    formationEnthalpy: -350900,
    cpA: 2210,
    pseudo: true,
  },
  {
    id: 'kerosene',
    formula: { C: 12, H: 23 },
    phase: PHASE_LIQUID,
    formationEnthalpy: -279166,
    cpA: 2010,
    pseudo: true,
  },
  {
    id: 'propane',
    formula: { C: 3, H: 8 },
    phase: PHASE_GAS,
    formationEnthalpy: -103800,
    cpA: 1670,
  },
  {
    id: 'butane',
    formula: { C: 4, H: 10 },
    phase: PHASE_GAS,
    formationEnthalpy: -125700,
    cpA: 1700,
  },

  /* Polymers, as repeat units. PVC carries the chlorine that becomes HCl in a fire and polyurethane
     carries the nitrogen that becomes HCN — which is why a burning sofa is the dangerous one, and
     it falls out of the formulas rather than out of a rule. */
  {
    id: 'polyethylene',
    formula: { C: 2, H: 4 },
    phase: PHASE_SOLID,
    formationEnthalpy: -54169,
    cpA: 2300,
    pseudo: true,
  },
  {
    id: 'polypropylene',
    formula: { C: 3, H: 6 },
    phase: PHASE_SOLID,
    formationEnthalpy: -102294,
    cpA: 1920,
    pseudo: true,
  },
  {
    id: 'PVC',
    formula: { C: 2, H: 3, Cl: 1 },
    phase: PHASE_SOLID,
    formationEnthalpy: -40232,
    cpA: 900,
    pseudo: true,
  },
  {
    id: 'polystyrene',
    formula: { C: 8, H: 8 },
    phase: PHASE_SOLID,
    formationEnthalpy: 72569,
    cpA: 1300,
    pseudo: true,
  },
  {
    id: 'PMMA',
    formula: { C: 5, H: 8, O: 2 },
    phase: PHASE_SOLID,
    formationEnthalpy: -487805,
    cpA: 1470,
    pseudo: true,
  },
  {
    id: 'polyurethane',
    formula: { C: 25, H: 42, N: 2, O: 6 },
    phase: PHASE_SOLID,
    formationEnthalpy: -3708086,
    cpA: 1800,
    pseudo: true,
  },

  /* Minerals. Gypsum is here for one reason: the two waters it loses at 100-150 C are an enormous
     latent-heat sink, which is *why* plasterboard is a fire barrier. Limestone is here for the
     other: calcination is endothermic and releases gas, which is why stone spalls in a fire. */
  {
    id: 'SiO2',
    formula: { Si: 1, O: 2 },
    phase: PHASE_SOLID,
    formationEnthalpy: -910700,
    cpA: 740,
  },
  {
    id: 'CaCO3',
    formula: { Ca: 1, C: 1, O: 3 },
    phase: PHASE_SOLID,
    formationEnthalpy: -1207600,
    cpA: 820,
  },
  { id: 'CaO', formula: { Ca: 1, O: 1 }, phase: PHASE_SOLID, formationEnthalpy: -634900, cpA: 750 },
  {
    id: 'gypsum',
    formula: { Ca: 1, S: 1, O: 6, H: 4 },
    phase: PHASE_SOLID,
    formationEnthalpy: -2022600,
    cpA: 1090,
  },
  {
    id: 'anhydrite',
    formula: { Ca: 1, S: 1, O: 4 },
    phase: PHASE_SOLID,
    formationEnthalpy: -1434500,
    cpA: 730,
  },
  {
    id: 'Al2O3',
    formula: { Al: 2, O: 3 },
    phase: PHASE_SOLID,
    formationEnthalpy: -1675700,
    cpA: 880,
  },
  {
    id: 'Fe2O3',
    formula: { Fe: 2, O: 3 },
    phase: PHASE_SOLID,
    formationEnthalpy: -824200,
    cpA: 650,
  },
  {
    id: 'Fe3O4',
    formula: { Fe: 3, O: 4 },
    phase: PHASE_SOLID,
    formationEnthalpy: -1118400,
    cpA: 620,
  },
  { id: 'MgO', formula: { Mg: 1, O: 1 }, phase: PHASE_SOLID, formationEnthalpy: -601600, cpA: 930 },
  { id: 'CuO', formula: { Cu: 1, O: 1 }, phase: PHASE_SOLID, formationEnthalpy: -157300, cpA: 530 },
  /* Ash is the one species with an arbitrary enthalpy, and it is arbitrary because nothing ever
     produces or consumes it: a substance holds its ash from the start and every reaction leaves it
     alone. Zero is therefore not a claim about ash, it is the absence of one. */
  {
    id: 'ash',
    formula: { Si: 0.4, Ca: 0.3, K: 0.15, Mg: 0.1, P: 0.05, O: 1.2 },
    phase: PHASE_SOLID,
    formationEnthalpy: 0,
    cpA: 800,
    pseudo: true,
  },

  /* Metals. Magnesium is here because it burns, which most metals do not at any temperature a fire
     reaches, and iron because it rusts, which is the slowest reaction in the whole model. */
  { id: 'Fe', formula: { Fe: 1 }, phase: PHASE_SOLID, formationEnthalpy: 0, cpA: 449 },
  { id: 'Al', formula: { Al: 1 }, phase: PHASE_SOLID, formationEnthalpy: 0, cpA: 897 },
  { id: 'Cu', formula: { Cu: 1 }, phase: PHASE_SOLID, formationEnthalpy: 0, cpA: 385 },
  { id: 'Mg', formula: { Mg: 1 }, phase: PHASE_SOLID, formationEnthalpy: 0, cpA: 1023 },
];

/** Register the whole standard set into a registry, in order. */
export function registerStandardSpecies(registry: SpeciesRegistry): void {
  for (const definition of STANDARD_SPECIES) registry.register(definition);
}
