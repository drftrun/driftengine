/**
 * Splitting a mesh into clusters: the unit a GPU-driven frame culls, chooses detail for and draws.
 *
 * **A cluster is the unit of three separate decisions**, which is why its size is a parameter
 * rather than a constant. Smaller clusters cull more precisely and pay more per-cluster overhead
 * on every one of them; 128 triangles is the default because it is one workgroup of 128
 * invocations doing one triangle each.
 *
 * **Growth is by shared vertices, and ties break on the lowest index.** That tie-break is not a
 * detail: a baker whose output depends on iteration order produces a different container from the
 * same source, which breaks every content hash downstream. The determinism test in this module's
 * suite is what holds it.
 *
 * Each cluster carries a bounding sphere and a normal cone, because the runtime culls against both
 * and computing them here costs nothing that the bake was not already paying.
 */
import type { MeshData } from '@driftengine/drft';

export interface ClusterSet {
  /** First triangle of each cluster, as an index into `indices` divided by three. */
  triangleOffsets: Uint32Array;
  /** How many triangles each cluster holds. */
  triangleCounts: Uint32Array;
  /** The mesh's indices, reordered so each cluster's triangles are contiguous. */
  indices: Uint32Array;
  /** Three floats per cluster. */
  boundsCentre: Float32Array;
  /** One float per cluster. */
  boundsRadius: Float32Array;
  /** Three floats per cluster: the average face normal, normalised. */
  coneAxis: Float32Array;
  /** One float per cluster: the minimum dot product of any face normal against the axis. */
  coneCutoff: Float32Array;
  count: number;
}

/** Vertices shared between two triangles, each given as three vertex indices. */
function shared(a: Uint32Array, ai: number, b: Uint32Array, bi: number): number {
  let count = 0;
  for (let i = 0; i < 3; i += 1) {
    const v = a[ai * 3 + i] as number;
    for (let j = 0; j < 3; j += 1) if (v === (b[bi * 3 + j] as number)) count += 1;
  }
  return count;
}

function faceNormal(positions: Float32Array, indices: Uint32Array, tri: number, out: Float32Array) {
  const a = (indices[tri * 3] as number) * 3;
  const b = (indices[tri * 3 + 1] as number) * 3;
  const c = (indices[tri * 3 + 2] as number) * 3;
  const ux = (positions[b] as number) - (positions[a] as number);
  const uy = (positions[b + 1] as number) - (positions[a + 1] as number);
  const uz = (positions[b + 2] as number) - (positions[a + 2] as number);
  const vx = (positions[c] as number) - (positions[a] as number);
  const vy = (positions[c + 1] as number) - (positions[a + 1] as number);
  const vz = (positions[c + 2] as number) - (positions[a + 2] as number);
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const length = Math.hypot(nx, ny, nz);
  if (length > 0) {
    nx /= length;
    ny /= length;
    nz /= length;
  }
  out[0] = nx;
  out[1] = ny;
  out[2] = nz;
}

/**
 * Every triangle touching each vertex, as a compressed row: offsets, then the triangles.
 *
 * **This is what makes the growth linear rather than cubic**, and the difference is not an
 * optimisation. Growth picks the unassigned triangle sharing the most vertices with the cluster so
 * far, and a triangle sharing none can never be picked — the loop stops when the best score is
 * zero. So the only triangles worth considering are the ones reachable through a vertex, and this
 * is the map that says which those are. Scanning the whole mesh to discover that answer is what
 * the first version here did: 128 triangles took 16 ms, 2,048 took 1.9 s, 4,608 took 9.7 s, and a
 * million-triangle asset extrapolated to days.
 *
 * Two passes and no arrays of arrays, because a million-triangle mesh is a million small
 * allocations otherwise.
 */
function vertexTriangles(
  indices: Uint32Array,
  vertices: number,
): { starts: Uint32Array; list: Uint32Array } {
  const triangles = Math.floor(indices.length / 3);
  const starts = new Uint32Array(vertices + 1);
  for (let i = 0; i < triangles * 3; i += 1) starts[(indices[i] as number) + 1] += 1;
  for (let v = 0; v < vertices; v += 1) {
    starts[v + 1] = (starts[v + 1] as number) + (starts[v] as number);
  }
  const cursor = Uint32Array.from(starts.subarray(0, vertices));
  const list = new Uint32Array(triangles * 3);
  for (let t = 0; t < triangles; t += 1) {
    for (let corner = 0; corner < 3; corner += 1) {
      const v = indices[t * 3 + corner] as number;
      list[cursor[v] as number] = t;
      cursor[v] = (cursor[v] as number) + 1;
    }
  }
  return { starts, list };
}

