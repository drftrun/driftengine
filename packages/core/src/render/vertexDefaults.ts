/**
 * What a vertex attribute reads as when a mesh does not supply it.
 *
 * **One decision, and it was being made twice.** WebGL2 disables the attribute and hands the
 * driver a constant; WebGPU has no such thing as a disabled attribute, so it reads a
 * one-element buffer at a stride of zero. Two mechanisms, one question — *what does a mesh that
 * said nothing about this mean?* — and `AGENTS.md` is explicit that a question both backends
 * answer belongs in one module and is bound twice.
 *
 * **It was not a tidiness problem.** The values had drifted apart and two of them mattered:
 *
 * - `emissiveColor` is a **sentinel**, not a colour. `flat.ts` reads
 *   `vEmissiveColor.r < 0.0 ? albedo : vEmissiveColor`, so −1 means *"glow in my own colour"*
 *   and 0 means *"glow black"*. WebGPU was filling zeroes, so **every emissive surface whose
 *   mesh omitted the attribute stopped emitting**. `night-street`'s far windows went dark and
 *   its near ones only looked right because they were clipped at white already — which is how
 *   it survived a whole session of being attributed to fog, ambient occlusion and relief.
 * - `roughness` absent is the engine's long-standing lobe, not a mirror. Zero is the shiniest
 *   surface expressible, which is the opposite of "unstated".
 *
 * The rest are genuinely zero, and are written down here anyway so the next attribute added
 * has somewhere obvious to state its answer instead of inheriting one by accident.
 */

/** The engine's fixed lobe, for geometry that never says how rough it is. */
export const DEFAULT_ROUGHNESS = 0.4277;

/**
 * Keyed by the attribute's name in `MeshData`, with one entry per optional attribute.
 *
 * Lengths match the attribute's component count; `vertexDefaults.test.ts` pins that, because a
 * short entry would write a default into the next attribute's slot rather than fail.
 */
export const ABSENT_ATTRIBUTE: Readonly<Record<string, readonly number[]>> = {
  /** No highlight, for geometry that never claimed one. */
  specular: [0],
  uvs: [0, 0],
  /** The sentinel `flat.ts` tests for: inherit the albedo. Never a colour. */
  emissiveColor: [-1, -1, -1],
  roughness: [DEFAULT_ROUGHNESS],
  /**
   * No grain and no relief at all, and that is the point of these attributes rather than a
   * default chosen for convenience: a surface that never says it is mineral is not mineral.
   * `mesh.ts` records that the two versions which inferred it were both wrong.
   */
  grain: [0],
  relief: [0],
  /**
   * A usable frame rather than zero, for the reason `generateTangents` gives about degenerate
   * UVs: a zero tangent normalises to a NaN in any shader that eventually reads one, and a NaN
   * in a fragment takes the pixel with it. `(1, 0, 0)` with a right-handed bitangent is
   * arbitrary and finite, and arbitrary is the honest answer for geometry that has no texture
   * to be oriented against in the first place.
   */
  tangents: [1, 0, 0, 1],
  /**
   * All four influences on joint 0, for a mesh a skinned pipeline draws without a rig.
   *
   * Zero is a trap here rather than a neutral value: four zero weights build a zero matrix, and a
   * zero matrix collapses every vertex it touches onto the origin — so the mesh would not shade
   * oddly, it would vanish. The identity influence is one and three zeroes, which for a mesh with
   * no rig leaves every vertex where it already was.
   *
   * What it costs is nothing; a mesh with joints never reads these. What would make it wrong is a
   * palette whose entry 0 is not identity, which is a rig the importer sorted incorrectly rather
   * than a case to defend against here.
   */
  joints: [0, 0, 0, 0],
  weights: [1, 0, 0, 0],
  /**
   * The four-lane channel: planted, fully sunlit, opaque, and a reserved lane.
   *
   * **Two of these are ones and that is load bearing.** Zero for `skyDirect` would take the
   * directional light off every mesh in the engine that has never heard of this attribute, and
   * zero for `alpha` would make all of them invisible — so the wrong default here is not a subtle
   * shading difference, it is the whole world going dark or vanishing. `vertexDefaults.test.ts`
   * pins the tuple for that reason.
   *
   * Sway is the one honest zero: geometry that never said it bends does not bend.
   *
   * **The fourth lane was 0 while it was reserved and is 1 now that it carries thickness**, and the
   * difference is not cosmetic. It multiplies the thickness a refracting draw states, so a zero
   * makes the path length zero, `pow(tint, 0)` one, and a pane of coloured glass absorb nothing at
   * all — a draw naming a tint and a thickness would bend the scene behind it and take no colour
   * out of it. Every lane here is a multiplier or an amount, and the identity for a multiplier is
   * one.
   *
   * It survived as 0 because the lane was declared and unread, and because the check that exercises
   * refraction supplies a channel array on every subject it draws — so the absent case was never
   * the thing being measured.
   */
  channel: [0, 1, 1, 1],
};

/**
 * What `uOutputTransform` means, as the shader's own integers.
 *
 * Shared because both backends have to agree about which curve a profile named, and because
 * getting it wrong is invisible: the codes are small integers and every one of them is a legal
 * value that produces a picture. `flat.ts` reads `0` as none, `1` as sRGB and `2` as ACES.
 */
export const OUTPUT_TRANSFORM_CODE: Readonly<Record<string, number>> = {
  none: 0,
  srgb: 1,
  aces: 2,
};

/**
 * How far the speed rush reaches, and how far a motion-blurred pixel may travel, both in UV.
 *
 * Shared because both backends run the same composite shader and a difference here is a
 * difference in the picture that nothing else would explain. `renderer.ts` held the only copy.
 */
export const RUSH_REACH_UV = 0.012;
export const MOTION_BLUR_MAX_UV = 0.03;
