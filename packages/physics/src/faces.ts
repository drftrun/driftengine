import type { ConvexShape } from './shape.ts';

/**
 * A shape's faces, as planes and as ordered vertex loops.
 *
 * **`faceNormals` is not this, and the two are deliberately separate.** That array is deduped
 * *directions* — a box has three, because a plane and its opposite are one separating axis — which
 * is exactly what SAT wants and exactly what clipping cannot use. A contact manifold needs the
 * reference face's plane and the incident face's ordered loop, so a box needs six of each.
 *
 * CSR rather than an array of arrays: traversal allocates nothing, and a shape built of typed
 * arrays alone is structured-cloneable, so it survives a `postMessage` into a worker.
 *
 * **What this gives up** is memory on every shape, whether or not anything clips it: four floats
 * per face plus one index per face vertex. **What would make it wrong** is a consumer building tens
 * of thousands of shapes for broad-phase-only use, at which point the answer is a builder flag
 * rather than a second shape type.
 */

/** How many faces the shape has. Zero for a sphere or a capsule, which have none. */
export function faceCount(shape: ConvexShape): number {
  return shape.faceVertexStart.length === 0 ? 0 : shape.faceVertexStart.length - 1;
}

/**
 * Fill `out` with the vertex indices of one face, wound counter-clockwise seen from outside.
 *
 * Returns how many were written. `out` must hold at least that many; a face cannot have more
 * vertices than the shape has, so `new Uint16Array(shape.vertices.length / 3)` always suffices.
 */
export function faceVertices(shape: ConvexShape, face: number, out: Uint16Array): number {
  const start = shape.faceVertexStart[face] ?? 0;
  const end = shape.faceVertexStart[face + 1] ?? start;
  const n = end - start;
  for (let i = 0; i < n; i++) out[i] = shape.faceVertexIndices[start + i] ?? 0;
  return n;
}
