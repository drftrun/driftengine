import { describe, expect, it } from 'vitest';
import { boxShape, capsuleShape, hullShape, sphereShape, shapeBounds } from './shape.ts';
import type { ConvexShape } from './shape.ts';

/** True when the packed direction list contains `dir` as a line (sign ignored). */
function hasDirection(packed: Float32Array, dx: number, dy: number, dz: number): boolean {
  const len = Math.hypot(dx, dy, dz);
  for (let i = 0; i < packed.length; i += 3) {
    const dot =
      ((packed[i] ?? 0) * dx + (packed[i + 1] ?? 0) * dy + (packed[i + 2] ?? 0) * dz) / len;
    if (Math.abs(dot) > 1 - 1e-3) return true;
  }
  return false;
}

function directionCount(packed: Float32Array): number {
  return packed.length / 3;
}

describe('boxShape', () => {
  it('is eight corners, three face directions, three edge directions', () => {
    const shape = boxShape(0.35, 0.85, 0.35);
    expect(shape.vertices.length).toBe(24);
    expect(directionCount(shape.faceNormals)).toBe(3);
    expect(directionCount(shape.edgeDirs)).toBe(3);
    expect(hasDirection(shape.faceNormals, 1, 0, 0)).toBe(true);
    expect(hasDirection(shape.faceNormals, 0, 1, 0)).toBe(true);
    expect(hasDirection(shape.faceNormals, 0, 0, 1)).toBe(true);
    expect(shape.radius).toBe(0);
    expect(shape.boundRadius).toBeCloseTo(Math.hypot(0.35, 0.85, 0.35), 12);
  });
});

describe('sphereShape', () => {
  it('is one vertex and a radius, with no separating features of its own', () => {
    const shape = sphereShape(0.4);
    expect(shape.vertices.length).toBe(3);
    expect(shape.faceNormals.length).toBe(0);
    expect(shape.edgeDirs.length).toBe(0);
    expect(shape.radius).toBe(0.4);
    expect(shape.boundRadius).toBe(0.4);
  });
});

describe('hullShape', () => {
  const cube = (h: number, rot = 0): number[] => {
    const pts: number[] = [];
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    for (const x of [-h, h]) {
      for (const y of [-h, h]) {
        for (const z of [-h, h]) {
          // Rotate about z so a tilted cube's features tilt with it.
          pts.push(x * c - y * s, x * s + y * c, z);
        }
      }
    }
    return pts;
  };

  it('recovers a cube: three face directions, three edge directions', () => {
    const shape = hullShape(cube(1));
    expect(shape.vertices.length).toBe(24);
    expect(directionCount(shape.faceNormals)).toBe(3);
    expect(directionCount(shape.edgeDirs)).toBe(3);
    expect(hasDirection(shape.faceNormals, 0, 0, 1)).toBe(true);
  });

  it('features follow a rotated cube instead of staying world-axis', () => {
    const rot = 0.72;
    const shape = hullShape(cube(1, rot));
    expect(hasDirection(shape.faceNormals, Math.cos(rot), Math.sin(rot), 0)).toBe(true);
    expect(hasDirection(shape.faceNormals, -Math.sin(rot), Math.cos(rot), 0)).toBe(true);
    expect(hasDirection(shape.faceNormals, 0, 0, 1)).toBe(true);
    expect(hasDirection(shape.faceNormals, 1, 0, 0)).toBe(false);
  });

  it('a banked slab keeps its banked top as a face direction', () => {
    // A ribbon-like span: two cross-sections along +x, width 4, banked 0.72 rad,
    // slab 0.6 thick — the exact shape a track collider needs to be.
    const bank = 0.72;
    const ny = Math.cos(bank);
    const nz = Math.sin(bank);
    const pts: number[] = [];
    for (const x of [0, 4]) {
      for (const z of [-2, 2]) {
        const topY = (-z * nz) / ny; // top plane satisfies ny*y + nz*z = 0
        pts.push(x, topY, z);
        pts.push(x, topY - 0.6 * ny, z - 0.6 * nz);
      }
    }
    const shape = hullShape(pts);
    expect(hasDirection(shape.faceNormals, 0, ny, nz)).toBe(true);
    expect(hasDirection(shape.edgeDirs, 1, 0, 0)).toBe(true);
  });

  it('deduplicates repeated points', () => {
    const shape = hullShape([0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(shape.vertices.length).toBe(12);
  });

  it('a flat sheet still offers its plane and its rim as axes', () => {
    const shape = hullShape([0, 0, 0, 2, 0, 0, 2, 0, 2, 0, 0, 2]);
    expect(directionCount(shape.faceNormals)).toBe(1);
    expect(hasDirection(shape.faceNormals, 0, 1, 0)).toBe(true);
    expect(shape.edgeDirs.length).toBeGreaterThan(0);
    expect(hasDirection(shape.edgeDirs, 1, 0, 0)).toBe(true);
  });

  it('a rounding radius grows the bound and the bounds', () => {
    const sharp = hullShape([0, 0, 0, 1, 0, 0], 0);
    const round = hullShape([0, 0, 0, 1, 0, 0], 0.25);
    expect(round.boundRadius).toBeCloseTo(sharp.boundRadius + 0.25, 12);
  });
});

describe('shapeBounds', () => {
  const aabb = () => ({ minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 });

  it('is the exact box for a box shape', () => {
    const out = aabb();
    shapeBounds(boxShape(0.35, 0.85, 0.2), out);
    expect(out.minX).toBeCloseTo(-0.35, 6);
    expect(out.maxY).toBeCloseTo(0.85, 6);
    expect(out.maxZ).toBeCloseTo(0.2, 6);
  });

  it('adds the rounding radius on every side', () => {
    const out = aabb();
    shapeBounds(sphereShape(0.4), out);
    expect(out.minX).toBeCloseTo(-0.4, 6);
    expect(out.maxY).toBeCloseTo(0.4, 6);
  });

  it('returns what it was given, filled', () => {
    const out = aabb();
    const shape: ConvexShape = hullShape([1, 2, 3, 5, 2, 3]);
    expect(shapeBounds(shape, out)).toBe(out);
    expect(out.minX).toBeCloseTo(1, 6);
    expect(out.maxX).toBeCloseTo(5, 6);
    expect(out.minY).toBeCloseTo(2, 6);
  });
});

describe('capsuleShape', () => {
  it('is two points and a radius', () => {
    const capsule = capsuleShape(0.4, 1);
    expect(capsule.vertices.length / 3).toBe(2);
    expect(capsule.radius).toBeCloseTo(0.4, 6);
  });

  it('bounds the whole capsule', () => {
    expect(capsuleShape(0.4, 1).boundRadius).toBeCloseTo(1.4, 6);
  });

  it('stands along y, so a character capsule needs no rotation', () => {
    const capsule = capsuleShape(0.4, 1);
    expect(capsule.vertices[1]).toBeCloseTo(-1, 6);
    expect(capsule.vertices[4]).toBeCloseTo(1, 6);
  });

  it('degenerates to a sphere at zero half-height', () => {
    const capsule = capsuleShape(0.5, 0);
    expect(capsule.vertices.length / 3).toBe(1);
    expect(capsule.boundRadius).toBeCloseTo(0.5, 6);
  });

  it('refuses a negative radius rather than producing a shape that is inside out', () => {
    expect(() => capsuleShape(-1, 1)).toThrow(/radius/);
  });

  it('refuses a negative half-height', () => {
    expect(() => capsuleShape(0.4, -1)).toThrow(/halfHeight/);
  });
});
