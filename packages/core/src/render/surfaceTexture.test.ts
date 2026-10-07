import { describe, expect, it, vi } from 'vitest';

import { SurfaceTexture } from './surfaceTexture.ts';

/** Enough GL to upload a texture, recording the pixel-store settings it asked for. */
function stubGl() {
  const stores: { name: number; value: unknown }[] = [];
  const gl = {
    UNPACK_FLIP_Y_WEBGL: 37440,
    TEXTURE_2D: 3553,
    TEXTURE_2D_ARRAY: 35866,
    RGBA: 6408,
    SRGB8_ALPHA8: 35907,
    UNSIGNED_BYTE: 5121,
    REPEAT: 10497,
    CLAMP_TO_EDGE: 33071,
    LINEAR: 9729,
    NEAREST: 9728,
    NEAREST_MIPMAP_LINEAR: 9986,
    LINEAR_MIPMAP_LINEAR: 9987,
    TEXTURE_WRAP_S: 10242,
    TEXTURE_WRAP_T: 10243,
    TEXTURE_MAG_FILTER: 10240,
    TEXTURE_MIN_FILTER: 10241,
    createTexture: vi.fn(() => ({}) as WebGLTexture),
    bindTexture: vi.fn(),
    texImage2D: vi.fn(),
    texImage3D: vi.fn(),
    texSubImage3D: vi.fn(),
    TEXTURE_BASE_LEVEL: 33084,
    TEXTURE_MAX_LEVEL: 33085,
    texParameteri: vi.fn(),
    compressedTexImage3D: vi.fn(),
    generateMipmap: vi.fn(),
    deleteTexture: vi.fn(),
    activeTexture: vi.fn(),
    getExtension: vi.fn(() => null),
    pixelStorei: vi.fn((name: number, value: unknown) => {
      stores.push({ name, value });
    }),
  };
  return { gl: gl as unknown as WebGL2RenderingContext, stores, raw: gl };
}

const SOURCE = { width: 4, height: 4 } as unknown as TexImageSource;

describe('uploading a surface texture', () => {
  /**
   * **The flag is honoured for a canvas and ignored for an `ImageBitmap`.**
   *
   * That is a WebGL rule, not a choice: a bitmap carries its own orientation and
   * `UNPACK_FLIP_Y_WEBGL` does not apply to it. So setting the flag flipped one of the two
   * source types this class accepts and not the other, and they arrived the opposite way up.
   * Nothing caught it because every canvas-sourced texture here was symmetric under a vertical
   * flip — noise, a radial halo, a blur — until a consumer painted lettering next to a sleeve.
   *
   * Asserted as "never set" rather than "set to false", because the two are the same to the
   * driver and the point is that this class no longer has an opinion the source can veto.
   */
  it('never asks for a vertical flip, because one source type would ignore it', () => {
    const { gl, stores } = stubGl();

    const texture = new SurfaceTexture(gl, SOURCE, {});
    texture.update(gl, SOURCE);

    const flips = stores.filter((s) => s.name === 37440 && s.value === true);
    expect(flips).toEqual([]);
  });

  /* The upload still happens, or the assertion above would pass on a class that does nothing. */
  it('uploads on construction and again on update', () => {
    const { gl, raw } = stubGl();

    const texture = new SurfaceTexture(gl, SOURCE, {});
    /* Allocated as a one-layer array, then the image written into layer 0. */
    expect(raw.texImage3D.mock.calls[0]?.[5], 'one layer').toBe(1);
    expect(raw.texSubImage3D.mock.calls[0]?.[10]).toBe(SOURCE);
    texture.update(gl, SOURCE);
    expect(raw.texImage3D.mock.calls[1]?.[9], 'the new pixels').toBe(SOURCE);
  });

  it('AN ARRAY WRITES EVERY IMAGE AT ITS OWN LAYER, and refuses images of two sizes', () => {
    const { gl, raw } = stubGl();
    const images = [0, 1, 2].map(() => ({ width: 8, height: 4 }) as unknown as TexImageSource);
    const array = new SurfaceTexture(gl, images, {});
    expect(array.layers).toBe(3);
    expect(raw.texImage3D.mock.calls[0]?.slice(3, 6), 'one allocation, three deep').toEqual([
      8, 4, 3,
    ]);
    expect(raw.texSubImage3D.mock.calls.map((call) => [call[4], call[10]])).toEqual([
      [0, images[0]],
      [1, images[1]],
      [2, images[2]],
    ]);
    const odd = [images[0], { width: 4, height: 4 } as unknown as TexImageSource];
    expect(() => new SurfaceTexture(gl, odd as TexImageSource[], {})).toThrow(
      /layer 1 is 4×4 and layer 0 is 8×4/,
    );
    expect(() => array.update(gl, images[0] as TexImageSource)).toThrow(/array of 3 layers/);
  });

  /* sRGB is a format decision and stays one: the shader must not decode a second time. */
  it('asks for an sRGB internal format only when the caller says the pixels are display values', () => {
    const linear = stubGl();
    new SurfaceTexture(linear.gl, SOURCE, {});
    expect(linear.raw.texImage3D.mock.calls[0]?.[2]).toBe(6408);

    const srgb = stubGl();
    new SurfaceTexture(srgb.gl, SOURCE, { colorSpace: 'srgb' });
    expect(srgb.raw.texImage3D.mock.calls[0]?.[2]).toBe(35907);
  });
});

