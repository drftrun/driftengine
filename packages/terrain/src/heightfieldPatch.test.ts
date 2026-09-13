import { describe, expect, test } from 'vitest';

import { Terrain } from './heightfield.ts';
import { heightfieldPatch } from './heightfieldPatch.ts';
import { TerrainMaterials } from './terrainMaterials.ts';

/**
 * A field with a bump in it, so every vertex has a different height and a different normal.
 *
 * **The cross term is not decoration.** A field of the form `f(x) + g(z)` is *separable*, and for a
 * separable field a bilinear patch and the two triangles that span it are the same surface — the
 * expansions cancel exactly. So a test comparing a query against a mesh over a separable field
 * passes whichever interpolation the query uses, which is the one thing these tests exist to tell
 * apart. Measured: with `sin(x) + cos(z)` alone, making `heightAt` bilinear turned nothing red.
 */
function bumpy(size = 9): Terrain {
  return new Terrain({
    width: size,
    depth: size,
    spacingM: 1,
    heights: Float32Array.from({ length: size * size }, (_, i) => {
      const x = i % size;
      const z = Math.floor(i / size);
      return Math.sin(x * 0.6) * 1.5 + Math.cos(z * 0.4) * 0.9 + Math.sin(x * 0.4 + z * 0.5) * 0.7;
    }),
  });
}

describe('the geometry a patch emits', () => {
  test('stands on the surface the query answers, vertex for vertex', () => {
    /*
     * **The claim the whole package is built on.** A heightfield is drawn as triangles and queried
     * as a surface, and those are the same surface here or a character floats over half of every
     * cell. Asserted for every vertex rather than for a sample of them, because the failure is
     * per-cell and a spot check would find it only by luck.
     */
    const terrain = bumpy();
    const mesh = heightfieldPatch(terrain, { x: 0, z: 0, cells: 8 });

    for (let v = 0; v < mesh.positions.length; v += 3) {
      const x = mesh.positions[v] ?? 0;
      const y = mesh.positions[v + 1] ?? 0;
      const z = mesh.positions[v + 2] ?? 0;
      expect(y).toBeCloseTo(terrain.heightAt(x, z), 5);
    }
  });

  test('carries the field normal at each vertex rather than a face normal', () => {
    const terrain = bumpy();
    const mesh = heightfieldPatch(terrain, { x: 0, z: 0, cells: 8 });
    const expected = new Float32Array(3);

    for (let v = 0; v < mesh.positions.length; v += 3) {
      terrain.normalAt(mesh.positions[v] ?? 0, mesh.positions[v + 2] ?? 0, expected);
      expect(mesh.normals[v]).toBeCloseTo(expected[0] ?? 0, 5);
      expect(mesh.normals[v + 1]).toBeCloseTo(expected[1] ?? 0, 5);
      expect(mesh.normals[v + 2]).toBeCloseTo(expected[2] ?? 0, 5);
    }
  });

  test('winds every triangle so its own normal points up', () => {
    /*
     * A ground surface drawn the other way round is culled and the world has a hole in it — which
     * on a flat-lit page looks exactly like the terrain not having been submitted at all. Checked
     * per triangle rather than on the first one, since a mistake in the second of the two a cell
     * emits is the one that survives a glance at the code.
     */
    const mesh = heightfieldPatch(bumpy(), { x: 0, z: 0, cells: 8 });

    for (let i = 0; i < mesh.indices.length; i += 3) {
      const a = (mesh.indices[i] ?? 0) * 3;
      const b = (mesh.indices[i + 1] ?? 0) * 3;
      const c = (mesh.indices[i + 2] ?? 0) * 3;
      const ux = (mesh.positions[b] ?? 0) - (mesh.positions[a] ?? 0);
      const uz = (mesh.positions[b + 2] ?? 0) - (mesh.positions[a + 2] ?? 0);
      const vx = (mesh.positions[c] ?? 0) - (mesh.positions[a] ?? 0);
      const vz = (mesh.positions[c + 2] ?? 0) - (mesh.positions[a + 2] ?? 0);
      /* Only the y of the cross product, which is what says which way the face looks. */
      const upward = uz * vx - ux * vz;
      expect(upward).toBeGreaterThan(0);
    }
  });

  test('is the surface the query answers *between* the vertices too, not only at them', () => {
    /*
     * **The assertion that was missing, and the defect it now catches.** Every vertex of a patch
     * lies on both of a cell's possible triangulations, so asserting the vertices proves only that
     * the samples agree — and the mesh was split along one diagonal while `heightAt` read the other
     * for two rows of this track without a single test noticing. The test fields hid it too: a
     * field of the form `f(x) + g(z)` is separable, and for a separable field both diagonals give
     * the same surface.
     *
     * So this reads the mesh's own triangle under a point off the lattice, and compares it with
     * what the query says the ground is there.
     */
    const terrain = bumpy();
    const mesh = heightfieldPatch(terrain, { x: 0, z: 0, cells: 8 });

    let checked = 0;
    for (let cell = 0; cell < 40; cell++) {
      const x = 0.5 + (cell % 7) + 0.23;
      const z = 0.5 + Math.floor(cell / 7) + 0.61;
      if (x > 8 || z > 8) continue;
      expect(meshHeightAt(mesh, x, z)).toBeCloseTo(terrain.heightAt(x, z), 5);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(20);
  });

  test('covers exactly the cells it was asked for', () => {
    const terrain = bumpy();
    const mesh = heightfieldPatch(terrain, { x: 2, z: 3, cells: 4 });

    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let v = 0; v < mesh.positions.length; v += 3) {
      minX = Math.min(minX, mesh.positions[v] ?? 0);
      maxX = Math.max(maxX, mesh.positions[v] ?? 0);
      minZ = Math.min(minZ, mesh.positions[v + 2] ?? 0);
      maxZ = Math.max(maxZ, mesh.positions[v + 2] ?? 0);
    }

    expect(minX).toBeCloseTo(2, 6);
    expect(maxX).toBeCloseTo(6, 6);
    expect(minZ).toBeCloseTo(3, 6);
    expect(maxZ).toBeCloseTo(7, 6);
  });

  test('emits two triangles per drawn cell, and drops to a quarter of them at half the detail', () => {
    const terrain = bumpy();
    const fine = heightfieldPatch(terrain, { x: 0, z: 0, cells: 8, step: 1 });
    const coarse = heightfieldPatch(terrain, { x: 0, z: 0, cells: 8, step: 2 });

    expect(fine.indices.length).toBe(8 * 8 * 6);
    expect(coarse.indices.length).toBe(4 * 4 * 6);
  });
});

