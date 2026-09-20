/**
 * Every cluster in the scene, packed into one set of buffers.
 *
 * **One dispatch over every cluster is the whole point of the pipeline.** A buffer per mesh means
 * a dispatch per mesh, which is the draw-call bound this exists to remove — so the packing rebases
 * each mesh's index offsets by the indices already written and gives every cluster an identifier
 * that is unique across the scene rather than within its mesh.
 *
 * **A cluster says which mesh it came from**, because a cluster that cannot name its mesh cannot
 * find the transform it is drawn with. The number is the mesh's position in the list handed in,
 * which is what a caller's own transform array is indexed by — so an empty mesh still takes a slot.
 * Skipping empty meshes shifts every index after them and every cluster past the gap draws
 * somewhere else.
 *
 * **Bounds and cones are interleaved as vec4s.** A storage buffer read as `array<vec4<f32>>` wants
 * sixteen-byte stride, and three floats followed by one is exactly the sphere and exactly the cone,
 * so the packing costs nothing and the shader indexes without arithmetic.
 */

import { cullCutoff } from './cullClusters.ts';

/** Floats per cluster in `bounds` and in `cones`: a vec4 each. */
export const CLUSTER_FLOATS = 8;

/** What packing needs of one mesh's clusters. `MeshletLevel` from `MSHL` satisfies it. */
export interface ClusterSource {
  readonly count: number;
  readonly triangleOffsets: Uint32Array;
  readonly triangleCounts: Uint32Array;
  readonly boundsCentre: Float32Array;
  readonly boundsRadius: Float32Array;
  readonly coneAxis: Float32Array;
  /**
   * The minimum dot product of any face normal against the axis — the cosine of the cone's
   * half-angle, as `buildClusters` writes it and `MSHL` stores it. Packing turns it into the sine
   * the cull is written in; see `cullCutoff`.
   */
  readonly coneCutoff: Float32Array;
  readonly ownError: Float32Array;
  readonly parentError: Float32Array;
  readonly indices: Uint32Array;
}

export interface ClusterBuffers {
  /** Four floats a cluster: centre and radius. */
  bounds: Float32Array;
  /** Four floats a cluster: cone axis and cutoff. */
  cones: Float32Array;
  /** Two floats a cluster: its own error and its parent's. */
  errors: Float32Array;
  /** Where this cluster's indices begin, in the packed index buffer. */
  indexOffsets: Uint32Array;
  /** How many indices it has. */
  indexCounts: Uint32Array;
  /** Unique across the scene, and equal to the cluster's position here. */
  clusterId: Uint32Array;
  /** Which mesh of the input list this cluster came from. */
  meshOf: Uint32Array;
  indices: Uint32Array;
  count: number;
}

/** Floats a shader steps by to reach the next cluster's bounds or cone. */
export function clusterStride(): number {
  return CLUSTER_FLOATS;
}

export function packClusters(meshes: readonly ClusterSource[]): ClusterBuffers {
  let clusters = 0;
  let indices = 0;
  for (const mesh of meshes) {
    clusters += mesh.count;
    indices += mesh.indices.length;
  }

  const packed: ClusterBuffers = {
    bounds: new Float32Array(clusters * 4),
    cones: new Float32Array(clusters * 4),
    errors: new Float32Array(clusters * 2),
    indexOffsets: new Uint32Array(clusters),
    indexCounts: new Uint32Array(clusters),
    clusterId: new Uint32Array(clusters),
    meshOf: new Uint32Array(clusters),
    indices: new Uint32Array(indices),
    count: clusters,
  };

  let cluster = 0;
  let indexAt = 0;
  for (let meshIndex = 0; meshIndex < meshes.length; meshIndex += 1) {
    const mesh = meshes[meshIndex] as ClusterSource;
    packed.indices.set(mesh.indices, indexAt);

    for (let c = 0; c < mesh.count; c += 1) {
      packed.bounds[cluster * 4] = mesh.boundsCentre[c * 3] as number;
      packed.bounds[cluster * 4 + 1] = mesh.boundsCentre[c * 3 + 1] as number;
      packed.bounds[cluster * 4 + 2] = mesh.boundsCentre[c * 3 + 2] as number;
      packed.bounds[cluster * 4 + 3] = mesh.boundsRadius[c] as number;

      packed.cones[cluster * 4] = mesh.coneAxis[c * 3] as number;
      packed.cones[cluster * 4 + 1] = mesh.coneAxis[c * 3 + 1] as number;
      packed.cones[cluster * 4 + 2] = mesh.coneAxis[c * 3 + 2] as number;
      /* Carried as a cosine, read by the cull as a sine: see `cullCutoff`. */
      packed.cones[cluster * 4 + 3] = cullCutoff(mesh.coneCutoff[c] as number);

      packed.errors[cluster * 2] = mesh.ownError[c] as number;
      packed.errors[cluster * 2 + 1] = mesh.parentError[c] as number;

      /*
       * `MSHL` stores a cluster's span in *triangles*; the packed buffer stores it in *indices*,
       * because a shader fetching indices counts indices. Three of one is one of the other, and
       * mixing them is a cluster that draws a third of itself.
       */
      packed.indexOffsets[cluster] = indexAt + (mesh.triangleOffsets[c] as number) * 3;
      packed.indexCounts[cluster] = (mesh.triangleCounts[c] as number) * 3;
      packed.clusterId[cluster] = cluster;
      packed.meshOf[cluster] = meshIndex;
      cluster += 1;
    }
    indexAt += mesh.indices.length;
  }
  return packed;
}
