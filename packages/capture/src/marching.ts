/**
 * A volume's zero crossing as a mesh, facing outwards.
 *
 * **Tetrahedra rather than cubes, and the reason is watertightness rather than taste.** Marching
 * cubes classifies a cube's eight corners into 256 cases, and a handful of those are *ambiguous*:
 * the same corner signs admit two different surfaces, and two neighbouring cubes that resolve one
 * the two different ways leave a hole between them. Every implementation patches this, and the
 * patches are the part that gets subtly wrong. A tetrahedron has four corners and sixteen cases,
 * **none of them ambiguous** — a plane through a tetrahedron cuts it one way — so a mesh built this
 * way is closed wherever the volume is known, by construction rather than by a table of exceptions.
 *
 * What it costs is triangles: roughly twice what marching cubes emits for the same surface, because
 * a cube is cut six ways rather than once. `decimate` is the answer to that, and it is a better
 * answer than an ambiguity table because it is driven by the error it introduces.
 *
 * **A cube with an unknown corner is not marched at all.** A sample no view ever saw has no
 * distance, and a surface built through it is one the capture invented — which is exactly the
 * spurious closing surface an open scene must not grow. The boundary of what was seen is left open,
 * and that is the honest shape of a clip that walked through a room rather than around an object.
 *
 * **Normals come from the volume's gradient, and their sign is checked against it.** An inverted
 * mesh collides inside-out: a character walks through the floor and falls out of the world, which
 * reads as a physics fault and is a meshing one.
 */
import type { MeshData } from '@driftengine/drft';

import type { Volume } from './fusion.ts';

/**
 * The six tetrahedra a cube is cut into, by corner index.
 *
 * Corner `n` is the one at `(n & 1, (n >> 1) & 1, (n >> 2) & 1)`. Every tetrahedron holds corners
 * 0 and 7 — the cube's main diagonal — which is what makes the cut the same for every cube and so
 * agrees across their shared faces. A cut chosen per cube would leave the faces between them
 * triangulated two different ways, which is the hole this arrangement exists to avoid.
 */
const TETRAHEDRA: readonly (readonly [number, number, number, number])[] = [
  [0, 7, 1, 3],
  [0, 7, 3, 2],
  [0, 7, 2, 6],
  [0, 7, 6, 4],
  [0, 7, 4, 5],
  [0, 7, 5, 1],
];

/** The six edges of a tetrahedron, as pairs of its own corner slots. */
const TETRA_EDGES: readonly (readonly [number, number])[] = [
  [0, 1],
  [0, 2],
  [0, 3],
  [1, 2],
  [1, 3],
  [2, 3],
];

export interface MarchOptions {
  /** A sample with less evidence than this is treated as unknown, and its cube is not marched. */
  readonly minimumWeight?: number;
}

const DEFAULT_WEIGHT = 1e-6;

/**
 * How far a crossing is kept from either end of the edge it is on, as a fraction of that edge.
 *
 * **A surface passing exactly through a sample is the one degenerate case tetrahedra do not save
 * you from.** Every edge out of that sample crosses at its very end, so several crossings land on
 * the same point and the triangles between them have no area at all — measured on a sphere whose
 * radius is a whole number of samples: **280 faces of 3,960 with zero area**, and 256 of those with
 * no direction to wind by, because a degenerate triangle has no normal. They cannot simply be
 * dropped: their edges are shared with real faces, and dropping them opens the mesh.
 *
 * So the crossing is held a thousandth of an edge away from each end instead. At a tenth-metre
 * spacing that is a tenth of a millimetre of geometry given up, and it makes the case stop
 * existing rather than handling it.
 */
const MARGIN = 1e-3;

/**
 * `volume`'s surface, welded so that neighbours share vertices exactly.
 *
 * A vertex belongs to the *edge* it was found on, so two tetrahedra meeting along an edge find the
 * same one — which is what closes the mesh. Answers the mesh; a volume with no crossing answers an
 * empty one rather than throwing, because a capture of nothing is a real thing to have.
 */
