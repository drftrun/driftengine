/*! DriftEngine | Copyright 2026 Drift Technologies | Apache-2.0 | https://github.com/drftrun/driftengine */
/**
 * `@driftengine/terrain` — a heightfield, the surface it draws, and the same answer to both.
 *
 * **It imports no renderer.** What it hands back is `MeshData`, which a consumer gives to
 * `createMesh` like any other geometry, so terrain is drawn by the pass that already exists rather
 * than by one of its own. That is why this is a package and not a part of core: a world with no
 * terrain in it pays nothing, and a world with terrain pays for arithmetic rather than for a
 * second renderer.
 *
 * The three things it is careful about are written where they are decided — `heightfield.ts` on why
 * a query reads the triangle rather than the bilinear patch, `heightfieldPatch.ts` on why a seam
 * between two levels of detail is matched rather than covered with a skirt, and
 * `terrainMaterials.ts` on why a weight map is read the *other* way, bilinearly, and baked into
 * vertex colour rather than sampled by a shader.
 */

export { Terrain } from './heightfield.ts';
export type { HeightfieldOptions } from './heightfield.ts';
export { heightfieldPatch } from './heightfieldPatch.ts';
export type { HeightfieldPatchOptions } from './heightfieldPatch.ts';
export { TerrainMaterials, terrainMaterialWeights } from './terrainMaterials.ts';
export type { TerrainMaterial, TerrainMaterialsOptions } from './terrainMaterials.ts';
/*
 * The clipmap: which squares of the field to draw at what detail, as one decision per patch so it
 * can move into a compute pass beside the cluster cut rather than be rewritten there. It builds no
 * geometry — `heightfieldPatch` does that, and matches the seam.
 */
export {
  CLIPMAP_LEVELS,
  CLIPMAP_PATCHES_ACROSS,
  CLIPMAP_PATCH_CELLS,
  clipmapFrame,
  clipmapLevelAt,
  clipmapPatchAt,
  clipmapPatchCount,
  clipmapPatchOptions,
  emptyClipmapPatch,
  selectClipmap,
} from './clipmap.ts';
export type { ClipmapFrame, ClipmapOptions, ClipmapPatch } from './clipmap.ts';
/*
 * Heights and material weights as `DTEX` layers, and the one rule that makes it safe: a terrain
 * rebuilt from a layer is built from the decoded samples, so collision and rendering cannot read
 * different numbers. Opt-in — a consumer who never names these imports none of `@driftengine/texture`.
 */
export {
  TERRAIN_HEIGHT_LEVELS,
  TERRAIN_SPLAT_CHANNELS,
  TERRAIN_SPLAT_LEVELS,
  decodeTerrainHeights,
  decodeTerrainSplat,
  encodeTerrainHeights,
  encodeTerrainSplat,
  terrainFromHeightLayer,
  terrainHeightTolerance,
} from './terrainTexture.ts';
export type { TerrainHeightLayer, TerrainSplatLayer } from './terrainTexture.ts';
