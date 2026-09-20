/**
 * A mesh brought down to a triangle budget, by collapsing the edges that cost the least.
 *
 * **What a marched surface hands over is far more triangles than its shape needs.** The volume is
 * sampled on a lattice and every cell that the surface crosses emits triangles of about one cell
 * across, so a flat wall costs as much as a folded one. Quadric error collapse is the standard
 * answer and is the right one here: it measures each candidate collapse by the squared distance the
 * surface would move, in metres, so what goes first is what changes the shape least — a wall
 * flattens to a few triangles and a corner keeps its detail, without anybody choosing which.
 *
 * **The error is a quadric per vertex**, the sum over its faces of the squared distance to each
 * face's plane. That is what makes the measure *accumulate*: after a collapse the survivor carries
 * both vertices' planes, so the tenth collapse in a region is costed against the original surface
 * rather than against the ninth's result. A greedy measure without it flattens a region one
 * imperceptible step at a time until the shape is gone.
 *
 * **A border is held, and so is the facing.** An open capture's boundary is where the evidence
 * stopped, and letting it creep inwards is losing the part of the scene that was seen. A collapse
 * that would turn a face inside out is refused outright rather than costed, because the cost of an
 * inverted face is not large — it is meaningless, and a mesh that collides inside-out is the
 * failure `marching.ts` opens by describing.
 */
import type { MeshData } from '@driftengine/drft';

export interface DecimateOptions {
  /**
   * How much a border edge resists being collapsed.
   *
   * The standard construction: each boundary edge contributes a plane through itself perpendicular
   * to its own face, weighted by this, so moving along the border is cheap and moving off it is
   * not. A hundred is enough that a border survives a decimation to a tenth and small enough that a
   * long straight border still simplifies.
   */
  readonly borderWeight?: number;
}

const DEFAULT_BORDER = 100;

/**
 * `mesh` simplified until it holds at most `budget` triangles.
 *
 * **Answers a mesh rather than filling one**, because neither the vertex count nor the triangle
 * count is known before the collapses are made: a caller cannot size the arrays. A mesh already
 * inside its budget is answered as it stands, copied, so a caller never has to ask which it got.
 */
