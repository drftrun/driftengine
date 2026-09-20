import { describe, expect, test } from 'vitest';
import {
  DECODE_OP,
  REMAP_SEMANTICS,
  nodeB,
  nodeOp,
  validateDecodeGraph,
  type LatentImage,
} from '@driftengine/texture';

import { Terrain } from './heightfield.ts';
import {
  TERRAIN_HEIGHT_LEVELS,
  TERRAIN_SPLAT_CHANNELS,
  decodeTerrainHeights,
  decodeTerrainSplat,
  encodeTerrainHeights,
  encodeTerrainSplat,
  terrainFromHeightLayer,
  terrainHeightTolerance,
} from './terrainTexture.ts';

/** A field with a cross term, for the reason `terrainCollision.test.ts` states at length. */
function ridges(size: number, spacingM = 1): Terrain {
  return new Terrain({
    width: size,
    depth: size,
    spacingM,
    heights: Float32Array.from({ length: size * size }, (_, i) => {
      const x = i % size;
      const z = Math.floor(i / size);
      return (
        Math.sin(x * 0.5) * 1.4 + Math.cos(z * 0.7) * 0.8 + Math.sin(x * 0.35 + z * 0.45) * 0.9
      );
    }),
    origin: [-8, 2, -8],
  });
}

describe('a heightfield as a texture layer', () => {
  test('decodes to the source heights within the format tolerance', () => {
    const terrain = ridges(33);
    const layer = encodeTerrainHeights(terrain);
    const decoded = new Float32Array(terrain.width * terrain.depth);
    decodeTerrainHeights(layer, decoded);

    const tolerance = terrainHeightTolerance(layer);
    let worst = 0;
    for (let at = 0; at < decoded.length; at += 1) {
      const error = Math.abs((decoded[at] as number) - (terrain.heights[at] as number));
      if (error > worst) worst = error;
    }
    expect(worst).toBeLessThanOrEqual(tolerance);
    /* And the tolerance is a real number rather than a slack one: sixteen bits over the field's
       own range, which for this field is under a tenth of a millimetre. */
    expect(tolerance).toBeLessThan(0.0001);
    expect(tolerance).toBeGreaterThan(0);
  });

  test('states a tolerance that scales with the range it had to cover', () => {
    const shallow = encodeTerrainHeights(ridges(9));
    const deep = new Terrain({
      width: 9,
      depth: 9,
      spacingM: 1,
      heights: Float32Array.from({ length: 81 }, (_, i) => (i % 9) * 400),
    });
    expect(terrainHeightTolerance(encodeTerrainHeights(deep))).toBeGreaterThan(
      terrainHeightTolerance(shallow) * 100,
    );
  });

  test('carries a flat field without a division by a range of zero', () => {
    const flat = new Terrain({ width: 4, depth: 4, spacingM: 2, heights: new Float32Array(16) });
    const layer = encodeTerrainHeights(flat);
    const decoded = new Float32Array(16);
    decodeTerrainHeights(layer, decoded);
    for (let at = 0; at < 16; at += 1) expect(decoded[at]).toBe(0);
    expect(terrainHeightTolerance(layer)).toBe(0);
  });

  test('is sixteen bits, which is what puts the tolerance below a millimetre', () => {
    expect(TERRAIN_HEIGHT_LEVELS).toBe(65536);
    const layer = encodeTerrainHeights(ridges(9));
    /* Under a hundred metres of range, sixteen bits is a millimetre and a half; eight bits would be
       four hundred, which is a visible step on any slope a character walks up. */
    expect(layer.rangeM / TERRAIN_HEIGHT_LEVELS).toBeLessThan(0.001);
  });
});

