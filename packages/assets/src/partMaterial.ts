/**
 * A loaded part's material, written into the shape the renderer's `setMaterial` takes.
 *
 * **Every field or none**, because a partial copy fails in the one way nobody notices: silently and
 * dark. `SurfaceMaterial` defaults `occlusionStrength` to 1, which is right for a caller who binds
 * an ORM map and says nothing. A glTF material with no occlusion texture is carried as 0, and glTF
 * lets its ORM map's red channel be anything — zero, in a bought scene measured here. A consumer
 * who copied the maps and not the strength drew every surface multiplied by that zero. This is the
 * one place the correspondence is written, so a field added to one side has one place to arrive.
 *
 * Writes into a caller-owned object and allocates nothing, so a scene rewrites one material per
 * part in its frame loop. Opacity and reflectivity are not written: the first is a choice of draw
 * call and the second a separate setter, and both stay the caller's to apply.
 */
import type { SurfaceMaterial, SurfaceTextureHandle } from '@driftengine/core';
import type { TextureSet } from './drftTextures.ts';
import type { DrftPart } from './loadProgress.ts';

function at(
  textures: TextureSet<SurfaceTextureHandle> | null,
  index: number,
): SurfaceTextureHandle | null {
  return index >= 0 ? (textures?.at(index) ?? null) : null;
}

/** `part`'s maps and factors into `out`, resolving each map through `textures`. */
export function writePartMaterial(
  part: DrftPart,
  textures: TextureSet<SurfaceTextureHandle> | null,
  out: SurfaceMaterial<SurfaceTextureHandle>,
): SurfaceMaterial<SurfaceTextureHandle> {
  out.albedo = at(textures, part.albedo);
  out.orm = at(textures, part.orm);
  out.normal = at(textures, part.normal);
  out.emissive = at(textures, part.emissive);
  out.roughnessScale = part.roughnessScale;
  out.metallicScale = part.metallicScale;
  out.occlusionStrength = part.occlusionStrength;
  out.cutout = part.cutout;
  out.doubleSided = part.doubleSided;
  return out;
}
