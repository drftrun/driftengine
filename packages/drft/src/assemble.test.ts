import { describe, expect, it } from 'vitest';

import { assemblyBounds, expandAssembly } from './assemble.ts';
import { ATTR_CHANNEL, ATTR_LAYERS, ATTR_TANGENT, ATTR_UVS } from './drftFormat.ts';
import { SURFACE, SURFACE_FLOATS } from './drftAssembly.ts';
import type { DrftAssembly } from './drftAssembly.ts';
import type { MeshData } from './meshData.ts';

/* A unit quad in XY facing +z: u along +x, v along +y, and a tangent that says so. */
const QUAD: MeshData = {
  positions: new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
  colors: new Float32Array(12),
  emissive: new Float32Array(4),
  uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
  tangents: new Float32Array([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
};

/* One triangle on the plane x + z = 0, wound to face (1, 0, 1)/√2. */
const SLOPE: MeshData = {
  positions: new Float32Array([0, 0, 0, 0, 1, 0, 1, 0, -1]),
  normals: new Float32Array([
    Math.SQRT1_2,
    0,
    Math.SQRT1_2,
    Math.SQRT1_2,
    0,
    Math.SQRT1_2,
    Math.SQRT1_2,
    0,
    Math.SQRT1_2,
  ]),
  colors: new Float32Array(9),
  emissive: new Float32Array(3),
  indices: new Uint32Array([0, 2, 1]),
};

function surface(r: number, g: number, b: number, layer: number): number[] {
  const s = new Array<number>(SURFACE_FLOATS).fill(0);
  s[SURFACE.color] = r;
  s[SURFACE.color + 1] = g;
  s[SURFACE.color + 2] = b;
  s[SURFACE.layer] = layer;
  return s;
}

/** Three columns and a translation. */
const matrix = (x: number[], y: number[], z: number[], t: number[]): number[] => [
  ...x,
  ...y,
  ...z,
  ...t,
];
const round = (a: ArrayLike<number>): number[] =>
  Array.from(a, (v) => Math.round(v * 1e6) / 1e6 + 0);

describe('assembling a mesh from copies of a kit', () => {
  const textured: DrftAssembly = {
    attributes: ATTR_UVS | ATTR_TANGENT | ATTR_LAYERS,
    surfaces: new Float32Array([...surface(1, 0.5, 0.25, 3), ...surface(0, 1, 0, 7)]),
    pieces: new Uint32Array([0, 0]),
    surfaceOf: new Uint32Array([0, 1]),
    transforms: new Float32Array([
      /* Four wide, two high, ten along x. */
      ...matrix([4, 0, 0], [0, 2, 0], [0, 0, 1], [10, 0, 0]),
      /* Mirrored in x and five up. */
      ...matrix([-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 5, 0]),
    ]),
    uv: new Float32Array([
      /* A 2 m tile: 4 m of x is two repeats, 2 m of y a half at 4 m; shifted a quarter. */
      2, 2, 2, 0, 0.5, 0, 0.25, 0 /* Identity. */, 1, 1, 1, 1, 1, 1, 0, 0,
    ]),
  };
  const mesh = expandAssembly(textured, () => QUAD);

  it('A COPY IS ITS PIECE MOVED, PAINTED BY ITS SURFACE, ITS UVS STRETCHED IN METRES ALONG THE PIECE’S OWN TANGENT', () => {
    expect(round(mesh.positions.subarray(0, 12))).toEqual([8, -1, 0, 12, -1, 0, 12, 1, 0, 8, 1, 0]);
    /* u from 0 to 2 repeats plus a quarter; v from 0 to a half. */
    expect(round(mesh.uvs?.subarray(0, 8) ?? [])).toEqual([0.25, 0, 2.25, 0, 2.25, 0.5, 0.25, 0.5]);
    expect(round(mesh.colors.subarray(0, 3))).toEqual([1, 0.5, 0.25]);
    expect(Array.from(mesh.layers ?? [])).toEqual([3, 3, 3, 3, 7, 7, 7, 7]);
    expect(Array.from(mesh.indices.subarray(0, 6))).toEqual([0, 1, 2, 0, 2, 3]);
  });

  it('A MIRRORED COPY STILL FACES OUT: ITS TRIANGLES WIND BACK AND ITS TANGENT CHANGES HANDS', () => {
    /* x negated: the first corner (−0.5, −0.5) lands at (0.5, 4.5). */
    expect(round(mesh.positions.subarray(12, 15))).toEqual([0.5, 4.5, 0]);
    /* The normal still +z; each triangle reversed so it is counter-clockwise seen from +z. */
    expect(round(mesh.normals.subarray(12, 15))).toEqual([0, 0, 1]);
    expect(Array.from(mesh.indices.subarray(6, 12))).toEqual([4, 6, 5, 4, 7, 6]);
    /* The tangent points along −x now, and w = −1 keeps the bitangent on +y where v runs. */
    expect(round(mesh.tangents?.subarray(16, 20) ?? [])).toEqual([-1, 0, 0, -1]);
  });

  it('NORMALS FOLLOW THE INVERSE TRANSPOSE, SO A STRETCHED SLOPE STAYS PERPENDICULAR TO ITSELF', () => {
    const slope = expandAssembly(
      {
        attributes: 0,
        surfaces: new Float32Array(surface(1, 1, 1, 0)),
        pieces: new Uint32Array([1]),
        surfaceOf: new Uint32Array([0]),
        transforms: new Float32Array(matrix([2, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, 0])),
        uv: new Float32Array([1, 1, 1, 1, 1, 1, 0, 0]),
      },
      () => SLOPE,
    );
    /* Stretched twice along x the face runs through (2, 0, −1): its normal is (1, 0, 2)/√5, where
       the matrix itself would have turned the normal to (2, 0, 1)/√5. */
    expect(round(slope.normals.subarray(0, 3))).toEqual(
      round([1 / Math.sqrt(5), 0, 2 / Math.sqrt(5)]),
    );
    expect(slope.uvs).toBeUndefined();
    /* A quarter turn about y takes the quad's +z face to +x, and its tangent from +x to −z. A
       rotation is its own inverse transpose, so a transposed normal matrix turns it to −x. */
    const turned = expandAssembly(
      {
        attributes: ATTR_UVS | ATTR_TANGENT,
        surfaces: new Float32Array(surface(1, 1, 1, 0)),
        pieces: new Uint32Array([0]),
        surfaceOf: new Uint32Array([0]),
        transforms: new Float32Array(matrix([0, 0, -1], [0, 1, 0], [1, 0, 0], [0, 0, 0])),
        uv: new Float32Array([1, 1, 1, 1, 1, 1, 0, 0]),
      },
      () => QUAD,
    );
    expect(round(turned.normals.subarray(0, 3))).toEqual([1, 0, 0]);
    expect(round(turned.tangents?.subarray(0, 4) ?? [])).toEqual([0, 0, -1, 1]);
  });

  it('bounds are every copy’s piece box through its matrix', () => {
    /* The first copy spans x 8..12 and y −1..1; the mirrored one x −0.5..0.5 and y 4.5..5.5. */
    expect(round(assemblyBounds(textured, () => QUAD))).toEqual([-0.5, -1, 0, 12, 5.5, 0]);
  });
});

describe('what a piece carries into its copies', () => {
  it('A PIECE’S SWAY IS ITS OWN: A COPY CARRIES ITS PIECE’S CHANNEL, WHEREVER AND HOWEVER TURNED', () => {
    /* A tree's sway rises from its root to its leaves whatever stands it where: shape, not paint. */
    const swaying: MeshData = {
      ...SLOPE,
      channel: new Float32Array([0, 1, 1, 0, 0.5, 1, 1, 0, 1, 1, 1, 0]),
    };
    const mesh = expandAssembly(
      {
        attributes: ATTR_CHANNEL,
        surfaces: new Float32Array(surface(1, 1, 1, 0)),
        pieces: new Uint32Array([0, 0]),
        surfaceOf: new Uint32Array([0, 0]),
        transforms: new Float32Array([
          ...matrix([1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, 0]),
          ...matrix([0, 0, -1], [0, 2, 0], [1, 0, 0], [9, 0, 0]),
        ]),
        uv: new Float32Array(16).fill(1),
      },
      () => swaying,
    );
    const sway = Array.from(mesh.channel ?? []).filter((_, i) => i % 4 === 0);
    expect(sway).toEqual([0, 0.5, 1, 0, 0.5, 1]);
  });
});
