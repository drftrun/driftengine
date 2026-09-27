/**
 * Copies merged into one mesh, found again: a prototype and a rigid placement for each copy.
 *
 * **What an export does to repeated objects, undone.** A modelling tool that flattens a scene writes
 * N copies of an object as one mesh: N runs of the same triangles, one after another, each run's
 * vertices in the same order, each run moved. A bought scene measured here shipped ten thousand
 * candles that way — nineteen million triangles for one candle's worth of shape. Finding the runs
 * turns that back into one mesh and ten thousand matrices.
 *
 * **Strict, and the strictness is the design.** A count N is accepted only when:
 * - the triangle and vertex counts both divide by N;
 * - every run's indices are run 0's, offset by a whole run of vertices;
 * - every run is a rigid transform of run 0 within a tolerance tied to the run's own size, with its
 *   normals and tangents turned by the same rotation;
 * - every other attribute is exactly equal.
 *
 * One vertex out refuses the count. What that gives up is copies a tool reordered or re-triangulated,
 * which this cannot see. What would make that wrong is a scene where such copies dominate; finding
 * them needs shape matching, not run matching.
 *
 * **Rigid only.** A scaled copy is refused rather than instanced with a scale, because a scale
 * changes what the normals mean and nothing downstream is asked to renormalise them. Skinned and
 * morphed meshes are refused outright: their copies are not placements of one shape.
 */
import type { MeshData } from '@driftengine/drft';

/** The attributes that must be equal between copies, exactly. Directions are compared turned. */
const EQUAL = [
  'colors',
  'emissive',
  'uvs',
  'specular',
  'roughness',
  'grain',
  'relief',
  'emissiveColor',
  'channel',
] as const;

/**
 * How far a copy's normal may sit from the prototype's once turned, as a chord on the unit sphere.
 *
 * **An exporter recomputes normals per copy, and they come out noisy.** Measured on ten thousand
 * copies of one candle: a median worst of 3e-4 and a worst of 2e-3 per copy, about a tenth of a
 * degree, 75 copies over 1e-3. A hundredth, about half a degree, changes shading by well under one
 * 8-bit level, and the prototype's normal is what every copy is then drawn with. What would make it
 * wrong is a copy whose normals were really turned, a softened edge on one of them, which this would
 * flatten into the prototype's.
 */
const DIRECTION_TOLERANCE = 1e-2;

export interface Repeats {
  /** Run 0: one copy's geometry, with its own indices from zero. */
  readonly prototype: MeshData;
  readonly count: number;
  /** One column-major 4×4 matrix a copy, taking the prototype to where that copy was. Copy 0 is identity. */
  readonly transforms: Float32Array;
}

/** How many connected pieces the indices make of the mesh. Unreferenced vertices count as their own. */
export function componentCount(mesh: MeshData): number {
  const vertices = mesh.positions.length / 3;
  const parent = new Int32Array(vertices);
  for (let i = 0; i < vertices; i++) parent[i] = i;
  const find = (x: number): number => {
    let r = x;
    while ((parent[r] as number) !== r) r = parent[r] as number;
    while ((parent[x] as number) !== r) {
      const next = parent[x] as number;
      parent[x] = r;
      x = next;
    }
    return r;
  };
  const indices = mesh.indices;
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = find(indices[t] as number);
    const b = find(indices[t + 1] as number);
    const c = find(indices[t + 2] as number);
    parent[b] = a;
    parent[find(c)] = a;
  }
  let roots = 0;
  for (let i = 0; i < vertices; i++) if (find(i) === i) roots++;
  return roots;
}

/**
 * The prototype and placements for the largest candidate count that `mesh` is exactly that many
 * rigid copies of, or null when none is.
 */
