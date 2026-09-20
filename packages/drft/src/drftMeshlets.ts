import { DrftError, align } from './drftFormat.ts';

/**
 * `MSHL`: the clusters a mesh draws as, and the level-of-detail graph over them.
 *
 * **One chunk per level, not one for the whole graph.** A level is a complete alternative mesh —
 * its own positions, its own indices, its own clusters — so folding every level into one chunk
 * would mean one payload whose parts are only meaningful together. Separate chunks let a loader
 * stream the coarsest level first and refine, which is the same argument `coarseFirst.ts` already
 * makes for splats.
 *
 * ```
 * u32  clusterCount
 * u32  indexTotal
 * u32  triangleOffsets[clusterCount]   first triangle of each cluster
 * u32  triangleCounts[clusterCount]
 * f32  boundsCentre[clusterCount * 3]
 * f32  boundsRadius[clusterCount]
 * f32  coneAxis[clusterCount * 3]      average face normal, normalised
 * f32  coneCutoff[clusterCount]        minimum dot of any face against the axis
 * f32  ownError[clusterCount]          this cluster's geometric error
 * f32  parentError[clusterCount]       the error of what replaces it one level up
 * u32  indices[indexTotal]
 * ```
 *
 * **No per-chunk version field**, matching `COLL` and every other chunk here: the file's own
 * version covers the format and a second one would be a second thing to keep in step.
 *
 * **`parentError` may be infinite**, which is how the coarsest level says it has no parent. A
 * float32 carries that exactly, so a reader needs no sentinel and a comparison against it needs
 * no special case.
 */

/** How many clusters one level may carry. Well past what a streaming budget permits. */
export const MAX_CLUSTERS = 1 << 20;

export interface MeshletLevel {
  triangleOffsets: Uint32Array;
  triangleCounts: Uint32Array;
  boundsCentre: Float32Array;
  boundsRadius: Float32Array;
  coneAxis: Float32Array;
  coneCutoff: Float32Array;
  ownError: Float32Array;
  parentError: Float32Array;
  indices: Uint32Array;
  count: number;
}

const HEADER = 8;

function layoutOf(clusterCount: number, indexTotal: number) {
  const triangleOffsets = HEADER;
  const triangleCounts = triangleOffsets + clusterCount * 4;
  const boundsCentre = triangleCounts + clusterCount * 4;
  const boundsRadius = boundsCentre + clusterCount * 12;
  const coneAxis = boundsRadius + clusterCount * 4;
  const coneCutoff = coneAxis + clusterCount * 12;
  const ownError = coneCutoff + clusterCount * 4;
  const parentError = ownError + clusterCount * 4;
  const indices = parentError + clusterCount * 4;
  return {
    triangleOffsets,
    triangleCounts,
    boundsCentre,
    boundsRadius,
    coneAxis,
    coneCutoff,
    ownError,
    parentError,
    indices,
    size: indices + indexTotal * 4,
  };
}

