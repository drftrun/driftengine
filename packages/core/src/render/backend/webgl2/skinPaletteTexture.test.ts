import { expect, test, vi } from 'vitest';

import { SkinPaletteTexture } from './skinPaletteTexture.ts';

/** The calls the texture makes, counted: enough of a context to see an allocation. */
function fakeGl() {
  const calls = { createTexture: 0, texStorage2D: 0, texSubImage2D: [] as number[] };
  const gl = {
    TEXTURE_2D: 1,
    RGBA32F: 2,
    RGBA: 3,
    FLOAT: 4,
    TEXTURE_MIN_FILTER: 5,
    TEXTURE_MAG_FILTER: 6,
    TEXTURE_WRAP_S: 7,
    TEXTURE_WRAP_T: 8,
    NEAREST: 9,
    CLAMP_TO_EDGE: 10,
    createTexture: vi.fn(() => {
      calls.createTexture += 1;
      return {};
    }),
    deleteTexture: vi.fn(),
    bindTexture: vi.fn(),
    texStorage2D: vi.fn(() => {
      calls.texStorage2D += 1;
    }),
    texParameteri: vi.fn(),
    texSubImage2D: vi.fn((_t, _l, _x, _y, width: number) => {
      calls.texSubImage2D.push(width);
    }),
  };
  return { gl: gl as unknown as WebGL2RenderingContext, calls };
}

const rig = (joints: number): Float32Array => new Float32Array(joints * 16);

/*
 * **One texture for every skinned draw, so it must not follow the rig's size down.** WebGL2 uploads
 * a palette in the draw stream before each skinned draw, into the one texture: a character and a
 * prop drawn in turn reallocated it at every draw while it was rebuilt on any change of joint
 * count. The shader reads joints by index, so a wider texture serves a smaller rig as it is.
 */
test('THE PALETTE TEXTURE GROWS FOR A LARGER RIG AND KEEPS ITS SIZE FOR A SMALLER ONE', () => {
  const { gl, calls } = fakeGl();
  const texture = new SkinPaletteTexture();
  texture.update(gl, rig(4));
  texture.update(gl, rig(2));
  texture.update(gl, rig(4));
  expect(calls.createTexture, 'one texture for the 4, the 2 and the 4 again').toBe(1);
  /* Each upload writes its own rig's texels: four a joint. */
  expect(calls.texSubImage2D).toEqual([16, 8, 16]);
  texture.update(gl, rig(6));
  expect(calls.createTexture, 'a larger rig grows it').toBe(2);
});
