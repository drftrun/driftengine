/** Where a cluster actually stands: its bounds, its cone and its error through its mesh transform. */

/**
 * **The cull asks about the world and a cluster is baked in its mesh's own space.**
 *
 * `visbufferRaster.wgsl.ts` multiplies every vertex by `transforms[mesh]` and `shade.wgsl.ts`
 * multiplies every normal by the same upper three-by-three. The culling did neither: it read
 * `ClusterBuffers.bounds` and `ClusterBuffers.cones` as they came out of the bake, so a mesh placed
 * anywhere but the origin was frustum-culled against the wrong region, cone-culled with the wrong
 * orientation, LOD-cut on a misprojected error and occlusion-tested on the wrong rectangle — while
 * the picture it drew was still drawn in the right place, because the raster had the transform.
 *
 * **Every rig in `DRAFT_SCENES` uses an identity transform**, which is the only reason it never
 * showed. That is the shape §3 row 79 is about: the device check agreed, the reference agreed, and
 * nothing in the repository placed a mesh anywhere.
 *
 * **It happens once, at upload, and not per frame.** This pipeline owns a fixed cluster set with
 * static transforms — the same property `shadowCamera.ts` fits the light's box to — so the world
 * bounds are a property of the scene. A pipeline that ever moves a mesh has to rewrite these two
 * buffers when it does, and that is the cost of having them.
 */

/** What the transform needs of a packed cluster set. `ClusterBuffers` satisfies it. */
export interface ClusterWorldSource {
  /** Four floats a cluster: centre and radius, in the mesh's own space. */
  readonly bounds: Float32Array;
  /** Four floats a cluster: cone axis and cutoff, in the mesh's own space. */
  readonly cones: Float32Array;
  /** Two floats a cluster: its own error and its parent's. */
  readonly errors: Float32Array;
  /** Which mesh each cluster belongs to, which is what it reaches a transform through. */
  readonly meshOf: Uint32Array;
  readonly count: number;
}

/** The two buffers the culling stages read, in the layout they are bound in. */
export interface ClusterWorld {
  /** Eight floats a cluster: world centre, radius, cone axis, cutoff. `cullClusters` takes this. */
  cull: Float32Array;
  /** Six floats a cluster: world centre, radius, own error, parent error. `lodCut` reads these. */
  lod: Float32Array;
}

/** Eight floats a cluster in `cull`, matching `CLUSTER_CULL_FLOATS` and the cull shader's stride. */
const CULL_FLOATS = 8;

/** Six floats a cluster in `lod`, matching the LOD shader's `i * 6u`. */
const LOD_FLOATS = 6;

/**
 * How far from a similarity a transform may be before the cone is refused.
 *
 * Relative, and loose on purpose: a rotation composed in single precision loses a few parts in ten
 * million, and the comparison has to pass every matrix a `Transform` produces without passing a
 * scale a modeller meant. A hundredth of a per cent is three orders of magnitude clear of the one
 * and four clear of the other.
 */
const SIMILARITY_TOLERANCE = 1e-4;

/**
 * Transform every cluster into the world, once.
 *
 * `transforms` is sixteen floats a mesh, column-major, indexed by `meshOf`.
 */
export function worldClusters(
  clusters: ClusterWorldSource,
  transforms: Float32Array,
): ClusterWorld {
  const cull = new Float32Array(clusters.count * CULL_FLOATS);
  const lod = new Float32Array(clusters.count * LOD_FLOATS);
  worldClustersInto(clusters, transforms, cull, lod, 0);
  return { cull, lod };
}

/**
 * The same arithmetic, writing into arrays the caller owns at a cluster offset it chooses.
 *
 * **This exists because a streamed mesh computes its own bounds**, at the moment it is added, into
 * the middle of a scene-sized buffer that already holds other meshes'. `worldClusters` is this
 * with the allocation, so the two cannot drift — which this file asserts by composing two meshes
 * both ways and comparing byte for byte.
 *
 * `base` is in clusters, not floats: the record at `base + c` is written for every cluster `c` of
 * the source, and everything outside that range is left exactly as it was found.
 */
