import { describe, expect, it } from 'vitest';
import type { Shape } from './shells.ts';
import { MAX_SHELLS, SHAPE_CYLINDER, SHAPE_SLAB, SHAPE_SPHERE, shellGeometry } from './shells.ts';

const sum = (a: Float64Array): number => {
  let total = 0;
  for (const v of a) total += v;
  return total;
};

describe('shellGeometry', () => {
  it('splits a slab into equal thicknesses, because equal mass is equal thickness there', () => {
    const g = shellGeometry(SHAPE_SLAB, 4);
    expect(g.count).toBe(4);
    for (const t of g.thicknessFraction) expect(t).toBeCloseTo(0.25, 12);
    /* A slab's cross-section does not shrink inward, so every interface is the full area. */
    for (const a of g.areaFactor) expect(a).toBeCloseTo(1, 12);
    expect(g.depthFactor).toBe(1);
  });

  it('makes a cylinder and a sphere thin at the surface and fat at the core', () => {
    /*
     * The claim in `§4` of the design, and it is what equal *mass* buys over equal thickness: the
     * resolution goes where the gradient is. Shell 0 is the surface.
     */
    for (const shape of [SHAPE_CYLINDER, SHAPE_SPHERE] as readonly Shape[]) {
      const g = shellGeometry(shape, 4);
      expect(g.thicknessFraction[0] as number, `shape ${shape}`).toBeLessThan(
        g.thicknessFraction[3] as number,
      );
    }
  });

  it('puts a cylinder’s boundaries at the square roots of the volume fractions', () => {
    const g = shellGeometry(SHAPE_CYLINDER, 4);
    /* Shell i's inner boundary encloses (3 - i)/4 of the volume, and volume goes as r². */
    expect(g.innerFraction[0]).toBeCloseTo(Math.sqrt(0.75), 12);
    expect(g.innerFraction[1]).toBeCloseTo(Math.sqrt(0.5), 12);
    expect(g.innerFraction[2]).toBeCloseTo(Math.sqrt(0.25), 12);
    expect(g.innerFraction[3]).toBe(0);
    expect(g.depthFactor).toBe(2);
  });

  it('puts a sphere’s boundaries at the cube roots, and its areas at their squares', () => {
    const g = shellGeometry(SHAPE_SPHERE, 4);
    expect(g.innerFraction[0]).toBeCloseTo(Math.cbrt(0.75), 12);
    expect(g.innerFraction[1]).toBeCloseTo(Math.cbrt(0.5), 12);
    expect(g.areaFactor[0]).toBeCloseTo(Math.cbrt(0.75) ** 2, 12);
    expect(g.areaFactor[1]).toBeCloseTo(Math.cbrt(0.5) ** 2, 12);
    expect(g.depthFactor).toBe(3);
  });

  it('fills the whole depth, whatever the shape', () => {
    for (const shape of [SHAPE_SLAB, SHAPE_CYLINDER, SHAPE_SPHERE] as readonly Shape[]) {
      for (const count of [1, 2, 4, 8, 16]) {
        expect(sum(shellGeometry(shape, count).thicknessFraction), `${shape}/${count}`).toBeCloseTo(
          1,
          12,
        );
      }
    }
  });

  it('is one whole shell when there is only one', () => {
    const g = shellGeometry(SHAPE_SPHERE, 1);
    expect(g.count).toBe(1);
    expect(g.thicknessFraction[0]).toBeCloseTo(1, 12);
    expect(g.innerFraction[0]).toBe(0);
  });

  it('refuses a shell count outside what a parcel can hold, naming it', () => {
    expect(() => shellGeometry(SHAPE_SLAB, 0)).toThrow(/0/);
    expect(() => shellGeometry(SHAPE_SLAB, MAX_SHELLS + 1)).toThrow(new RegExp(String(MAX_SHELLS)));
    expect(() => shellGeometry(SHAPE_SLAB, 2.5)).toThrow(/2\.5/);
  });

  it('refuses a shape it does not have', () => {
    expect(() => shellGeometry(9 as 0, 4)).toThrow(/9/);
  });
});
