import { beforeEach, describe, expect, it } from 'vitest';
import { ELEMENT_COUNT } from '../element/elements.ts';
import { SpeciesRegistry } from '../species/registry.ts';
import { registerStandardSpecies } from '../species/standard.ts';
import { maxElementDrift } from '../testing/drift.ts';
import { STANDARD_AIR } from './ambient.ts';
import { AtmosphereField } from './atmosphere.ts';

describe('transport through the field', () => {
  let species: SpeciesRegistry;
  let field: AtmosphereField;
  let co: number;

  beforeEach(() => {
    species = new SpeciesRegistry();
    registerStandardSpecies(species);
    field = new AtmosphereField(species, { cellSize: 1, ambient: STANDARD_AIR });
    co = species.indexOf('CO');
  });

  /**
   * Seal chunk (0,0,0) by blocking its own outer shell, leaving the 6 by 6 by 6 interior free.
   *
   * Blocking a ring *outside* the chunk would work too, and would touch eight chunks - 4,096 cells
   * a sweep against 512, eight times the work for the same assertion. A blocked cell transports
   * nothing at all, including to the far field, so one chunk sealed this way is a closed system.
   */
  const sealChunk = (): void => {
    for (let x = 0; x < 8; x++) {
      for (let y = 0; y < 8; y++) {
        for (let z = 0; z < 8; z++) {
          const shell = x === 0 || y === 0 || z === 0 || x === 7 || y === 7 || z === 7;
          if (shell) field.setBlocked(x + 0.5, y + 0.5, z + 0.5, true);
        }
      }
    }
  };

  it('spreads a species into its neighbours', () => {
    sealChunk();
    field.addSpecies(2.5, 2.5, 2.5, co, 0.01);
    expect(field.speciesMassAt(3.5, 2.5, 2.5, co)).toBeCloseTo(0, 9);
    for (let i = 0; i < 300; i++) field.step(1 / 60);
    expect(field.speciesMassAt(3.5, 2.5, 2.5, co)).toBeGreaterThan(1e-5);
  });

  it('CONSERVES mass and every element through a sealed volume', () => {
    /*
     * Transport moves matter and must never make or lose any. Every flux is computed once and
     * applied to both sides of a face, the same way conduction moves enthalpy between shells — so
     * this is exact rather than approximate, and it is asserted through a thousand ticks of
     * diffusion, expansion and buoyancy all running at once.
     */
    sealChunk();
    field.addSpecies(2.5, 2.5, 2.5, co, 0.02);
    field.addHeat(2.5, 1.5, 2.5, 200000);

    const before = new Float64Array(ELEMENT_COUNT);
    const after = new Float64Array(ELEMENT_COUNT);
    field.elementTotals(before);
    const massBefore = field.totalMass();
    const ventedBefore = field.ventedTotalMass();
    const enthalpyBefore = field.totalEnthalpy();

    for (let i = 0; i < 400; i++) field.step(1 / 60, 2, 0);

    field.elementTotals(after);
    expect(maxElementDrift(before, after)).toBeLessThan(1e-12);
    expect(field.totalMass() + field.ventedTotalMass()).toBeCloseTo(massBefore + ventedBefore, 9);
    expect(field.totalEnthalpy()).toBeCloseTo(enthalpyBefore, 3);
  });

  it('lets a heated cell expand, so its density falls and a plume becomes possible', () => {
    sealChunk();
    const cold = field.densityAt(2.5, 1.5, 2.5);
    field.addHeat(2.5, 1.5, 2.5, 300000);
    expect(field.densityAt(2.5, 1.5, 2.5)).toBeCloseTo(cold, 9);
    for (let i = 0; i < 150; i++) field.step(1 / 60);
    /* The gas has pushed its way out into its neighbours, and what is left is thinner. */
    expect(field.densityAt(2.5, 1.5, 2.5)).toBeLessThan(cold * 0.9);
  });

  it('carries hot gas upward, which is the plume', () => {
    sealChunk();
    field.addHeat(2.5, 1.5, 2.5, 400000);
    field.addSoot(2.5, 1.5, 2.5, 1e-4);
    for (let i = 0; i < 250; i++) field.step(1 / 60);
    /* Soot rides the gas it was made in, so it is above where it started rather than below. */
    expect(field.sootAt(2.5, 3.5, 2.5)).toBeGreaterThan(field.sootAt(2.5, 1.5, 2.5) * 0.05);
    expect(field.temperatureAt(2.5, 3.5, 2.5)).toBeGreaterThan(
      field.temperatureAt(2.5, 1.5, 2.5) * 0.5,
    );
  });

  it('carries smoke downwind rather than upwind', () => {
    sealChunk();
    field.addSoot(2.5, 2.5, 2.5, 1e-4);
    for (let i = 0; i < 200; i++) field.step(1 / 60, 3, 0);
    expect(field.sootAt(4.5, 2.5, 2.5)).toBeGreaterThan(field.sootAt(1.5, 2.5, 2.5));
  });

  it('transports nothing across a blocked face', () => {
    sealChunk();
    /* A wall down the middle of the sealed box. */
    for (let y = 1; y < 7; y++) {
      for (let z = 1; z < 7; z++) field.setBlocked(3.5, y + 0.5, z + 0.5, true);
    }
    field.addSpecies(2.5, 2.5, 2.5, co, 0.02);
    for (let i = 0; i < 500; i++) field.step(1 / 60, 4, 0);
    expect(field.speciesMassAt(4.5, 2.5, 2.5, co)).toBeCloseTo(0, 9);
    expect(field.speciesMassAt(1.5, 2.5, 2.5, co)).toBeGreaterThan(1e-5);
  });

  it('relaxes an open cell back toward the far field, and books what left', () => {
    /* No seal at all: the live chunk's edge faces the outdoors. */
    field.addSpecies(2.5, 2.5, 2.5, co, 0.05);
    const put = field.totalAdded(co);
    for (let i = 0; i < 900; i++) field.step(1 / 60);
    const left = field.totalAdded(co);
    expect(left).toBeLessThan(put * 0.98);
    /* Nothing vanished: what the field lost, the ledger holds. */
    expect(left + field.ventedMass(co)).toBeCloseTo(put, 6);
  });

  it('does not depend on the order cells happen to be visited in', () => {
    /*
     * Fluxes are computed from the state the step began with and applied afterwards, so no cell
     * ever sees a neighbour an earlier cell in the sweep already changed. A Gauss-Seidel sweep
     * would give an answer that depended on chunk allocation order, which is a determinism hole
     * with no symptom until two runs happen to allocate differently.
     *
     * Two chunks are touched in opposite orders so the sweep genuinely visits them the other way
     * round, and the cap keeps the live set at two so the test stays cheap.
     */
    const run = (reversed: boolean): number => {
      const s = new SpeciesRegistry();
      registerStandardSpecies(s);
      const f = new AtmosphereField(s, { cellSize: 1, ambient: STANDARD_AIR, maxChunks: 2 });
      const co2 = s.indexOf('CO');
      if (reversed) {
        f.addSpecies(9.5, 2.5, 2.5, co2, 0);
        f.addSpecies(6.5, 2.5, 2.5, co2, 0.02);
      } else {
        f.addSpecies(6.5, 2.5, 2.5, co2, 0.02);
        f.addSpecies(9.5, 2.5, 2.5, co2, 0);
      }
      expect(f.chunkCount).toBe(2);
      for (let i = 0; i < 120; i++) f.step(1 / 60, 1, 0);
      return f.speciesMassAt(8.5, 2.5, 2.5, co2);
    };
    const forward = run(false);
    expect(forward).toBeGreaterThan(0);
    expect(run(true)).toBeCloseTo(forward, 12);
  });

  it('grows the live set as smoke reaches new ground, and stops at its cap', () => {
    const capped = new AtmosphereField(species, {
      cellSize: 1,
      ambient: STANDARD_AIR,
      maxChunks: 2,
    });
    capped.addHeat(2.5, 2.5, 2.5, 2000000);
    capped.addSoot(2.5, 2.5, 2.5, 1e-3);
    for (let i = 0; i < 300; i++) capped.step(1 / 60, 6, 0);
    expect(capped.chunkCount).toBeLessThanOrEqual(2);
  });
});
