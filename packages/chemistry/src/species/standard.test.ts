import { describe, expect, it } from 'vitest';
import { elementIndex } from '../element/elements.ts';
import { PHASE_GAS, PHASE_LIQUID, PHASE_SOLID } from './species.ts';
import { SpeciesRegistry } from './registry.ts';
import { STANDARD_SPECIES, registerStandardSpecies } from './standard.ts';

const C = elementIndex('C');
const H = elementIndex('H');
const O = elementIndex('O');
const N = elementIndex('N');
const S = elementIndex('S');
const CL = elementIndex('Cl');

/**
 * The higher heating value a species' stored formation enthalpy implies, MJ/kg.
 *
 * Hess's law over the element row: carbon to CO2, sulphur to SO2, chlorine to HCl, nitrogen to N2,
 * and whatever hydrogen the chlorine did not take to liquid water. Oxygen never appears, because
 * `O2`'s formation enthalpy is zero by the definition of a standard state.
 *
 * Written here rather than in the package because a reaction network is CH-3. What it checks is
 * that the stored numbers agree with the measured world before anything reads them.
 */
function higherHeatingValue(registry: SpeciesRegistry, id: string): number {
  const species = registry.indexOf(id);
  expect(species, `${id} is not registered`).toBeGreaterThanOrEqual(0);
  const at = (element: number): number => registry.elements.at(species, element);
  const hcl = at(CL);
  const water = (at(H) - hcl) / 2;
  const products = at(C) * -393510 + water * -285830 + hcl * -92310 + at(S) * -296840;
  const combustion = products - registry.formationEnthalpyOf(species);
  return -combustion / registry.molarMass(species) / 1e6;
}

