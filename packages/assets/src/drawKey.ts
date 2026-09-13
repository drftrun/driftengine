import type { DrftMaterial } from '@driftengine/drft';

/**
 * What decides whether two parts of one model become a single draw call.
 *
 * **This lives here rather than inside `DrftLoader` because a consumer needs it and was copying
 * it.** The loader merges parts whose material would set the same GPU state, and a baker that
 * reports how many draws a baked part will cost has to ask the same question the loader asks. One
 * consumer answered it by rebuilding the key by hand, field for field, with a comment saying so —
 * and that copy went stale the day `cutout` joined the key in 3.26.0, which is a defect nothing
 * could see: a stale key does not throw, it under-counts.
 *
 * So the loader and anyone counting its draws now call the same function. A field added here is
 * added for both, and the copy that could drift no longer exists.
 */

/** The override `DrftLoaderOptions.surface` may return for a material. */
export interface DrawSurfaceOverride {
  readonly opacity?: number;
  readonly reflectivity?: number;
}

/**
 * The fields a merged group carries, resolved from a material and its override.
 *
 * Named for what they are on a group rather than for what they are called on a material —
 * `ormMap` is `orm` here — because these are the values the renderer is handed, and the group is
 * what holds them between the loader and the draw.
 */
export interface DrawGrouping {
  readonly albedo: number;
  readonly orm: number;
  readonly normal: number;
  readonly emissive: number;
  readonly opacity: number;
  readonly reflectivity: number;
  readonly roughnessScale: number;
  readonly metallicScale: number;
  readonly occlusionStrength: number;
  readonly cutout: number;
}

/**
 * Resolve what a part will actually be drawn with.
 *
 * **The defaults are the loader's and are not arbitrary.** A missing texture index is `-1` rather
 * than `0`, because `0` is a real image. Opacity and the two scales default to 1 and the rest to
 * 0, which is the identity that lets a file saying nothing about a property draw the same as one
 * that did not have the property to say.
 *
 * The override wins over the material for the two fields it may carry, because a consumer dressing
 * a surface by name knows more than a default an exporter wrote. A cutout is not among them: it is
 * a fact about the *image* a material wears, so nothing outside the file has anything to say
 * about it.
 */
export function resolveDrawGrouping(
  material: DrftMaterial | undefined,
  override?: DrawSurfaceOverride,
): DrawGrouping {
  return {
    albedo: material?.albedo ?? -1,
    orm: material?.ormMap ?? -1,
    normal: material?.normalMap ?? -1,
    emissive: material?.emissiveMap ?? -1,
    opacity: override?.opacity ?? material?.opacity ?? 1,
    reflectivity: override?.reflectivity ?? material?.reflectivity ?? 0,
    roughnessScale: material?.roughnessScale ?? 1,
    metallicScale: material?.metallicScale ?? 1,
    occlusionStrength: material?.occlusionStrength ?? 0,
    cutout: material?.cutout ?? 0,
  };
}

/**
 * The key two parts must share to be merged into one draw.
 *
 * Grouped by opacity and reflectivity as well as by image, because two surfaces can share a map
 * and differ in blend: merging on the image alone means one cannot be made translucent without
 * taking the other with it. **And by the ORM map and its three scales**, for the same reason one
 * step further out — two surfaces sharing a colour map and differing in roughness scale are not
 * one draw, and merging them would silently give one of them the other's material.
 *
 * A string because it is a `Map` key and nothing reads it back apart.
 */
export function drawKeyOf(
  material: DrftMaterial | undefined,
  override?: DrawSurfaceOverride,
): string {
  const g = resolveDrawGrouping(material, override);
  return `${g.albedo}:${g.orm}:${g.normal}:${g.emissive}:${g.opacity}:${g.reflectivity}:${g.roughnessScale}:${g.metallicScale}:${g.occlusionStrength}:${g.cutout}`;
}