export function decimate(mesh: MeshData, budget: number, options: DecimateOptions = {}): MeshData {
  const faceCount = mesh.indices.length / 3;
  if (faceCount <= budget || budget <= 0) return copyOf(mesh);
  const borderWeight = options.borderWeight ?? DEFAULT_BORDER;

  const vertexCount = mesh.positions.length / 3;
  const position = Float64Array.from(mesh.positions);
  const faces = Int32Array.from(mesh.indices);
  const faceAlive = new Uint8Array(faceCount).fill(1);
  const vertexAlive = new Uint8Array(vertexCount).fill(1);
  const facesOf: Set<number>[] = Array.from({ length: vertexCount }, () => new Set<number>());
  for (let face = 0; face < faceCount; face += 1) {
    for (let slot = 0; slot < 3; slot += 1) {
      (facesOf[faces[face * 3 + slot] as number] as Set<number>).add(face);
    }
  }

  /* Ten numbers a vertex: the symmetric 4 × 4 of the squared distance to its own planes. */
  const quadrics = new Float64Array(vertexCount * 10);
  const plane = new Float64Array(4);
  for (let face = 0; face < faceCount; face += 1) {
    if (!planeOf(position, faces, face, plane)) continue;
    for (let slot = 0; slot < 3; slot += 1) {
      addPlane(quadrics, faces[face * 3 + slot] as number, plane, 1);
    }
  }
  /* And the borders, as a plane through each border edge at right angles to its own face. */
  forEachBorderEdge(faces, faceAlive, faceCount, (a, b, face) => {
    if (!planeOf(position, faces, face, plane)) return;
    if (!borderPlane(position, a, b, plane)) return;
    addPlane(quadrics, a, plane, borderWeight);
    addPlane(quadrics, b, plane, borderWeight);
  });

  const heap = new CostHeap();
  const version = new Map<number, number>();
  const target = new Float64Array(3);
  const pushEdge = (a: number, b: number): void => {
    if (a === b) return;
    const low = a < b ? a : b;
    const high = a < b ? b : a;
    const key = low * vertexCount + high;
    const cost = collapseCost(quadrics, position, low, high, target);
    const stamp = (version.get(key) ?? 0) + 1;
    version.set(key, stamp);
    heap.push(cost, key, stamp);
  };
  const edges = new Set<number>();
  for (let face = 0; face < faceCount; face += 1) {
    for (let slot = 0; slot < 3; slot += 1) {
      const a = faces[face * 3 + slot] as number;
      const b = faces[face * 3 + ((slot + 1) % 3)] as number;
      const key = a < b ? a * vertexCount + b : b * vertexCount + a;
      if (edges.has(key)) continue;
      edges.add(key);
      pushEdge(a, b);
    }
  }

  let alive = faceCount;
  while (alive > budget) {
    const next = heap.pop();
    if (next === null) break;
    const key = next.key;
    if ((version.get(key) ?? 0) !== next.stamp) continue;
    const keep = Math.floor(key / vertexCount);
    const drop = key % vertexCount;
    if ((vertexAlive[keep] as number) === 0 || (vertexAlive[drop] as number) === 0) continue;
    collapseCost(quadrics, position, keep, drop, target);
    if (wouldFlip(position, faces, faceAlive, facesOf, keep, drop, target)) continue;

    /* The faces that held both ends go; the rest move from the dropped vertex to the kept one. */
    const kept = facesOf[keep] as Set<number>;
    const dropped = facesOf[drop] as Set<number>;
    for (const face of dropped) {
      if (kept.has(face)) {
        if ((faceAlive[face] as number) === 1) {
          faceAlive[face] = 0;
          alive -= 1;
        }
        continue;
      }
      for (let slot = 0; slot < 3; slot += 1) {
        if ((faces[face * 3 + slot] as number) === drop) faces[face * 3 + slot] = keep;
      }
      kept.add(face);
    }
    for (const face of kept) {
      if ((faceAlive[face] as number) === 0) kept.delete(face);
    }
    dropped.clear();
    vertexAlive[drop] = 0;
    for (let k = 0; k < 3; k += 1) position[keep * 3 + k] = target[k] as number;
    for (let k = 0; k < 10; k += 1) {
      quadrics[keep * 10 + k] =
        (quadrics[keep * 10 + k] as number) + (quadrics[drop * 10 + k] as number);
    }

    /* Everything still touching the survivor has a new cost. */
    const neighbours = new Set<number>();
    for (const face of kept) {
      for (let slot = 0; slot < 3; slot += 1) {
        const vertex = faces[face * 3 + slot] as number;
        if (vertex !== keep && (vertexAlive[vertex] as number) === 1) neighbours.add(vertex);
      }
    }
    for (const vertex of neighbours) pushEdge(keep, vertex);
  }

  return rebuild(
    position,
    normalsFrom(position, faces, faceAlive, faceCount),
    faces,
    faceAlive,
    faceCount,
    mesh,
  );
}

/** A face's plane, unit normal first, or false where the triangle has no area to have one. */
function planeOf(
  position: Float64Array,
  faces: Int32Array,
  face: number,
  out: Float64Array,
): boolean {
  const a = faces[face * 3] as number;
  const b = faces[face * 3 + 1] as number;
  const c = faces[face * 3 + 2] as number;
  const ux = (position[b * 3] as number) - (position[a * 3] as number);
  const uy = (position[b * 3 + 1] as number) - (position[a * 3 + 1] as number);
  const uz = (position[b * 3 + 2] as number) - (position[a * 3 + 2] as number);
  const vx = (position[c * 3] as number) - (position[a * 3] as number);
  const vy = (position[c * 3 + 1] as number) - (position[a * 3 + 1] as number);
  const vz = (position[c * 3 + 2] as number) - (position[a * 3 + 2] as number);
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (!(length > 0)) return false;
  out[0] = nx / length;
  out[1] = ny / length;
  out[2] = nz / length;
  out[3] = -(
    (out[0] as number) * (position[a * 3] as number) +
    (out[1] as number) * (position[a * 3 + 1] as number) +
    (out[2] as number) * (position[a * 3 + 2] as number)
  );
  return true;
}

