/**
 * What a material is made of: mass fractions over species, summing to one.
 *
 * **Mass fractions rather than moles**, and it is the open question `§30` of the design marks
 * first. Mass is what a consumer thinks in, what a density multiplies, and what a parcel stores;
 * moles are what stoichiometry wants. The conversion is one multiply by the derived molar mass and
 * it happens at the reaction boundary, which is the one place that needs it.
 *
 * Two parallel arrays rather than a map, because every consumer of a composition walks it in a
 * loop and a map's iteration allocates.
 */
import type { SpeciesRegistry } from '../species/registry.ts';

/**
 * How far a hand-written composition may be from summing to one.
 *
 * Generous enough for six fractions typed to three decimals, tight enough that a transposed digit
 * is a refusal rather than a material that quietly loses half a percent of its mass on every
 * conservation check.
 */
export const SUM_TOLERANCE = 1e-6;

export interface Composition {
  /** Species indices, ascending. */
  readonly species: Int32Array;
  /** Mass fraction of each, parallel to `species`. */
  readonly fraction: Float64Array;
}

/**
 * A composition from species ids and mass fractions.
 *
 * Fails fast on anything wrong, per `AGENTS.md`: an unknown id, a fraction that is negative or not
 * a number, a sum that is not one. Each names the offending value, because "invalid composition" in
 * a stack trace is a sentence somebody has to reproduce to act on.
 */
export function massFractions(
  registry: SpeciesRegistry,
  entries: Readonly<Record<string, number>>,
): Composition {
  const ids = Object.keys(entries);
  if (ids.length === 0) {
    throw new Error('a composition may not be empty');
  }

  const pairs: { species: number; fraction: number }[] = [];
  let sum = 0;
  for (const id of ids) {
    const species = registry.indexOf(id);
    if (species < 0) {
      throw new Error(`composition names "${id}", which is not a registered species`);
    }
    const fraction = entries[id] as number;
    if (!Number.isFinite(fraction) || fraction < 0) {
      throw new Error(`composition gives "${id}" a mass fraction of ${fraction}`);
    }
    sum += fraction;
    pairs.push({ species, fraction });
  }

  if (Math.abs(sum - 1) > SUM_TOLERANCE) {
    throw new Error(`composition sums to ${sum} rather than 1`);
  }

  /*
   * Sorted by species index, not by the order the author typed.
   *
   * Adding doubles is not associative, so two spellings of the same material would reduce to
   * different last bits — and a conservation check is exactly where a last bit becomes a failing
   * assertion nobody can explain. Sorting here makes the storage canonical, once, at init.
   */
  pairs.sort((a, b) => a.species - b.species);

  const species = new Int32Array(pairs.length);
  const fraction = new Float64Array(pairs.length);
  for (let i = 0; i < pairs.length; i++) {
    species[i] = (pairs[i] as { species: number }).species;
    fraction[i] = (pairs[i] as { fraction: number }).fraction;
  }
  return { species, fraction };
}
