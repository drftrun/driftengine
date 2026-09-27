/**
 * What an edge collapse is judged by: how far it moves the surface, and how far it slides a texture.
 *
 * The surface is measured by quadrics (Garland and Heckbert): each vertex carries the planes of the
 * faces around it as ten sums, weighted by area, and a point's cost is its squared distance from
 * them. The texture is measured against the uv each vertex was painted with, read back off the
 * triangles a collapse leaves. Positions are a flat `Float64Array` of xyz and uvs a flat
 * `Float32Array` of uv, both indexed by vertex.
 */

/** How much a border's own planes weigh against the faces', per unit of edge length squared. */
const BORDER_WEIGHT = 4;
/**
 * How far past a triangle's edge a sample may lie, in barycentric units, and still be measured
 * against it: a vertex on a border that curves, which the straightened border no longer quite
 * reaches. Further out, the surface the sample was painted on has gone from under it.
 */
const NEAR_EDGE = 0.05;

/** A key for the undirected edge `a`–`b` among `v` vertices. */
export function edgeKey(a: number, b: number, v: number): number {
  return a < b ? a * v + b : b * v + a;
}

/** The unit normal of a triangle into `out`, returning twice its area, or 0 for none. */
export function triangleNormal(
  p: Float64Array,
  a: number,
  b: number,
  c: number,
  out: number[],
): number {
  const ux = p[b * 3]! - p[a * 3]!;
  const uy = p[b * 3 + 1]! - p[a * 3 + 1]!;
  const uz = p[b * 3 + 2]! - p[a * 3 + 2]!;
  const vx = p[c * 3]! - p[a * 3]!;
  const vy = p[c * 3 + 1]! - p[a * 3 + 1]!;
  const vz = p[c * 3 + 2]! - p[a * 3 + 2]!;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const length = Math.hypot(nx, ny, nz);
  if (length <= 1e-30) return 0;
  out[0] = nx / length;
  out[1] = ny / length;
  out[2] = nz / length;
  return length;
}

/** Adds the plane `ax + by + cz + d = 0`, weighted by `w`, to vertex `vert`'s quadric. */
export function addPlane(
  q: Float64Array,
  vert: number,
  a: number,
  b: number,
  c: number,
  d: number,
  w: number,
): void {
  const at = vert * 10;
  q[at] = q[at]! + w * a * a;
  q[at + 1] = q[at + 1]! + w * a * b;
  q[at + 2] = q[at + 2]! + w * a * c;
  q[at + 3] = q[at + 3]! + w * a * d;
  q[at + 4] = q[at + 4]! + w * b * b;
  q[at + 5] = q[at + 5]! + w * b * c;
  q[at + 6] = q[at + 6]! + w * b * d;
  q[at + 7] = q[at + 7]! + w * c * c;
  q[at + 8] = q[at + 8]! + w * c * d;
  q[at + 9] = q[at + 9]! + w * d * d;
}

/** Vertex `vert`'s quadric at the point `x, y, z`: its planes' weighted squared distance from it. */
export function quadricAt(q: Float64Array, vert: number, x: number, y: number, z: number): number {
  const at = vert * 10;
  return (
    q[at]! * x * x +
    2 * q[at + 1]! * x * y +
    2 * q[at + 2]! * x * z +
    2 * q[at + 3]! * x +
    q[at + 4]! * y * y +
    2 * q[at + 5]! * y * z +
    2 * q[at + 6]! * y +
    q[at + 7]! * z * z +
    2 * q[at + 8]! * z +
    q[at + 9]!
  );
}

/** Every face's plane on its three corners, weighted by its area, and each corner's area summed. */
export function addFacePlanes(
  p: Float64Array,
  faces: Uint32Array,
  quadric: Float64Array,
  area: Float64Array,
): void {
  const f = faces.length / 3;
  const n = [0, 0, 0];
  for (let face = 0; face < f; face++) {
    const a = faces[face * 3] as number;
    const b = faces[face * 3 + 1] as number;
    const c = faces[face * 3 + 2] as number;
    const twice = triangleNormal(p, a, b, c, n);
    if (twice <= 0) continue;
    const w = twice / 2;
    const d = -(n[0]! * p[a * 3]! + n[1]! * p[a * 3 + 1]! + n[2]! * p[a * 3 + 2]!);
    for (const vert of [a, b, c]) {
      addPlane(quadric, vert, n[0]!, n[1]!, n[2]!, d, w);
      area[vert] = area[vert]! + w;
    }
  }
}

/**
 * A plane standing on every open edge, perpendicular to its face, so a border holds its line.
 * `edges` counts the faces on each edge, keyed by `edgeKey`.
 */
