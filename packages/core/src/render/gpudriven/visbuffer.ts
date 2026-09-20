/**
 * What a pixel records: which triangle of which cluster of which instance covered it.
 *
 * **One 32-bit target, and its ceiling is stated here rather than discovered.** Seven bits carry
 * the triangle, which is the 128 a cluster may hold, and the remaining twenty-five carry the
 * cluster-in-instance identifier — 33.5 million of them, far past what a streaming budget permits.
 * If a scene ever reaches it the answer is a second target, not a repack.
 *
 * **Zero is a legal value, so the buffer is cleared to a sentinel instead.** Cleared to zero, an
 * uncovered pixel is indistinguishable from triangle 0 of cluster 0 of instance 0, which is a real
 * triangle in every scene that has one.
 */

/** Triangles a cluster may hold, and therefore what the low bits carry. */
export const VIS_TRIANGLE_BITS = 7;
export const VIS_MAX_TRIANGLES = 1 << VIS_TRIANGLE_BITS;
/** Cluster-in-instance identifiers the remaining bits carry. */
export const VIS_MAX_CLUSTERS = 1 << (32 - VIS_TRIANGLE_BITS);
/** What an uncovered pixel holds. Not zero — see the header. */
export const VIS_EMPTY = 0xffffffff;

export function packVisibility(cluster: number, triangle: number): number {
  if (triangle < 0 || triangle >= VIS_MAX_TRIANGLES) {
    throw new RangeError(`triangle ${triangle} does not fit in ${VIS_TRIANGLE_BITS} bits`);
  }
  if (cluster < 0 || cluster >= VIS_MAX_CLUSTERS) {
    throw new RangeError(`cluster ${cluster} does not fit in ${32 - VIS_TRIANGLE_BITS} bits`);
  }
  return ((cluster << VIS_TRIANGLE_BITS) | triangle) >>> 0;
}

export function unpackVisibility(packed: number): { cluster: number; triangle: number } {
  return {
    cluster: packed >>> VIS_TRIANGLE_BITS,
    triangle: packed & (VIS_MAX_TRIANGLES - 1),
  };
}

export function visibilityCovered(packed: number): boolean {
  return packed !== VIS_EMPTY;
}
