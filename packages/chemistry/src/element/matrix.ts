/**
 * Moles of each element per mole of each species, as one growable table.
 *
 * This is the law `§6` of the design rests on. A reaction balances when the sum of its reactants'
 * rows equals the sum of its products'; a world conserves matter when the sum of every parcel's
 * composition through this table is constant. Both are one reduction over one `Float64Array`, and
 * that is only true because `ELEMENT_COUNT` is fixed and the storage is dense.
 *
 * **Dense rather than sparse, and it is not close.** Sixty species over fifteen elements is 900
 * doubles, or 7.2 KB. A sparse structure would save perhaps two thirds of that and cost an
 * indirection in the innermost loop of every conservation check. The dense table is smaller than
 * one texture tile.
 *
 * Row-major, species-major: a species' fifteen elements are adjacent, because every consumer of
 * this table walks one species at a time.
 */
import { ELEMENT_COUNT } from './elements.ts';

/** Rows the table holds before its first growth. Doubles from here. */
const INITIAL_ROWS = 64;

export class SpeciesElementMatrix {
  private store = new Float64Array(INITIAL_ROWS * ELEMENT_COUNT);
  private used = 0;

  get rows(): number {
    return this.used;
  }

  /** Append a zeroed row and return its index. */
  addRow(): number {
    if ((this.used + 1) * ELEMENT_COUNT > this.store.length) {
      const grown = new Float64Array(this.store.length * 2);
      grown.set(this.store);
      this.store = grown;
    }
    return this.used++;
  }

  set(row: number, element: number, moles: number): void {
    this.check(row, element);
    this.store[row * ELEMENT_COUNT + element] = moles;
  }

  at(row: number, element: number): number {
    this.check(row, element);
    return this.store[row * ELEMENT_COUNT + element] as number;
  }

  /**
   * A row as a view of fifteen, sharing storage rather than copying.
   *
   * **A view is invalidated by a later `addRow` that grows the table**, because growth reallocates.
   * Every caller in this package takes a view inside a loop that registers nothing, which is the
   * only safe pattern and is why this is not handed out as a promise.
   */
  rowView(row: number): Float64Array {
    this.check(row, 0);
    return this.store.subarray(row * ELEMENT_COUNT, (row + 1) * ELEMENT_COUNT);
  }

  /**
   * `out[e] += scale * this[row][e]`, for all fifteen. Allocates nothing.
   *
   * The primitive every conservation check is built from, and it exists rather than a loop over
   * `at` for one reason: `rowView` would be the natural way to write that loop and `subarray`
   * allocates a view object per call, which is an allocation per species per tick. It adds rather
   * than replaces so a caller sums a whole world into one vector without a second accumulator.
   */
  addScaledRow(row: number, scale: number, out: Float64Array): void {
    this.check(row, 0);
    if (out.length !== ELEMENT_COUNT) {
      throw new Error(`a totals vector is ${ELEMENT_COUNT} wide, not ${out.length}`);
    }
    const base = row * ELEMENT_COUNT;
    for (let e = 0; e < ELEMENT_COUNT; e++) {
      out[e] = (out[e] as number) + scale * (this.store[base + e] as number);
    }
  }

  private check(row: number, element: number): void {
    if (!Number.isInteger(row) || row < 0 || row >= this.used) {
      throw new Error(`species row ${row} is outside a matrix of ${this.used}`);
    }
    if (!Number.isInteger(element) || element < 0 || element >= ELEMENT_COUNT) {
      throw new Error(`element ${element} is outside the set of ${ELEMENT_COUNT}`);
    }
  }
}
