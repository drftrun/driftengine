/**
 * What a species is: a formula, a phase, a formation enthalpy and a heat capacity.
 *
 * A *species* is a chemical entity the model tracks an amount of. Most are real molecules; some are
 * **pseudo-species** — a lumped repeat unit like cellulose's `C6H10O5`, or an average composition
 * like a protein residue — and those are marked, because a reader needs to know which numbers are
 * exact and which are a mean over a population.
 *
 * **No molar mass field, and that is the point.** A species carries a formula and the mass is
 * derived from it against the atomic-weight table. A typed-in mass that disagreed with its own
 * formula would be a stoichiometry error with no symptom: every reaction over the species would
 * conserve moles correctly and lose kilograms quietly.
 */

export const PHASE_SOLID = 0;
export const PHASE_LIQUID = 1;
export const PHASE_GAS = 2;

export type Phase = typeof PHASE_SOLID | typeof PHASE_LIQUID | typeof PHASE_GAS;

export interface SpeciesDefinition {
  /** Unique, and it is what a substance and a reaction name. Phase is part of it: `H2O(l)`. */
  readonly id: string;
  /**
   * Moles of each element per mole of species, keyed by symbol.
   *
   * Fractional subscripts are allowed and are not a compromise: an average protein residue is
   * `C4.4H7.7N1.2O1.4S0.04`, and rounding those to integers breaks element balance by percent-scale
   * amounts across a whole body.
   */
  readonly formula: Readonly<Record<string, number>>;
  readonly phase: Phase;
  /**
   * Standard enthalpy of formation at 298.15 K, J/mol.
   *
   * Every reaction's `ΔH` is derived from these by Hess's law rather than typed in, so a wrong
   * value here is wrong in every reaction that touches the species at once — which is a bug that
   * can be found, unlike a single reaction quietly disagreeing with its own species.
   */
  readonly formationEnthalpy: number;
  /** Specific heat at 298.15 K, J/(kg·K). */
  readonly cpA: number;
  /** Linear coefficient, J/(kg·K²). Absent means a constant heat capacity. */
  readonly cpB?: number;
  /** A lumped repeat unit or an average composition rather than a real molecule. */
  readonly pseudo?: boolean;
}

/** The temperature every standard state in this package is anchored at, K. */
export const STANDARD_TEMPERATURE = 298.15;

/** The pressure every standard state in this package is anchored at, Pa. */
export const STANDARD_PRESSURE = 101325;