describe('the standard species set', () => {
  it('registers in full into a fresh registry', () => {
    const registry = new SpeciesRegistry();
    expect(() => registerStandardSpecies(registry)).not.toThrow();
    expect(registry.count).toBe(STANDARD_SPECIES.length);
    expect(registry.count).toBeGreaterThanOrEqual(60);
  });

  it('names every species once', () => {
    const ids = new Set(STANDARD_SPECIES.map((s) => s.id));
    expect(ids.size).toBe(STANDARD_SPECIES.length);
  });

  it('derives the molar masses a chemist would look up', () => {
    const registry = new SpeciesRegistry();
    registerStandardSpecies(registry);
    expect(registry.molarMass(registry.indexOf('CO2'))).toBeCloseTo(0.044009, 6);
    expect(registry.molarMass(registry.indexOf('CH4'))).toBeCloseTo(0.016043, 6);
    expect(registry.molarMass(registry.indexOf('H2O(l)'))).toBeCloseTo(0.018015, 6);
    expect(registry.molarMass(registry.indexOf('glucose'))).toBeCloseTo(0.180156, 6);
    expect(registry.molarMass(registry.indexOf('CaCO3'))).toBeCloseTo(0.100086, 6);
    /* 172.164 rather than the 172.17 a handbook prints: the difference is this table's oxygen at
       15.999 against the 15.9994 the handbook rounded from, over six oxygens. Asserted at the
       derived value, because that is the number every stoichiometry in the package will use. */
    expect(registry.molarMass(registry.indexOf('gypsum'))).toBeCloseTo(0.172164, 6);
  });

  it('gives every element in its standard state a formation enthalpy of zero', () => {
    const registry = new SpeciesRegistry();
    registerStandardSpecies(registry);
    for (const id of ['O2', 'N2', 'H2', 'C(graphite)', 'Fe', 'Al', 'Cu', 'Mg']) {
      expect(registry.formationEnthalpyOf(registry.indexOf(id)), id).toBe(0);
    }
  });

  it('reproduces published heating values through Hess’s law', () => {
    /*
     * The load-bearing test of this whole table. A formation enthalpy that disagrees with the
     * measured heat of combustion of its own species is a silent energy error in every reaction
     * that species ever takes part in — and CH-3 derives every reaction's enthalpy from exactly
     * these numbers, so a wrong one here is wrong everywhere at once rather than in one place.
     *
     * Two percent, which is inside the spread of the published values themselves.
     */
    const registry = new SpeciesRegistry();
    registerStandardSpecies(registry);
    const published: readonly (readonly [string, number])[] = [
      ['H2', 141.8],
      ['CH4', 55.5],
      ['CO', 10.1],
      ['propane', 50.4],
      ['octane', 47.9],
      ['ethanol', 29.7],
      ['methanol', 22.7],
      ['glucose', 15.6],
      ['sucrose', 16.5],
      ['cellulose', 17.4],
      ['hemicellulose', 16.0],
      ['lignin', 24.0],
      ['starch', 17.5],
      ['triglyceride(saturated)', 40.3],
      ['polyethylene', 46.5],
      ['polystyrene', 41.9],
      ['PVC', 18.0],
      ['C(char)', 32.8],
    ];
    for (const [id, expected] of published) {
      const measured = higherHeatingValue(registry, id);
      expect(
        Math.abs(measured - expected) / expected,
        `${id}: ${measured} against ${expected}`,
      ).toBeLessThan(0.02);
    }
  });

  it('marks a lumped repeat unit or an average composition as a pseudo-species', () => {
    const registry = new SpeciesRegistry();
    registerStandardSpecies(registry);
    for (const id of ['cellulose', 'lignin', 'protein', 'polyethylene', 'ash', 'diesel']) {
      expect(registry.isPseudo(registry.indexOf(id)), id).toBe(true);
    }
    for (const id of ['CO2', 'H2O(l)', 'glucose', 'Fe', 'octane']) {
      expect(registry.isPseudo(registry.indexOf(id)), id).toBe(false);
    }
  });

  it('phases the species the way the world does', () => {
    const registry = new SpeciesRegistry();
    registerStandardSpecies(registry);
    expect(registry.phaseOf(registry.indexOf('O2'))).toBe(PHASE_GAS);
    expect(registry.phaseOf(registry.indexOf('H2O(l)'))).toBe(PHASE_LIQUID);
    expect(registry.phaseOf(registry.indexOf('H2O(s)'))).toBe(PHASE_SOLID);
    expect(registry.phaseOf(registry.indexOf('H2O(g)'))).toBe(PHASE_GAS);
    expect(registry.phaseOf(registry.indexOf('ethanol'))).toBe(PHASE_LIQUID);
    expect(registry.phaseOf(registry.indexOf('Fe'))).toBe(PHASE_SOLID);
  });

  it('holds a species from each of the groups the design names', () => {
    const ids = new Set(STANDARD_SPECIES.map((s) => s.id));
    for (const id of [
      'O2', // atmospheric
      'CO', // combustion gas
      'H2O(s)', // condensed water
      'C(soot)', // carbon
      'cellulose', // wood polymer
      'chitin', // other biopolymer
      'sucrose', // small organic
      'triglyceride(unsaturated)', // lipid
      'gelatin', // protein
      'diesel', // fuel surrogate
      'PVC', // polymer
      'gypsum', // mineral
      'Mg', // metal
    ]) {
      expect(ids.has(id), id).toBe(true);
    }
  });

  it('carries a hydrolysis that balances: collagen plus water is gelatin', () => {
    /*
     * The one relation in this table that two species have to agree about, and it is here because
     * §8.7 of the design turns on it: collagen becoming gelatin is what slow cooking is. If the
     * formulas do not balance, CH-3 refuses the reaction at registration and the cooking half of
     * the design is unreachable — so it is checked where the numbers are written.
     */
    const registry = new SpeciesRegistry();
    registerStandardSpecies(registry);
    const collagen = registry.indexOf('collagen');
    const gelatin = registry.indexOf('gelatin');
    const water = registry.indexOf('H2O(l)');
    for (const element of [C, H, O, N, S]) {
      expect(
        registry.elements.at(collagen, element) + registry.elements.at(water, element),
        `element ${element}`,
      ).toBeCloseTo(registry.elements.at(gelatin, element), 9);
    }
    /* Hydrolysing a peptide bond is mildly exothermic, so gelatin sits below its reactants. */
    const heat =
      registry.formationEnthalpyOf(gelatin) -
      registry.formationEnthalpyOf(collagen) -
      registry.formationEnthalpyOf(water);
    expect(heat).toBeLessThan(0);
    expect(heat).toBeGreaterThan(-50000);
  });

  it('carries a denaturation that costs energy rather than releasing it', () => {
    const registry = new SpeciesRegistry();
    registerStandardSpecies(registry);
    const native = registry.formationEnthalpyOf(registry.indexOf('protein'));
    const denatured = registry.formationEnthalpyOf(registry.indexOf('protein(denatured)'));
    expect(denatured).toBeGreaterThan(native);
  });
});
