import { describe, expect, it } from 'vitest';

import { LIGHTMAP_LAYERS, lightmapTexels, withLightmapUvs } from './lightmap.ts';
import { MODEL_PARAM_FLOATS, lightmapModel, packModel } from './surfaceModel.ts';

describe('a lightmap page as both backends upload it', () => {
  /*
   * Two texels, so a layout that interleaved the layers or read the wrong texel puts a value where
   * the hand-derived one is not. (0.25, 1.5, 3): the largest is 3, so the exponent is
   * floor(log2 3) + 1 + 15 = 17 and the step 2^(17 - 24) = 1/128, giving mantissas 32, 192 and 384,
   * the word 32 | 192 << 9 | 384 << 18 | 17 << 27 = 2,382,463,008 and the bytes, lowest first,
   * 32, 128, 1, 142. (0.5, 0, 2): the same exponent, mantissas 64, 0 and 256: bytes 64, 0, 0, 140.
   */
  it('PACKS FLOAT IRRADIANCE AS ONE RGB9E5 WORD A TEXEL, AND TAKES THE DIRECTION AS ITS BYTES', () => {
    const direction = new Uint8Array([255, 0, 51, 255, 0, 255, 0, 0]);
    const texels = lightmapTexels({
      width: 2,
      height: 1,
      irradiance: new Float32Array([0.25, 1.5, 3, 0.5, 0, 2]),
      direction,
    });
    expect(texels.layers).toHaveLength(LIGHTMAP_LAYERS);
    expect(texels.width).toBe(2);
    expect(Array.from(texels.layers[0] ?? [])).toEqual([32, 128, 1, 142, 64, 0, 0, 140]);
    expect(texels.layers[1], 'the direction uploads where it lies').toBe(direction);
  });

  /*
   * A bake that arrives packed is the case the format exists for: 21.8 million texels of floats
   * were 348 MB on the device as half floats and a second copy on the way. A packed page is read
   * where it lies, so its bytes are a view of the caller's own words.
   */
  it('READS PACKED IRRADIANCE WHERE IT LIES, WITH NO COPY', () => {
    const words = new Uint32Array([2382463008, 2348810304]);
    const texels = lightmapTexels({
      width: 2,
      height: 1,
      irradiance: words,
      direction: new Uint8Array(8),
    });
    expect(texels.layers[0]?.buffer).toBe(words.buffer);
    expect(Array.from(texels.layers[0] ?? [])).toEqual([32, 128, 1, 142, 64, 0, 0, 140]);
  });

  it('refuses arrays that are not the page, naming the one that is short', () => {
    const page = { width: 2, height: 2, direction: new Uint8Array(16) };
    expect(() => lightmapTexels({ ...page, irradiance: new Float32Array(11) })).toThrow(
      /11 irradiance floats .* wants 12/,
    );
    expect(() => lightmapTexels({ ...page, irradiance: new Uint32Array(3) })).toThrow(
      /3 irradiance words .* wants 4: one rgb9e5 word a texel/,
    );
    expect(() =>
      lightmapTexels({ ...page, irradiance: new Float32Array(12), direction: new Uint8Array(15) }),
    ).toThrow(/15 direction bytes .* wants 16/);
    expect(() =>
      lightmapTexels({
        width: 0,
        height: 2,
        irradiance: new Float32Array(0),
        direction: page.direction,
      }),
    ).toThrow(/nothing in it/);
  });
});

/** Two vertices and the attributes every mesh carries. */
function twoVertices() {
  return {
    positions: new Float32Array(6),
    normals: new Float32Array(6),
    colors: new Float32Array(6),
    emissive: new Float32Array(2),
    indices: new Uint32Array([0, 1, 0]),
  };
}

describe('the second coordinates on the lanes they ride', () => {
  /*
   * Below zero, as `-1 - uv`, so a standard material — whose grain takes effect only above zero
   * and whose relief is read through `max(relief, 0)` — sees a mesh with neither.
   */
  it('STORES THEM BELOW ZERO, SO A MATERIAL WITH NO PAGE READS NO GRAIN AND NO RELIEF', () => {
    const data = {
      ...twoVertices(),
      lightmapUvs: new Float32Array([0, 1, 0.25, 0.5]),
    };
    const moved = withLightmapUvs(data);
    expect(Array.from(moved.grain ?? [])).toEqual([-1, -1.25]);
    expect(Array.from(moved.relief ?? [])).toEqual([-2, -1.5]);
    expect(moved.lightmapUvs).toBeUndefined();
  });

  it('hands back a mesh with none exactly as it came', () => {
    const data = twoVertices();
    expect(withLightmapUvs(data)).toBe(data);
  });
});

describe('a lightmapped material', () => {
  it('carries its region in the first vector of its numbers, and the whole page by default', () => {
    const out = new Float32Array(MODEL_PARAM_FLOATS);
    packModel(lightmapModel({ region: [0.5, 0.25, 0.5, 0.75] }), true, out);
    expect(Array.from(out)).toEqual([0.5, 0.25, 0.5, 0.75, 0, 0, 0, 1]);
    packModel(lightmapModel(), false, out);
    expect(Array.from(out)).toEqual([1, 1, 0, 0, 0, 0, 0, 0]);
  });

  it('refuses a region that is not four finite numbers', () => {
    expect(() => lightmapModel({ region: [1, 1, 0, Number.NaN] })).toThrow(/four numbers/);
    expect(() =>
      lightmapModel({ region: [1, 1, 0] as unknown as [number, number, number, number] }),
    ).toThrow(/four numbers/);
  });
});