export interface ClusterOptions {
  /**
   * What makes two triangles neighbours while a cluster grows. **`'index'` by default**, which is
   * what every baked container was hashed with and must go on producing.
   *
   * **`'position'` counts two corners as shared when they stand at the same point**, whatever their
   * indices. A mesh that splits its vertices at every seam — a voxel mesher, whose faces each carry
   * their own uv and occlusion, or a box built face by face — shares no index between two faces,
   * so growth by index stops at every face and each quad becomes a cluster of two triangles: a
   * median voxel chunk was 1,012 clusters for 2,024 triangles. The indices written out are still
   * the mesh's own, because welding decides who is a neighbour and nothing else.
   */
  readonly share?: 'index' | 'position';
}

/**
 * Each index replaced by the first vertex standing where it stands.
 *
 * **The first, in vertex order**, so the answer depends on the mesh and not on a hash table's
 * iteration — which is the reproducibility the tie-break above is written for. Keyed on the
 * numbers rather than their bits, so a corner at `-0` meets one at `0`.
 */
function canonicalIndices(
  indices: Uint32Array,
  positions: Float32Array,
  vertices: number,
): Uint32Array {
  const first = new Map<string, number>();
  const canonical = new Uint32Array(vertices);
  for (let v = 0; v < vertices; v += 1) {
    const key = `${positions[v * 3]},${positions[v * 3 + 1]},${positions[v * 3 + 2]}`;
    const known = first.get(key);
    if (known === undefined) {
      first.set(key, v);
      canonical[v] = v;
    } else {
      canonical[v] = known;
    }
  }
  return Uint32Array.from(indices, (index) => canonical[index] as number);
}

