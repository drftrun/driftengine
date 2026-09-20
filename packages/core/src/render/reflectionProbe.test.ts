import { describe, expect, test } from 'vitest';

import { Camera } from './camera.ts';
import { cubeFaceProjection } from './reflectionProbe.ts';

/**
 * Which way up a cubemap face is stored, which is the one thing a probe cannot get wrong quietly.
 *
 * **A cubemap face's texel rows run downward and a GL framebuffer's run upward**, and nothing in
 * either API reconciles them: `framebufferTexture2D` on `TEXTURE_CUBE_MAP_POSITIVE_X` puts
 * framebuffer row 0 at the face's texel row 0, while the face's own direction mapping says texel
 * row 0 is the *top* — the +Y end. A camera aimed along +X with its up at +Y puts +Y at the top of
 * the render area, which in GL is the *last* row. So the face comes out mirrored, and every
 * reflection and every irradiance sample built from it has up and down the wrong way round.
 *
 * **It survived because almost nothing can see it.** A face that is flat, or chequered, or bright
 * across its whole width is symmetric under a vertical flip; so is every room `demo/dev/ibl.html`
 * could build before `?band=1`. What finally showed it was four side walls bright above and dark
 * below: on WebGL2 the spheres in that room were lit from *underneath*, and WebGPU — whose
 * generated vertex stage negates clip y for its own reasons — had them right. Measured
 * 2026-09-16: sphere tops 26 to 55 of 255 against WebGPU's 70 to 78, and the bottoms the other way
 * about.
 *
 * The numbers below are the cube map's own convention, from the specification's table: for the +X
 * face `sc` is −z, `tc` is −y and `ma` is |x|, so a direction half a unit above the axis stores at
 * `t = 0.25` — a quarter of the way down from the top, which is a *low* row.
 */
describe('a cubemap face is stored the other way up from a GL framebuffer', () => {
  /** The +X face's camera, exactly as `ReflectionProbe.bake` aims it. */
  function faceCamera(): Camera {
    const camera = new Camera();
    camera.position[0] = 0;
    camera.position[1] = 0;
    camera.position[2] = 0;
    camera.yaw = Math.PI / 2;
    camera.pitch = 0;
    camera.roll = 0;
    camera.fovYDeg = 90;
    camera.near = 0.1;
    camera.far = 200;
    camera.updateMatrices(1);
    return camera;
  }

  /** `y / w` for a world point through a view-projection, which is NDC y. */
  function ndcY(viewProj: ArrayLike<number>, x: number, y: number, z: number): number {
    const cy =
      (viewProj[1] as number) * x +
      (viewProj[5] as number) * y +
      (viewProj[9] as number) * z +
      (viewProj[13] as number);
    const cw =
      (viewProj[3] as number) * x +
      (viewProj[7] as number) * y +
      (viewProj[11] as number) * z +
      (viewProj[15] as number);
    return cy / cw;
  }

  test('THE UNCORRECTED MATRIX PUTS THE SKY IN THE HIGH ROWS, which is where the face wants the ground', () => {
    const camera = faceCamera();
    /* Ten metres along +X and five above: on the +X face, a quarter of the way down from its top
       edge, so the face wants it at t = 0.25 and the framebuffer must put it at a low row. */
    expect(ndcY(camera.viewProjection, 10, 5, 0)).toBeCloseTo(0.5, 5);
  });

  test('AND THE CORRECTED ONE PUTS IT IN THE LOW ROWS, at the same distance from the middle', () => {
    const camera = faceCamera();
    const out = new Float32Array(16);
    cubeFaceProjection(out, camera.viewProjection);
    expect(ndcY(out, 10, 5, 0)).toBeCloseTo(-0.5, 5);
  });

  test('the correction is clip y and nothing else', () => {
    const camera = faceCamera();
    const out = new Float32Array(16);
    cubeFaceProjection(out, camera.viewProjection);
    for (let i = 0; i < 16; i++) {
      const source = camera.viewProjection[i] as number;
      const expected = i % 4 === 1 ? -source : source;
      expect(out[i]).toBeCloseTo(expected, 6);
    }
  });

  test('it is its own inverse, so a second pass is the matrix it started from', () => {
    const camera = faceCamera();
    const once = new Float32Array(16);
    const twice = new Float32Array(16);
    cubeFaceProjection(once, camera.viewProjection);
    cubeFaceProjection(twice, once);
    for (let i = 0; i < 16; i++) {
      expect(twice[i]).toBeCloseTo(camera.viewProjection[i] as number, 6);
    }
  });

  test('writing into the source in place is allowed, because the renderer holds one buffer', () => {
    const camera = faceCamera();
    const held = new Float32Array(camera.viewProjection as ArrayLike<number>);
    const out = new Float32Array(held);
    cubeFaceProjection(out, out);
    expect(ndcY(out, 10, 5, 0)).toBeCloseTo(-0.5, 5);
  });
});
