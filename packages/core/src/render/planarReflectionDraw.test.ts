import { describe, expect, it } from 'vitest';

import { Camera } from './camera.ts';
import { mirrorCamera, reflectionClipPlane, reflectionTargetSize } from './planarReflectionDraw.ts';

/** `dot(vec4(0, y, 0, 1), plane)`, which is the test the shaders run per fragment. */
function keeps(plane: Float32Array, y: number): boolean {
  return (plane[1] as number) * y + (plane[3] as number) >= 0;
}

describe('reflectionClipPlane', () => {
  /*
   * **Which half survives follows the camera, and getting it backwards inverts silently.**
   * A constant side works perfectly until a viewer's eye passes the waterline, at which point
   * the mirror starts drawing the half it is supposed to be hiding — and the frame still looks
   * like a reflection, which is why this is pinned rather than eyeballed.
   */
  it('keeps the half the viewer is on, from above', () => {
    const plane = new Float32Array(4);
    reflectionClipPlane(5, 2, plane);

    expect(keeps(plane, 3)).toBe(true);
    expect(keeps(plane, 1)).toBe(false);
  });

  it('keeps the other half from below', () => {
    const plane = new Float32Array(4);
    reflectionClipPlane(0, 2, plane);

    expect(keeps(plane, 1)).toBe(true);
    expect(keeps(plane, 3)).toBe(false);
  });

  it('tolerates a fragment sitting exactly on the plane', () => {
    /*
     * The clip runs against a *displaced* surface, so geometry meeting the waterline lands on
     * either side of it by a fraction depending on the wave. Without the tolerance the shoreline
     * opens a hairline seam that flickers with the swell.
     */
    const plane = new Float32Array(4);
    reflectionClipPlane(5, 2, plane);
    expect(keeps(plane, 2)).toBe(true);
    expect(keeps(plane, 2 - 0.02)).toBe(true);
    expect(keeps(plane, 2 - 0.05)).toBe(false);
  });
});

describe('mirrorCamera', () => {
  it('stands the camera as far below the plane as the viewer is above it', () => {
    const source = new Camera();
    source.position[1] = 5;
    source.pitch = 0.3;
    source.yaw = 1.1;
    source.updateMatrices(1);

    const out = new Camera();
    mirrorCamera(source, 2, 1, out);

    expect(out.position[1]).toBeCloseTo(-1);
    expect(out.pitch).toBeCloseTo(-0.3);
    /* Yaw is unchanged: a horizontal mirror turns a look up into a look down and nothing else. */
    expect(out.yaw).toBeCloseTo(1.1);
  });
});

describe('reflectionTargetSize', () => {
  it('keeps the aspect when the drawing buffer is over the device ceiling', () => {
    /*
     * **One shared factor, not one per axis.** Clamping independently gives 640×640 here, and a
     * mirror rendered at 1:1 and sampled onto a 16:9 surface is a reflection squashed against
     * the thing it reflects.
     */
    const size = reflectionTargetSize(1280, 720, 1, 640, { width: 0, height: 0 });

    expect(size.width).toBe(640);
    expect(size.height).toBe(360);
  });

  it('scales below the ceiling without touching the aspect', () => {
    const size = reflectionTargetSize(1280, 720, 0.5, 4096, { width: 0, height: 0 });

    expect(size.width).toBe(640);
    expect(size.height).toBe(360);
  });
});
