import { expect, test } from 'vitest';

import { PointGlassTint } from './pointGlassTint.ts';
import { recordingGl } from './rendererHarness.ts';

/*
 * **What a lamp's light keeps through glass: a colour layer per light, born clear, with a chain.**
 * The tint is drawn per face into a face-sized colour scratch and resolved into its octahedral
 * layer, as the depth is; frost reads it at the level its spread asks for, so it carries mips.
 */
test('THE TINT IS A LAYER A LIGHT, BORN CLEAR, AT THE EDGE IT WAS ASKED FOR', () => {
  const { gl, calls } = recordingGl();
  const tint = new PointGlassTint(gl, 512, 512, 4);
  const storage = calls.find((c) => c.name === 'texStorage3D');
  /* texStorage3D(target, levels, internalformat, width, height, depth) */
  expect(storage?.args.slice(1)).toEqual([10, gl.RGBA8, 512, 512, 4]);
  const clears = calls.filter((c) => c.name === 'clearBufferfv' && c.args[0] === gl.COLOR);
  expect(clears.length, 'every layer born white').toBe(4);
  expect([...((clears[0]?.args[2] ?? []) as Float32Array)]).toEqual([1, 1, 1, 1]);
  const scratch = calls.find(
    (c) => c.name === 'texStorage2D' && c.args[2] === gl.RGBA8 && c.args[1] === 1,
  );
  expect(scratch?.args.slice(3), 'one face of colour').toEqual([512, 512]);
  tint.dispose(gl);
});

test('A TINT FACE MULTIPLIES, with no depth test, on a scratch cleared white', () => {
  const { gl, calls } = recordingGl();
  const tint = new PointGlassTint(gl, 256, 1024, 2);
  calls.length = 0;
  tint.beginFace(gl);
  expect(calls.some((c) => c.name === 'disable' && c.args[0] === gl.DEPTH_TEST)).toBe(true);
  expect(
    calls.some(
      (c) =>
        c.name === 'blendFuncSeparate' &&
        c.args[0] === gl.DST_COLOR &&
        c.args[1] === gl.ZERO &&
        c.args[2] === gl.DST_ALPHA &&
        c.args[3] === gl.ZERO,
    ),
  ).toBe(true);
  expect(calls.find((c) => c.name === 'viewport')?.args).toEqual([0, 0, 256, 256]);
  expect(calls.some((c) => c.name === 'clearBufferfv' && c.args[0] === gl.COLOR)).toBe(true);
  tint.dispose(gl);
});

test('A RESOLVED FACE LANDS IN ITS LIGHT S LAYER, and the tint remembers which faces hold glass', () => {
  const { gl, calls } = recordingGl();
  const tint = new PointGlassTint(gl, 256, 1024, 3);
  calls.length = 0;
  tint.beginFace(gl);
  tint.resolveFace(gl, 2, 4, true);
  const attach = calls.filter((c) => c.name === 'framebufferTextureLayer').at(-1);
  /* framebufferTextureLayer(target, attachment, texture, level, layer) */
  expect(attach?.args.slice(3)).toEqual([0, 2]);
  expect(
    calls.some((c) => c.name === 'disable' && c.args[0] === gl.BLEND),
    'a copy',
  ).toBe(true);
  expect(tint.held(2, 4)).toBe(true);
  expect(tint.held(2, 3)).toBe(false);
  expect(tint.held(1, 4)).toBe(false);
  tint.resolveFace(gl, 2, 4, false);
  expect(tint.held(2, 4), 'cleared by a face that drew none').toBe(false);
  tint.dispose(gl);
});

/*
 * **Only the layers a round touched get a new chain, and never by mipmapping the array**:
 * `generateMipmap` on an array rebuilds every layer, which for a pool of lamps is the whole pool's
 * worth of texels for one lamp's glass. The layer goes through a 2D staging chain instead.
 */
test('THE CHAIN IS REBUILT FOR THE LAYERS A ROUND TOUCHED, one layer at a time', () => {
  const { gl, calls } = recordingGl();
  const tint = new PointGlassTint(gl, 256, 16, 4);
  tint.beginFace(gl);
  tint.resolveFace(gl, 3, 0, true);
  calls.length = 0;
  tint.fillMips(gl);
  expect(
    calls.filter((c) => c.name === 'generateMipmap').map((c) => c.args[0]),
    'the staging chain, not the array',
  ).toEqual([gl.TEXTURE_2D]);
  /* Level 0 out of layer 3, then levels 1–4 back into it. */
  const layered = calls
    .filter((c) => c.name === 'framebufferTextureLayer')
    .map((c) => [c.args[0], c.args[3], c.args[4]]);
  expect(layered).toEqual([
    [gl.READ_FRAMEBUFFER, 0, 3],
    [gl.DRAW_FRAMEBUFFER, 1, 3],
    [gl.DRAW_FRAMEBUFFER, 2, 3],
    [gl.DRAW_FRAMEBUFFER, 3, 3],
    [gl.DRAW_FRAMEBUFFER, 4, 3],
  ]);
  expect(calls.filter((c) => c.name === 'blitFramebuffer').length).toBe(5);

  calls.length = 0;
  tint.fillMips(gl);
  expect(calls, 'nothing touched since: nothing to do').toEqual([]);
  tint.dispose(gl);
});