export function findRepeats(mesh: MeshData, candidates: readonly number[]): Repeats | null {
  if (mesh.joints !== undefined || mesh.weights !== undefined || mesh.morphTargets !== undefined) {
    return null;
  }
  const vertices = mesh.positions.length / 3;
  const triangles = mesh.indices.length / 3;
  const counts = [...new Set(candidates)].filter((n) => n > 1).sort((a, b) => b - a);
  /* Built once, the first time a count divides the triangles and not the shared vertices. */
  let corners: MeshData | null = null;
  for (const n of counts) {
    if (triangles % n !== 0) continue;
    if (vertices % n === 0 && sameTopology(mesh.indices, n, vertices / n)) {
      const per = vertices / n;
      const transforms = fitRuns(mesh, n, per);
      if (transforms !== null) return { prototype: runZero(mesh, per, n), count: n, transforms };
      continue;
    }
    /*
     * **Through the triangles, when the vertices do not line up.** An exporter can share corners
     * differently from copy to copy, so the copies' vertex counts differ while their triangles do
     * not: a bought scene's candle wicks were 128 triangles each over a vertex count ten thousand
     * did not divide. One vertex a corner makes every copy the same run. The cost is a copy of the
     * mesh that size, and a prototype that needs welding again, which the baker does anyway.
     */
    corners ??= expandCorners(mesh);
    const per = (triangles * 3) / n;
    const transforms = fitRuns(corners, n, per);
    if (transforms !== null) return { prototype: runZero(corners, per, n), count: n, transforms };
  }
  return null;
}

/** One vertex a triangle corner, in triangle order, so run k of the triangles is run k of the vertices. */
function expandCorners(mesh: MeshData): MeshData {
  const vertices = mesh.positions.length / 3;
  const indices = mesh.indices;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(mesh)) {
    if (!(value instanceof Float32Array)) {
      out[key] = value;
      continue;
    }
    const width = value.length / vertices;
    const expanded = new Float32Array(indices.length * width);
    for (let c = 0; c < indices.length; c++) {
      const from = (indices[c] as number) * width;
      for (let k = 0; k < width; k++) expanded[c * width + k] = value[from + k] as number;
    }
    out[key] = expanded;
  }
  const sequential = new Uint32Array(indices.length);
  for (let c = 0; c < sequential.length; c++) sequential[c] = c;
  out['indices'] = sequential;
  return out as unknown as MeshData;
}

function sameTopology(indices: Uint32Array | Uint16Array, n: number, per: number): boolean {
  const stride = indices.length / n;
  for (let j = 0; j < stride; j++) if ((indices[j] as number) >= per) return false;
  for (let k = 1; k < n; k++) {
    const base = k * stride;
    const offset = k * per;
    for (let j = 0; j < stride; j++) {
      if ((indices[base + j] as number) - offset !== indices[j]) return false;
    }
  }
  return true;
}

function runZero(mesh: MeshData, per: number, n: number): MeshData {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(mesh)) {
    if (value instanceof Float32Array) {
      out[key] = value.slice(0, (value.length / (mesh.positions.length / 3)) * per);
    } else {
      out[key] = value;
    }
  }
  out['indices'] = mesh.indices.slice(0, mesh.indices.length / n);
  return out as unknown as MeshData;
}

/** Every run's placement, or null the moment one run is not a rigid copy of run 0. */
function fitRuns(mesh: MeshData, n: number, per: number): Float32Array | null {
  const p = mesh.positions;
  /* The tolerance, from run 0's own size and the magnitude of the coordinates it sits at. */
  let min0 = Infinity;
  let min1 = Infinity;
  let min2 = Infinity;
  let max0 = -Infinity;
  let max1 = -Infinity;
  let max2 = -Infinity;
  for (let v = 0; v < per; v++) {
    const x = p[v * 3] as number;
    const y = p[v * 3 + 1] as number;
    const z = p[v * 3 + 2] as number;
    min0 = Math.min(min0, x);
    min1 = Math.min(min1, y);
    min2 = Math.min(min2, z);
    max0 = Math.max(max0, x);
    max1 = Math.max(max1, y);
    max2 = Math.max(max2, z);
  }
  const diagonal = Math.hypot(max0 - min0, max1 - min1, max2 - min2);

  const transforms = new Float32Array(n * 16);
  const r = new Float64Array(9);
  const t = new Float64Array(3);
  for (let k = 0; k < n; k++) {
    const base = k * per;
    fitRigid(p, 0, p, base, per, r, t);
    let magnitude = 0;
    for (let i = base * 3; i < (base + per) * 3; i++)
      magnitude = Math.max(magnitude, Math.abs(p[i] as number));
    /*
     * A ten-thousandth of the shape, plus a few float32 steps at the coordinates it sits at. The
     * second term is what lets a copy thirty metres from the origin match at all; the first is what
     * refuses a vertex a modeller actually moved.
     */
    const tolerance = 1e-4 * diagonal + 4e-7 * magnitude + 1e-7;
    if (!placedWithin(mesh, per, base, r, t, tolerance)) return null;
    writeMatrix(transforms, k * 16, r, t);
  }
  return transforms;
}

