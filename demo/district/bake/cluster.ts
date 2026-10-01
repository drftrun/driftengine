/**
 * A region's coarse levels by vertex clustering: every vertex snapped to the cell of a grid it
 * falls in, every triangle that keeps three cells kept, and colour and glow carried as the cells'
 * averages.
 *
 * **Why clustering and not the simplifier.** The district is built of loose quads — a terrain tile
 * of 7,700 triangles is 3,600 separate pieces, a facade a few hundred thousand — so there is no
 * edge to collapse and a quadric simplifier leaves 94% of what it was given. A grid does not care
 * whether triangles are joined: what is smaller than a cell vanishes, what spans cells keeps its
 * shape to within one, and loose pieces lying on one surface weld into it. Rossignac and Borrel's
 * method, in its simplest form, which is enough at the distances these levels are drawn.
 *
 * **Colour comes from the pictures, not the materials.** A coarse level is drawn with no textures,
 * so each vertex arrives carrying what its material's colour map and glow map say at its UV, and a
 * cell keeps the area-weighted mean of those. A tower's lit windows are then a cell's glow a block
 * away, and the far side of the city at night is still a city at night.
 *
 * What it gives up: shading finer than a cell — a cell's faces that look one way share one normal —
 * and anything thinner than a cell, which is what the level's error is for. What would make it wrong is a level
 * drawn nearer than its error says it may be; `HlodSet` is what holds that.
 */
import type { MeshData } from '@driftengine/drft';

/** A mesh in world space with a colour and a glow a vertex, linear RGB, to be clustered. */
export interface ClusterInput {
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
  readonly colors: Float32Array;
  readonly glows: Float32Array;
}

