/**
 * A material's tiled detail: small normal maps, and occlusion, repeated many times over the base
 * maps, a region map choosing which one each texel wears. `SurfaceMaterial.detail`, packed into
 * `uDetail` for `shaders/flat/detail.ts`.
 *
 * **What it is for.** A surface's finest grain — leather, a weave, brushed metal, a face's pores —
 * is a map of a few hundred texels repeated tens of times across it. Baked into the base maps it is
 * lost: a 256-texel detail tiled forty times over a 2048-texel map would want some ten thousand
 * texels a side. So the base maps carry the shape and a detail map the grain, each garment region
 * with its own grain at its own repeat, which is how such surfaces are authored.
 *
 * **Where the maps are.** The lit stage has no texture binding to spare on either backend, so the
 * detail maps are layers of the array read where a shading model's map is (`uModelMap`), and the
 * region map is a layer of the material's own ORM array, one index a texel in its red. What that
 * gives up, said where each is refused: a material whose shading model has a map must put its
 * detail layers in that same array; a layered material whose mask is a map cannot have detail; and
 * the region map shares the ORM array's size and format, which must keep an index exactly, so an
 * uncompressed one.
 *
 * **Sixteen regions, two vectors each**, behind one vector saying how many and where the region
 * map is: thirty-three in all, which is why WebGL2 compiles them in only when a material first asks
 * and refuses them on a part with no room for them.
 */

/** Regions a material may name. */
export const MAX_DETAIL_REGIONS = 16;

/** Floats `uDetail` holds: a header vector, then two vectors a region. */
export const DETAIL_FLOATS = 4 + MAX_DETAIL_REGIONS * 8;

/** One region's detail. */
export interface SurfaceDetailRegion {
  /** The layer of the detail array holding this region's tangent-space normal map. */
  readonly normalLayer: number;
  /** The layer holding its occlusion, in red; absent, the region adds none. */
  readonly occlusionLayer?: number;
  /** Repeats across the base coordinates, the same both ways or across and down apart. */
  readonly repeat: number | readonly [number, number];
  /** Added to the repeated coordinates, so neighbouring regions need not line up. Default none. */
  readonly offset?: readonly [number, number];
  /** How far the detail turns the normal: 0 lies flat, 1 as drawn, more steeper. Default 1. */
  readonly normalStrength?: number;
  /** How much of its occlusion is laid on, from 0 to 1. Default 1. */
  readonly occlusionStrength?: number;
}

/** A material's tiled detail. */
export interface SurfaceDetail<Texture> {
  /**
   * The array whose layers the regions name, read where a shading model's map is. A material with
   * a `modelMap` puts its detail layers in that array and names it here too.
   */
  readonly maps: Texture;
  /**
   * The layer of the material's ORM array holding the region map: in its red, each texel's region
   * as an index from 0, stored as `index / 255`, read exactly at the base coordinates. Absent, every
   * texel is region 0, which is a surface with one detail all over: a face's pores.
   */
  readonly regionLayer?: number;
  /** Up to sixteen, by index. A texel naming a region past the last wears the last. */
  readonly regions: readonly SurfaceDetailRegion[];
}

/**
 * Pack a material's detail into `out`, `DETAIL_FLOATS` long; zeros for none, which the shader reads
 * as no detail. `hasOrm` says whether the material carries the ORM array a region map is a layer
 * of; without one every texel is region 0. Allocates nothing.
 */
export function packSurfaceDetail(
  detail: SurfaceDetail<unknown> | null,
  hasOrm: boolean,
  out: Float32Array,
): void {
  out.fill(0);
  if (detail === null) return;
  const count = Math.min(MAX_DETAIL_REGIONS, detail.regions.length);
  out[0] = count;
  const regionLayer = detail.regionLayer;
  out[1] = hasOrm && regionLayer !== undefined ? Math.max(0, Math.floor(regionLayer)) : -1;
  for (let i = 0; i < count; i++) {
    const region = detail.regions[i] as SurfaceDetailRegion;
    const at = 4 + i * 8;
    const repeat = region.repeat;
    const across = typeof repeat === 'number' ? repeat : repeat[0];
    const down = typeof repeat === 'number' ? repeat : repeat[1];
    out[at] = Math.max(0, Math.floor(region.normalLayer));
    out[at + 1] =
      region.occlusionLayer === undefined ? -1 : Math.max(0, Math.floor(region.occlusionLayer));
    out[at + 2] = Math.max(0, region.normalStrength ?? 1);
    out[at + 3] = Math.min(1, Math.max(0, region.occlusionStrength ?? 1));
    /* A repeat at or below zero has no grain to show, so it is one rather than a mirror or nothing. */
    out[at + 4] = across > 0 ? across : 1;
    out[at + 5] = down > 0 ? down : 1;
    out[at + 6] = region.offset?.[0] ?? 0;
    out[at + 7] = region.offset?.[1] ?? 0;
  }
}

/** Why a material's detail is drawn without, or null where nothing stands in its way. */
export type DetailRefusal = 'slot' | 'projection';

/**
 * Whether a material's detail can be drawn, given what else wants the slot its maps are read
 * through: a shading model's own map, or a layered material's mask where it is a map. Either must
 * be the detail's array itself. And a material placed by the world has no base coordinates for a
 * region map to be read at, so its detail is refused too.
 */
export function detailRefusal(
  detail: SurfaceDetail<unknown>,
  slotTakenBy: unknown,
  projected: boolean,
): DetailRefusal | null {
  if (projected) return 'projection';
  if (slotTakenBy !== null && slotTakenBy !== undefined && slotTakenBy !== detail.maps) {
    return 'slot';
  }
  return null;
}

/** A material's detail, or null where it names none or no region. */
export function detailOf<Texture>(
  material: { readonly detail?: SurfaceDetail<Texture> | null } | null,
): SurfaceDetail<Texture> | null {
  const detail = material?.detail ?? null;
  return detail === null || detail.regions.length === 0 ? null : detail;
}

/** The sentence each backend says once when it draws a material without its detail. */
export function detailRefusalWarning(refusal: DetailRefusal): string {
  return refusal === 'slot'
    ? "Renderer: a material's detail is drawn without: its maps are read where a shading model's " +
        "map goes, and this material binds another array there, its `modelMap` or its layers' " +
        'mask. Put the detail layers in the `modelMap` array and name that array as `detail.maps`.'
    : "Renderer: a material's detail is drawn without: it is placed by the world (`projection`), " +
        'so there are no base coordinates for its regions and repeats to be read at.';
}