/** The plane through a border edge at right angles to `plane`, replacing it in place. */
function borderPlane(position: Float64Array, a: number, b: number, plane: Float64Array): boolean {
  const ex = (position[b * 3] as number) - (position[a * 3] as number);
  const ey = (position[b * 3 + 1] as number) - (position[a * 3 + 1] as number);
  const ez = (position[b * 3 + 2] as number) - (position[a * 3 + 2] as number);
  const nx = ey * (plane[2] as number) - ez * (plane[1] as number);
  const ny = ez * (plane[0] as number) - ex * (plane[2] as number);
  const nz = ex * (plane[1] as number) - ey * (plane[0] as number);
  const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (!(length > 0)) return false;
  plane[0] = nx / length;
  plane[1] = ny / length;
  plane[2] = nz / length;
  plane[3] = -(
    (plane[0] as number) * (position[a * 3] as number) +
    (plane[1] as number) * (position[a * 3 + 1] as number) +
    (plane[2] as number) * (position[a * 3 + 2] as number)
  );
  return true;
}

function addPlane(
  quadrics: Float64Array,
  vertex: number,
  plane: Float64Array,
  weight: number,
): void {
  const at = vertex * 10;
  let slot = 0;
  for (let row = 0; row < 4; row += 1) {
    for (let column = row; column < 4; column += 1) {
      quadrics[at + slot] =
        (quadrics[at + slot] as number) +
        weight * (plane[row] as number) * (plane[column] as number);
      slot += 1;
    }
  }
}

/** `vᵀQv` for the quadric of a vertex, which is the squared distance to all its planes. */
function errorAt(quadrics: Float64Array, vertex: number, x: number, y: number, z: number): number {
  const q = vertex * 10;
  const v = [x, y, z, 1];
  let total = 0;
  let slot = 0;
  for (let row = 0; row < 4; row += 1) {
    for (let column = row; column < 4; column += 1) {
      const term = (quadrics[q + slot] as number) * (v[row] as number) * (v[column] as number);
      total += row === column ? term : 2 * term;
      slot += 1;
    }
  }
  return total;
}

/**
 * What collapsing an edge costs, and where the survivor goes, into `out`.
 *
 * **Three candidates rather than the exact minimum**: both ends and the midpoint. Solving the
 * quadric for its own minimum puts the vertex wherever the planes say, which for a nearly flat
 * region is a badly conditioned system and an answer far outside the mesh. Choosing the best of
 * three keeps every survivor on the surface it came from, which is what a collision mesh needs.
 */
function collapseCost(
  quadrics: Float64Array,
  position: Float64Array,
  keep: number,
  drop: number,
  out: Float64Array,
): number {
  const candidates = [
    [
      position[keep * 3] as number,
      position[keep * 3 + 1] as number,
      position[keep * 3 + 2] as number,
    ],
    [
      position[drop * 3] as number,
      position[drop * 3 + 1] as number,
      position[drop * 3 + 2] as number,
    ],
    [
      ((position[keep * 3] as number) + (position[drop * 3] as number)) / 2,
      ((position[keep * 3 + 1] as number) + (position[drop * 3 + 1] as number)) / 2,
      ((position[keep * 3 + 2] as number) + (position[drop * 3 + 2] as number)) / 2,
    ],
  ];
  let best = Infinity;
  for (const candidate of candidates) {
    const [x, y, z] = candidate as [number, number, number];
    const cost = errorAt(quadrics, keep, x, y, z) + errorAt(quadrics, drop, x, y, z);
    if (cost < best) {
      best = cost;
      out[0] = x;
      out[1] = y;
      out[2] = z;
    }
  }
  return best;
}

