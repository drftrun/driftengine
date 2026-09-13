import { describe, expect, it } from 'vitest';
import { ELEMENT_COUNT, elementIndex } from './elements.ts';
import { SpeciesElementMatrix } from './matrix.ts';

describe('SpeciesElementMatrix', () => {
  it('starts empty', () => {
    expect(new SpeciesElementMatrix().rows).toBe(0);
  });

  it('appends rows in order and reads back what was written', () => {
    const matrix = new SpeciesElementMatrix();
    const glucose = matrix.addRow();
    expect(glucose).toBe(0);
    matrix.set(glucose, elementIndex('C'), 6);
    matrix.set(glucose, elementIndex('H'), 12);
    matrix.set(glucose, elementIndex('O'), 6);

    expect(matrix.rows).toBe(1);
    expect(matrix.at(glucose, elementIndex('C'))).toBe(6);
    expect(matrix.at(glucose, elementIndex('H'))).toBe(12);
    expect(matrix.at(glucose, elementIndex('O'))).toBe(6);
  });

  it('leaves an element the row never mentioned at zero', () => {
    const matrix = new SpeciesElementMatrix();
    const row = matrix.addRow();
    matrix.set(row, elementIndex('C'), 1);
    expect(matrix.at(row, elementIndex('Fe'))).toBe(0);
  });

  it('keeps a fractional subscript exactly as written', () => {
    const matrix = new SpeciesElementMatrix();
    const row = matrix.addRow();
    matrix.set(row, elementIndex('S'), 0.04);
    expect(matrix.at(row, elementIndex('S'))).toBe(0.04);
  });

  it('grows past its initial capacity without losing a value', () => {
    const matrix = new SpeciesElementMatrix();
    for (let i = 0; i < 200; i++) {
      const row = matrix.addRow();
      matrix.set(row, elementIndex('C'), i);
    }
    expect(matrix.rows).toBe(200);
    for (let i = 0; i < 200; i++) {
      expect(matrix.at(i, elementIndex('C'))).toBe(i);
    }
  });

  it('hands out a row as a view of fifteen, not a copy', () => {
    const matrix = new SpeciesElementMatrix();
    const row = matrix.addRow();
    const view = matrix.rowView(row);
    expect(view.length).toBe(ELEMENT_COUNT);
    matrix.set(row, elementIndex('N'), 3);
    expect(view[elementIndex('N')]).toBe(3);
  });

  it('reduces a scaled row into a caller-owned vector, adding rather than replacing', () => {
    // The reduction every conservation check is built from. It adds, so a caller sums many species
    // into one vector; and it takes the target, so nothing is allocated per species.
    const matrix = new SpeciesElementMatrix();
    const methane = matrix.addRow();
    matrix.set(methane, elementIndex('C'), 1);
    matrix.set(methane, elementIndex('H'), 4);
    const oxygen = matrix.addRow();
    matrix.set(oxygen, elementIndex('O'), 2);

    const out = new Float64Array(ELEMENT_COUNT);
    matrix.addScaledRow(methane, 3, out);
    matrix.addScaledRow(oxygen, 6, out);

    expect(out[elementIndex('C')]).toBe(3);
    expect(out[elementIndex('H')]).toBe(12);
    expect(out[elementIndex('O')]).toBe(12);
    expect(out[elementIndex('Fe')]).toBe(0);
  });

  it('refuses a target that is not the width of the element set', () => {
    const matrix = new SpeciesElementMatrix();
    const row = matrix.addRow();
    expect(() => matrix.addScaledRow(row, 1, new Float64Array(3))).toThrow(/3/);
  });

  it('refuses a row or an element outside the matrix, naming the index', () => {
    const matrix = new SpeciesElementMatrix();
    matrix.addRow();
    expect(() => matrix.at(1, 0)).toThrow(/1/);
    expect(() => matrix.at(0, ELEMENT_COUNT)).toThrow(/15/);
    expect(() => matrix.set(0, -1, 1)).toThrow(/-1/);
  });
});
