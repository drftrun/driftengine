/**
 * The joint palette's shape: how wide its texture is, how many joints fit, and which unit it takes.
 *
 * **Backend-neutral by the 2026-08-13 rule.** Both backends upload a palette and both need the
 * same three answers, so the decision lives here and only the binding is per-backend. A helper
 * that took a `WebGL2RenderingContext` would be a decision the other backend could not reach, and
 * two implementations of one rule drift.
 *
 * **The palette is a texture and not a `uniform mat4[]`, and the rule that would have barred one
 * does not reach here.** The 2026-08-07 rule governs implicit derivatives in non-uniform control
 * flow — a *fragment*-stage hazard. A vertex stage computes no derivatives, so `texelFetch` there
 * is unconditional and that rule has nothing to say about it.
 *
 * What a uniform array would have cost is the reason: `MAX_VERTEX_UNIFORM_VECTORS` is 256 on the
 * WebGL2 floor and `FLAT_VERT` already spends fifteen, so four vectors a matrix caps a rig at
 * **sixty joints** — under a humanoid with fingers, and on exactly the mid-range hardware the
 * engine hard-gates 60 fps on.
 *
 * What the texture costs is an upload per skinned draw where an array would be a uniform write.
 * What would make it wrong is a profile showing that upload is the limit at a realistic character
 * count; the fix is then one texture holding every character's palette with a per-draw row offset,
 * which is a follow-on rather than a starting point.
 *
 * **A palette belongs to a draw, and what it takes to honour that differs per backend.** WebGL2
 * uploads with `texSubImage2D`, a command in the same stream as the draws around it, so one texture
 * rewritten between two draws separates them by construction. WebGPU's `queue.writeTexture` is
 * ordered on the queue timeline and the frame's encoder is submitted after every upload in it, so
 * the same one texture hands *every* skinned draw of the frame the last palette written — and since
 * a rig carries its placement in its palette, that is every character standing where the last one
 * drawn stands. That backend therefore binds a ring of palettes, one slot per palette a frame sets:
 * `backend/webgpu/skinPaletteRing.ts`. The decision here is one; only the binder differs, per the
 * 2026-08-13 rule.
 */

/**
 * The palette's texture unit, from the lit pass's own budget.
 *
 * Re-exported rather than declared, because a unit number written twice is a collision waiting to
 * happen and `lightBudget.ts` is where every other unit in this pass is decided. It carries the
 * reason it is not 0.
 */
export { SKIN_PALETTE_TEXTURE_UNIT } from './lightBudget.ts';

/** Four `rgba32float` texels hold one column-major 4x4. */
const TEXELS_PER_JOINT = 4;

/**
 * The most joints one palette can hold.
 *
 * WebGL2 guarantees `MAX_TEXTURE_SIZE` of 2048 and promises nothing above it, so a single-row
 * palette holds 2048 / 4 matrices. A humanoid rig is sixty to ninety joints, so this is not a
 * limit anybody meets by accident — but it is stated, refused at construction and named in the
 * error, because a limit a consumer discovers is a defect and a limit they read is a
 * specification.
 *
 * What it costs is that a crowd cannot share one palette. What would make it wrong is a rig above
 * it, and the fix is wrapping onto more rows — which costs one division in the vertex stage and is
 * why it is not the starting point.
 */
export const MAX_JOINTS = 512;

/** How wide the palette texture is for a rig of this many joints. */
export function paletteTextureWidth(jointCount: number): number {
  if (!Number.isInteger(jointCount) || jointCount < 1) {
    throw new Error(`skin palette: a rig needs at least one joint, got ${jointCount}`);
  }
  if (jointCount > MAX_JOINTS) {
    throw new Error(
      `skin palette: ${jointCount} joints exceeds the ${MAX_JOINTS} a single-row palette holds. ` +
        `WebGL2 guarantees a texture width of 2048 and four texels carry one matrix, so this is ` +
        `the floor rather than this machine's limit.`,
    );
  }
  return jointCount * TEXELS_PER_JOINT;
}

/**
 * Refuse a palette that is not whole matrices, naming the length.
 *
 * A caller error with exactly one correct outcome, so it throws rather than warns — and it throws
 * where the palette is handed over rather than where a shader reads a partial matrix and draws a
 * rig folded in on itself.
 */
export function validateSkinPalette(palette: Float32Array): void {
  if (palette.length % 16 !== 0) {
    throw new Error(
      `skin palette: ${palette.length} floats is not a whole number of 4x4 matrices (16 each)`,
    );
  }
  const joints = palette.length / 16;
  if (joints < 1 || joints > MAX_JOINTS) {
    throw new Error(
      `skin palette: ${joints} joints, which is outside 1 to ${MAX_JOINTS}. See MAX_JOINTS.`,
    );
  }
}

/* --- Morph targets, on the same mechanism --- */

/**
 * The most morph targets one mesh can carry.
 *
 * Bounded by the weight array in the vertex uniform block rather than by the delta texture, which
 * is why it is small: eight `vec4`-aligned floats is 128 bytes of a block that has fifteen vectors
 * in it already. Eight is what glTF's own tooling emits and what every exporter defaults to.
 *
 * What it costs is a rig wanting nine expressions. What would make it wrong is one, and the fix is
 * a second weight texture rather than a wider block — the block is per draw and the texture is not.
 */
export const MAX_MORPH_TARGETS = 8;

/**
 * Where one target's delta for one vertex sits in the delta texture.
 *
 * Interleaved by vertex rather than by target — every target of a vertex is adjacent — because the
 * shader reads all of them for one vertex and nothing reads one target across many vertices. That
 * is one cache line instead of `targetCount` of them.
 */
export function morphTexelIndex(vertex: number, target: number, targetCount: number): number {
  return vertex * targetCount + target;
}

/** Refuse a weight array that cannot drive the targets a mesh carries, naming both counts. */
export function validateMorph(weights: Float32Array, targetCount: number): void {
  if (targetCount < 1 || targetCount > MAX_MORPH_TARGETS) {
    throw new Error(
      `morph targets: ${targetCount} is outside 1 to ${MAX_MORPH_TARGETS}. See MAX_MORPH_TARGETS.`,
    );
  }
  if (weights.length < targetCount) {
    throw new Error(
      `morph targets: ${weights.length} weights for ${targetCount} targets. Every target needs ` +
        `one, or the ones past the end read as zero and that target silently never applies.`,
    );
  }
}

/** How wide the delta texture is for a mesh of this many vertices and targets. */
export function morphTextureWidth(vertexCount: number, targetCount: number): number {
  const texels = vertexCount * targetCount;
  if (texels < 1) throw new Error('morph targets: a mesh needs at least one vertex and one target');
  /*
   * One row while it fits, then as many rows as it takes. WebGL2 guarantees a texture width of
   * 2048 and nothing more, and a mesh times its targets passes that at 256 vertices with eight
   * targets — which is a small mesh, so unlike the palette this is the ordinary case rather than
   * the edge one.
   */
  return Math.min(texels, MORPH_TEXTURE_WIDTH);
}

/** Rows the delta texture needs, given the width above. */
export function morphTextureRows(vertexCount: number, targetCount: number): number {
  return Math.ceil((vertexCount * targetCount) / MORPH_TEXTURE_WIDTH);
}

/** WebGL2's guaranteed `MAX_TEXTURE_SIZE`, which is the only width that is safe everywhere. */
const MORPH_TEXTURE_WIDTH = 2048;