/** Would any face that survives the collapse end up facing the other way? */
function wouldFlip(
  position: Float64Array,
  faces: Int32Array,
  faceAlive: Uint8Array,
  facesOf: readonly Set<number>[],
  keep: number,
  drop: number,
  target: Float64Array,
): boolean {
  const before = new Float64Array(4);
  const after = new Float64Array(4);
  const held = [0, 0, 0];
  for (const vertex of [keep, drop]) {
    for (const face of facesOf[vertex] as Set<number>) {
      if ((faceAlive[face] as number) === 0) continue;
      let touchesBoth = false;
      for (let slot = 0; slot < 3; slot += 1) {
        const other = faces[face * 3 + slot] as number;
        if (other === (vertex === keep ? drop : keep)) touchesBoth = true;
      }
      /* A face holding both ends disappears in the collapse, so its facing is not at stake. */
      if (touchesBoth) continue;
      if (!planeOf(position, faces, face, before)) continue;
      for (let slot = 0; slot < 3; slot += 1) {
        const at = faces[face * 3 + slot] as number;
        if (at !== vertex) continue;
        for (let k = 0; k < 3; k += 1) {
          held[k] = position[at * 3 + k] as number;
          position[at * 3 + k] = target[k] as number;
        }
        const flat = !planeOf(position, faces, face, after);
        for (let k = 0; k < 3; k += 1) position[at * 3 + k] = held[k] as number;
        if (flat) return true;
        const agree =
          (before[0] as number) * (after[0] as number) +
          (before[1] as number) * (after[1] as number) +
          (before[2] as number) * (after[2] as number);
        if (agree <= 0) return true;
      }
    }
  }
  return false;
}

/** Every edge used by exactly one live face, with that face. */
function forEachBorderEdge(
  faces: Int32Array,
  faceAlive: Uint8Array,
  faceCount: number,
  visit: (a: number, b: number, face: number) => void,
): void {
  const owner = new Map<string, { face: number; count: number }>();
  for (let face = 0; face < faceCount; face += 1) {
    if ((faceAlive[face] as number) === 0) continue;
    for (let slot = 0; slot < 3; slot += 1) {
      const a = faces[face * 3 + slot] as number;
      const b = faces[face * 3 + ((slot + 1) % 3)] as number;
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      const held = owner.get(key);
      if (held === undefined) owner.set(key, { face, count: 1 });
      else held.count += 1;
    }
  }
  for (const [key, held] of owner) {
    if (held.count !== 1) continue;
    const [a, b] = key.split('-').map((value) => Number(value));
    visit(a as number, b as number, held.face);
  }
}

/** A normal a vertex, from the faces it is left with, so a collapsed mesh is shaded by itself. */
function normalsFrom(
  position: Float64Array,
  faces: Int32Array,
  faceAlive: Uint8Array,
  faceCount: number,
): Float64Array {
  const normals = new Float64Array(position.length);
  const plane = new Float64Array(4);
  for (let face = 0; face < faceCount; face += 1) {
    if ((faceAlive[face] as number) === 0) continue;
    if (!planeOf(position, faces, face, plane)) continue;
    for (let slot = 0; slot < 3; slot += 1) {
      const vertex = faces[face * 3 + slot] as number;
      for (let k = 0; k < 3; k += 1) {
        normals[vertex * 3 + k] = (normals[vertex * 3 + k] as number) + (plane[k] as number);
      }
    }
  }
  for (let vertex = 0; vertex < normals.length / 3; vertex += 1) {
    const x = normals[vertex * 3] as number;
    const y = normals[vertex * 3 + 1] as number;
    const z = normals[vertex * 3 + 2] as number;
    const length = Math.sqrt(x * x + y * y + z * z);
    if (!(length > 0)) continue;
    normals[vertex * 3] = x / length;
    normals[vertex * 3 + 1] = y / length;
    normals[vertex * 3 + 2] = z / length;
  }
  return normals;
}