describe('the terrain a layer rebuilds', () => {
  test('answers the heights the layer holds, not the ones it was encoded from', () => {
    /*
     * **The whole point of this file, and the plan had it the other way round.** The plan asked
     * that heights decoded from a layer match the source within tolerance — which they do, and
     * which is not enough. If rendering reads the layer and collision reads the source, the two
     * surfaces differ by exactly that tolerance everywhere, for ever, and the character floats. So
     * a terrain built from a layer is built from the *decoded* samples, and the two cannot differ
     * because there is only one set of numbers.
     */
    const source = ridges(17);
    const layer = encodeTerrainHeights(source);
    const rebuilt = terrainFromHeightLayer(layer);
    const decoded = new Float32Array(source.width * source.depth);
    decodeTerrainHeights(layer, decoded);

    for (let at = 0; at < decoded.length; at += 1) {
      expect(rebuilt.heights[at]).toBe(decoded[at]);
    }
  });

  test('keeps the spacing and the origin, so a query lands in the same place', () => {
    const source = ridges(17, 2.5);
    const rebuilt = terrainFromHeightLayer(encodeTerrainHeights(source));
    expect(rebuilt.spacingM).toBe(source.spacingM);
    expect([...rebuilt.origin]).toEqual([...source.origin]);
    expect(rebuilt.width).toBe(source.width);
    expect(rebuilt.depth).toBe(source.depth);
  });

  test('is within the tolerance of the source everywhere a query can ask', () => {
    const source = ridges(17);
    const layer = encodeTerrainHeights(source);
    const rebuilt = terrainFromHeightLayer(layer);
    const tolerance = terrainHeightTolerance(layer);
    for (let z = -7.5; z < 7; z += 0.37) {
      for (let x = -7.5; x < 7; x += 0.41) {
        /* No slack: `heightAt` interpolates within a triangle, so the error at any point is a
           convex combination of the errors at its three samples and cannot exceed the worst. */
        expect(Math.abs(rebuilt.heightAt(x, z) - source.heightAt(x, z))).toBeLessThanOrEqual(
          tolerance,
        );
      }
    }
  });
});

describe('splat weights as a texture layer', () => {
  /** Four materials whose weights vary across the field and sum to one at every sample. */
  function weightsFor(size: number): Float32Array {
    const out = new Float32Array(size * size * TERRAIN_SPLAT_CHANNELS);
    for (let z = 0; z < size; z += 1) {
      for (let x = 0; x < size; x += 1) {
        const raw = [
          Math.abs(Math.sin(x * 0.3)),
          Math.abs(Math.cos(z * 0.4)),
          Math.abs(Math.sin((x + z) * 0.2)),
          0.05,
        ];
        const sum = raw[0]! + raw[1]! + raw[2]! + raw[3]!;
        for (let c = 0; c < TERRAIN_SPLAT_CHANNELS; c += 1) {
          out[(z * size + x) * TERRAIN_SPLAT_CHANNELS + c] = raw[c]! / sum;
        }
      }
    }
    return out;
  }

  test('sums to one after decode, at a sample and between two', () => {
    /*
     * **Quantisation does not preserve a sum.** Four weights rounded to eight bits each land
     * anywhere between 0.994 and 1.006, and a shader that trusts the sum draws a patch of ground
     * that is slightly too bright or slightly too dark — over a whole hillside, since the error is
     * smooth. So the decode renormalises, and it has to: the alternative is to store three weights
     * and derive the fourth, which moves the whole error onto one material.
     */
    const size = 16;
    const layer = encodeTerrainSplat(size, size, weightsFor(size));
    const out = new Float32Array(4);
    for (let v = 0; v <= 1.0001; v += 1 / 37) {
      for (let u = 0; u <= 1.0001; u += 1 / 41) {
        decodeTerrainSplat(layer, Math.min(1, u), Math.min(1, v), out);
        const sum =
          (out[0] as number) + (out[1] as number) + (out[2] as number) + (out[3] as number);
        expect(sum).toBeCloseTo(1, 6);
      }
    }
  });

  test('keeps each weight within a quantisation step of the one it was given', () => {
    const size = 16;
    const source = weightsFor(size);
    const layer = encodeTerrainSplat(size, size, source);
    const out = new Float32Array(4);
    let worst = 0;
    for (let z = 0; z < size; z += 1) {
      for (let x = 0; x < size; x += 1) {
        decodeTerrainSplat(layer, x / (size - 1), z / (size - 1), out);
        for (let c = 0; c < TERRAIN_SPLAT_CHANNELS; c += 1) {
          const error = Math.abs(
            (out[c] as number) - (source[(z * size + x) * TERRAIN_SPLAT_CHANNELS + c] as number),
          );
          if (error > worst) worst = error;
        }
      }
    }
    /* One eight-bit step is 1/255; the renormalisation can move a weight by a little more. */
    expect(worst).toBeLessThan(2 / 255);
  });

  test('answers a single material where one material covers everything', () => {
    const weights = new Float32Array(4 * 4 * TERRAIN_SPLAT_CHANNELS);
    for (let at = 0; at < 16; at += 1) weights[at * TERRAIN_SPLAT_CHANNELS + 2] = 1;
    const layer = encodeTerrainSplat(4, 4, weights);
    const out = new Float32Array(4);
    decodeTerrainSplat(layer, 0.5, 0.5, out);
    expect(out[2]).toBeCloseTo(1, 6);
    expect(out[0]).toBeCloseTo(0, 6);
  });

  test('refuses weights that do not sum to one, rather than normalising a mistake away', () => {
    const weights = new Float32Array(4 * 4 * TERRAIN_SPLAT_CHANNELS);
    /* Every texel empty: a weight map nobody filled in, which silently becomes material zero
       everywhere if the decode is allowed to invent a normalisation for it. */
    expect(() => encodeTerrainSplat(4, 4, weights)).toThrow(/sum to one/);
  });
});