function placedWithin(
  mesh: MeshData,
  per: number,
  base: number,
  r: Float64Array,
  t: Float64Array,
  tolerance: number,
): boolean {
  const p = mesh.positions;
  const nrm = mesh.normals;
  for (let v = 0; v < per; v++) {
    const a = v * 3;
    const b = (base + v) * 3;
    const x = p[a] as number;
    const y = p[a + 1] as number;
    const z = p[a + 2] as number;
    const px =
      (r[0] as number) * x + (r[1] as number) * y + (r[2] as number) * z + (t[0] as number);
    const py =
      (r[3] as number) * x + (r[4] as number) * y + (r[5] as number) * z + (t[1] as number);
    const pz =
      (r[6] as number) * x + (r[7] as number) * y + (r[8] as number) * z + (t[2] as number);
    if (
      Math.hypot(px - (p[b] as number), py - (p[b + 1] as number), pz - (p[b + 2] as number)) >
      tolerance
    ) {
      return false;
    }
    if (!turned(nrm, a, b, r, DIRECTION_TOLERANCE)) return false;
  }
  const tangents = mesh.tangents;
  if (tangents !== undefined) {
    for (let v = 0; v < per; v++) {
      const a = v * 4;
      const b = (base + v) * 4;
      if (!turned(tangents, a, b, r, DIRECTION_TOLERANCE)) return false;
      if (tangents[a + 3] !== tangents[b + 3]) return false;
    }
  }
  for (const name of EQUAL) {
    const array = mesh[name];
    if (array === undefined) continue;
    const width = array.length / (mesh.positions.length / 3);
    for (let i = 0; i < per * width; i++) {
      if (Math.abs((array[i] as number) - (array[base * width + i] as number)) > 1e-6) return false;
    }
  }
  return true;
}

/** Whether direction `a` in `from`, turned by `r`, is direction `b` in the same array. */
function turned(
  values: Float32Array,
  a: number,
  b: number,
  r: Float64Array,
  tolerance: number,
): boolean {
  const x = values[a] as number;
  const y = values[a + 1] as number;
  const z = values[a + 2] as number;
  const dx =
    (r[0] as number) * x + (r[1] as number) * y + (r[2] as number) * z - (values[b] as number);
  const dy =
    (r[3] as number) * x + (r[4] as number) * y + (r[5] as number) * z - (values[b + 1] as number);
  const dz =
    (r[6] as number) * x + (r[7] as number) * y + (r[8] as number) * z - (values[b + 2] as number);
  return Math.hypot(dx, dy, dz) <= tolerance;
}

/**
 * The rotation and translation taking `count` points of `a` onto `b`, in the least-squares sense:
 * Horn's closed form, the rotation being the quaternion that is the top eigenvector of a symmetric
 * 4×4 built from the two sets' cross-covariance. Row-major 3×3 into `r`.
 */
