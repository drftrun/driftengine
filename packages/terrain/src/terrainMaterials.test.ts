import { describe, expect, test } from 'vitest';

import { TerrainMaterials, terrainMaterialWeights } from './terrainMaterials.ts';

const GRASS = { color: [0.2, 0.6, 0.2] as const };
const ROCK = { color: [0.5, 0.5, 0.5] as const };
const SAND = { color: [0.9, 0.8, 0.5] as const };

/** A two-by-two map: grass at one corner, rock at the opposite one, an even mix between. */
function pair(): TerrainMaterials {
  return new TerrainMaterials({
    materials: [GRASS, ROCK],
    width: 2,
    depth: 2,
    weights: new Float32Array([
      1, 0 /* (0,0) all grass */, 0, 1 /* (1,0) all rock  */, 0, 1 /* (0,1) all rock  */, 1,
      0 /* (1,1) all grass */,
    ]),
  });
}

describe('the weights a map answers', () => {
  test('are the sample itself, at a sample', () => {
    const out = new Float32Array(2);
    terrainMaterialWeights(pair(), 0, 0, out);

    expect(out[0]).toBeCloseTo(1, 6);
    expect(out[1]).toBeCloseTo(0, 6);
  });

  test('are bilinear between samples, which is right here and wrong for a height', () => {
    /*
     * **The opposite of `heightAt`, and the contrast is worth stating.** A height is read as the
     * triangle because the surface is *drawn* as triangles and the query has to agree with the
     * picture. A weight is not drawn at all — it decides a vertex colour, and the vertex is
     * wherever the mesh put it — so there is no triangulation to agree with and the smooth
     * interpolation is simply the better one. Reading a weight map as triangles would put a visible
     * crease along every cell diagonal for no reason at all.
     */
    const out = new Float32Array(2);
    terrainMaterialWeights(pair(), 0.5, 0, out);

    expect(out[0]).toBeCloseTo(0.5, 6);
    expect(out[1]).toBeCloseTo(0.5, 6);
  });

  test('are normalised, so a map nobody balanced still blends', () => {
    /*
     * A weight map is authored — painted, or generated from slope and height — and nothing makes
     * its channels sum to one. Un-normalised weights would darken wherever they summed below one
     * and blow out wherever they summed above it, which reads as lighting rather than as a map.
     */
    const doubled = new TerrainMaterials({
      materials: [GRASS, ROCK],
      width: 2,
      depth: 2,
      weights: new Float32Array([2, 2, 2, 2, 2, 2, 2, 2]),
    });
    const out = new Float32Array(2);
    terrainMaterialWeights(doubled, 0.25, 0.75, out);

    expect(out[0]).toBeCloseTo(0.5, 6);
    expect(out[1]).toBeCloseTo(0.5, 6);
  });

  test('fall back to the first material where a sample weighs nothing at all', () => {
    /*
     * **Black is not a colour a terrain should ever be by accident.** An unpainted corner of a map
     * sums to zero, and dividing by that gives a NaN or a black patch depending on where it lands —
     * both of which read as a rendering bug rather than as an unpainted map.
     */
    const empty = new TerrainMaterials({
      materials: [GRASS, ROCK],
      width: 2,
      depth: 2,
      weights: new Float32Array(8),
    });
    const out = new Float32Array(2);
    terrainMaterialWeights(empty, 0.5, 0.5, out);

    expect(out[0]).toBeCloseTo(1, 6);
    expect(out[1]).toBeCloseTo(0, 6);
  });

  test('clamp outside the map rather than wrapping it round', () => {
    const out = new Float32Array(2);
    const inside = new Float32Array(2);
    terrainMaterialWeights(pair(), -3, -3, out);
    terrainMaterialWeights(pair(), 0, 0, inside);

    expect(out[0]).toBeCloseTo(inside[0] ?? 0, 6);
    expect(out[1]).toBeCloseTo(inside[1] ?? 0, 6);
  });
});

describe('the colour a blend gives', () => {
  test('is the material itself where one of them holds all the weight', () => {
    const out = new Float32Array(3);
    pair().colorAt(0, 0, out);

    expect(out[0]).toBeCloseTo(GRASS.color[0], 6);
    expect(out[1]).toBeCloseTo(GRASS.color[1], 6);
    expect(out[2]).toBeCloseTo(GRASS.color[2], 6);
  });

  test('is the mix where two of them share it', () => {
    const out = new Float32Array(3);
    pair().colorAt(0.5, 0, out);

    expect(out[0]).toBeCloseTo((GRASS.color[0] + ROCK.color[0]) / 2, 6);
    expect(out[1]).toBeCloseTo((GRASS.color[1] + ROCK.color[1]) / 2, 6);
    expect(out[2]).toBeCloseTo((GRASS.color[2] + ROCK.color[2]) / 2, 6);
  });

  test('carries emissive and specular through the same blend as the colour', () => {
    const lit = new TerrainMaterials({
      materials: [
        { color: [0, 0, 0], emissive: 1, specular: 0 },
        { color: [1, 1, 1], emissive: 0, specular: 1 },
      ],
      width: 2,
      depth: 2,
      weights: new Float32Array([1, 0, 0, 1, 0, 1, 1, 0]),
    });

    expect(lit.emissiveAt(0.5, 0)).toBeCloseTo(0.5, 6);
    expect(lit.specularAt(0.5, 0)).toBeCloseTo(0.5, 6);
    expect(lit.emissiveAt(0, 0)).toBeCloseTo(1, 6);
    expect(lit.specularAt(0, 0)).toBeCloseTo(0, 6);
  });

  test('says whether anything shines at all, so a mesh with none uploads no buffer', () => {
    const dull = new TerrainMaterials({
      materials: [GRASS, ROCK],
      width: 2,
      depth: 2,
      weights: new Float32Array([1, 0, 0, 1, 0, 1, 1, 0]),
    });
    const shiny = new TerrainMaterials({
      materials: [GRASS, { ...ROCK, specular: 0.4 }],
      width: 2,
      depth: 2,
      weights: new Float32Array([1, 0, 0, 1, 0, 1, 1, 0]),
    });

    expect(dull.shines).toBe(false);
    expect(shiny.shines).toBe(true);
  });
});

describe('what a map refuses', () => {
  test('a weight array that does not match its size and its materials', () => {
    expect(
      () =>
        new TerrainMaterials({
          materials: [GRASS, ROCK, SAND],
          width: 2,
          depth: 2,
          weights: new Float32Array(8),
        }),
    ).toThrow(/12/);
  });

  test('a map with no materials to blend', () => {
    expect(
      () =>
        new TerrainMaterials({ materials: [], width: 2, depth: 2, weights: new Float32Array() }),
    ).toThrow(/material/);
  });
});
