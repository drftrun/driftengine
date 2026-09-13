import { describe, expect, test } from 'vitest';

import { boxShape } from './shape.ts';
import { createManifold } from './manifold.ts';
import type { Manifold, ShapePose } from './manifold.ts';
import { MAX_MESH_MANIFOLDS, collideMesh } from './meshContact.ts';
import { heightfieldShape } from './heightfieldShape.ts';
import type { Heightfield } from './heightfieldShape.ts';
import { meshShape } from './meshShape.ts';

/**
 * The heightfield collider against the mesh collider, on the same ground.
 *
 * **This is the test the whole thing rests on.** A heightfield path that is merely *plausible* is
 * worth nothing: the mesh path is the one this package has shipped, tested and fixed for a year,
 * and the only claim worth making about a second one is that it answers the same. So every case
 * here builds both shapes over one field and compares the contacts — the normals, the counts and
 * the separations — rather than asserting numbers somebody chose.
 *
 * **The mesh is built here from the rule rather than from the generator**, so this is a
 * cross-check and not a tautology: if `heightfieldShape` split a cell the other way, or numbered
 * its triangles differently, or classified an edge differently, the two would disagree.
 */

const SIZE = 6;

function rolling(): Heightfield {
  const heights = new Float32Array(SIZE * SIZE);
  for (let z = 0; z < SIZE; z++) {
    for (let x = 0; x < SIZE; x++) {
      /* A cross term, so the two triangulations of a cell are genuinely different surfaces — a
         field of the form `f(x) + g(z)` is separable and both diagonals give the same one, which
         is how Track L's diagonal defect hid from every test it had. */
      heights[z * SIZE + x] =
        Math.sin(x * 0.7) * 0.5 + Math.cos(z * 0.5) * 0.4 + Math.sin(x * 0.3 + z * 0.4) * 0.6;
    }
  }
  return { width: SIZE, depth: SIZE, spacingM: 1, heights, origin: [-2, 0, -2] };
}

/**
 * The same field as an explicit mesh: two triangles a cell, `a, d, c` and `a, c, b`.
 *
 * Written out rather than taken from `fieldCorners`, which is the point — the rule appears twice
 * on purpose so that a disagreement between the two implementations shows up here.
 */
function asMesh(field: Heightfield): { positions: Float32Array; indices: Uint32Array } {
  const positions = new Float32Array(field.width * field.depth * 3);
  for (let z = 0; z < field.depth; z++) {
    for (let x = 0; x < field.width; x++) {
      const at = (z * field.width + x) * 3;
      positions[at] = (field.origin?.[0] ?? 0) + x * field.spacingM;
      positions[at + 1] = (field.origin?.[1] ?? 0) + (field.heights[z * field.width + x] ?? 0);
      positions[at + 2] = (field.origin?.[2] ?? 0) + z * field.spacingM;
    }
  }
  const cellsX = field.width - 1;
  const cellsZ = field.depth - 1;
  const indices = new Uint32Array(cellsX * cellsZ * 6);
  let at = 0;
  for (let cz = 0; cz < cellsZ; cz++) {
    for (let cx = 0; cx < cellsX; cx++) {
      const a = cz * field.width + cx;
      const b = a + 1;
      const d = a + field.width;
      const c = d + 1;
      indices[at++] = a;
      indices[at++] = d;
      indices[at++] = c;
      indices[at++] = a;
      indices[at++] = c;
      indices[at++] = b;
    }
  }
  return { positions, indices };
}

const STILL: ShapePose = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 };
const pose = (x: number, y: number, z: number): ShapePose => ({ ...STILL, x, y, z });

function manifolds(): Manifold[] {
  return Array.from({ length: MAX_MESH_MANIFOLDS }, () => createManifold());
}

/** Every contact a shape makes with the ground, flattened so two runs can be compared. */
function contacts(ground: ReturnType<typeof heightfieldShape>, at: ShapePose): string[] {
  const out = manifolds();
  const body = boxShape(0.4, 0.4, 0.4);
  const count = collideMesh(ground, STILL, body, at, 0.02, out);
  const rows: string[] = [];
  for (let m = 0; m < count; m++) {
    const manifold = out[m];
    if (manifold === undefined) continue;
    const points: string[] = [];
    for (let i = 0; i < manifold.count; i++) {
      points.push(
        `${(manifold.points[i * 3] ?? 0).toFixed(4)},` +
          `${(manifold.points[i * 3 + 1] ?? 0).toFixed(4)},` +
          `${(manifold.points[i * 3 + 2] ?? 0).toFixed(4)}` +
          `@${(manifold.separations[i] ?? 0).toFixed(4)}`,
      );
    }
    rows.push(
      `n ${manifold.nx.toFixed(4)},${manifold.ny.toFixed(4)},${manifold.nz.toFixed(4)} ` +
        `[${points.sort().join(' ')}]`,
    );
  }
  return rows.sort();
}