export function addBorderPlanes(
  p: Float64Array,
  faces: Uint32Array,
  edges: ReadonlyMap<number, number>,
  quadric: Float64Array,
): void {
  const v = p.length / 3;
  const f = faces.length / 3;
  const n = [0, 0, 0];
  for (let face = 0; face < f; face++) {
    const a0 = faces[face * 3] as number;
    const b0 = faces[face * 3 + 1] as number;
    const c0 = faces[face * 3 + 2] as number;
    if (triangleNormal(p, a0, b0, c0, n) <= 0) continue;
    for (let k = 0; k < 3; k++) {
      const a = faces[face * 3 + k] as number;
      const b = faces[face * 3 + ((k + 1) % 3)] as number;
      if (edges.get(edgeKey(a, b, v)) !== 1) continue;
      const ex = p[b * 3]! - p[a * 3]!;
      const ey = p[b * 3 + 1]! - p[a * 3 + 1]!;
      const ez = p[b * 3 + 2]! - p[a * 3 + 2]!;
      let px = ey * n[2]! - ez * n[1]!;
      let py = ez * n[0]! - ex * n[2]!;
      let pz = ex * n[1]! - ey * n[0]!;
      const length = Math.hypot(px, py, pz);
      if (length <= 0) continue;
      px /= length;
      py /= length;
      pz /= length;
      const d = -(px * p[a * 3]! + py * p[a * 3 + 1]! + pz * p[a * 3 + 2]!);
      const w = BORDER_WEIGHT * (ex * ex + ey * ey + ez * ez);
      addPlane(quadric, a, px, py, pz, d, w);
      addPlane(quadric, b, px, py, pz, d, w);
    }
  }
}

/** A triangle's signed area in uv. */
export function uvArea(uvs: Float32Array, a: number, b: number, c: number): number {
  const ux = uvs[b * 2]! - uvs[a * 2]!;
  const uy = uvs[b * 2 + 1]! - uvs[a * 2 + 1]!;
  const vx = uvs[c * 2]! - uvs[a * 2]!;
  const vy = uvs[c * 2 + 1]! - uvs[a * 2 + 1]!;
  return (ux * vy - uy * vx) / 2;
}

/**
 * How far `sample`'s own uv is from what the triangles in `corners` interpolate where it lies: the
 * triangle it projects into, or the nearest one where it projects into none.
 */
export function uvMiss(
  p: Float64Array,
  uvs: Float32Array,
  corners: readonly number[],
  sample: number,
): number {
  let inside = Infinity;
  let nearest = Infinity;
  let nearestMiss = Infinity;
  const px = p[sample * 3]!;
  const py = p[sample * 3 + 1]!;
  const pz = p[sample * 3 + 2]!;
  for (let t = 0; t < corners.length; t += 3) {
    const a = corners[t] as number;
    const b = corners[t + 1] as number;
    const c = corners[t + 2] as number;
    const e0x = p[b * 3]! - p[a * 3]!;
    const e0y = p[b * 3 + 1]! - p[a * 3 + 1]!;
    const e0z = p[b * 3 + 2]! - p[a * 3 + 2]!;
    const e1x = p[c * 3]! - p[a * 3]!;
    const e1y = p[c * 3 + 1]! - p[a * 3 + 1]!;
    const e1z = p[c * 3 + 2]! - p[a * 3 + 2]!;
    const qx = px - p[a * 3]!;
    const qy = py - p[a * 3 + 1]!;
    const qz = pz - p[a * 3 + 2]!;
    const d00 = e0x * e0x + e0y * e0y + e0z * e0z;
    const d01 = e0x * e1x + e0y * e1y + e0z * e1z;
    const d11 = e1x * e1x + e1y * e1y + e1z * e1z;
    const d20 = qx * e0x + qy * e0y + qz * e0z;
    const d21 = qx * e1x + qy * e1y + qz * e1z;
    const denominator = d00 * d11 - d01 * d01;
    if (denominator <= 1e-30) continue;
    const beta = (d11 * d20 - d01 * d21) / denominator;
    const gamma = (d00 * d21 - d01 * d20) / denominator;
    const alpha = 1 - beta - gamma;
    const outside = Math.max(0, -alpha, -beta, -gamma);
    const u = alpha * uvs[a * 2]! + beta * uvs[b * 2]! + gamma * uvs[c * 2]!;
    const w = alpha * uvs[a * 2 + 1]! + beta * uvs[b * 2 + 1]! + gamma * uvs[c * 2 + 1]!;
    const miss = Math.hypot(u - uvs[sample * 2]!, w - uvs[sample * 2 + 1]!);
    if (outside < 1e-6) inside = Math.min(inside, miss);
    else if (outside < nearest) {
      nearest = outside;
      nearestMiss = miss;
    }
  }
  if (inside !== Infinity) return inside;
  return nearest < NEAR_EDGE ? nearestMiss : Infinity;
}
