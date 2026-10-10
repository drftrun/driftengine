/**
 * A mesh's indices in the narrowest type that holds them: sixteen bits where every vertex can be
 * named in sixteen, thirty-two otherwise — half the index memory for every mesh of 65,536 vertices
 * or fewer, which is most of them. Lossless because `validateMeshData` has already refused an
 * index past the last vertex.
 *
 * **Padded to an even count**, so the sixteen-bit copy is a whole number of four-byte words: WebGPU
 * writes a buffer only in whole words. The extra index is never drawn, since every draw counts the
 * mesh's own indices. What would make this wrong is a draw that counts the buffer instead.
 *
 * **What it costs** is a copy of the indices while the mesh is built, let go once they are on the
 * device; and every draw of the mesh has to say which width it holds, which is why the width
 * travels with the mesh rather than being worked out where it is drawn.
 */

/** The most vertices sixteen-bit indices can name: every index below 65,536. */
export const MAX_UINT16_VERTICES = 65536;

export function compactIndices(
  indices: Uint32Array,
  vertexCount: number,
): Uint16Array | Uint32Array {
  if (vertexCount > MAX_UINT16_VERTICES) return indices;
  const out = new Uint16Array(indices.length + (indices.length % 2));
  out.set(indices);
  return out;
}
