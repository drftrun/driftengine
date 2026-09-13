import { describe, expect, test } from 'vitest';
import { mat4, vec3 } from 'gl-matrix';

import {
  DecalProjector,
  decalScissor,
  decalToWorldMatrix,
  worldToDecalMatrix,
} from './decalProjector.ts';

/** A point through a column-major 4x4, perspective divide included. */
function through(m: Float32Array, p: readonly [number, number, number]): [number, number, number] {
  const out = vec3.create();
  vec3.transformMat4(out, [p[0], p[1], p[2]], m);
  return [out[0], out[1], out[2]];
}

function viewProjection(eye: readonly [number, number, number]): Float32Array {
  const view = mat4.create();
  mat4.lookAt(view, eye as vec3, [0, 0, 0], [0, 1, 0]);
  const projection = mat4.create();
  mat4.perspective(projection, Math.PI / 3, 16 / 9, 0.1, 100);
  const out = mat4.create();
  mat4.multiply(out, projection, view);
  return out as Float32Array;
}

describe('the projector box', () => {
  test('puts the centre of the box at the origin of decal space', () => {
    const m = worldToDecalMatrix(new Float32Array(16), {
      center: [3, 4, 5],
      halfExtents: [2, 2, 2],
      forward: [0, -1, 0],
      up: [0, 0, 1],
    });

    const at = through(m, [3, 4, 5]);
    expect(at[0]).toBeCloseTo(0, 6);
    expect(at[1]).toBeCloseTo(0, 6);
    expect(at[2]).toBeCloseTo(0, 6);
  });

  test('puts the far face of the box at one along each axis', () => {
    const m = worldToDecalMatrix(new Float32Array(16), {
      center: [0, 0, 0],
      /* Deliberately unequal, since a box scaled the same on every axis cannot catch an axis
         divided by the wrong half-extent. */
      halfExtents: [2, 3, 5],
      forward: [0, -1, 0],
      up: [0, 0, 1],
    });

    /* forward is -y, up is +z, so right is up x forward = +x. */
    expect(through(m, [2, 0, 0])[0]).toBeCloseTo(1, 6);
    expect(through(m, [0, 0, 3])[1]).toBeCloseTo(1, 6);
    expect(through(m, [0, -5, 0])[2]).toBeCloseTo(1, 6);
  });

  test('turns the mark when up turns, which no scalar of the box records', () => {
    const straight = worldToDecalMatrix(new Float32Array(16), {
      center: [0, 0, 0],
      halfExtents: [1, 1, 1],
      forward: [0, -1, 0],
      up: [0, 0, 1],
    });
    const turned = worldToDecalMatrix(new Float32Array(16), {
      center: [0, 0, 0],
      halfExtents: [1, 1, 1],
      forward: [0, -1, 0],
      /* A quarter turn about the projection axis. */
      up: [1, 0, 0],
    });

    /* The same world point reads along one axis of the mark and across the other. */
    const point: [number, number, number] = [1, 0, 0];
    expect(through(straight, point)[0]).toBeCloseTo(1, 6);
    expect(through(straight, point)[1]).toBeCloseTo(0, 6);
    expect(through(turned, point)[0]).toBeCloseTo(0, 6);
    expect(through(turned, point)[1]).toBeCloseTo(1, 6);
  });

  test('re-derives the frame when up is not perpendicular to forward', () => {
    const m = worldToDecalMatrix(new Float32Array(16), {
      center: [0, 0, 0],
      halfExtents: [1, 1, 1],
      forward: [0, -1, 0],
      /* Leaning into the projection axis by 45 degrees, which a caller aiming a projector by hand
         does constantly. */
      up: [0, -1, 1],
    });

    /* Orthonormal or the mark shears: the three axes must still land on the three unit points. */
    expect(through(m, [1, 0, 0])[0]).toBeCloseTo(1, 6);
    expect(through(m, [0, 0, 1])[1]).toBeCloseTo(1, 6);
    expect(through(m, [0, -1, 0])[2]).toBeCloseTo(1, 6);
  });

  test('refuses a frame with no orientation rather than dividing by zero', () => {
    expect(() =>
      worldToDecalMatrix(new Float32Array(16), {
        center: [0, 0, 0],
        halfExtents: [1, 1, 1],
        forward: [0, -1, 0],
        up: [0, 2, 0],
      }),
    ).toThrow(/parallel/);
  });

  test('refuses a box with no volume, which would divide every axis by zero', () => {
    expect(() =>
      worldToDecalMatrix(new Float32Array(16), {
        center: [0, 0, 0],
        halfExtents: [1, 0, 1],
        forward: [0, -1, 0],
        up: [0, 0, 1],
      }),
    ).toThrow(/halfExtents/);
  });

  test('the two matrices are inverses, so a fragment and a corner agree about the box', () => {
    const options = {
      center: [1, -2, 3] as const,
      halfExtents: [2, 0.5, 4] as const,
      forward: [1, -2, 0.5] as const,
      up: [0.2, 1, 0] as const,
    };
    const toDecal = worldToDecalMatrix(new Float32Array(16), options);
    const toWorld = decalToWorldMatrix(new Float32Array(16), options);

    for (const corner of [
      [1, 1, 1],
      [-1, 1, -1],
      [0.25, -0.75, 0.5],
    ] as const) {
      const world = through(toWorld, corner);
      const back = through(toDecal, world);
      expect(back[0]).toBeCloseTo(corner[0], 5);
      expect(back[1]).toBeCloseTo(corner[1], 5);
      expect(back[2]).toBeCloseTo(corner[2], 5);
    }
  });
});