describe('a body resting on a field', () => {
  const field = rolling();
  const mesh = asMesh(field);
  const asTriangles = meshShape(mesh.positions, mesh.indices);
  const asField = heightfieldShape(field);

  test('makes the same contacts against either collider, everywhere over the field', () => {
    let touched = 0;
    for (let i = 0; i < 48; i++) {
      const x = -1.7 + (i % 8) * 0.44;
      const z = -1.7 + Math.floor(i / 8) * 0.55;
      /* Sunk a little into the ground, which is where a solver finds a body between ticks. Read
         off the field rather than recomputed from the formula, which is how the first version of
         this test placed the box six metres above a hill and agreed about nothing. */
      const y = nearestHeight(field, x, z) + 0.38;
      const at = pose(x, y, z);
      const fromMesh = contacts(asTriangles, at);
      const fromField = contacts(asField, at);
      expect(fromField, `at ${x.toFixed(2)}, ${z.toFixed(2)}`).toEqual(fromMesh);
      if (fromMesh.length > 0) touched += 1;
    }
    /* And the sweep actually met the ground, rather than agreeing about nothing. */
    expect(touched).toBeGreaterThan(30);
  });

  test('touches nothing, on either, when it is well clear of the ground', () => {
    const at = pose(0, 20, 0);
    expect(contacts(asField, at)).toEqual([]);
    expect(contacts(asTriangles, at)).toEqual([]);
  });

  test('is not caught on the seams, which is what the interior-edge filter is for', () => {
    /*
     * **A flat floor made of triangles must push a body straight up.** Every seam on one is a
     * coplanar edge, and a contact normal coming off an edge instead of the face is the artefact
     * that reads as a character stumbling once a metre. Asserted directly here rather than only
     * through the comparison above, because a heightfield collider that reproduced the mesh path's
     * *bug* would pass that one.
     */
    const flat: Heightfield = {
      width: 5,
      depth: 5,
      spacingM: 1,
      heights: new Float32Array(25),
      origin: [-2, 0, -2],
    };
    const ground = heightfieldShape(flat);
    const out = manifolds();
    const body = boxShape(0.4, 0.4, 0.4);

    let checked = 0;
    for (let i = 0; i < 24; i++) {
      /* Walked along a line that crosses cell edges and diagonals alike. */
      const x = -1.6 + i * 0.13;
      const count = collideMesh(ground, STILL, body, pose(x, 0.38, x * 0.37), 0.02, out);
      for (let m = 0; m < count; m++) {
        const manifold = out[m];
        if (manifold === undefined || manifold.count === 0) continue;
        /* Straight up, to a thousandth. An edge normal on a flat floor is nowhere near. */
        expect(Math.abs(manifold.ny), `at x ${x.toFixed(2)}`).toBeGreaterThan(0.999);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(10);
  });
});

describe('what the field collider costs', () => {
  test('carries the heights and no geometry, where the mesh carries both and a tree', () => {
    /*
     * **The measurement the whole row exists for**, taken on a field big enough to matter rather
     * than on the toy above.
     */
    const size = 129;
    const heights = new Float32Array(size * size);
    for (let i = 0; i < heights.length; i++) heights[i] = Math.sin(i * 0.03);
    const field: Heightfield = {
      width: size,
      depth: size,
      spacingM: 1,
      heights,
    };
    const mesh = asMesh(field);

    const asMeshBytes = mesh.positions.byteLength + mesh.indices.byteLength;
    const asFieldBytes = heights.byteLength;

    expect(asMeshBytes / asFieldBytes).toBeGreaterThan(5);
    /* And the shape itself holds nothing beyond the field it was handed. */
    const shape = heightfieldShape(field);
    expect(shape.triangles?.positions.byteLength).toBe(0);
    expect(shape.triangles?.indices.byteLength).toBe(0);
    expect(shape.triangles?.tree).toBe(null);
  });
});

/** The field's own sample nearest a place, for putting a body on the ground rather than near it. */
function nearestHeight(field: Heightfield, x: number, z: number): number {
  const ix = Math.min(
    field.width - 1,
    Math.max(0, Math.round((x - (field.origin?.[0] ?? 0)) / field.spacingM)),
  );
  const iz = Math.min(
    field.depth - 1,
    Math.max(0, Math.round((z - (field.origin?.[2] ?? 0)) / field.spacingM)),
  );
  return (field.origin?.[1] ?? 0) + (field.heights[iz * field.width + ix] ?? 0);
}
