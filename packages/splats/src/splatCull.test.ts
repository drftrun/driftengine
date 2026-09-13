import { describe, expect, it } from 'vitest';
import { splatBoundsVisible } from './splatCull.ts';

/**
 * A perspective projection written from its own definition rather than taken from a library.
 *
 * The engine builds this with `mat4.perspective`, which is the OpenGL convention: right-handed,
 * looking down -z, clipping z to [-1, 1]. Writing the five non-zero entries here is what makes the
 * expectations below independent of the code under test.
 */
function perspective(fovYDeg: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan((fovYDeg * Math.PI) / 180 / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) / (near - far);
  m[11] = -1;
  m[14] = (2 * far * near) / (near - far);
  return m;
}

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** A column-major translation, which is the only model matrix these cases need. */
function translation(x: number, y: number, z: number): Float32Array {
  const m = new Float32Array(IDENTITY);
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

const PROJECTION = perspective(45, 16 / 9, 0.1, 100);

function box(cx: number, cy: number, cz: number, half: number): [Float32Array, Float32Array] {
  return [
    new Float32Array([cx - half, cy - half, cz - half]),
    new Float32Array([cx + half, cy + half, cz + half]),
  ];
}

describe('splatBoundsVisible', () => {
  it('keeps a capture the camera is looking at', () => {
    const [min, max] = box(0, 0, -10, 1);
    expect(splatBoundsVisible(IDENTITY, PROJECTION, IDENTITY, min, max)).toBe(true);
  });

  it('drops a capture off the side of the frame', () => {
    /*
     * **This is the whole point of the test, and it is checked before the sort rather than after.**
     * A capture out of frame still costs a counting sort over every one of its splats — a
     * megabyte-scale pass in a worker for a picture nobody sees — and the sort is the expensive
     * half, so culling after it saves only the draw call.
     */
    const [min, max] = box(0, 0, -10, 1);
    expect(splatBoundsVisible(IDENTITY, PROJECTION, translation(90, 0, 0), min, max)).toBe(false);
  });

  it('drops a capture standing behind the camera', () => {
    const [min, max] = box(0, 0, 40, 1);
    expect(splatBoundsVisible(IDENTITY, PROJECTION, IDENTITY, min, max)).toBe(false);
  });

  it('drops a capture past the far plane', () => {
    const [min, max] = box(0, 0, -400, 1);
    expect(splatBoundsVisible(IDENTITY, PROJECTION, IDENTITY, min, max)).toBe(false);
  });

  it('keeps a capture the camera is standing inside', () => {
    /*
     * Every one of the six planes has corners on both sides of it, so no single plane rejects the
     * box — which is the case a naive "is the centre inside" test gets wrong, and is exactly the
     * case a room-scale capture is.
     */
    const [min, max] = box(0, 0, 0, 50);
    expect(splatBoundsVisible(IDENTITY, PROJECTION, IDENTITY, min, max)).toBe(true);
  });

  it('keeps a capture that is only partly in frame', () => {
    /*
     * Conservative in the direction that costs a sort rather than in the one that loses a picture.
     * A box reaching in from the left edge has to be drawn, and a test that answered on its centre
     * would drop it.
     */
    const min = new Float32Array([-40, -1, -11]);
    const max = new Float32Array([-2, 1, -9]);
    expect(splatBoundsVisible(IDENTITY, PROJECTION, IDENTITY, min, max)).toBe(true);
  });

  it('follows the capture when its model matrix moves it back into frame', () => {
    /* The bounds are in the capture's own space, so the model matrix is what decides where they
       land — the reason this takes three matrices rather than a world-space box. */
    const [min, max] = box(0, 0, 0, 1);
    expect(splatBoundsVisible(IDENTITY, PROJECTION, translation(0, 0, 60), min, max)).toBe(false);
    expect(splatBoundsVisible(IDENTITY, PROJECTION, translation(0, 0, -20), min, max)).toBe(true);
  });
});