export function buildMeshlets(level: MeshletLevel): Uint8Array {
  const { count } = level;
  if (count > MAX_CLUSTERS) {
    throw new DrftError(`${count} clusters exceeds the ${MAX_CLUSTERS} cap`);
  }
  if (level.triangleOffsets.length < count || level.triangleCounts.length < count) {
    throw new DrftError('MSHL was given fewer cluster offsets or counts than clusters');
  }
  if (level.indices.length % 3 !== 0) {
    throw new DrftError(
      `MSHL was given ${level.indices.length} indices, which is not whole triangles`,
    );
  }

  /*
   * Every cluster's triangles are checked to lie inside the index array before anything is
   * written. A cluster running past the end would otherwise be a subarray of arbitrary geometry on
   * the way back in, which is the same failure `COLL` checks its starts table for.
   */
  const triangles = level.indices.length / 3;
  for (let c = 0; c < count; c += 1) {
    const at = level.triangleOffsets[c] as number;
    const n = level.triangleCounts[c] as number;
    if (at + n > triangles) {
      throw new DrftError(`MSHL cluster ${c} runs past the ${triangles} triangles it was given`);
    }
  }

  const layout = layoutOf(count, level.indices.length);
  const bytes = new Uint8Array(align(layout.size));
  const view = new DataView(bytes.buffer);
  view.setUint32(0, count, true);
  view.setUint32(4, level.indices.length, true);

  new Uint32Array(bytes.buffer, layout.triangleOffsets, count).set(
    level.triangleOffsets.subarray(0, count),
  );
  new Uint32Array(bytes.buffer, layout.triangleCounts, count).set(
    level.triangleCounts.subarray(0, count),
  );
  new Float32Array(bytes.buffer, layout.boundsCentre, count * 3).set(
    level.boundsCentre.subarray(0, count * 3),
  );
  new Float32Array(bytes.buffer, layout.boundsRadius, count).set(
    level.boundsRadius.subarray(0, count),
  );
  new Float32Array(bytes.buffer, layout.coneAxis, count * 3).set(
    level.coneAxis.subarray(0, count * 3),
  );
  new Float32Array(bytes.buffer, layout.coneCutoff, count).set(level.coneCutoff.subarray(0, count));
  new Float32Array(bytes.buffer, layout.ownError, count).set(level.ownError.subarray(0, count));
  new Float32Array(bytes.buffer, layout.parentError, count).set(
    level.parentError.subarray(0, count),
  );
  new Uint32Array(bytes.buffer, layout.indices, level.indices.length).set(level.indices);
  return bytes;
}

/**
 * The level an `MSHL` chunk carries, as views over the fetched buffer.
 *
 * Views rather than copies, like every other chunk here, so a load allocates nothing beyond the
 * object holding them.
 */
export function readMeshlets(
  buffer: ArrayBuffer,
  offset: number,
  byteLength: number,
): MeshletLevel {
  if (byteLength < HEADER) throw new DrftError('MSHL is too short to hold its counts');
  const view = new DataView(buffer, offset, byteLength);
  const count = view.getUint32(0, true);
  const indexTotal = view.getUint32(4, true);

  if (count > MAX_CLUSTERS) {
    throw new DrftError(`MSHL claims ${count} clusters, over the ${MAX_CLUSTERS} cap`);
  }
  if (indexTotal % 3 !== 0) {
    throw new DrftError(`MSHL claims ${indexTotal} indices, which is not whole triangles`);
  }

  const layout = layoutOf(count, indexTotal);
  if (byteLength < layout.size) {
    throw new DrftError(
      `MSHL claims ${count} clusters and ${indexTotal} indices, which runs past the chunk`,
    );
  }

  const triangleOffsets = new Uint32Array(buffer, offset + layout.triangleOffsets, count);
  const triangleCounts = new Uint32Array(buffer, offset + layout.triangleCounts, count);
  const triangles = indexTotal / 3;
  for (let c = 0; c < count; c += 1) {
    if ((triangleOffsets[c] as number) + (triangleCounts[c] as number) > triangles) {
      throw new DrftError(`MSHL cluster ${c} runs past the ${triangles} triangles the chunk holds`);
    }
  }

  return {
    triangleOffsets,
    triangleCounts,
    boundsCentre: new Float32Array(buffer, offset + layout.boundsCentre, count * 3),
    boundsRadius: new Float32Array(buffer, offset + layout.boundsRadius, count),
    coneAxis: new Float32Array(buffer, offset + layout.coneAxis, count * 3),
    coneCutoff: new Float32Array(buffer, offset + layout.coneCutoff, count),
    ownError: new Float32Array(buffer, offset + layout.ownError, count),
    parentError: new Float32Array(buffer, offset + layout.parentError, count),
    indices: new Uint32Array(buffer, offset + layout.indices, indexTotal),
    count,
  };
}
