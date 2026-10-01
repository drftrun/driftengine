/**
 * Meshes moved and joined as typed arrays: the loader's fast path, with no builder in between.
 *
 * **`MeshBuilder` is for building geometry, and a loader was using it to copy geometry.** It
 * pushes every vertex one number at a time into growable arrays, and it carries the attributes a
 * procedural mesh has. Streaming a bought courtyard spent seven seconds of its main thread there,
 * copying each part twice, once to upload it and once into its merge group. Worse, the builder has
 * no tangent channel, so every normal-mapped part lost the frame its file carried and the shader
 * fell back to derivatives.
 *
 * So `placeMesh` moves a mesh by a fit, or hands it back untouched when the fit is the identity,
 * and `concatMeshes` joins a group once, into arrays sized in advance. An attribute one member
 * lacks is filled with the value a mesh without it draws with (`ABSENT_ATTRIBUTE`). One no member
 * carries is left out, as absent rather than invented.
 */
import { ABSENT_ATTRIBUTE } from '../render/vertexDefaults.ts';
import type { MeshData } from '../render/mesh.ts';

/** The optional per-vertex attributes, with how many floats a vertex each carries. */
const OPTIONAL = [
  ['specular', 1],
  ['tangents', 4],
  ['uvs', 2],
  ['emissiveColor', 3],
  ['roughness', 1],
  ['grain', 1],
  ['relief', 1],
  ['channel', 4],
  ['joints', 4],
  ['weights', 4],
  ['layers', 1],
] as const;

/**
 * `mesh` scaled uniformly and then moved by `x, y, z`. The same object when the fit is the
 * identity; otherwise a copy of the positions and every other attribute shared, since a uniform
 * scale turns no normal. Morph deltas are the caller's to scale.
 */
export function placeMesh(mesh: MeshData, x: number, y: number, z: number, scale = 1): MeshData {
  if (x === 0 && y === 0 && z === 0 && scale === 1) return mesh;
  const from = mesh.positions;
  const positions = new Float32Array(from.length);
  for (let i = 0; i + 2 < from.length; i += 3) {
    positions[i] = (from[i] as number) * scale + x;
    positions[i + 1] = (from[i + 1] as number) * scale + y;
    positions[i + 2] = (from[i + 2] as number) * scale + z;
  }
  return { ...mesh, positions };
}

/** `meshes` as one, in order, each member's indices moved past the vertices before it. */
export function concatMeshes(meshes: readonly MeshData[]): MeshData {
  const only = meshes[0];
  if (meshes.length === 1 && only !== undefined) return only;
  let vertices = 0;
  let indexCount = 0;
  for (const mesh of meshes) {
    vertices += mesh.positions.length / 3;
    indexCount += mesh.indices.length;
  }
  const out: MeshData = {
    positions: new Float32Array(vertices * 3),
    normals: new Float32Array(vertices * 3),
    colors: new Float32Array(vertices * 3),
    emissive: new Float32Array(vertices),
    indices: new Uint32Array(indexCount),
  };
  const optional = out as unknown as Record<string, Float32Array | undefined>;
  for (const [key, width] of OPTIONAL) {
    if (meshes.some((mesh) => mesh[key] !== undefined)) {
      optional[key] = new Float32Array(vertices * width);
    }
  }
  let vertex = 0;
  let index = 0;
  for (const mesh of meshes) {
    const count = mesh.positions.length / 3;
    out.positions.set(mesh.positions, vertex * 3);
    out.normals.set(mesh.normals, vertex * 3);
    out.colors.set(mesh.colors, vertex * 3);
    out.emissive.set(mesh.emissive, vertex);
    for (const [key, width] of OPTIONAL) {
      const target = optional[key];
      if (target === undefined) continue;
      const source = mesh[key];
      if (source !== undefined) {
        target.set(source, vertex * width);
        continue;
      }
      const fill = ABSENT_ATTRIBUTE[key] ?? [];
      for (let v = 0; v < count; v++) {
        for (let c = 0; c < width; c++) target[(vertex + v) * width + c] = fill[c] ?? 0;
      }
    }
    const from = mesh.indices;
    for (let i = 0; i < from.length; i++) out.indices[index + i] = (from[i] as number) + vertex;
    vertex += count;
    index += from.length;
  }
  return out;
}