export function worldClustersInto(
  clusters: ClusterWorldSource,
  transforms: Float32Array,
  cull: Float32Array,
  lod: Float32Array,
  base: number,
): void {
  const count = clusters.count;

  /*
   * Per mesh rather than per cluster: a scene is thousands of clusters over a handful of meshes,
   * and the two questions asked of a matrix — how much it scales, and whether it scales evenly —
   * are nine multiplies each.
   */
  const meshes = Math.floor(transforms.length / 16);
  const scales = new Float64Array(meshes);
  const similar = new Uint8Array(meshes);
  for (let m = 0; m < meshes; m += 1) {
    const at = m * 16;
    const l0 = Math.hypot(
      transforms[at] as number,
      transforms[at + 1] as number,
      transforms[at + 2] as number,
    );
    const l1 = Math.hypot(
      transforms[at + 4] as number,
      transforms[at + 5] as number,
      transforms[at + 6] as number,
    );
    const l2 = Math.hypot(
      transforms[at + 8] as number,
      transforms[at + 9] as number,
      transforms[at + 10] as number,
    );
    const longest = Math.max(l0, l1, l2);
    scales[m] = longest;

    /*
     * **The longest basis vector is the scale, which is exact for `T · R · S` and conservative for
     * nothing else.** A sphere of radius `r` maps to an ellipsoid whose longest semi-axis is the
     * matrix's largest singular value, and for a rotation applied *after* a scale the columns are
     * the scaled axes and their lengths are exactly the singular values. A sheared matrix — a scale
     * applied after a rotation, which nothing in this engine composes — has a largest singular
     * value above its longest column, and there the bound is too small and clusters are culled that
     * should be drawn. `sceneShadowBounds` reads the same number and carries the same limit.
     *
     * A similarity is the case where the *cone* survives too: three columns of equal length, at
     * right angles. Then the inverse transpose is the matrix over the scale squared, so a normal
     * multiplied by the matrix and renormalised is the right direction and the cone's half-angle is
     * unchanged. Anywhere else the two disagree by up to a right angle and the cone is refused.
     */
    const even =
      Math.abs(l0 - longest) <= SIMILARITY_TOLERANCE * longest &&
      Math.abs(l1 - longest) <= SIMILARITY_TOLERANCE * longest &&
      Math.abs(l2 - longest) <= SIMILARITY_TOLERANCE * longest;
    const square = longest * longest;
    const d01 =
      (transforms[at] as number) * (transforms[at + 4] as number) +
      (transforms[at + 1] as number) * (transforms[at + 5] as number) +
      (transforms[at + 2] as number) * (transforms[at + 6] as number);
    const d02 =
      (transforms[at] as number) * (transforms[at + 8] as number) +
      (transforms[at + 1] as number) * (transforms[at + 9] as number) +
      (transforms[at + 2] as number) * (transforms[at + 10] as number);
    const d12 =
      (transforms[at + 4] as number) * (transforms[at + 8] as number) +
      (transforms[at + 5] as number) * (transforms[at + 9] as number) +
      (transforms[at + 6] as number) * (transforms[at + 10] as number);
    const square90 =
      Math.abs(d01) <= SIMILARITY_TOLERANCE * square &&
      Math.abs(d02) <= SIMILARITY_TOLERANCE * square &&
      Math.abs(d12) <= SIMILARITY_TOLERANCE * square;
    similar[m] = longest > 0 && even && square90 ? 1 : 0;
  }

  for (let c = 0; c < count; c += 1) {
    const at = (clusters.meshOf[c] as number) * 16;
    const scale = scales[clusters.meshOf[c] as number] as number;

    const cx = clusters.bounds[c * 4] as number;
    const cy = clusters.bounds[c * 4 + 1] as number;
    const cz = clusters.bounds[c * 4 + 2] as number;
    const wx =
      (transforms[at] as number) * cx +
      (transforms[at + 4] as number) * cy +
      (transforms[at + 8] as number) * cz +
      (transforms[at + 12] as number);
    const wy =
      (transforms[at + 1] as number) * cx +
      (transforms[at + 5] as number) * cy +
      (transforms[at + 9] as number) * cz +
      (transforms[at + 13] as number);
    const wz =
      (transforms[at + 2] as number) * cx +
      (transforms[at + 6] as number) * cy +
      (transforms[at + 10] as number) * cz +
      (transforms[at + 14] as number);
    const radius = (clusters.bounds[c * 4 + 3] as number) * scale;

    const ax = clusters.cones[c * 4] as number;
    const ay = clusters.cones[c * 4 + 1] as number;
    const az = clusters.cones[c * 4 + 2] as number;
    const tx =
      (transforms[at] as number) * ax +
      (transforms[at + 4] as number) * ay +
      (transforms[at + 8] as number) * az;
    const ty =
      (transforms[at + 1] as number) * ax +
      (transforms[at + 5] as number) * ay +
      (transforms[at + 9] as number) * az;
    const tz =
      (transforms[at + 2] as number) * ax +
      (transforms[at + 6] as number) * ay +
      (transforms[at + 10] as number) * az;
    const length = Math.hypot(tx, ty, tz);
    /*
     * **A cutoff of one is a refusal rather than a wide cone.** `cullClusters` culls when
     * `dot(axis, d) >= cutoff * |d| + radius`, and for a unit axis the left-hand side is at most
     * `|d|` — so at one the test cannot fire however the cluster is aimed, which is the
     * conservative answer and is already what a bake writes for a cluster whose normals span a
     * hemisphere.
     */
    const keepsCone = similar[clusters.meshOf[c] as number] === 1 && length > 0;
    const out = (base + c) * CULL_FLOATS;
    cull[out] = wx;
    cull[out + 1] = wy;
    cull[out + 2] = wz;
    cull[out + 3] = radius;
    cull[out + 4] = keepsCone ? tx / length : ax;
    cull[out + 5] = keepsCone ? ty / length : ay;
    cull[out + 6] = keepsCone ? tz / length : az;
    cull[out + 7] = keepsCone ? (clusters.cones[c * 4 + 3] as number) : 1;

    /*
     * **The errors are lengths and a scale is a length's units.** `projectedError` divides a
     * geometric error by the distance to the eye and multiplies by the screen height; the distance
     * is in world metres now, so the error has to be. A mesh scaled up with its model-space error
     * left alone draws its coarsest level everywhere.
     *
     * `Infinity` is how the coarsest level says it has no parent, and it is left alone: multiplied
     * by a scale of zero it is `NaN`, every comparison against it is false, and the root of every
     * mesh disappears.
     */
    const ownError = clusters.errors[c * 2] as number;
    const parentError = clusters.errors[c * 2 + 1] as number;
    const into = (base + c) * LOD_FLOATS;
    lod[into] = wx;
    lod[into + 1] = wy;
    lod[into + 2] = wz;
    lod[into + 3] = radius;
    lod[into + 4] = ownError * scale;
    lod[into + 5] = Number.isFinite(parentError) ? parentError * scale : parentError;
  }
}
