/**
 * Moles of each element held by a set of species masses.
 *
 * **This is the law `§6` of the design calls the most valuable test in the track**, and it is one
 * reduction: kilograms of a species become moles through its derived molar mass, and moles of a
 * species become moles of its elements through the species-by-element matrix.
 *
 * A chemistry model that does not conserve elements invents or destroys matter, and every symptom
 * of that is subtle — fires that will not go out, mass that quietly grows, smoke that never clears.
 * One assertion catches all of them, which is why this function exists before there is anything to
 * conserve through.
 *
 * Writes into a caller-owned vector and allocates nothing, so it is affordable on a tick rather
 * than only in a test.
 */
import { ELEMENT_COUNT } from './element/elements.ts';
import type { SpeciesRegistry } from './species/registry.ts';

/**
 * Reduce kilograms per species into moles per element.
 *
 * `out` is **overwritten**, not accumulated into, so a caller may hold one vector for the life of a
 * world and re-derive totals every tick without clearing it first. `speciesMass` is indexed by
 * species, so it is the registry's width; a species with no mass costs one comparison.
 */
export function elementTotals(
  registry: SpeciesRegistry,
  speciesMass: Float64Array,
  out: Float64Array,
): void {
  if (speciesMass.length !== registry.count) {
    throw new Error(`a mass vector is ${registry.count} wide, not ${speciesMass.length}`);
  }
  if (out.length !== ELEMENT_COUNT) {
    throw new Error(`a totals vector is ${ELEMENT_COUNT} wide, not ${out.length}`);
  }

  out.fill(0);
  for (let species = 0; species < speciesMass.length; species++) {
    const kilograms = speciesMass[species] as number;
    if (kilograms === 0) continue;
    registry.elements.addScaledRow(species, kilograms / registry.molarMass(species), out);
  }
}
