import { describe, expect, it } from 'vitest';
import { ATOMIC_MASS, ELEMENTS, ELEMENT_COUNT, elementIndex } from './elements.ts';

describe('the element set', () => {
  it('is closed at fifteen', () => {
    expect(ELEMENTS.length).toBe(15);
    expect(ELEMENT_COUNT).toBe(ELEMENTS.length);
  });

  it('resolves a symbol to its index', () => {
    expect(elementIndex('C')).toBe(0);
    expect(elementIndex('H')).toBe(1);
    expect(elementIndex('O')).toBe(2);
  });

  it('answers -1 for an element it does not carry', () => {
    expect(elementIndex('Xx')).toBe(-1);
    expect(elementIndex('U')).toBe(-1);
  });

  it('is case sensitive, because Co is cobalt and CO is not an element', () => {
    expect(elementIndex('c')).toBe(-1);
    expect(elementIndex('CL')).toBe(-1);
  });

  it('carries the conventional atomic weight of every element, in g/mol', () => {
    expect(ATOMIC_MASS.length).toBe(ELEMENT_COUNT);
    expect(ATOMIC_MASS[elementIndex('C')]).toBeCloseTo(12.011, 3);
    expect(ATOMIC_MASS[elementIndex('H')]).toBeCloseTo(1.008, 3);
    expect(ATOMIC_MASS[elementIndex('O')]).toBeCloseTo(15.999, 3);
    expect(ATOMIC_MASS[elementIndex('Fe')]).toBeCloseTo(55.845, 3);
  });
});