function fitRigid(
  a: Float32Array,
  aStart: number,
  b: Float32Array,
  bStart: number,
  count: number,
  r: Float64Array,
  t: Float64Array,
): void {
  let ax = 0;
  let ay = 0;
  let az = 0;
  let bx = 0;
  let by = 0;
  let bz = 0;
  for (let v = 0; v < count; v++) {
    ax += a[(aStart + v) * 3] as number;
    ay += a[(aStart + v) * 3 + 1] as number;
    az += a[(aStart + v) * 3 + 2] as number;
    bx += b[(bStart + v) * 3] as number;
    by += b[(bStart + v) * 3 + 1] as number;
    bz += b[(bStart + v) * 3 + 2] as number;
  }
  ax /= count;
  ay /= count;
  az /= count;
  bx /= count;
  by /= count;
  bz /= count;
  let sxx = 0;
  let sxy = 0;
  let sxz = 0;
  let syx = 0;
  let syy = 0;
  let syz = 0;
  let szx = 0;
  let szy = 0;
  let szz = 0;
  for (let v = 0; v < count; v++) {
    const px = (a[(aStart + v) * 3] as number) - ax;
    const py = (a[(aStart + v) * 3 + 1] as number) - ay;
    const pz = (a[(aStart + v) * 3 + 2] as number) - az;
    const qx = (b[(bStart + v) * 3] as number) - bx;
    const qy = (b[(bStart + v) * 3 + 1] as number) - by;
    const qz = (b[(bStart + v) * 3 + 2] as number) - bz;
    sxx += px * qx;
    sxy += px * qy;
    sxz += px * qz;
    syx += py * qx;
    syy += py * qy;
    syz += py * qz;
    szx += pz * qx;
    szy += pz * qy;
    szz += pz * qz;
  }
  const n = [
    [sxx + syy + szz, syz - szy, szx - sxz, sxy - syx],
    [syz - szy, sxx - syy - szz, sxy + syx, szx + sxz],
    [szx - sxz, sxy + syx, -sxx + syy - szz, syz + szy],
    [sxy - syx, szx + sxz, syz + szy, -sxx - syy + szz],
  ];
  const [w, x, y, z] = topEigenvector(n);
  r[0] = 1 - 2 * (y * y + z * z);
  r[1] = 2 * (x * y - w * z);
  r[2] = 2 * (x * z + w * y);
  r[3] = 2 * (x * y + w * z);
  r[4] = 1 - 2 * (x * x + z * z);
  r[5] = 2 * (y * z - w * x);
  r[6] = 2 * (x * z - w * y);
  r[7] = 2 * (y * z + w * x);
  r[8] = 1 - 2 * (x * x + y * y);
  t[0] = bx - ((r[0] as number) * ax + (r[1] as number) * ay + (r[2] as number) * az);
  t[1] = by - ((r[3] as number) * ax + (r[4] as number) * ay + (r[5] as number) * az);
  t[2] = bz - ((r[6] as number) * ax + (r[7] as number) * ay + (r[8] as number) * az);
}

/** The unit eigenvector of a symmetric 4×4's largest eigenvalue, by cyclic Jacobi rotations. */
function topEigenvector(m: number[][]): [number, number, number, number] {
  const a = m.map((row) => row.slice());
  const v = [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ];
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0;
    for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) off += (a[i]?.[j] ?? 0) ** 2;
    if (off < 1e-30) break;
    for (let p = 0; p < 4; p++) {
      for (let q = p + 1; q < 4; q++) {
        const apq = a[p]?.[q] ?? 0;
        if (Math.abs(apq) < 1e-300) continue;
        const app = a[p]?.[p] ?? 0;
        const aqq = a[q]?.[q] ?? 0;
        const theta = (aqq - app) / (2 * apq);
        const tt = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(tt * tt + 1);
        const s = tt * c;
        for (let k = 0; k < 4; k++) {
          const akp = a[k]?.[p] ?? 0;
          const akq = a[k]?.[q] ?? 0;
          (a[k] as number[])[p] = c * akp - s * akq;
          (a[k] as number[])[q] = s * akp + c * akq;
        }
        for (let k = 0; k < 4; k++) {
          const apk = a[p]?.[k] ?? 0;
          const aqk = a[q]?.[k] ?? 0;
          (a[p] as number[])[k] = c * apk - s * aqk;
          (a[q] as number[])[k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 4; k++) {
          const vkp = v[k]?.[p] ?? 0;
          const vkq = v[k]?.[q] ?? 0;
          (v[k] as number[])[p] = c * vkp - s * vkq;
          (v[k] as number[])[q] = s * vkp + c * vkq;
        }
      }
    }
  }
  let best = 0;
  for (let i = 1; i < 4; i++) if ((a[i]?.[i] ?? 0) > (a[best]?.[best] ?? 0)) best = i;
  const e: [number, number, number, number] = [
    v[0]?.[best] ?? 0,
    v[1]?.[best] ?? 0,
    v[2]?.[best] ?? 0,
    v[3]?.[best] ?? 0,
  ];
  const len = Math.hypot(...e);
  return [e[0] / len, e[1] / len, e[2] / len, e[3] / len];
}

function writeMatrix(out: Float32Array, at: number, r: Float64Array, t: Float64Array): void {
  out[at] = r[0] as number;
  out[at + 1] = r[3] as number;
  out[at + 2] = r[6] as number;
  out[at + 3] = 0;
  out[at + 4] = r[1] as number;
  out[at + 5] = r[4] as number;
  out[at + 6] = r[7] as number;
  out[at + 7] = 0;
  out[at + 8] = r[2] as number;
  out[at + 9] = r[5] as number;
  out[at + 10] = r[8] as number;
  out[at + 11] = 0;
  out[at + 12] = t[0] as number;
  out[at + 13] = t[1] as number;
  out[at + 14] = t[2] as number;
  out[at + 15] = 1;
}