describe('the scissor the box is drawn through', () => {
  const options = {
    center: [0, 0, 0] as const,
    halfExtents: [1, 1, 1] as const,
    forward: [0, -1, 0] as const,
    up: [0, 0, 1] as const,
  };
  const toWorld = decalToWorldMatrix(new Float32Array(16), options);

  test('bounds a box in front of the camera inside the viewport', () => {
    const out = new Int32Array(4);
    const drawn = decalScissor(viewProjection([0, 0, 12]), toWorld, 1280, 720, false, out);

    expect(drawn).toBe(true);
    expect(out[0]).toBeGreaterThan(0);
    expect(out[1]).toBeGreaterThan(0);
    /* A two-metre box twelve metres out covers a small part of the frame and not the whole of it. */
    expect(out[2]).toBeLessThan(1280);
    expect(out[3]).toBeLessThan(720);
    expect((out[0] ?? 0) + (out[2] ?? 0)).toBeLessThanOrEqual(1280);
    expect((out[1] ?? 0) + (out[3] ?? 0)).toBeLessThanOrEqual(720);
  });

  test('centres that box, so the bound is the projection and not an approximation of it', () => {
    const out = new Int32Array(4);
    decalScissor(viewProjection([0, 0, 12]), toWorld, 1280, 720, false, out);

    const midX = (out[0] ?? 0) + (out[2] ?? 0) / 2;
    const midY = (out[1] ?? 0) + (out[3] ?? 0) / 2;
    expect(midX).toBeGreaterThan(1280 / 2 - 2);
    expect(midX).toBeLessThan(1280 / 2 + 2);
    expect(midY).toBeGreaterThan(720 / 2 - 2);
    expect(midY).toBeLessThan(720 / 2 + 2);
  });

  test('flips the rectangle for a backend whose framebuffer Y runs down', () => {
    const high = decalToWorldMatrix(new Float32Array(16), { ...options, center: [0, 3, 0] });
    const up = new Int32Array(4);
    const down = new Int32Array(4);
    const camera = viewProjection([0, 0, 12]);

    decalScissor(camera, high, 1280, 720, false, up);
    decalScissor(camera, high, 1280, 720, true, down);

    /* A box above the axis is in the top half either way — near the top of a Y-down frame and near
       the bottom of a Y-up one, which is the same pixels described twice. */
    expect(up[3]).toBe(down[3]);
    expect(up[2]).toBe(down[2]);
    expect(down[1]).toBe(720 - (up[1] ?? 0) - (up[3] ?? 0));
    expect(up[1]).toBeGreaterThan(360);
    expect(down[1]).toBeLessThan(360);
  });

  test('skips a box the camera is not looking at', () => {
    const aside = decalToWorldMatrix(new Float32Array(16), { ...options, center: [60, 0, 0] });
    const out = new Int32Array(4);

    expect(decalScissor(viewProjection([0, 0, 12]), aside, 1280, 720, false, out)).toBe(false);
  });

  test('skips a box entirely behind the camera', () => {
    const behind = decalToWorldMatrix(new Float32Array(16), { ...options, center: [0, 0, 24] });
    const out = new Int32Array(4);

    /* The camera stands at z = 12 looking at the origin, so a box at z = 24 is squarely behind it —
       and every corner of it projects to a w below zero, which is where a bound taken from the
       divided corners reads as a perfectly ordinary rectangle in the middle of the screen. */
    expect(decalScissor(viewProjection([0, 0, 12]), behind, 1280, 720, false, out)).toBe(false);
  });

  test('draws the whole viewport for a box the camera stands inside', () => {
    const around = decalToWorldMatrix(new Float32Array(16), {
      ...options,
      center: [0, 0, 12],
      halfExtents: [4, 4, 4],
    });
    const out = new Int32Array(4);

    expect(decalScissor(viewProjection([0, 0, 12]), around, 1280, 720, false, out)).toBe(true);
    expect([...out]).toEqual([0, 0, 1280, 720]);
  });

  test('clamps to the viewport, since a scissor outside it is rejected', () => {
    const wide = decalToWorldMatrix(new Float32Array(16), {
      ...options,
      halfExtents: [40, 40, 40],
    });
    const out = new Int32Array(4);

    expect(decalScissor(viewProjection([0, 0, 12]), wide, 1280, 720, false, out)).toBe(true);
    expect(out[0]).toBeGreaterThanOrEqual(0);
    expect(out[1]).toBeGreaterThanOrEqual(0);
    expect((out[0] ?? 0) + (out[2] ?? 0)).toBeLessThanOrEqual(1280);
    expect((out[1] ?? 0) + (out[3] ?? 0)).toBeLessThanOrEqual(720);
  });
});

