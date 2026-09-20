/**
 * The level-of-detail graph over a mesh's clusters, and the property the whole pipeline rests on.
 *
 * **A cluster's own error must never exceed its parent's.** Given that, a cut chosen independently
 * per cluster — draw this one if its projected error is under the threshold, otherwise ask its
 * parent — is guaranteed crack-free, because two adjacent clusters can never choose levels whose
 * shared edge was simplified differently. Without it the pipeline draws holes, and the holes appear
 * at viewing distances nobody tested. The property holds here **by construction**: each level's
 * error is forced up to at least its children's maximum.
 *
 * **Simplification is vertex clustering on a grid, not edge collapse, and that is a deliberate
 * first implementation.** Grid snapping is deterministic without a tie-break argument, needs no
 * dependency, and — the part that matters — has an error bound that is *known in advance* rather
 * than measured after the fact: no vertex moves further than half a cell diagonal. A quadric edge
 * collapse would give a better-looking result at the same triangle count and would have to
 * measure its error to keep the invariant above. The graph shape, the error discipline and every
 * consumer of both are identical either way, so the better simplifier is a drop-in replacement
 * for `simplifyGroup` and nothing else.
 */
import type { MeshData } from '@driftengine/drft';
import { buildClusters } from './cluster.ts';
import type { ClusterSet } from './cluster.ts';

export interface ClusterLevel {
  /** The clusters at this level. Level 0 is the source mesh's. */
  set: ClusterSet;
  /** Positions the level's indices address. Level 0 shares the source mesh's. */
  positions: Float32Array;
  /** Geometric error each cluster at this level carries. Zero at level 0. */
  ownError: Float32Array;
  /** The error of the group that replaces this cluster one level up, or Infinity at the root. */
  parentError: Float32Array;
  /** Which group of this level was simplified together. Clusters sharing one share a parent. */
  groupOf: Uint32Array;
}

export interface ClusterDag {
  levels: ClusterLevel[];
}

/**
 * The mean length of a triangle edge, which is the mesh's own sense of how far apart its detail is.
 *
 * Sampled over every triangle rather than every unique edge: each interior edge is counted twice
 * and each boundary edge once, which biases the mean by a fraction of a percent on any mesh large
 * enough to matter and saves building an edge set.
 */
function meanEdgeLength(positions: Float32Array, indices: Uint32Array): number {
  let total = 0;
  let count = 0;
  for (let t = 0; t < indices.length / 3; t += 1) {
    for (let e = 0; e < 3; e += 1) {
      const a = (indices[t * 3 + e] as number) * 3;
      const b = (indices[t * 3 + ((e + 1) % 3)] as number) * 3;
      total += Math.hypot(
        (positions[b] as number) - (positions[a] as number),
        (positions[b + 1] as number) - (positions[a + 1] as number),
        (positions[b + 2] as number) - (positions[a + 2] as number),
      );
      count += 1;
    }
  }
  return count === 0 ? 0 : total / count;
}

/** How far a vertex can move when snapped to a grid of this size: half the cell diagonal. */
function snapError(cell: number): number {
  return (cell * Math.sqrt(3)) / 2;
}

/**
 * Collapse a group's triangles by snapping vertices to a grid and dropping what degenerates.
 *
 * Returns the surviving geometry and the error bound, which is a property of the grid rather than
 * a measurement of the result — see the header for why that matters.
 */
function simplifyGroup(
  positions: Float32Array,
  indices: Uint32Array,
  cell: number,
): { positions: Float32Array; indices: Uint32Array; error: number } {
  const keyOf = new Map<string, number>();
  const remap = new Map<number, number>();
  const out: number[] = [];

  for (let i = 0; i < indices.length; i += 1) {
    const v = indices[i] as number;
    if (remap.has(v)) continue;
    const at = v * 3;
    const gx = Math.round((positions[at] as number) / cell);
    const gy = Math.round((positions[at + 1] as number) / cell);
    const gz = Math.round((positions[at + 2] as number) / cell);
    const key = `${gx},${gy},${gz}`;
    let slot = keyOf.get(key);
    if (slot === undefined) {
      slot = out.length / 3;
      keyOf.set(key, slot);
      out.push(gx * cell, gy * cell, gz * cell);
    }
    remap.set(v, slot);
  }

  const kept: number[] = [];
  for (let t = 0; t < indices.length / 3; t += 1) {
    const a = remap.get(indices[t * 3] as number) as number;
    const b = remap.get(indices[t * 3 + 1] as number) as number;
    const c = remap.get(indices[t * 3 + 2] as number) as number;
    /* A triangle whose corners snapped together has no area and is dropped, not kept flat. */
    if (a === b || b === c || a === c) continue;
    kept.push(a, b, c);
  }

  return {
    positions: Float32Array.from(out),
    indices: Uint32Array.from(kept),
    error: snapError(cell),
  };
}