describe('the seam between two levels of detail', () => {
  /**
   * The claim: a fine patch beside a coarse one shares an *identical* edge.
   *
   * **A crack in terrain is a hole through to the sky**, and it appears exactly where two patches
   * at different detail meet: the fine one has a vertex the coarse one does not, and that vertex
   * sits on the field while the coarse edge cuts the chord beneath it. Skirts hide that; matching
   * the edge removes it. What is asserted is the removal — every vertex of the fine edge lies on
   * the coarse edge's own straight segment.
   */
  test('puts the fine edge exactly on the coarse one', () => {
    const terrain = bumpy();
    const fine = heightfieldPatch(terrain, {
      x: 0,
      z: 0,
      cells: 8,
      step: 1,
      neighbours: { plusX: 2 },
    });

    /* The far edge of the patch, at x = 8, where the neighbour draws at half the detail. */
    let checked = 0;
    for (let v = 0; v < fine.positions.length; v += 3) {
      const x = fine.positions[v] ?? 0;
      if (Math.abs(x - 8) > 1e-6) continue;
      const z = fine.positions[v + 2] ?? 0;
      const y = fine.positions[v + 1] ?? 0;
      /* Where the coarse neighbour's own edge is at this z: a chord between its samples. */
      const below = Math.floor(z / 2) * 2;
      const above = Math.min(8, below + 2);
      const t = above === below ? 0 : (z - below) / (above - below);
      const chord = terrain.heightAt(8, below) * (1 - t) + terrain.heightAt(8, above) * t;
      expect(y).toBeCloseTo(chord, 5);
      checked += 1;
    }
    expect(checked).toBe(9);
  });

  test('and leaves the edge alone where the neighbour draws at the same detail', () => {
    /* The control. Without it the assertion above is satisfied by a patch that flattens every
       edge it has, which would be a seam that matches and a surface that does not. */
    const terrain = bumpy();
    const plain = heightfieldPatch(terrain, { x: 0, z: 0, cells: 8, step: 1 });

    let offField = 0;
    for (let v = 0; v < plain.positions.length; v += 3) {
      const x = plain.positions[v] ?? 0;
      if (Math.abs(x - 8) > 1e-6) continue;
      const y = plain.positions[v + 1] ?? 0;
      if (Math.abs(y - terrain.heightAt(8, plain.positions[v + 2] ?? 0)) > 1e-5) offField += 1;
    }

    expect(offField).toBe(0);
  });

  test('matches on every side it is told about, and only there', () => {
    const terrain = bumpy();
    const mesh = heightfieldPatch(terrain, {
      x: 0,
      z: 0,
      cells: 8,
      step: 1,
      neighbours: { minusX: 2, minusZ: 4 },
    });

    /* An interior vertex is untouched whatever the neighbours are doing. */
    for (let v = 0; v < mesh.positions.length; v += 3) {
      const x = mesh.positions[v] ?? 0;
      const z = mesh.positions[v + 2] ?? 0;
      if (x <= 0 || x >= 8 || z <= 0 || z >= 8) continue;
      expect(mesh.positions[v + 1]).toBeCloseTo(terrain.heightAt(x, z), 5);
    }

    /* And the two named edges are chords. `z = 1` on the `minusX` edge is an odd vertex. */
    const at = (x: number, z: number): number => {
      for (let v = 0; v < mesh.positions.length; v += 3) {
        if (
          Math.abs((mesh.positions[v] ?? 0) - x) < 1e-6 &&
          Math.abs((mesh.positions[v + 2] ?? 0) - z) < 1e-6
        ) {
          return mesh.positions[v + 1] ?? 0;
        }
      }
      throw new Error(`no vertex at ${x}, ${z}`);
    };
    expect(at(0, 1)).toBeCloseTo((terrain.heightAt(0, 0) + terrain.heightAt(0, 2)) / 2, 5);
    expect(at(1, 0)).toBeCloseTo(terrain.heightAt(0, 0) * 0.75 + terrain.heightAt(4, 0) * 0.25, 5);
  });
});