export function marchVolume(volume: Volume, options: MarchOptions = {}): MeshData {
  const [nx, ny, nz] = volume.dims;
  const minimumWeight = options.minimumWeight ?? DEFAULT_WEIGHT;
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  /* Which vertex each crossed edge already has, keyed by its two sample indices. */
  const vertexOf = new Map<number, number>();

  const corner = new Int32Array(8);
  const value = new Float64Array(8);
  for (let k = 0; k + 1 < nz; k += 1) {
    for (let j = 0; j + 1 < ny; j += 1) {
      for (let i = 0; i + 1 < nx; i += 1) {
        let known = true;
        for (let n = 0; n < 8; n += 1) {
          const at = (((k + ((n >> 2) & 1)) * ny + (j + ((n >> 1) & 1))) * nx +
            (i + (n & 1))) as number;
          corner[n] = at;
          value[n] = volume.distance[at] as number;
          if ((volume.weight[at] as number) < minimumWeight) known = false;
        }
        if (!known) continue;

        for (const tetra of TETRAHEDRA) {
          marchTetrahedron(volume, corner, value, tetra, vertexOf, positions, normals, indices);
        }
      }
    }
  }

  const colors = new Float32Array(positions.length).fill(1);
  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    colors,
    /*
     * **One float a vertex, which is what `MeshData` means by emissive** — how much of the
     * surface's own colour it emits — rather than a colour of its own. It was three, and nothing
     * noticed until a captured mesh was written to a file: every consumer of it so far measured
     * geometry, and the container is the first thing that checks an attribute's length against
     * the vertex count. A short attribute buffer is the failure `writeDrft` refuses by name,
     * because a driver handed one may draw zeroes or drop the draw.
     */
    emissive: new Float32Array(positions.length / 3),
    indices: Uint32Array.from(indices),
  };
}

function marchTetrahedron(
  volume: Volume,
  corner: Int32Array,
  value: Float64Array,
  tetra: readonly [number, number, number, number],
  vertexOf: Map<number, number>,
  positions: number[],
  normals: number[],
  indices: number[],
): void {
  /* Which of the four corners are inside, as a four-bit pattern. */
  let pattern = 0;
  for (let slot = 0; slot < 4; slot += 1) {
    if ((value[tetra[slot] as number] as number) < 0) pattern |= 1 << slot;
  }
  if (pattern === 0 || pattern === 15) return;

  /* The edges this pattern crosses: one end inside, the other out. */
  const crossings: number[] = [];
  for (const [a, b] of TETRA_EDGES) {
    const insideA = (pattern & (1 << a)) !== 0;
    const insideB = (pattern & (1 << b)) !== 0;
    if (insideA === insideB) continue;
    crossings.push(
      vertexOn(
        volume,
        corner[tetra[a] as number] as number,
        corner[tetra[b] as number] as number,
        value[tetra[a] as number] as number,
        value[tetra[b] as number] as number,
        vertexOf,
        positions,
        normals,
      ),
    );
  }
  /*
   * Three crossings where one corner is alone on its side of the surface, four where they are two
   * against two — a quadrilateral, which becomes two triangles. There is no other case: this is the
   * whole of the ambiguity marching cubes has and tetrahedra do not.
   */
  if (crossings.length === 3) {
    emit(
      volume,
      positions,
      normals,
      indices,
      crossings[0] as number,
      crossings[1] as number,
      crossings[2] as number,
    );
    return;
  }
  if (crossings.length !== 4) return;
  /*
   * The four are in edge order, which walks the quadrilateral as 0–1–3–2 rather than 0–1–2–3: the
   * edges opposite each other in the list share no corner. Taking them in the listed order would
   * fold the quad into a bowtie, which is a pair of triangles that overlap and leave a hole.
   */
  emit(
    volume,
    positions,
    normals,
    indices,
    crossings[0] as number,
    crossings[1] as number,
    crossings[3] as number,
  );
  emit(
    volume,
    positions,
    normals,
    indices,
    crossings[0] as number,
    crossings[3] as number,
    crossings[2] as number,
  );
}

/** The crossing on the edge between two samples, made once and shared by everything that meets it. */
function vertexOn(
  volume: Volume,
  a: number,
  b: number,
  valueA: number,
  valueB: number,
  vertexOf: Map<number, number>,
  positions: number[],
  normals: number[],
): number {
  /* Keyed by the pair, smaller first, so the two tetrahedra either side agree on the key. */
  const low = a < b ? a : b;
  const high = a < b ? b : a;
  const key = low * volume.distance.length + high;
  const held = vertexOf.get(key);
  if (held !== undefined) return held;

  const first = low === a ? valueA : valueB;
  const second = low === a ? valueB : valueA;
  /* Where the line between the two samples is zero; a pair that does not straddle takes the middle. */
  const span = second - first;
  const found = span === 0 ? 0.5 : first / -span;
  const t = found < MARGIN ? MARGIN : found > 1 - MARGIN ? 1 - MARGIN : found;
  const index = positions.length / 3;
  const [nx, ny] = volume.dims;
  for (let axis = 0; axis < 3; axis += 1) {
    const from = sampleAxis(low, axis, nx, ny);
    const to = sampleAxis(high, axis, nx, ny);
    positions.push((volume.origin[axis] as number) + (from + (to - from) * t) * volume.spacing);
  }
  const normal = gradientAt(volume, low, high, t);
  normals.push(normal[0] as number, normal[1] as number, normal[2] as number);
  vertexOf.set(key, index);
  return index;
}

