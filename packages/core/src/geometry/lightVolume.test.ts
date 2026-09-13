import { describe, expect, test } from 'vitest';
import { buildLightVolume } from './lightVolume.ts';
import type { MeshData } from '../render/mesh.ts';
import type { Vec3 } from '../math/color.ts';

const COLOR: Vec3 = [1, 0.86, 0.62];

function vertex(mesh: MeshData, i: number): [number, number, number] {
  return [
    mesh.positions[i * 3] ?? 0,
    mesh.positions[i * 3 + 1] ?? 0,
    mesh.positions[i * 3 + 2] ?? 0,
  ];
}

/** Position quantised, so corners that should coincide share a key. */
function key(mesh: MeshData, i: number): string {
  const q = (v: number): number => Math.round(v * 10_000);
  const [x, y, z] = vertex(mesh, i);
  return `${q(x)},${q(y)},${q(z)}`;
}

describe('buildLightVolume', () => {
  /**
   * The hull is a boundary the march runs inside, so a hole in it is a hole in the light.
   *
   * Watertightness stated as the property that matters rather than as "vertices are shared":
   * in a closed surface every edge belongs to exactly two triangles. It is load-bearing twice
   * over. The renderer culls one half of this hull and keeps the other, so an open surface
   * loses the volume from whichever side the missing face was; and the near cap in particular
   * is what a viewer looking straight up a vertical shaft sees, which is exactly the direction
   * the geometry this replaced failed in.
   */
  test('the hull is closed, so there is no angle the volume is missing from', () => {
    const mesh = buildLightVolume({ nearM: 1.1, lengthM: 90, spread: 0.09, color: COLOR });
    const edges = new Map<string, number>();
    for (let i = 0; i < mesh.indices.length; i += 3) {
      const corners = [mesh.indices[i] ?? 0, mesh.indices[i + 1] ?? 0, mesh.indices[i + 2] ?? 0];
      for (let e = 0; e < 3; e++) {
        const a = key(mesh, corners[e] ?? 0);
        const b = key(mesh, corners[(e + 1) % 3] ?? 0);
        const edge = a < b ? `${a}|${b}` : `${b}|${a}`;
        edges.set(edge, (edges.get(edge) ?? 0) + 1);
      }
    }
    const unshared = [...edges.values()].filter((count) => count !== 2);
    expect(unshared).toEqual([]);
  });

  /**
   * And wound outward, because the renderer picks a face to cull rather than drawing both.
   *
   * Drawing both would march every pixel twice and arrive at double the light; picking the
   * wrong one draws the half that is not there. The signed volume is what tells them apart,
   * and it is measured from the triangles rather than read out of `normals` for the reason
   * the ribbon's own test records: the stored normals are written by hand and would agree
   * with themselves whatever the winding did.
   */
  test('the hull is wound outward, so the renderer culls the half it means to', () => {
    const mesh = buildLightVolume({ nearM: 1.1, lengthM: 90, spread: 0.09, color: COLOR });
    let six = 0;
    for (let i = 0; i < mesh.indices.length; i += 3) {
      const [ax, ay, az] = vertex(mesh, mesh.indices[i] ?? 0);
      const [bx, by, bz] = vertex(mesh, mesh.indices[i + 1] ?? 0);
      const [cx, cy, cz] = vertex(mesh, mesh.indices[i + 2] ?? 0);
      six += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
    }
    /* A frustum from z 1.1 to 90 at this aperture is thousands of cubic metres; the sign is
       the assertion and the magnitude only proves the hull is not degenerate. */
    expect(six / 6).toBeGreaterThan(1000);
  });

  /**
   * The hull has to contain the light, or its silhouette becomes the beam's edge.
   *
   * The march fades the light to nothing at the aperture it is told. If the hull sat inside
   * that aperture, the fade would still be climbing where the polygon ends and the volume
   * would be cut rather than dissolved, which is the hard-edged wedge a consumer shipped in
   * two worlds before this function existed.
   */
  test('the lateral surface stands outside the aperture the light fades over', () => {
    const spread = 0.09;
    const lengthM = 90;
    const mesh = buildLightVolume({ nearM: 1.1, lengthM, spread, color: COLOR });

    let sawFarRim = false;
    for (let i = 0; i < mesh.positions.length / 3; i++) {
      const [x, y, z] = vertex(mesh, i);
      const radius = Math.hypot(x, y);
      /* Cap centres sit on the axis and say nothing about the rim. */
      if (radius < 1e-6) continue;
      expect(radius / Math.max(z, 1e-3) / spread).toBeGreaterThanOrEqual(1);
      if (z > lengthM - 1e-6) sawFarRim = true;
    }
    expect(sawFarRim).toBe(true);
  });

  test('a length that does not reach the near plane is refused at build time', () => {
    expect(() => buildLightVolume({ nearM: 6, lengthM: 4, spread: 0.1, color: COLOR })).toThrow(
      /beyond/,
    );
  });
});
