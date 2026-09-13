/**
 * The closed element set, and the atomic weights every molar mass is derived from.
 *
 * Fifteen elements, and the set is closed deliberately rather than for want of typing. Every
 * species this package can hold is built from these, so the species-by-element matrix has a fixed
 * width, `elementTotals` reduces into a fixed-length array, and the conservation assertion that
 * `§6` of the design calls the most valuable test in the track is a comparison of two vectors of
 * fifteen doubles rather than a walk over a dictionary.
 *
 * **Adding a sixteenth is a deliberate act with a cost**: every `Float64Array` sized by
 * `ELEMENT_COUNT` grows, and a stored conservation baseline taken before the change no longer
 * compares. That is the right amount of friction for a decision that widens the model's universe.
 *
 * The values are IUPAC conventional atomic weights in g/mol. They are *conventional* rather than
 * the interval form the tables now publish, because a molar mass is arithmetic here and an interval
 * would make every derived mass an interval too — which is honest and useless.
 */

/**
 * The elements, in the order the design lists them: organic first, then the rest.
 *
 * The order is the wire format of every matrix row and every totals vector in this package, so it
 * is frozen. Reordering it invalidates any baseline a consumer has stored, in exactly the way
 * `AGENTS.md` says the RNG sequence is frozen.
 */
export const ELEMENTS = [
  'C',
  'H',
  'O',
  'N',
  'S',
  'Cl',
  'Si',
  'Ca',
  'Fe',
  'Al',
  'Mg',
  'Cu',
  'Na',
  'K',
  'P',
] as const;

export type ElementSymbol = (typeof ELEMENTS)[number];

export const ELEMENT_COUNT = ELEMENTS.length;

/** Conventional atomic weights, g/mol, indexed the way `ELEMENTS` is. */
export const ATOMIC_MASS = new Float64Array([
  12.011, // C
  1.008, // H
  15.999, // O
  14.007, // N
  32.06, // S
  35.45, // Cl
  28.085, // Si
  40.078, // Ca
  55.845, // Fe
  26.9815384, // Al
  24.305, // Mg
  63.546, // Cu
  22.98976928, // Na
  39.0983, // K
  30.973761998, // P
]);

/*
 * A map rather than an `indexOf`, and case-sensitive rather than folded.
 *
 * Case is load-bearing in chemical notation: `Co` is cobalt and `CO` is carbon monoxide, so a
 * lookup that folded case would accept a molecule where an element was wanted and silently produce
 * a molar mass for the wrong thing. Nothing here runs in a frame, so the map is for legibility
 * rather than speed.
 */
const INDEX = new Map<string, number>(ELEMENTS.map((symbol, at) => [symbol, at]));

/** The index of an element symbol, or `-1` for anything this package does not carry. */
export function elementIndex(symbol: string): number {
  return INDEX.get(symbol) ?? -1;
}