function sampleAxis(at: number, axis: number, nx: number, ny: number): number {
  if (axis === 0) return at % nx;
  if (axis === 1) return Math.floor(at / nx) % ny;
  return Math.floor(at / (nx * ny));
}

/**
 * The volume's gradient partway along an edge, normalised: which way is out.
 *
 * Taken at each end and blended, rather than at the point, because the gradient is only defined at
 * samples. A gradient of nothing — a flat patch of volume — answers the edge's own direction, which
 * is the one thing that is certainly not tangent to the surface there.
 */
function gradientAt(volume: Volume, low: number, high: number, t: number): readonly number[] {
  const first = gradientAtSample(volume, low);
  const second = gradientAtSample(volume, high);
  const out = [0, 0, 0];
  for (let axis = 0; axis < 3; axis += 1) {
    out[axis] = (first[axis] as number) * (1 - t) + (second[axis] as number) * t;
  }
  const length = Math.sqrt(
    (out[0] as number) * (out[0] as number) +
      (out[1] as number) * (out[1] as number) +
      (out[2] as number) * (out[2] as number),
  );
  if (length > 1e-12) {
    for (let axis = 0; axis < 3; axis += 1) out[axis] = (out[axis] as number) / length;
    return out;
  }
  const [nx, ny] = volume.dims;
  const fallback = [0, 0, 0];
  for (let axis = 0; axis < 3; axis += 1) {
    fallback[axis] = sampleAxis(high, axis, nx, ny) - sampleAxis(low, axis, nx, ny);
  }
  const span = Math.sqrt(
    (fallback[0] as number) * (fallback[0] as number) +
      (fallback[1] as number) * (fallback[1] as number) +
      (fallback[2] as number) * (fallback[2] as number),
  );
  return span > 0 ? fallback.map((value) => (value as number) / span) : [0, 0, 1];
}

/** A central difference where both neighbours exist, and a one-sided one at the volume's edge. */
function gradientAtSample(volume: Volume, at: number): readonly number[] {
  const [nx, ny, nz] = volume.dims;
  const x = at % nx;
  const y = Math.floor(at / nx) % ny;
  const z = Math.floor(at / (nx * ny));
  const here = volume.distance[at] as number;
  const out = [0, 0, 0];
  const steps = [1, nx, nx * ny];
  const limits = [
    [x, nx],
    [y, ny],
    [z, nz],
  ];
  for (let axis = 0; axis < 3; axis += 1) {
    const [position, size] = limits[axis] as [number, number];
    const step = steps[axis] as number;
    const low = position > 0 ? (volume.distance[at - step] as number) : here;
    const high = position + 1 < size ? (volume.distance[at + step] as number) : here;
    const span = (position > 0 ? 1 : 0) + (position + 1 < size ? 1 : 0);
    out[axis] = span === 0 ? 0 : (high - low) / (span * volume.spacing);
  }
  return out;
}

/**
 * One triangle, wound so that its own normal agrees with the volume's gradient.
 *
 * **This is the check the whole module exists to pass.** A mesh whose faces point inwards collides
 * inside-out — a character walks through the floor and out of the world — and it looks entirely
 * correct until something stands on it.
 */
function emit(
  volume: Volume,
  positions: number[],
  normals: number[],
  indices: number[],
  a: number,
  b: number,
  c: number,
): void {
  if (a === b || b === c || a === c) return;
  const ax = positions[a * 3] as number;
  const ay = positions[a * 3 + 1] as number;
  const az = positions[a * 3 + 2] as number;
  const ux = (positions[b * 3] as number) - ax;
  const uy = (positions[b * 3 + 1] as number) - ay;
  const uz = (positions[b * 3 + 2] as number) - az;
  const vx = (positions[c * 3] as number) - ax;
  const vy = (positions[c * 3 + 1] as number) - ay;
  const vz = (positions[c * 3 + 2] as number) - az;
  const fx = uy * vz - uz * vy;
  const fy = uz * vx - ux * vz;
  const fz = ux * vy - uy * vx;
  /* The three vertices' own normals, which came from the gradient, say which way out is. */
  let outward = 0;
  for (const vertex of [a, b, c]) {
    outward +=
      fx * (normals[vertex * 3] as number) +
      fy * (normals[vertex * 3 + 1] as number) +
      fz * (normals[vertex * 3 + 2] as number);
  }
  if (outward >= 0) indices.push(a, b, c);
  else indices.push(a, c, b);
  void volume;
}
