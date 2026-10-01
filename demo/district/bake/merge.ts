/**
 * Moving a piece's geometry to where a copy stands, and joining what one region wears alike.
 *
 * **Normals by the inverse transpose, tangents by the matrix, and a mirror flips the winding.** A
 * copy scaled unevenly tilts its normals unless they go through the inverse transpose; a copy whose
 * matrix has a negative determinant is a mirror, and its triangles wind the other way round, which
 * a renderer culling back faces reads as inside out unless the indices are turned back. Blender
 * handles both when it draws, so the bake does too.
 *
 * Offline, so it allocates as it likes.
 */
import { concatMeshes } from '@driftengine/core';
import type { MeshData } from '@driftengine/drft';

import type { Mat4 } from './scene.ts';

function determinant3(m: Mat4): number {
  const g = (i: number): number => m[i] as number;
  return (
    g(0) * (g(5) * g(10) - g(9) * g(6)) -
    g(4) * (g(1) * g(10) - g(9) * g(2)) +
    g(8) * (g(1) * g(6) - g(5) * g(2))
  );
}

/** The inverse transpose of a matrix's 3×3, column-major in a 9. */
function normalMatrix(m: Mat4): number[] {
  const g = (i: number): number => m[i] as number;
  const det = determinant3(m) || 1;
  /* The cofactor matrix over the determinant is the inverse transpose. */
  return [
    (g(5) * g(10) - g(6) * g(9)) / det,
    (g(6) * g(8) - g(4) * g(10)) / det,
    (g(4) * g(9) - g(5) * g(8)) / det,
    (g(2) * g(9) - g(1) * g(10)) / det,
    (g(0) * g(10) - g(2) * g(8)) / det,
    (g(1) * g(8) - g(0) * g(9)) / det,
    (g(1) * g(6) - g(2) * g(5)) / det,
    (g(2) * g(4) - g(0) * g(6)) / det,
    (g(0) * g(5) - g(1) * g(4)) / det,
  ];
}

/** `mesh` moved by `m`. */
export function transformed(mesh: MeshData, m: Mat4): MeshData {
  const g = (i: number): number => m[i] as number;
  const n = normalMatrix(m);
  const h = (i: number): number => n[i] as number;
  const count = mesh.positions.length / 3;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  for (let v = 0; v < count; v++) {
    const x = mesh.positions[v * 3] as number;
    const y = mesh.positions[v * 3 + 1] as number;
    const z = mesh.positions[v * 3 + 2] as number;
    positions[v * 3] = g(0) * x + g(4) * y + g(8) * z + g(12);
    positions[v * 3 + 1] = g(1) * x + g(5) * y + g(9) * z + g(13);
    positions[v * 3 + 2] = g(2) * x + g(6) * y + g(10) * z + g(14);
    const a = mesh.normals[v * 3] as number;
    const b = mesh.normals[v * 3 + 1] as number;
    const c = mesh.normals[v * 3 + 2] as number;
    const nx = h(0) * a + h(3) * b + h(6) * c;
    const ny = h(1) * a + h(4) * b + h(7) * c;
    const nz = h(2) * a + h(5) * b + h(8) * c;
    const length = Math.hypot(nx, ny, nz) || 1;
    normals[v * 3] = nx / length;
    normals[v * 3 + 1] = ny / length;
    normals[v * 3 + 2] = nz / length;
  }
  const mirrored = determinant3(m) < 0;
  let tangents = mesh.tangents;
  if (tangents !== undefined) {
    const out = new Float32Array(tangents.length);
    for (let v = 0; v < count; v++) {
      const a = tangents[v * 4] as number;
      const b = tangents[v * 4 + 1] as number;
      const c = tangents[v * 4 + 2] as number;
      const tx = g(0) * a + g(4) * b + g(8) * c;
      const ty = g(1) * a + g(5) * b + g(9) * c;
      const tz = g(2) * a + g(6) * b + g(10) * c;
      const length = Math.hypot(tx, ty, tz) || 1;
      out[v * 4] = tx / length;
      out[v * 4 + 1] = ty / length;
      out[v * 4 + 2] = tz / length;
      out[v * 4 + 3] = (tangents[v * 4 + 3] as number) * (mirrored ? -1 : 1);
    }
    tangents = out;
  }
  let indices = mesh.indices;
  if (mirrored) {
    indices = new Uint32Array(indices.length);
    for (let t = 0; t < indices.length; t += 3) {
      indices[t] = mesh.indices[t] as number;
      indices[t + 1] = mesh.indices[t + 2] as number;
      indices[t + 2] = mesh.indices[t + 1] as number;
    }
  }
  return { ...mesh, positions, normals, indices, ...(tangents === undefined ? {} : { tangents }) };
}

/** Join meshes into one, or null where there are none. */
export function joined(meshes: readonly MeshData[]): MeshData | null {
  if (meshes.length === 0) return null;
  if (meshes.length === 1) return meshes[0] as MeshData;
  return concatMeshes(meshes);
}

/** Min xyz then max xyz of meshes' positions. */
export function boundsOfMeshes(meshes: readonly MeshData[]): number[] {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const mesh of meshes) {
    const p = mesh.positions;
    for (let i = 0; i < p.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const v = p[i + k] as number;
        if (v < (b[k] as number)) b[k] = v;
        if (v > (b[k + 3] as number)) b[k + 3] = v;
      }
    }
  }
  return b;
}

/** A box's corners moved by `m`, as a new box. */
export function movedBounds(bounds: ArrayLike<number>, m: Mat4): number[] {
  const out = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const x of [bounds[0] as number, bounds[3] as number]) {
    for (const y of [bounds[1] as number, bounds[4] as number]) {
      for (const z of [bounds[2] as number, bounds[5] as number]) {
        const p = [
          (m[0] as number) * x + (m[4] as number) * y + (m[8] as number) * z + (m[12] as number),
          (m[1] as number) * x + (m[5] as number) * y + (m[9] as number) * z + (m[13] as number),
          (m[2] as number) * x + (m[6] as number) * y + (m[10] as number) * z + (m[14] as number),
        ];
        for (let k = 0; k < 3; k++) {
          out[k] = Math.min(out[k] as number, p[k] as number);
          out[k + 3] = Math.max(out[k + 3] as number, p[k] as number);
        }
      }
    }
  }
  return out;
}
