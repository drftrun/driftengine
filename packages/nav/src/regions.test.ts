import { describe, expect, it } from 'vitest';
import { buildRegions, regionOfSpan, regionsLinked, spanIndexAt } from './regions.ts';
import { fieldFromMap, stackedField } from './testField.ts';

const OPEN = ['........', '........', '........', '........', '........'];

describe('regions', () => {
  it('make one region of a plane', () => {
    const regions = buildRegions(fieldFromMap(OPEN), { minRegionSpans: 4, maxStep: 1 });
    expect(regions.count).toBe(1);
    expect(regions.linkCount).toBe(0);
  });

  /**
   * **Two rooms joined by a corridor are two regions and a link, and a flood fill says one.** That
   * matters because the contour of one region wrapping through a one-cell corridor is a shape that
   * simplifies into something that crosses itself — and the funnel then walks out of the mesh.
   * The split comes from the distance field: a corridor is far from nothing, so it is a watershed
   * rather than part of either basin.
   */
  it('split two rooms joined by a corridor, and link them', () => {
    const rooms = fieldFromMap(['.....#.....', '...........', '.....#.....']);
    const regions = buildRegions(rooms, { minRegionSpans: 2, maxStep: 1 });
    expect(regions.count, 'two basins').toBe(2);

    const left = regionOfSpan(regions, spanIndexAt(rooms, 1, 1));
    const right = regionOfSpan(regions, spanIndexAt(rooms, 9, 1));
    expect(left).not.toBe(right);
    expect(regionsLinked(regions, left, right), 'and you can walk between them').toBe(true);
  });

  it('do not link two areas that do not touch', () => {
    const split = fieldFromMap(['....#....', '....#....', '....#....']);
    const regions = buildRegions(split, { minRegionSpans: 2, maxStep: 1 });
    expect(regions.count).toBe(2);
    expect(regions.linkCount).toBe(0);
  });

  /**
   * **A region smaller than the threshold is merged and never left as a hole.** A hole in a
   * navigation mesh is a place an agent refuses to stand for no reason anybody can see, and the
   * smallest ones come from a corner of the voxel field surviving erosion by one cell.
   */
  it('merge a region smaller than the threshold into its neighbour', () => {
    /* A two-wide room and an eight-wide one, joined at (2, 1): six spans against twenty-four. */
    const lopsided = fieldFromMap(['..#........', '...........', '..#........']);

    const kept = buildRegions(lopsided, { minRegionSpans: 1, maxStep: 1 });
    expect(kept.count, 'both basins exist to begin with').toBe(2);

    const merged = buildRegions(lopsided, { minRegionSpans: 8, maxStep: 1 });
    expect(merged.count, 'the small one went into the large one').toBe(1);

    /* Whatever happened to it, the small room is still in a region rather than a hole. */
    expect(regionOfSpan(merged, spanIndexAt(lopsided, 0, 0))).toBeGreaterThanOrEqual(0);
  });

  it('leave every walkable span in some region', () => {
    const field = fieldFromMap(['..##..', '......', '..##..']);
    const regions = buildRegions(field, { minRegionSpans: 2, maxStep: 1 });
    for (let z = 0; z < field.depth; z += 1) {
      for (let x = 0; x < field.width; x += 1) {
        const span = spanIndexAt(field, x, z);
        if (span < 0) continue;
        expect(regionOfSpan(regions, span), `${x},${z} is in a region`).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('are deterministic', () => {
    const field = fieldFromMap(['.....#.....', '...........', '.....#.....']);
    const a = buildRegions(field, { minRegionSpans: 2, maxStep: 1 });
    const b = buildRegions(field, { minRegionSpans: 2, maxStep: 1 });
    expect([...a.regionOf]).toEqual([...b.regionOf]);
    expect([...a.links]).toEqual([...b.links]);
  });
});

/** A step taller than the agent can climb is a wall, not a floor at a different height. */
describe('steps between spans', () => {
  it('join spans within the step height and not beyond it', () => {
    const gentle = fieldFromMap(['0011', '0011']);
    const sheer = fieldFromMap(['0055', '0055']);

    expect(buildRegions(gentle, { minRegionSpans: 1, maxStep: 1 }).count).toBe(1);
    expect(buildRegions(sheer, { minRegionSpans: 1, maxStep: 1 }).count).toBe(2);
  });
});

/** An overhang is two regions at one horizontal position, which is the point of the whole field. */
describe('an overhang', () => {
  it('puts the two layers in different regions', () => {
    const field = stackedField(['....', '....'], 6);
    const regions = buildRegions(field, { minRegionSpans: 1, maxStep: 1 });
    expect(regions.count).toBe(2);
  });
});