/** The live faces and the vertices they still use, renumbered from nothing. */
function rebuild(
  position: Float64Array,
  normals: Float64Array,
  faces: Int32Array,
  faceAlive: Uint8Array,
  faceCount: number,
  source: MeshData,
): MeshData {
  const renumbered = new Map<number, number>();
  const positions: number[] = [];
  const outNormals: number[] = [];
  const indices: number[] = [];
  for (let face = 0; face < faceCount; face += 1) {
    if ((faceAlive[face] as number) === 0) continue;
    for (let slot = 0; slot < 3; slot += 1) {
      const vertex = faces[face * 3 + slot] as number;
      let at = renumbered.get(vertex);
      if (at === undefined) {
        at = positions.length / 3;
        renumbered.set(vertex, at);
        for (let k = 0; k < 3; k += 1) positions.push(position[vertex * 3 + k] as number);
        for (let k = 0; k < 3; k += 1) outNormals.push(normals[vertex * 3 + k] as number);
      }
      indices.push(at);
    }
  }
  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(outNormals),
    colors: new Float32Array(positions.length).fill(1),
    /* One a vertex, against the vertices that survived rather than the ones that went in. */
    emissive: new Float32Array(positions.length / 3),
    indices: Uint32Array.from(indices),
  };
}

function copyOf(mesh: MeshData): MeshData {
  return {
    positions: Float32Array.from(mesh.positions),
    normals: Float32Array.from(mesh.normals),
    colors: Float32Array.from(mesh.colors),
    emissive: Float32Array.from(mesh.emissive),
    indices: Uint32Array.from(mesh.indices),
  };
}

/**
 * The cheapest collapse first, with stale entries left in and skipped on the way out.
 *
 * A collapse changes the cost of every edge around it, and finding those entries to move would
 * need a handle per edge. Pushing a new entry and letting the old one fall out is the standard
 * trade: the heap holds more than it needs to and every pop is checked against the edge's current
 * stamp. **Ties break by key**, so two collapses that cost the same happen in the same order every
 * run — which is what makes a decimated capture reproducible.
 */
class CostHeap {
  private readonly costs: number[] = [];
  private readonly keys: number[] = [];
  private readonly stamps: number[] = [];

  push(cost: number, key: number, stamp: number): void {
    this.costs.push(cost);
    this.keys.push(key);
    this.stamps.push(stamp);
    let at = this.costs.length - 1;
    while (at > 0) {
      const parent = (at - 1) >> 1;
      if (!this.before(at, parent)) break;
      this.swap(at, parent);
      at = parent;
    }
  }

  pop(): { key: number; stamp: number } | null {
    if (this.costs.length === 0) return null;
    const key = this.keys[0] as number;
    const stamp = this.stamps[0] as number;
    const last = this.costs.length - 1;
    this.swap(0, last);
    this.costs.pop();
    this.keys.pop();
    this.stamps.pop();
    let at = 0;
    for (;;) {
      const left = at * 2 + 1;
      const right = left + 1;
      let best = at;
      if (left < this.costs.length && this.before(left, best)) best = left;
      if (right < this.costs.length && this.before(right, best)) best = right;
      if (best === at) break;
      this.swap(at, best);
      at = best;
    }
    return { key, stamp };
  }

  private before(a: number, b: number): boolean {
    const first = this.costs[a] as number;
    const second = this.costs[b] as number;
    if (first !== second) return first < second;
    return (this.keys[a] as number) < (this.keys[b] as number);
  }

  private swap(a: number, b: number): void {
    [this.costs[a], this.costs[b]] = [this.costs[b] as number, this.costs[a] as number];
    [this.keys[a], this.keys[b]] = [this.keys[b] as number, this.keys[a] as number];
    [this.stamps[a], this.stamps[b]] = [this.stamps[b] as number, this.stamps[a] as number];
  }
}
