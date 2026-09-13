import { generateTangents } from '@driftengine/core';
import type { MeshData } from '@driftengine/drft';

/**
 * Derive a tangent frame for a mesh that has none, **after** it has been welded.
 *
 * **The order is the point of this function existing.** `generateTangents` accumulates a frame per
 * index, so a vertex shared by several triangles gets the sum of all of them and comes out smooth
 * — which is what it was written to do. Run on a mesh as a file stores it, and a great many files
 * store one vertex per triangle corner, every corner is its own index and gets exactly one
 * triangle's frame. Two corners at the same point then disagree, and the weld cannot merge them,
 * because two corners alike in position, normal and UV but opposite in the bitangent's sign are a
 * mirrored UV shell and merging those lights one side of a model inside out. Nothing can tell the
 * two cases apart from the data.
 *
 * **Measured on a rotationally unwrapped corner soup**, which is the shape a CAD conversion
 * arrives in: 9,600 corners weld to 1,681 vertices with no frame present and to 9,482 with a frame
 * derived per corner, with up to six different frames at one point. Deriving afterwards gives
 * 1,681 vertices and one frame each, and the frame is *better* — averaged over every triangle at
 * the vertex, which is the smoothing the derivation exists for and which a soup cannot supply.
 *
 * A mesh that already carries a frame is returned untouched: authored data is the file's to state.
 * A mesh with no texture coordinates is returned untouched too, since there is no texture
 * direction to derive one along.
 */
export function deriveTangentsFor(mesh: MeshData): MeshData {
  if (mesh.tangents !== undefined || mesh.uvs === undefined) return mesh;
  return {
    ...mesh,
    tangents: generateTangents(mesh.positions, mesh.normals, mesh.uvs, mesh.indices),
  };
}
