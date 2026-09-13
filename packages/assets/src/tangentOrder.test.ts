import { expect, test } from 'vitest';
import type { MeshData } from '@driftengine/drft';
import { deriveTangentsFor, weldMesh } from './index.ts';

/**
 * The order a tangent frame is derived in, which is the whole of this file.
 *
 * `generateTangents` accumulates a frame per *index*, so a vertex shared by two triangles gets
 * the sum of both and comes out smooth. Run on a mesh the way a great many files store one — a
 * corner soup, one vertex per triangle corner — every corner is its own index, gets exactly one
 * triangle's frame, and no two corners at the same point agree. The weld then meets corners
 * differing in an attribute it must respect, because two corners alike in position, normal and UV
 * but opposite in the bitangent's sign are a mirrored UV shell and merging them lights one side of
 * a model inside out. It cannot tell that case from this one, so it keeps them apart.
 *
 * **The unwrap below is rotational, and that is load-bearing.** The frame is normalised, so what
 * has to differ between two triangles is the *direction* u increases in and not its rate. A
 * separable unwrap — u from x, v from y — gives every triangle on a plane one direction and every
 * corner the same frame, and a version of this measurement built that way showed no difference at
 * all. That is the shape of a test that would pass with the bug present.
 */

/** A grid of quads as corner soup, unwrapped by angle and radius about its own centre. */
function cornerSoup(cells: number): MeshData {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const push = (x: number, y: number) => {
    positions.push(x, y, 0);
    normals.push(0, 0, 1);
    const dx = x - cells / 2;
    const dy = y - cells / 2;
    uvs.push(Math.atan2(dy, dx) / (Math.PI * 2) + 0.5, Math.hypot(dx, dy) / cells);
    indices.push(indices.length);
  };
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      push(x, y);
      push(x + 1, y);
      push(x + 1, y + 1);
      push(x, y);
      push(x + 1, y + 1);
      push(x, y + 1);
    }
  }
  const count = positions.length / 3;
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(count * 3).fill(1),
    emissive: new Float32Array(count),
    uvs: new Float32Array(uvs),
    indices: new Uint32Array(indices),
  };
}

const CELLS = 20;

test('the fixture is a soup that welds hard, which every assertion below rests on', () => {
  const soup = cornerSoup(CELLS);
  expect(soup.positions.length / 3).toBe(CELLS * CELLS * 6);
  expect(weldMesh(soup).positions.length / 3).toBe((CELLS + 1) * (CELLS + 1));
});

test('deriving after the weld costs no vertices, where deriving before costs almost all of them', () => {
  const soup = cornerSoup(CELLS);
  const corners = soup.positions.length / 3;

  const after = deriveTangentsFor(weldMesh(soup));
  const before = weldMesh(deriveTangentsFor(soup));

  expect(after.positions.length / 3).toBe((CELLS + 1) * (CELLS + 1));
  /* The defect, asserted rather than described: a frame derived first defeats the weld. */
  expect(before.positions.length / 3).toBeGreaterThan(corners * 0.9);
});

test('a frame derived after the weld covers every vertex, four floats each', () => {
  const welded = deriveTangentsFor(weldMesh(cornerSoup(CELLS)));
  expect(welded.tangents).toBeDefined();
  expect(welded.tangents).toHaveLength((welded.positions.length / 3) * 4);
});

test('a mesh that already carries a frame keeps the one it was given', () => {
  const soup = cornerSoup(4);
  const authored = new Float32Array((soup.positions.length / 3) * 4).fill(0.5);
  const out = deriveTangentsFor({ ...soup, tangents: authored });
  expect(out.tangents).toBe(authored);
});

test('a mesh with no texture coordinates gets no frame, because there is nothing to derive one from', () => {
  const soup = cornerSoup(4);
  const without = { ...soup, uvs: undefined };
  const out = deriveTangentsFor(without);
  expect(out.tangents).toBeUndefined();
  /* Returned as it came, so a caller can hand every mesh through without checking first. */
  expect(out).toBe(without);
});