export function buildClusters(
  mesh: MeshData,
  target: number,
  options: ClusterOptions = {},
): ClusterSet {
  const source = mesh.indices as Uint32Array;
  const triangles = Math.floor(source.length / 3);
  const positions = mesh.positions;
  const vertices = Math.floor(positions.length / 3);

  const assigned = new Uint8Array(triangles);
  const indices = new Uint32Array(source.length);
  const offsets: number[] = [];
  const counts: number[] = [];
  /*
   * **Who neighbours whom**, which is the source itself unless the caller asked for positions.
   * Growth and scoring read this; what is written out reads `source`.
   */
  const linked =
    options.share === 'position' ? canonicalIndices(source, positions, vertices) : source;
  const adjacency = vertexTriangles(linked, vertices);

  const member: number[] = [];
  /*
   * The frontier: unassigned triangles that share at least one vertex with a member, and the best
   * score each has against any member so far. `score` is indexed by triangle and is only read for
   * triangles in `frontier`, so it never has to be cleared between clusters.
   */
  const frontier: number[] = [];
  const score = new Uint8Array(triangles);
  const queued = new Uint8Array(triangles);

  let written = 0;
  let placed = 0;
  /* The lowest unassigned triangle seeds the next cluster, so the walk is reproducible. Monotone,
     because every triangle below it is assigned — scanning from zero each time is a second
     quadratic term hiding behind the first. */
  let nextSeed = 0;

  while (placed < triangles) {
    while (nextSeed < triangles && assigned[nextSeed] === 1) nextSeed += 1;
    if (nextSeed >= triangles) break;
    const seed = nextSeed;

    member.length = 0;
    frontier.length = 0;
    member.push(seed);
    assigned[seed] = 1;
    placed += 1;
    offer(seed);

    while (member.length < target) {
      /*
       * The best score, ties broken by the lowest triangle index — the same answer the whole-mesh
       * scan gave, because it ran in index order and compared strictly greater. The frontier is
       * not in index order, so the tie-break is written out rather than inherited from the loop.
       */
      let best = -1;
      let bestScore = 0;
      let live = 0;
      for (let i = 0; i < frontier.length; i += 1) {
        const t = frontier[i] as number;
        if (assigned[t] === 1) {
          queued[t] = 0;
          continue;
        }
        /* Compacted in place as it is scanned, so a consumed frontier entry is not walked again. */
        frontier[live] = t;
        live += 1;
        const s = score[t] as number;
        if (s > bestScore || (s === bestScore && best >= 0 && t < best)) {
          bestScore = s;
          best = t;
        }
      }
      frontier.length = live;
      if (best === -1 || bestScore <= 0) break;
      member.push(best);
      assigned[best] = 1;
      placed += 1;
      offer(best);
    }

    /*
     * **`queued` is per cluster and the frontier is where it is recorded.** Leaving a triangle
     * marked from a cluster that never took it makes it invisible to every cluster afterwards —
     * `offer` would update its score and never put it on the new frontier — and what that looks
     * like is growth stopping early everywhere: 25,088 triangles came out as 11,860 clusters
     * rather than 196.
     *
     * **The frontier alone is enough and a second loop over the members is not.** Every member
     * except the seed was offered before it was chosen, so it is in this array; the seed was
     * already assigned when its own `offer` ran and was never marked. A loop over the members
     * stood here and a perturbation survived it.
     */
    for (const t of frontier) queued[t] = 0;

    offsets.push(written / 3);
    counts.push(member.length);
    for (const t of member) {
      indices[written] = source[t * 3] as number;
      indices[written + 1] = source[t * 3 + 1] as number;
      indices[written + 2] = source[t * 3 + 2] as number;
      written += 3;
    }
  }

  /** Raise every neighbour of a new member to the score it now has against the cluster. */
  function offer(added: number): void {
    for (let corner = 0; corner < 3; corner += 1) {
      const v = linked[added * 3 + corner] as number;
      const from = adjacency.starts[v] as number;
      const to = adjacency.starts[v + 1] as number;
      for (let i = from; i < to; i += 1) {
        const t = adjacency.list[i] as number;
        /* Already in a cluster. The frontier scan refuses it again, so deleting this changes
           no answer — it is a cost guard, and the cost is 105 ms against 89 ms over a mesh of
           100,352 triangles, which is an eighteenth of the bake. A perturbation survives it. */
        if (assigned[t] === 1) continue;
        const shares = shared(linked, added, linked, t);
        if (queued[t] === 0) {
          queued[t] = 1;
          score[t] = shares;
          frontier.push(t);
        } else if (shares > (score[t] as number)) {
          score[t] = shares;
        }
      }
    }
  }

  const count = offsets.length;
  const set: ClusterSet = {
    triangleOffsets: Uint32Array.from(offsets),
    triangleCounts: Uint32Array.from(counts),
    indices,
    boundsCentre: new Float32Array(count * 3),
    boundsRadius: new Float32Array(count),
    coneAxis: new Float32Array(count * 3),
    coneCutoff: new Float32Array(count),
    count,
  };

  const normal = new Float32Array(3);
  for (let c = 0; c < count; c += 1) {
    const at = set.triangleOffsets[c] as number;
    const n = set.triangleCounts[c] as number;

    let cx = 0;
    let cy = 0;
    let cz = 0;
    let vertices = 0;
    for (let i = at * 3; i < (at + n) * 3; i += 1) {
      const v = (indices[i] as number) * 3;
      cx += positions[v] as number;
      cy += positions[v + 1] as number;
      cz += positions[v + 2] as number;
      vertices += 1;
    }
    cx /= vertices;
    cy /= vertices;
    cz /= vertices;

    let radius = 0;
    for (let i = at * 3; i < (at + n) * 3; i += 1) {
      const v = (indices[i] as number) * 3;
      radius = Math.max(
        radius,
        Math.hypot(
          (positions[v] as number) - cx,
          (positions[v + 1] as number) - cy,
          (positions[v + 2] as number) - cz,
        ),
      );
    }

    let ax = 0;
    let ay = 0;
    let az = 0;
    for (let t = at; t < at + n; t += 1) {
      faceNormal(positions, indices, t, normal);
      ax += normal[0] as number;
      ay += normal[1] as number;
      az += normal[2] as number;
    }
    const axisLength = Math.hypot(ax, ay, az);
    if (axisLength > 0) {
      ax /= axisLength;
      ay /= axisLength;
      az /= axisLength;
    }

    let cutoff = 1;
    for (let t = at; t < at + n; t += 1) {
      faceNormal(positions, indices, t, normal);
      cutoff = Math.min(
        cutoff,
        (normal[0] as number) * ax + (normal[1] as number) * ay + (normal[2] as number) * az,
      );
    }

    set.boundsCentre[c * 3] = cx;
    set.boundsCentre[c * 3 + 1] = cy;
    set.boundsCentre[c * 3 + 2] = cz;
    set.boundsRadius[c] = radius;
    set.coneAxis[c * 3] = ax;
    set.coneAxis[c * 3 + 1] = ay;
    set.coneAxis[c * 3 + 2] = az;
    set.coneCutoff[c] = cutoff;
  }

  return set;
}
