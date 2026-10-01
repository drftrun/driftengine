/**
 * A solid: an indexed triangle surface with normals and texture coordinates, and the operations
 * every procedural builder needs on one — place it, join several, measure it, and hand it to the
 * renderer as a mesh.
 *
 * **Why a type of its own rather than `MeshData`.** A mesh carries a dozen per-vertex channels a
 * renderer reads (colour, emissive, roughness, grain, joints…) and a solid is what exists before any
 * of them are decided: shape alone. Booleans, smoothing and transforms are defined on shape, and
 * dragging eleven channels through a boolean would mean deciding how each one interpolates across a
 * cut. The caller paints a finished solid once, with `solidToMesh` or its own writer.
 *
 * **Named `Solid` because `*Shape` is taken**: the physics colliders the core barrel re-exports are
 * `boxShape`, `cylinderShape` and the rest, and a second meaning for the word would read as the
 * same thing. Every primitive here is closed except `solidQuad`, a single-sided plane.
 *
 * Built at load or bake time, never per frame, so these functions allocate their results.
 */
import type { MeshData } from '../render/mesh.ts';
import type { Vec3 } from '../math/color.ts';

export interface Solid {
  /** Three floats a vertex. */
  readonly positions: Float32Array;
  /** Three floats a vertex, unit length, outward. */
  readonly normals: Float32Array;
  /**
   * Two floats a vertex, parametric: 0..1 across each face of a box, around and along a round
   * primitive. Tiling in metres is the caller's, who knows the sizes.
   */
  readonly uvs: Float32Array;
  /** Counter-clockwise triangles seen from outside. */
  readonly indices: Uint32Array;
}

export function emptySolid(): Solid {
  return {
    positions: new Float32Array(0),
    normals: new Float32Array(0),
    uvs: new Float32Array(0),
    indices: new Uint32Array(0),
  };
}

/**
 * `solid` moved by a column-major 4×4 model matrix.
 *
 * **Normals go through the inverse transpose of the upper 3×3**, then are renormalised. Rotating
 * them by the matrix itself is right only for rotations and uniform scales; under a non-uniform one
 * — a unit cylinder scaled to a post, a sphere to an ellipsoid — it leaves every normal leaning
 * toward the stretched axis, and the surface is lit as if it faced somewhere else, which reads as a
 * shading bug rather than a maths one.
 *
 * **A mirror reverses the winding**, because a negative determinant turns every triangle inside
 * out; without the reversal a mirrored solid is culled from outside and its volume goes negative.
 */
export function transformSolid(solid: Solid, model: ArrayLike<number>): Solid {
  const m = (i: number): number => model[i] ?? 0;
  const a = m(0);
  const b = m(4);
  const c = m(8);
  const d = m(1);
  const e = m(5);
  const f = m(9);
  const g = m(2);
  const h = m(6);
  const k = m(10);
  /* Cofactors of the upper 3×3 in row-major (a b c / d e f / g h k): the inverse transpose up to
     the determinant's scale, which renormalising removes — except its sign, kept below. */
  const c00 = e * k - f * h;
  const c01 = f * g - d * k;
  const c02 = d * h - e * g;
  const c10 = c * h - b * k;
  const c11 = a * k - c * g;
  const c12 = b * g - a * h;
  const c20 = b * f - c * e;
  const c21 = c * d - a * f;
  const c22 = a * e - b * d;
  const det = a * c00 + b * c01 + c * c02;
  const sign = det < 0 ? -1 : 1;

  const count = solid.positions.length / 3;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  for (let v = 0; v < count; v++) {
    const x = solid.positions[v * 3] ?? 0;
    const y = solid.positions[v * 3 + 1] ?? 0;
    const z = solid.positions[v * 3 + 2] ?? 0;
    positions[v * 3] = a * x + b * y + c * z + m(12);
    positions[v * 3 + 1] = d * x + e * y + f * z + m(13);
    positions[v * 3 + 2] = g * x + h * y + k * z + m(14);
    const nx = solid.normals[v * 3] ?? 0;
    const ny = solid.normals[v * 3 + 1] ?? 0;
    const nz = solid.normals[v * 3 + 2] ?? 0;
    const tx = (c00 * nx + c01 * ny + c02 * nz) * sign;
    const ty = (c10 * nx + c11 * ny + c12 * nz) * sign;
    const tz = (c20 * nx + c21 * ny + c22 * nz) * sign;
    const len = Math.hypot(tx, ty, tz) || 1;
    normals[v * 3] = tx / len;
    normals[v * 3 + 1] = ty / len;
    normals[v * 3 + 2] = tz / len;
  }
  let indices = solid.indices;
  if (det < 0) {
    indices = new Uint32Array(solid.indices.length);
    for (let t = 0; t < indices.length; t += 3) {
      indices[t] = solid.indices[t] ?? 0;
      indices[t + 1] = solid.indices[t + 2] ?? 0;
      indices[t + 2] = solid.indices[t + 1] ?? 0;
    }
  }
  return { positions, normals, uvs: solid.uvs, indices };
}

