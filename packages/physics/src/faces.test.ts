import { describe, expect, it } from 'vitest';
import { faceCount, faceVertices } from './faces.ts';
import { boxShape, hullShape, sphereShape } from './shape.ts';

describe('face data', () => {
  it('gives a box six faces, not three axes', () => {
    expect(faceCount(boxShape(1, 1, 1))).toBe(6);
  });

  it('gives each box face four vertices', () => {
    const shape = boxShape(1, 2, 3);
    const out = new Uint16Array(16);
    for (let face = 0; face < 6; face++) {
      expect(faceVertices(shape, face, out)).toBe(4);
    }
  });

  it('places every face vertex on its own plane', () => {
    const shape = boxShape(1, 2, 3);
    const out = new Uint16Array(16);
    for (let face = 0; face < faceCount(shape); face++) {
      const nx = shape.facePlanes[face * 4] ?? 0;
      const ny = shape.facePlanes[face * 4 + 1] ?? 0;
      const nz = shape.facePlanes[face * 4 + 2] ?? 0;
      const d = shape.facePlanes[face * 4 + 3] ?? 0;
      const n = faceVertices(shape, face, out);
      for (let i = 0; i < n; i++) {
        const v = (out[i] ?? 0) * 3;
        const x = shape.vertices[v] ?? 0;
        const y = shape.vertices[v + 1] ?? 0;
        const z = shape.vertices[v + 2] ?? 0;
        expect(nx * x + ny * y + nz * z - d).toBeCloseTo(0, 5);
      }
    }
  });

  it('points every face plane outward', () => {
    const shape = boxShape(1, 2, 3);
    for (let face = 0; face < faceCount(shape); face++) {
      // The origin is inside a box centred on it, so every outward plane has a positive offset.
      expect(shape.facePlanes[face * 4 + 3] ?? 0).toBeGreaterThan(0);
    }
  });

  it('winds each face counter-clockwise seen from outside', () => {
    const shape = boxShape(1, 1, 1);
    const out = new Uint16Array(16);
    for (let face = 0; face < faceCount(shape); face++) {
      const n = faceVertices(shape, face, out);
      const a = (out[0] ?? 0) * 3;
      const b = (out[1] ?? 0) * 3;
      const c = (out[2] ?? 0) * 3;
      const ux = (shape.vertices[b] ?? 0) - (shape.vertices[a] ?? 0);
      const uy = (shape.vertices[b + 1] ?? 0) - (shape.vertices[a + 1] ?? 0);
      const uz = (shape.vertices[b + 2] ?? 0) - (shape.vertices[a + 2] ?? 0);
      const vx = (shape.vertices[c] ?? 0) - (shape.vertices[a] ?? 0);
      const vy = (shape.vertices[c + 1] ?? 0) - (shape.vertices[a + 1] ?? 0);
      const vz = (shape.vertices[c + 2] ?? 0) - (shape.vertices[a + 2] ?? 0);
      const crossX = uy * vz - uz * vy;
      const crossY = uz * vx - ux * vz;
      const crossZ = ux * vy - uy * vx;
      const nx = shape.facePlanes[face * 4] ?? 0;
      const ny = shape.facePlanes[face * 4 + 1] ?? 0;
      const nz = shape.facePlanes[face * 4 + 2] ?? 0;
      expect(crossX * nx + crossY * ny + crossZ * nz).toBeGreaterThan(0);
      expect(n).toBe(4);
    }
  });

  it('gives a tetrahedron four triangular faces', () => {
    const shape = hullShape([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(faceCount(shape)).toBe(4);
    const out = new Uint16Array(16);
    for (let face = 0; face < 4; face++) expect(faceVertices(shape, face, out)).toBe(3);
  });

  it('winds a hull face outward too, not only a box face', () => {
    const shape = hullShape([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const out = new Uint16Array(16);
    for (let face = 0; face < faceCount(shape); face++) {
      faceVertices(shape, face, out);
      const a = (out[0] ?? 0) * 3;
      const b = (out[1] ?? 0) * 3;
      const c = (out[2] ?? 0) * 3;
      const ux = (shape.vertices[b] ?? 0) - (shape.vertices[a] ?? 0);
      const uy = (shape.vertices[b + 1] ?? 0) - (shape.vertices[a + 1] ?? 0);
      const uz = (shape.vertices[b + 2] ?? 0) - (shape.vertices[a + 2] ?? 0);
      const vx = (shape.vertices[c] ?? 0) - (shape.vertices[a] ?? 0);
      const vy = (shape.vertices[c + 1] ?? 0) - (shape.vertices[a + 1] ?? 0);
      const vz = (shape.vertices[c + 2] ?? 0) - (shape.vertices[a + 2] ?? 0);
      const crossX = uy * vz - uz * vy;
      const crossY = uz * vx - ux * vz;
      const crossZ = ux * vy - uy * vx;
      const nx = shape.facePlanes[face * 4] ?? 0;
      const ny = shape.facePlanes[face * 4 + 1] ?? 0;
      const nz = shape.facePlanes[face * 4 + 2] ?? 0;
      expect(crossX * nx + crossY * ny + crossZ * nz).toBeGreaterThan(0);
    }
  });

  it('gives a sphere no faces, because it separates on the other shape', () => {
    expect(faceCount(sphereShape(1))).toBe(0);
  });

  it('gives a capsule no faces either', () => {
    expect(faceCount(hullShape([0, -1, 0, 0, 1, 0], 0.5))).toBe(0);
  });

  it('leaves the SAT axis lists untouched', () => {
    // `faceNormals` is deduped directions and stays three for a box; `facePlanes` is six.
    const shape = boxShape(1, 1, 1);
    expect(shape.faceNormals.length / 3).toBe(3);
    expect(faceCount(shape)).toBe(6);
  });
});