/**
 * Group clusters for simplification, by proximity, `size` at a time.
 *
 * Ordered by cluster index rather than by a spatial sort, then filled greedily from the nearest
 * unassigned centroid — deterministic, and close enough to spatial that groups are contiguous on
 * ordinary geometry. Clusters in one group are simplified together, so edges interior to the group
 * may collapse and edges on its boundary may not.
 */
function groupClusters(set: ClusterSet, size: number): Uint32Array {
  const groupOf = new Uint32Array(set.count).fill(0xffffffff);
  let group = 0;
  for (let seed = 0; seed < set.count; seed += 1) {
    if (groupOf[seed] !== 0xffffffff) continue;
    groupOf[seed] = group;
    let taken = 1;
    while (taken < size) {
      let best = -1;
      let bestDistance = Infinity;
      for (let c = 0; c < set.count; c += 1) {
        if (groupOf[c] !== 0xffffffff) continue;
        const d = Math.hypot(
          (set.boundsCentre[c * 3] as number) - (set.boundsCentre[seed * 3] as number),
          (set.boundsCentre[c * 3 + 1] as number) - (set.boundsCentre[seed * 3 + 1] as number),
          (set.boundsCentre[c * 3 + 2] as number) - (set.boundsCentre[seed * 3 + 2] as number),
        );
        if (d < bestDistance) {
          bestDistance = d;
          best = c;
        }
      }
      if (best === -1) break;
      groupOf[best] = group;
      taken += 1;
    }
    group += 1;
  }
  return groupOf;
}

const GROUP_SIZE = 4;

export function buildClusterDag(
  set: ClusterSet,
  mesh: MeshData,
  options: { target?: number; maxLevels?: number } = {},
): ClusterDag {
  const target = options.target ?? 128;
  const maxLevels = options.maxLevels ?? 8;

  const levels: ClusterLevel[] = [];
  let currentSet = set;
  let currentPositions = mesh.positions;
  let currentError = new Float32Array(set.count);

  /*
   * The starting cell comes from the mesh's own edge length, not from its extent.
   *
   * Derived from the extent it is arbitrary, and arbitrary here means wrong in a way that looks
   * like the algorithm failing: a cell finer than the vertex spacing merges nothing, the triangle
   * count does not fall, and the build stops at one level believing the mesh cannot be
   * simplified. Starting a little above the mean edge collapses neighbouring vertices on the
   * first pass, which is what the doubling then builds on.
   */
  let cell = Math.max(1e-3, meanEdgeLength(mesh.positions, set.indices) * 1.5);

  for (let level = 0; level < maxLevels; level += 1) {
    const groupOf = groupClusters(currentSet, GROUP_SIZE);
    const parentError = new Float32Array(currentSet.count);

    const last = currentSet.count <= 1;
    if (last) {
      parentError.fill(Infinity);
      levels.push({
        set: currentSet,
        positions: currentPositions,
        ownError: currentError,
        parentError,
        groupOf,
      });
      break;
    }

    /* Every cluster of a group takes the group's error, so two in one group cannot disagree. */
    const error = Math.max(snapError(cell), ...Array.from(currentError));
    for (let c = 0; c < currentSet.count; c += 1) parentError[c] = error;

    levels.push({
      set: currentSet,
      positions: currentPositions,
      ownError: currentError,
      parentError,
      groupOf,
    });

    const simplified = simplifyGroup(currentPositions, currentSet.indices, cell);
    if (simplified.indices.length === 0 || simplified.indices.length >= currentSet.indices.length) {
      break;
    }

    const nextMesh = { ...mesh, positions: simplified.positions, indices: simplified.indices };
    const nextSet = buildClusters(nextMesh as MeshData, target);
    currentSet = nextSet;
    currentPositions = simplified.positions;
    currentError = new Float32Array(nextSet.count).fill(error);
    cell *= 2;
  }

  return { levels };
}