describe('the layer says what its channel means', () => {
  test('declares height-linear in the decode program itself', () => {
    /*
     * **The remap node changes no number and is held by this test rather than by arithmetic.**
     * `height-linear` normalises to itself, so removing the node from the program leaves every
     * decoded height identical — which is exactly why it needs saying: the node is the layer
     * *declaring* what its channel is, and a consumer that reads the program rather than this
     * package's documentation is the one the declaration is for. A layer whose channel says
     * nothing is a layer somebody eventually reads as a roughness map.
     */
    const layer = encodeTerrainHeights(ridges(9));
    let declared: string | null = null;
    for (let i = 0; i < layer.graph.count; i += 1) {
      if (nodeOp(layer.graph, i) !== DECODE_OP.REMAP_CHANNEL) continue;
      const operand = nodeB(layer.graph, i);
      declared = REMAP_SEMANTICS[operand >>> 4] ?? null;
      expect(operand & 0xf).toBe(0);
    }
    expect(declared).toBe('height-linear');
    expect(validateDecodeGraph(layer.graph)).toBeNull();
  });

  test('clamps outside the field rather than wrapping the far edge onto the near one', () => {
    /* A field has an edge. Wrapping puts the west ridge against the east one, which is a cliff
       through the middle of the last cell and a sample at `u = 1` reading texel zero. */
    expect(encodeTerrainHeights(ridges(9)).graph.addressMode).toBe(0);
  });
});

describe('a splat layer built some other way', () => {
  test('answers the first material rather than NaN where nothing was written', () => {
    /*
     * `encodeTerrainSplat` refuses a map that could produce this, so the guard is unreachable
     * through it — and reachable through any other way of building a layer, which is the point of
     * the layer being plain data. Dividing by a zero sum answers four NaNs, and a shader given
     * NaN weights draws a black patch of ground that nothing in the pipeline reports.
     */
    const source = encodeTerrainSplat(
      4,
      4,
      Float32Array.from({ length: 4 * 4 * TERRAIN_SPLAT_CHANNELS }, (_, i) =>
        i % TERRAIN_SPLAT_CHANNELS === 1 ? 1 : 0,
      ),
    );
    const blank = {
      ...source,
      resources: {
        ...source.resources,
        latents: [{ ...(source.resources.latents[0] as LatentImage), data: new Float32Array(64) }],
      },
    };
    const out = new Float32Array(4);
    decodeTerrainSplat(blank, 0.5, 0.5, out);
    expect([...out]).toEqual([1, 0, 0, 0]);
  });
});