describe('the projector a consumer holds', () => {
  test('follows a pose set every frame without allocating a matrix per frame', () => {
    const projector = new DecalProjector({
      center: [0, 0, 0],
      halfExtents: [1, 1, 1],
      forward: [0, -1, 0],
      up: [0, 0, 1],
    });
    const before = projector.worldToDecal;

    projector.setPose([5, 0, 0], [0, -1, 0], [0, 0, 1]);

    expect(projector.worldToDecal).toBe(before);
    expect(through(projector.worldToDecal, [5, 0, 0])[0]).toBeCloseTo(0, 6);
  });

  test('carries the projection axis in world space, which the facing test needs', () => {
    const projector = new DecalProjector({
      center: [0, 0, 0],
      halfExtents: [1, 1, 1],
      forward: [0, -2, 0],
      up: [0, 0, 1],
    });

    /* Normalised, because the shader compares it against a unit normal. */
    expect([...projector.axis]).toEqual([0, -1, 0]);
  });

  test('defaults a mark that is opaque, white, soft-edged and turned away from a wall', () => {
    const projector = new DecalProjector({
      center: [0, 0, 0],
      halfExtents: [1, 1, 1],
      forward: [0, -1, 0],
      up: [0, 0, 1],
    });

    expect(projector.opacity).toBe(1);
    expect([...projector.color]).toEqual([1, 1, 1]);
    expect(projector.softness).toBeGreaterThan(0);
    expect(projector.facingCos).toBeGreaterThan(0);
  });
});