/**
 * Nearest filtering, for an image whose pixels are the subject.
 *
 * **Reported by a consumer whose block atlas is pixel art.** Linear magnification turns an authored
 * tile into a smear as the camera approaches, and there was no way to ask for anything else — they
 * worked around it with `imageSmoothingEnabled = false` when composing the atlas and by keeping
 * tiles at twice the reference's resolution, neither of which touches *magnification*. The engine
 * did the smoothing, in the sampler, after everything they controlled.
 */
describe('the filter an image is sampled with', () => {
  const filtersOf = (raw: ReturnType<typeof stubGl>['raw']) =>
    raw.texParameteri.mock.calls
      .filter(([, name]) => name === raw.TEXTURE_MAG_FILTER || name === raw.TEXTURE_MIN_FILTER)
      .map(([, name, value]) => [name === raw.TEXTURE_MAG_FILTER ? 'mag' : 'min', value]);

  it('is linear by default, which is every surface that shipped before this', () => {
    const { gl, raw } = stubGl();
    new SurfaceTexture(gl, SOURCE, { mipmap: false });
    expect(filtersOf(raw)).toEqual([
      ['mag', raw.LINEAR],
      ['min', raw.LINEAR],
    ]);
  });

  it('is nearest when a caller asks, which is the whole of the request', () => {
    const { gl, raw } = stubGl();
    new SurfaceTexture(gl, SOURCE, { mipmap: false, filter: 'nearest' });
    expect(filtersOf(raw)).toEqual([
      ['mag', raw.NEAREST],
      ['min', raw.NEAREST],
    ]);
  });

  /*
   * **Minification still takes the mip chain, and that is not an oversight.** Nearest magnification
   * is what keeps a tile crisp up close; nearest *minification* across a mip chain is what makes a
   * tiled floor at a grazing angle shimmer, which is the artefact mips exist to remove. So the
   * request is honoured where it was made about — magnification — and the levels are still blended
   * between, so a tile stays crisp within a level and does not pop as the camera pulls back.
   */
  it('keeps a filtered mip chain under minification even when asked for nearest', () => {
    const { gl, raw } = stubGl();
    new SurfaceTexture(gl, SOURCE, { mipmap: true, filter: 'nearest' });
    expect(filtersOf(raw)).toEqual([
      ['mag', raw.NEAREST],
      ['min', raw.NEAREST_MIPMAP_LINEAR],
    ]);
  });
});

/**
 * **Blocks replace an image behind the handle it already has**, as a loader that showed a decoded
 * image first hands over the blocks it encoded afterwards. A new GL object rather than the image's
 * levels respecified, so no level of the image's chain is left allocated past the blocks'.
 */
describe('blocks swapped in for an image', () => {
  const chain = {
    format: 'etc2-rgb8',
    width: 8,
    height: 8,
    levels: [new Uint8Array(32), new Uint8Array(8), new Uint8Array(8), new Uint8Array(8)],
  } as const;

  it("UPLOAD INTO A NEW OBJECT IN THE IMAGE'S COLOUR SPACE, sampled as the image was, and the image is freed", () => {
    const { gl, raw } = stubGl();
    const texture = new SurfaceTexture(gl, SOURCE, { colorSpace: 'srgb', wrap: 'clamp' });
    const image = raw.createTexture.mock.results[0]?.value as WebGLTexture;
    raw.texParameteri.mockClear();

    texture.update(gl, chain, ['etc2-rgb8', 'etc2-rgb8-srgb']);

    const blocks = raw.createTexture.mock.results[1]?.value as WebGLTexture;
    expect(raw.deleteTexture).toHaveBeenCalledWith(image);
    /* COMPRESSED_SRGB8_ETC2, at each of the four levels the blocks carry. */
    expect(raw.compressedTexImage3D.mock.calls.map((call) => [call[1], call[2], call[3]])).toEqual([
      [0, 0x9275, 8],
      [1, 0x9275, 4],
      [2, 0x9275, 2],
      [3, 0x9275, 1],
    ]);
    const set = raw.texParameteri.mock.calls.map(([, name, value]) => [name, value]);
    expect(set, 'the wrap the image had').toContainEqual([raw.TEXTURE_WRAP_S, raw.CLAMP_TO_EDGE]);
    expect(set, 'and its chain still blended').toContainEqual([
      raw.TEXTURE_MIN_FILTER,
      raw.LINEAR_MIPMAP_LINEAR,
    ]);
    raw.bindTexture.mockClear();
    texture.bind(gl, 3);
    expect(raw.bindTexture).toHaveBeenCalledWith(raw.TEXTURE_2D_ARRAY, blocks);
    expect(() => texture.update(gl, SOURCE), 'and no image after them').toThrow(
      /holds ETC2-RGB8 blocks/,
    );
  });

  it('ARE REFUSED WHERE THE CONTEXT DOES NOT TAKE THEM, and the image is kept', () => {
    const { gl, raw } = stubGl();
    const texture = new SurfaceTexture(gl, SOURCE, { colorSpace: 'srgb' });
    expect(() => texture.update(gl, chain, ['etc2-rgb8'])).toThrow(/ETC2-RGB8/);
    expect(raw.deleteTexture).not.toHaveBeenCalled();
    expect(raw.createTexture).toHaveBeenCalledTimes(1);
  });
});