/** Cluster `inputs` at `size` metres into one flat-shaded mesh, or null where nothing survives. */
export function clusterLevel(inputs: readonly ClusterInput[], size: number): MeshData | null {
  const cellOf = new Map<number, number>();
  /* Per cell: summed position and count, summed colour, glow and the area weighting them. */
  let sums = new Float64Array(1 << 16);
  let cells = 0;
  const grow = (): void => {
    const next = new Float64Array(sums.length * 2);
    next.set(sums);
    sums = next;
  };
  const STRIDE = 11;
  const key = (x: number, y: number, z: number): number => {
    const ix = Math.floor(x / size) + 32768;
    const iy = Math.floor(y / size) + 1024;
    const iz = Math.floor(z / size) + 32768;
    return (ix * 2048 + iy) * 65536 + iz;
  };
  const triangles: number[] = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    const p = input.positions;
    const count = p.length / 3;
    const cellAt = new Int32Array(count);
    for (let v = 0; v < count; v++) {
      const k = key(p[v * 3] as number, p[v * 3 + 1] as number, p[v * 3 + 2] as number);
      let c = cellOf.get(k);
      if (c === undefined) {
        c = cells++;
        cellOf.set(k, c);
        while ((c + 1) * STRIDE > sums.length) grow();
      }
      cellAt[v] = c;
      const at = c * STRIDE;
      sums[at] = (sums[at] as number) + (p[v * 3] as number);
      sums[at + 1] = (sums[at + 1] as number) + (p[v * 3 + 1] as number);
      sums[at + 2] = (sums[at + 2] as number) + (p[v * 3 + 2] as number);
      sums[at + 3] = (sums[at + 3] as number) + 1;
    }
    const idx = input.indices;
    for (let t = 0; t < idx.length; t += 3) {
      const [i, j, k] = [idx[t] as number, idx[t + 1] as number, idx[t + 2] as number];
      /* The triangle's area weights what it says about the cells its corners fall in. */
      const ux = (p[j * 3] as number) - (p[i * 3] as number);
      const uy = (p[j * 3 + 1] as number) - (p[i * 3 + 1] as number);
      const uz = (p[j * 3 + 2] as number) - (p[i * 3 + 2] as number);
      const vx = (p[k * 3] as number) - (p[i * 3] as number);
      const vy = (p[k * 3 + 1] as number) - (p[i * 3 + 1] as number);
      const vz = (p[k * 3 + 2] as number) - (p[i * 3 + 2] as number);
      const area = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
      for (const v of [i, j, k]) {
        const at = (cellAt[v] as number) * STRIDE;
        for (let ch = 0; ch < 3; ch++) {
          sums[at + 4 + ch] =
            (sums[at + 4 + ch] as number) + (input.colors[v * 3 + ch] as number) * area;
          sums[at + 7 + ch] =
            (sums[at + 7 + ch] as number) + (input.glows[v * 3 + ch] as number) * area;
        }
        sums[at + 10] = (sums[at + 10] as number) + area;
      }
      const a = cellAt[i] as number;
      const b = cellAt[j] as number;
      const c = cellAt[k] as number;
      if (a === b || b === c || a === c) continue;
      /* The same three cells twice is one triangle, whichever way round. */
      const sorted = [a, b, c].sort((x, y) => x - y);
      const id = `${sorted[0]},${sorted[1]},${sorted[2]}`;
      if (seen.has(id)) continue;
      seen.add(id);
      triangles.push(a, b, c);
    }
  }
  const n = triangles.length / 3;
  if (n === 0) return null;
  const centre = (c: number, axis: number): number =>
    (sums[c * STRIDE + axis] as number) / (sums[c * STRIDE + 3] as number);
  /*
   * **Vertices are shared, one a cell for each way its faces look.** A triangle's corner is the
   * vertex of its cell for the axis its face normal leans along most, so the faces of a cell that
   * look the same way share one smooth normal and a box's corner, where they look three ways,
   * keeps three: crisp edges at about a vertex a triangle, where flat shading spent three.
   */
  const vertexOf = new Map<number, number>();
  const corner: number[] = [];
  const faceNormal = new Float32Array(n * 3);
  const indices = new Uint32Array(n * 3);
  for (let t = 0; t < n; t++) {
    const cs = [
      triangles[t * 3] as number,
      triangles[t * 3 + 1] as number,
      triangles[t * 3 + 2] as number,
    ];
    const q = cs.map((c) => [centre(c, 0), centre(c, 1), centre(c, 2)]) as number[][];
    const u = [0, 1, 2].map((k) => (q[1]?.[k] as number) - (q[0]?.[k] as number));
    const w = [0, 1, 2].map((k) => (q[2]?.[k] as number) - (q[0]?.[k] as number));
    const nx = (u[1] as number) * (w[2] as number) - (u[2] as number) * (w[1] as number);
    const ny = (u[2] as number) * (w[0] as number) - (u[0] as number) * (w[2] as number);
    const nz = (u[0] as number) * (w[1] as number) - (u[1] as number) * (w[0] as number);
    faceNormal[t * 3] = nx;
    faceNormal[t * 3 + 1] = ny;
    faceNormal[t * 3 + 2] = nz;
    const ax = Math.abs(nx);
    const ay = Math.abs(ny);
    const az = Math.abs(nz);
    const bucket =
      ax >= ay && ax >= az ? (nx > 0 ? 0 : 1) : ay >= az ? (ny > 0 ? 2 : 3) : nz > 0 ? 4 : 5;
    cs.forEach((c, k) => {
      const id = c * 6 + bucket;
      let v = vertexOf.get(id);
      if (v === undefined) {
        v = corner.length;
        vertexOf.set(id, v);
        corner.push(c);
      }
      indices[t * 3 + k] = v;
    });
  }
  const count = corner.length;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const emissive = new Float32Array(count);
  const emissiveColor = new Float32Array(count * 3);
  for (let t = 0; t < n; t++) {
    for (let k = 0; k < 3; k++) {
      const v = indices[t * 3 + k] as number;
      /* Unnormalised face normals are area-weighted, which is the weighting wanted. */
      normals[v * 3] = (normals[v * 3] as number) + (faceNormal[t * 3] as number);
      normals[v * 3 + 1] = (normals[v * 3 + 1] as number) + (faceNormal[t * 3 + 1] as number);
      normals[v * 3 + 2] = (normals[v * 3 + 2] as number) + (faceNormal[t * 3 + 2] as number);
    }
  }
  for (let v = 0; v < count; v++) {
    const c = corner[v] as number;
    const at = c * STRIDE;
    positions[v * 3] = centre(c, 0);
    positions[v * 3 + 1] = centre(c, 1);
    positions[v * 3 + 2] = centre(c, 2);
    const length =
      Math.hypot(
        normals[v * 3] as number,
        normals[v * 3 + 1] as number,
        normals[v * 3 + 2] as number,
      ) || 1;
    for (let k = 0; k < 3; k++) normals[v * 3 + k] = (normals[v * 3 + k] as number) / length;
    const weight = (sums[at + 10] as number) || 1;
    let glow = 0;
    for (let ch = 0; ch < 3; ch++) {
      colors[v * 3 + ch] = (sums[at + 4 + ch] as number) / weight;
      const g = (sums[at + 7 + ch] as number) / weight;
      emissiveColor[v * 3 + ch] = g;
      glow = Math.max(glow, g);
    }
    emissive[v] = glow > 0.004 ? 1 : 0;
    if (glow <= 0.004) for (let ch = 0; ch < 3; ch++) emissiveColor[v * 3 + ch] = -1;
  }
  return { positions, normals, colors, emissive, emissiveColor, indices };
}
