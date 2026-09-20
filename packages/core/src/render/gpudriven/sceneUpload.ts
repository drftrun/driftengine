/**
 * A scene's meshes packed into the one set of buffers a GPU-driven frame reads.
 *
 * **`clusterUpload.ts` packs the clusters and this packs everything they point at.** That split is
 * not arbitrary: the cluster packing is about identifiers and spans and has no idea a vertex
 * exists, and it rebases each mesh's index *offsets* by the indices already written while leaving
 * the index *values* alone. Which is right — a mesh's indices address that mesh's vertices — and
 * is exactly wrong the moment two meshes share one buffer, which is the whole point of the
 * pipeline. Every mesh after the first would address vertex zero of the *scene*, a real vertex
 * belonging to the first mesh, drawn in the wrong place with nothing reporting anything.
 *
 * So the rebasing happens here, where the vertex base is known, and the packer is handed sources
 * whose indices are already scene-global.
 *
 * **Three parallel arrays rather than one interleaved vertex.** The raster shader reads
 * `positions[index * 3]` and the shading pass reads normals and colours the same way; an
 * interleaved stride would put the layout in three shaders instead of one place, and the memory
 * this saves is not the memory the pipeline is short of.
 *
 * **Colour is a vertex attribute, because that is what this engine's geometry carries.**
 * `MeshData` has `colors` and most of it is untextured, so the shading pass interpolates them the
 * way the forward path does rather than inventing a material system to sit beside the one that
 * exists. What a *material* then selects is the shading each bin gets — see `materialBin.ts` — and
 * a mesh names one.
 */

import { packClusters, type ClusterBuffers, type ClusterSource } from './clusterUpload.ts';

/**
 * Floats a vertex in the buffer the GPU-driven pass uploads: position, normal, colour, uv, glow.
 *
 * **One number read by four consumers** — the upload, the raster, the blended raster and the
 * shading pass — and `vertexLayout.test.ts` holds all four to it. It was nine until UVs arrived on
 * 2026-09-17, and eleven until the voxel sandbox's block light needed a glow a vertex on 2026-09-18.
 */
export const GPU_DRIVEN_VERTEX_FLOATS = 12;

/** One mesh of a GPU-driven scene: its vertices, its clusters, and which material shades it. */
export interface GpuDrivenMesh {
  /** Three floats a vertex. */
  readonly positions: Float32Array;
  /** Three floats a vertex. */
  readonly normals: Float32Array;
  /** Three floats a vertex. */
  readonly colours: Float32Array;
  /**
   * Two floats a vertex. Optional: a mesh without them uploads zeros, and a textured material on
   * it reads one texel everywhere and turns no normal — a statement about the mesh, and what the
   * forward path does with an absent attribute.
   */
  readonly uvs?: Float32Array;
  /**
   * One float a vertex, added to the material's own emissive. Optional: a mesh without it glows as
   * its material says and nothing more, which is every mesh before 2026-09-18.
   *
   * **For light a colour cannot carry.** The voxel sandbox folds occlusion and sky light into the
   * vertex colour and keeps block light here, because it has to survive the sun going down and a
   * colour is multiplied by the sun. The forward path reads the same attribute from `MeshData`.
   */
  readonly emissive?: Float32Array;
  /** This mesh's clusters, with indices addressing *this mesh's* vertices. */
  readonly clusters: ClusterSource;
  /** Which material bin every cluster of this mesh shades in. */
  readonly material: number;
}

export interface GpuDrivenScene {
  /** Every mesh's positions, concatenated in the order they were given. */
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly colours: Float32Array;
  /** Two floats a vertex, zeros where a mesh carried none. */
  readonly uvs: Float32Array;
  /** One float a vertex, zeros where a mesh carried none. */
  readonly emissive: Float32Array;
  /** The clusters, with indices addressing `positions` rather than any one mesh. */
  readonly clusters: ClusterBuffers;
  /** One material a cluster, from the mesh it came from. */
  readonly materialOf: Uint32Array;
  /** Where each mesh's vertices begin. One entry a mesh, including meshes with no clusters. */
  readonly vertexBase: Uint32Array;
  readonly vertexCount: number;
}

/**
 * A mesh's per-vertex glow, refused by name when it is not one float a vertex.
 *
 * Shared by both packers, because a glow of the wrong length read one float a vertex is somebody
 * else's torchlight on the next mesh along — or `NaN` past the end, which lights nothing and says
 * nothing about why.
 */
export function glowOf(mesh: GpuDrivenMesh, at: number | string): Float32Array | undefined {
  const glow = mesh.emissive;
  if (glow === undefined) return undefined;
  const count = mesh.positions.length / 3;
  if (glow.length !== count) {
    throw new Error(
      `[driftengine] mesh ${at} carries ${glow.length} emissive values for ${count} vertices`,
    );
  }
  return glow;
}

/**
 * Pack a scene.
 *
 * **A mesh with no clusters still takes its slot**, in `vertexBase` and in the mesh numbering the
 * clusters carry. `meshOf` indexes the caller's transform array, so dropping an empty mesh shifts
 * every mesh after it and each of their clusters draws with somebody else's matrix — the same
 * reasoning `packClusters` already gives, one level up.
 */
export function buildGpuDrivenScene(meshes: readonly GpuDrivenMesh[]): GpuDrivenScene {
  let vertices = 0;
  let clusters = 0;
  const vertexBase = new Uint32Array(meshes.length);
  for (let at = 0; at < meshes.length; at += 1) {
    const mesh = meshes[at] as GpuDrivenMesh;
    vertexBase[at] = vertices;
    vertices += mesh.positions.length / 3;
    clusters += mesh.clusters.count;
  }

  const positions = new Float32Array(vertices * 3);
  const normals = new Float32Array(vertices * 3);
  const colours = new Float32Array(vertices * 3);
  const uvs = new Float32Array(vertices * 2);
  const emissive = new Float32Array(vertices);
  const rebased: ClusterSource[] = [];
  const materialOf = new Uint32Array(clusters);

  let cluster = 0;
  for (let at = 0; at < meshes.length; at += 1) {
    const mesh = meshes[at] as GpuDrivenMesh;
    const base = vertexBase[at] as number;
    positions.set(mesh.positions, base * 3);
    normals.set(mesh.normals, base * 3);
    colours.set(mesh.colours, base * 3);
    if (mesh.uvs !== undefined) {
      const count = mesh.positions.length / 3;
      if (mesh.uvs.length !== count * 2) {
        throw new Error(
          `[driftengine] mesh ${at} carries ${mesh.uvs.length} uv values for ${count} vertices`,
        );
      }
      uvs.set(mesh.uvs, base * 2);
    }
    const glow = glowOf(mesh, at);
    if (glow !== undefined) emissive.set(glow, base);

    const indices = new Uint32Array(mesh.clusters.indices.length);
    for (let i = 0; i < indices.length; i += 1) {
      indices[i] = (mesh.clusters.indices[i] as number) + base;
    }
    rebased.push({ ...mesh.clusters, indices });

    for (let c = 0; c < mesh.clusters.count; c += 1) {
      materialOf[cluster] = mesh.material;
      cluster += 1;
    }
  }

  return {
    positions,
    normals,
    colours,
    uvs,
    emissive,
    clusters: packClusters(rebased),
    materialOf,
    vertexBase,
    vertexCount: vertices,
  };
}
