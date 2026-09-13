import { beforeEach, describe, expect, it } from 'vitest';
import { ELEMENT_COUNT, elementIndex } from './element/elements.ts';
import { PHASE_GAS, PHASE_LIQUID } from './species/species.ts';
import { SpeciesRegistry } from './species/registry.ts';
import { elementTotals } from './conservation.ts';
import { maxElementDrift } from './testing/drift.ts';

const C = elementIndex('C');
const H = elementIndex('H');
const O = elementIndex('O');

describe('elementTotals', () => {
  let registry: SpeciesRegistry;
  let methane: number;
  let oxygen: number;
  let carbonDioxide: number;
  let steam: number;
  let water: number;

  beforeEach(() => {
    registry = new SpeciesRegistry();
    methane = registry.register({
      id: 'CH4',
      formula: { C: 1, H: 4 },
      phase: PHASE_GAS,
      formationEnthalpy: -74600,
      cpA: 2220,
    });
    oxygen = registry.register({
      id: 'O2',
      formula: { O: 2 },
      phase: PHASE_GAS,
      formationEnthalpy: 0,
      cpA: 918,
    });
    carbonDioxide = registry.register({
      id: 'CO2',
      formula: { C: 1, O: 2 },
      phase: PHASE_GAS,
      formationEnthalpy: -393510,
      cpA: 844,
    });
    steam = registry.register({
      id: 'H2O(g)',
      formula: { H: 2, O: 1 },
      phase: PHASE_GAS,
      formationEnthalpy: -241826,
      cpA: 1996,
    });
    water = registry.register({
      id: 'H2O(l)',
      formula: { H: 2, O: 1 },
      phase: PHASE_LIQUID,
      formationEnthalpy: -285830,
      cpA: 4182,
    });
  });

  it('turns kilograms of a species into moles of its elements', () => {
    // H2O is 18.015 g/mol, so a kilogram is 55.509298 mol: twice that in hydrogen, once in oxygen.
    const mass = new Float64Array(registry.count);
    mass[water] = 1;
    const out = new Float64Array(ELEMENT_COUNT);
    elementTotals(registry, mass, out);

    expect(out[H]).toBeCloseTo(111.018596, 5);
    expect(out[O]).toBeCloseTo(55.509298, 5);
    expect(out[C]).toBe(0);
  });

  it('conserves every element across a combustion, which is the shape of every later assertion', () => {
    // CH4 + 2 O2 -> CO2 + 2 H2O, one mole of each stoichiometric unit, weighed in kilograms.
    const before = new Float64Array(registry.count);
    before[methane] = 0.016043;
    before[oxygen] = 2 * 0.031998;

    const after = new Float64Array(registry.count);
    after[carbonDioxide] = 0.044009;
    after[steam] = 2 * 0.018015;

    const totalsBefore = new Float64Array(ELEMENT_COUNT);
    const totalsAfter = new Float64Array(ELEMENT_COUNT);
    elementTotals(registry, before, totalsBefore);
    elementTotals(registry, after, totalsAfter);

    expect(totalsBefore[C]).toBeCloseTo(1, 9);
    expect(totalsBefore[H]).toBeCloseTo(4, 9);
    expect(totalsBefore[O]).toBeCloseTo(4, 9);
    expect(maxElementDrift(totalsBefore, totalsAfter)).toBeLessThan(1e-9);
  });

  it('overwrites the target rather than accumulating into it', () => {
    const mass = new Float64Array(registry.count);
    mass[water] = 1;
    const out = new Float64Array(ELEMENT_COUNT);
    elementTotals(registry, mass, out);
    const once = out[O] as number;
    elementTotals(registry, mass, out);
    expect(out[O]).toBeCloseTo(once, 12);
  });

  it('ignores a species with no mass, so a sparse world costs the species it holds', () => {
    const mass = new Float64Array(registry.count);
    mass[methane] = 0.016043;
    const out = new Float64Array(ELEMENT_COUNT);
    elementTotals(registry, mass, out);
    expect(out[C]).toBeCloseTo(1, 9);
    expect(out[O]).toBe(0);
  });

  it('refuses a mass vector that is not the width of the registry', () => {
    const out = new Float64Array(ELEMENT_COUNT);
    expect(() => elementTotals(registry, new Float64Array(2), out)).toThrow(/2/);
  });

  it('allocates nothing', async () => {
    /*
     * Counted by garbage collections, never by `heapUsed` — which reads the live heap, so garbage
     * made and dropped does not move it. The control allocates one object per iteration; the
     * assertion is the separation between the two, not either number on its own.
     */
    const mass = new Float64Array(registry.count);
    mass[methane] = 0.016043;
    mass[oxygen] = 0.063996;
    const out = new Float64Array(ELEMENT_COUNT);

    const collections = async (work: () => void): Promise<number> => {
      let n = 0;
      const observer = new PerformanceObserver((list) => {
        n += list.getEntries().length;
      });
      observer.observe({ entryTypes: ['gc'] });
      work();
      await new Promise((resolve) => setTimeout(resolve, 50));
      observer.disconnect();
      return n;
    };

    let sink: unknown;
    const ROUNDS = 200000;
    /* The control first, so it collects whatever earlier work left in the young generation. */
    const noisy = await collections(() => {
      for (let i = 0; i < ROUNDS * 10; i++) sink = { at: i, of: [i] };
    });
    const quiet = await collections(() => {
      for (let i = 0; i < ROUNDS; i++) elementTotals(registry, mass, out);
    });

    expect(noisy, 'the control must separate the two states').toBeGreaterThan(3);
    expect(quiet).toBeLessThan(noisy / 4);
    expect(sink).not.toBe(undefined);
  });
});

describe('maxElementDrift', () => {
  it('is zero for two identical vectors', () => {
    const a = new Float64Array(ELEMENT_COUNT);
    a[C] = 5;
    const b = Float64Array.from(a);
    expect(maxElementDrift(a, b)).toBe(0);
  });

  it('is relative, so a large element is not held to an absolute tolerance', () => {
    const a = new Float64Array(ELEMENT_COUNT);
    const b = new Float64Array(ELEMENT_COUNT);
    a[C] = 1e6;
    b[C] = 1e6 + 1;
    expect(maxElementDrift(a, b)).toBeCloseTo(1e-6, 9);
  });

  it('reports an absolute difference where both sides are near zero', () => {
    // A relative measure divides by nothing when an element is absent from both, and an element
    // that appears from nowhere must not be reported as no drift at all.
    const a = new Float64Array(ELEMENT_COUNT);
    const b = new Float64Array(ELEMENT_COUNT);
    b[H] = 1e-12;
    expect(maxElementDrift(a, b)).toBeCloseTo(1e-12, 18);
  });

  it('refuses two vectors of different widths', () => {
    expect(() => maxElementDrift(new Float64Array(ELEMENT_COUNT), new Float64Array(2))).toThrow(
      /2/,
    );
  });
});
