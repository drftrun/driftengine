import { describe, expect, it } from 'vitest';

import { validateMeshData } from './meshData.ts';

/** Three vertices, one triangle, nothing optional. */
function base() {
  return {
    positions: new Float32Array(9),
    normals: new Float32Array(9),
    colors: new Float32Array(9),
    emissive: new Float32Array(3),
    indices: new Uint32Array([0, 1, 2]),
  };
}

describe('skinning attributes', () => {
  it('accepts a mesh with four influences per vertex', () => {
    expect(() =>
      validateMeshData({
        ...base(),
        joints: new Float32Array(12),
        weights: new Float32Array(12),
      }),
    ).not.toThrow();
  });

  /*
   * One without the other is a mesh that cannot be skinned and will draw collapsed at the origin,
   * which is a silent failure a validator can turn into a loud one.
   */
  it('refuses joints without weights, and weights without joints', () => {
    expect(() => validateMeshData({ ...base(), joints: new Float32Array(12) })).toThrow(/weights/i);
    expect(() => validateMeshData({ ...base(), weights: new Float32Array(12) })).toThrow(/joints/i);
  });

  it('refuses a count that is not four per vertex', () => {
    expect(() =>
      validateMeshData({
        ...base(),
        joints: new Float32Array(8),
        weights: new Float32Array(8),
      }),
    ).toThrow(/4 per vertex/);
  });
});

describe('the attribute that was already there', () => {
  /*
   * `tangents` was declared optional on 2026-08-22 and never added to this validator, so the
   * widest optional attribute in the format — four floats a vertex — was the one a short buffer
   * could reach the driver through. The hazard is the one this function's own header describes: a
   * driver may read zeroes and may equally drop the draw, with no GL error either way.
   */
  it('refuses a short tangent array', () => {
    expect(() => validateMeshData({ ...base(), tangents: new Float32Array(8) })).toThrow(
      /tangents/,
    );
  });

  it('accepts a correct one', () => {
    expect(() => validateMeshData({ ...base(), tangents: new Float32Array(12) })).not.toThrow();
  });
});

describe('morph targets', () => {
  it('accepts a mesh with three targets', () => {
    expect(() =>
      validateMeshData({
        ...base(),
        morphTargets: new Float32Array(3 * 3 * 3),
        morphTargetCount: 3,
      }),
    ).not.toThrow();
  });

  /*
   * The count and the array go together. A mesh declaring one without the other is a mesh that
   * says it deforms and cannot, or carries deltas nothing will ever weight — both draw a picture
   * rather than raising anything.
   */
  it('refuses one without the other', () => {
    expect(() => validateMeshData({ ...base(), morphTargets: new Float32Array(9) })).toThrow(
      /go together/,
    );
    expect(() => validateMeshData({ ...base(), morphTargetCount: 2 })).toThrow(/go together/);
  });

  /*
   * The one attribute whose length is not a fixed multiple of the vertex count — it scales with
   * the targets too, so `check` cannot express it. A short array reads as zero in its tail, and
   * the last targets then silently never move anything.
   */
  it('refuses an array that does not cover every vertex of every target', () => {
    expect(() =>
      validateMeshData({
        ...base(),
        morphTargets: new Float32Array(3 * 3),
        morphTargetCount: 2,
      }),
    ).toThrow(/expected 18/);
  });
});

/*
 * The four-lane channel. Its width is the thing worth asserting: a short array here is the same
 * hazard every other attribute has, and the lanes mean four different things, so a caller who
 * supplies one float a vertex has written a mesh whose sky factor is some other vertex's sway.
 */
describe('the per-vertex channel', () => {
  it('refuses a channel array that is not four floats a vertex', () => {
    expect(() => validateMeshData({ ...base(), channel: new Float32Array(9) })).toThrow(
      /channel has 9 floats for 3 vertices/,
    );
  });

  it('accepts a channel array of four floats a vertex', () => {
    expect(() => validateMeshData({ ...base(), channel: new Float32Array(12) })).not.toThrow();
  });
});
