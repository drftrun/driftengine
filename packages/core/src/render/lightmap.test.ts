import { describe, expect, it } from 'vitest';

import { LIGHTMAP_LAYERS, lightmapTexels, withLightmapUvs } from './lightmap.ts';
import { MODEL_PARAM_FLOATS, lightmapModel, packModel } from './surfaceModel.ts';

/** A half float's bits as the number they hold: sign, five exponent bits, ten of mantissa. */
function half(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const mantissa = bits & 0x3ff;
  if (exponent === 0) return sign * 2 ** -14 * (mantissa / 1024);
  return sign * 2 ** (exponent - 15) * (1 + mantissa / 1024);
}

describe('a lightmap page as both backends upload it', () => {
  /*
   * Two texels, so a layout that interleaved the layers, or read the direction from the wrong
   * texel, puts a value where the hand-written one is not. 0.25, 1.5 and 3 are exact in a half;
   * byte 255 is 1, byte 0 is 0, and 51 is 0.2 to the half's precision.
   */
  it('LAYS THE IRRADIANCE OUT AS ONE LAYER AND THE DIRECTION AS THE NEXT, FOUR HALVES A TEXEL', () => {
    const texels = lightmapTexels({
      width: 2,
      height: 1,
      irradiance: new Float32Array([0.25, 1.5, 3, 0.5, 0, 2]),
      direction: new Uint8Array([255, 0, 51, 255, 0, 255, 0, 0]),
    });
    expect(texels.layers).toBe(LIGHTMAP_LAYERS);
    expect(texels.width).toBe(2);
    expect(Array.from(texels.texels.subarray(0, 8), half)).toEqual([0.25, 1.5, 3, 1, 0.5, 0, 2, 1]);
    const direction = Array.from(texels.texels.subarray(8, 16), half);
    expect(direction[0]).toBe(1);
    expect(direction[1]).toBe(0);
    expect(direction[2]).toBeCloseTo(0.2, 3);
    expect(direction.slice(3)).toEqual([1, 0, 1, 0, 0]);
  });

  it('refuses arrays that are not the page, naming the one that is short', () => {
    const page = { width: 2, height: 2, direction: new Uint8Array(16) };
    expect(() => lightmapTexels({ ...page, irradiance: new Float32Array(11) })).toThrow(
      /11 irradiance floats .* wants 12/,
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
