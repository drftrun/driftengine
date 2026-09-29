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
  /**
   * The scale over the ORM map's metallic channel, in place of the material's. For a map whose
   * channel says metal where the surface is not: a bought courtyard's stone carried up to 0.37 on
   * its clean stone, and each patch in shade swapped its diffuse light for a reflection of a dark
   * gallery and read as a black blotch. 0 says dielectric.
   */
  readonly metallicScale?: number;
  /**
   * Glass, in place of what the file says: the share of light that passes, how milky it is, and
   * the colour it takes (`GlassOptions` in the renderer). For a model whose panes arrive as an
   * opaque dark material, because its format or its exporter had no word for glass. Transmission
   * above zero draws the part blended.
   */
  readonly transmission?: number;
  readonly frost?: number;
  readonly tint?: readonly [number, number, number];
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
  /** Whether the texture's alpha is coverage, so the part is drawn blended whatever its opacity. */
  readonly blend: boolean;
  /** Whether both faces are drawn and lit. A merge of a two-sided part and a one-sided one would cull
   *  one of them or unhide the back of the other, so it is part of the key. */
  readonly doubleSided: boolean;
  /**
   * Glass. Zero transmission is not glass, and then frost is 0 and the tint white whatever the
   * file or the override said, so a stray value on an opaque surface never splits a draw.
   */
  readonly transmission: number;
  readonly frost: number;
  readonly tint: readonly [number, number, number];
}

const CLEAR: readonly [number, number, number] = [1, 1, 1];

/**
 * Resolve what a part will actually be drawn with.
 *
 * **The defaults are the loader's and are not arbitrary.** A missing texture index is `-1` rather
 * than `0`, because `0` is a real image. Opacity and the two scales default to 1 and the rest to
 * 0, which is the identity that lets a file saying nothing about a property draw the same as one
 * that did not have the property to say.
 *
 * The override wins over the material for the fields it may carry, because a consumer dressing
 * a surface by name knows more than a default an exporter wrote. A cutout is not among them: it is
 * a fact about the *image* a material wears, so nothing outside the file has anything to say
 * about it.
 */
export function resolveDrawGrouping(
  material: DrftMaterial | undefined,
  override?: DrawSurfaceOverride,
): DrawGrouping {
  const transmission = Math.max(0, override?.transmission ?? material?.transmission ?? 0);
  const glass = transmission > 0;
  return {
    albedo: material?.albedo ?? -1,
    orm: material?.ormMap ?? -1,
    normal: material?.normalMap ?? -1,
    emissive: material?.emissiveMap ?? -1,
    opacity: override?.opacity ?? material?.opacity ?? 1,
    reflectivity: override?.reflectivity ?? material?.reflectivity ?? 0,
    roughnessScale: material?.roughnessScale ?? 1,
    metallicScale: override?.metallicScale ?? material?.metallicScale ?? 1,
    occlusionStrength: material?.occlusionStrength ?? 0,
    cutout: material?.cutout ?? 0,
    blend: material?.blend === true || glass,
    doubleSided: material?.doubleSided === true,
    transmission,
    frost: glass ? (override?.frost ?? material?.frost ?? 0) : 0,
    tint: glass ? (override?.tint ?? material?.tint ?? CLEAR) : CLEAR,
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
  return `${g.albedo}:${g.orm}:${g.normal}:${g.emissive}:${g.opacity}:${g.reflectivity}:${g.roughnessScale}:${g.metallicScale}:${g.occlusionStrength}:${g.cutout}:${g.blend ? 1 : 0}:${g.doubleSided ? 1 : 0}:${g.transmission}:${g.frost}:${g.tint[0]},${g.tint[1]},${g.tint[2]}`;
}