describe('what a patch refuses', () => {
  test('a step that does not divide the patch, which would leave a strip undrawn', () => {
    expect(() => heightfieldPatch(bumpy(), { x: 0, z: 0, cells: 5, step: 2 })).toThrow(/step/);
  });

  test('a neighbour whose step is not a multiple of this one, which cannot be matched', () => {
    expect(() =>
      heightfieldPatch(bumpy(), { x: 0, z: 0, cells: 8, step: 2, neighbours: { plusX: 3 } }),
    ).toThrow(/neighbour/);
  });

  test('a patch that runs off the end of the field', () => {
    expect(() => heightfieldPatch(bumpy(9), { x: 4, z: 0, cells: 8 })).toThrow(/field/);
  });
});

describe('a patch shaded by a weight map', () => {
  const materials = new TerrainMaterials({
    materials: [
      { color: [1, 0, 0], emissive: 1, specular: 0 },
      { color: [0, 0, 1], emissive: 0, specular: 0.8 },
    ],
    width: 2,
    depth: 2,
    /* All of the first material at x = 0 and all of the second at x = 1, so the blend runs along
       x and every vertex differs from its neighbour. */
    weights: new Float32Array([1, 0, 0, 1, 1, 0, 0, 1]),
  });

  test('takes the colour the map gives at each vertex, in the field own extent', () => {
    const terrain = bumpy();
    const mesh = heightfieldPatch(terrain, { x: 0, z: 0, cells: 8, materials });
    const expected = new Float32Array(3);

    for (let v = 0; v < mesh.positions.length; v += 3) {
      const u = ((mesh.positions[v] ?? 0) - (terrain.origin[0] ?? 0)) / terrain.extentX;
      const w = ((mesh.positions[v + 2] ?? 0) - (terrain.origin[2] ?? 0)) / terrain.extentZ;
      materials.colorAt(u, w, expected);
      expect(mesh.colors[v]).toBeCloseTo(expected[0] ?? 0, 5);
      expect(mesh.colors[v + 1]).toBeCloseTo(expected[1] ?? 0, 5);
      expect(mesh.colors[v + 2]).toBeCloseTo(expected[2] ?? 0, 5);
    }
  });

  test('gives two patches the same colour where they meet, so there is no seam to see', () => {
    /*
     * The colour comes from the field's own coordinates rather than the patch's, so a vertex on a
     * shared edge is shaded identically by both patches. Shading from a patch-local coordinate
     * would restart the blend at every boundary — a grid of visible squares, which is the failure
     * this asserts against.
     */
    const terrain = bumpy(9);
    const left = heightfieldPatch(terrain, { x: 0, z: 0, cells: 4, materials });
    const right = heightfieldPatch(terrain, { x: 4, z: 0, cells: 4, materials });

    const colourAt = (
      mesh: { positions: Float32Array; colors: Float32Array },
      x: number,
      z: number,
    ): number[] => {
      for (let v = 0; v < mesh.positions.length; v += 3) {
        if (
          Math.abs((mesh.positions[v] ?? 0) - x) < 1e-6 &&
          Math.abs((mesh.positions[v + 2] ?? 0) - z) < 1e-6
        ) {
          return [mesh.colors[v] ?? 0, mesh.colors[v + 1] ?? 0, mesh.colors[v + 2] ?? 0];
        }
      }
      throw new Error(`no vertex at ${x}, ${z}`);
    };

    for (const z of [0, 2, 4]) {
      const a = colourAt(left, 4, z);
      const b = colourAt(right, 4, z);
      expect(a[0]).toBeCloseTo(b[0] ?? 0, 6);
      expect(a[1]).toBeCloseTo(b[1] ?? 0, 6);
      expect(a[2]).toBeCloseTo(b[2] ?? 0, 6);
    }
  });

  test('emits a specular buffer only where a material shines', () => {
    const terrain = bumpy();
    const shiny = heightfieldPatch(terrain, { x: 0, z: 0, cells: 4, materials });
    const dull = heightfieldPatch(terrain, {
      x: 0,
      z: 0,
      cells: 4,
      materials: new TerrainMaterials({
        materials: [{ color: [1, 0, 0] }, { color: [0, 0, 1] }],
        width: 2,
        depth: 2,
        weights: new Float32Array([1, 0, 0, 1, 1, 0, 0, 1]),
      }),
    });

    expect(shiny.specular).toBeDefined();
    expect(dull.specular).toBeUndefined();
  });

  test('blends the emissive through the same weights', () => {
    const terrain = bumpy();
    const mesh = heightfieldPatch(terrain, { x: 0, z: 0, cells: 8, materials });

    for (let i = 0; i < mesh.emissive.length; i++) {
      const u = ((mesh.positions[i * 3] ?? 0) - (terrain.origin[0] ?? 0)) / terrain.extentX;
      const w = ((mesh.positions[i * 3 + 2] ?? 0) - (terrain.origin[2] ?? 0)) / terrain.extentZ;
      expect(mesh.emissive[i]).toBeCloseTo(materials.emissiveAt(u, w), 5);
    }
  });
});

/** The height of a built mesh at a point, by finding the triangle under it. Test-only. */
function meshHeightAt(
  mesh: { positions: Float32Array; indices: Uint32Array },
  x: number,
  z: number,
): number {
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const a = (mesh.indices[i] ?? 0) * 3;
    const b = (mesh.indices[i + 1] ?? 0) * 3;
    const c = (mesh.indices[i + 2] ?? 0) * 3;
    const ax = mesh.positions[a] ?? 0;
    const az = mesh.positions[a + 2] ?? 0;
    const bx = mesh.positions[b] ?? 0;
    const bz = mesh.positions[b + 2] ?? 0;
    const cx = mesh.positions[c] ?? 0;
    const cz = mesh.positions[c + 2] ?? 0;
    const area = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(area) < 1e-12) continue;
    const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / area;
    const v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / area;
    const w = 1 - u - v;
    if (u < -1e-6 || v < -1e-6 || w < -1e-6) continue;
    return (
      u * (mesh.positions[a + 1] ?? 0) +
      v * (mesh.positions[b + 1] ?? 0) +
      w * (mesh.positions[c + 1] ?? 0)
    );
  }
  throw new Error(`no triangle under ${x}, ${z}`);
}