/** Several solids as one, each one's indices offset past the vertices before it. */
export function mergeSolids(solids: readonly Solid[]): Solid {
  if (solids.length === 1 && solids[0] !== undefined) return solids[0];
  let vertices = 0;
  let triangles = 0;
  for (const s of solids) {
    vertices += s.positions.length / 3;
    triangles += s.indices.length;
  }
  const positions = new Float32Array(vertices * 3);
  const normals = new Float32Array(vertices * 3);
  const uvs = new Float32Array(vertices * 2);
  const indices = new Uint32Array(triangles);
  let v = 0;
  let t = 0;
  for (const s of solids) {
    positions.set(s.positions, v * 3);
    normals.set(s.normals, v * 3);
    uvs.set(s.uvs, v * 2);
    for (let i = 0; i < s.indices.length; i++) indices[t + i] = (s.indices[i] ?? 0) + v;
    v += s.positions.length / 3;
    t += s.indices.length;
  }
  return { positions, normals, uvs, indices };
}

/**
 * The enclosed volume by the divergence theorem: the sum of each triangle's signed tetrahedron
 * with the origin. Positive for a closed, outward-wound solid; meaningless for an open one.
 *
 * Exact for any closed surface, T-junctions included, which is why the CSG tests can use it on a
 * boolean's output where an edge-pairing check cannot.
 */
export function solidVolume(solid: Solid): number {
  const p = solid.positions;
  const idx = solid.indices;
  let sum = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = (idx[t] ?? 0) * 3;
    const b = (idx[t + 1] ?? 0) * 3;
    const c = (idx[t + 2] ?? 0) * 3;
    const ax = p[a] ?? 0;
    const ay = p[a + 1] ?? 0;
    const az = p[a + 2] ?? 0;
    const bx = p[b] ?? 0;
    const by = p[b + 1] ?? 0;
    const bz = p[b + 2] ?? 0;
    const cx = p[c] ?? 0;
    const cy = p[c + 1] ?? 0;
    const cz = p[c + 2] ?? 0;
    sum += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return sum / 6;
}

/**
 * A solid painted one colour, as a mesh the renderer draws. `emissive` is the usual scalar: the
 * surface's own colour scaled, gated by the environment's night factor like every emissive.
 */
export function solidToMesh(solid: Solid, color: Vec3, emissive = 0): MeshData {
  const count = solid.positions.length / 3;
  const colors = new Float32Array(count * 3);
  for (let v = 0; v < count; v++) {
    colors[v * 3] = color[0];
    colors[v * 3 + 1] = color[1];
    colors[v * 3 + 2] = color[2];
  }
  return {
    positions: solid.positions,
    normals: solid.normals,
    colors,
    emissive: new Float32Array(count).fill(emissive),
    uvs: solid.uvs,
    indices: solid.indices,
  };
}
