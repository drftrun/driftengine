/**
 * A baked lightmap: what a consumer hands over, how both backends lay it out, and what a surface
 * reads from it — the backend-neutral half of `createLightmap` and `lightmapModel`, by the
 * 2026-08-13 rule.
 *
 * **What it is for.** A stage built in another engine carries its static light baked: the bounce
 * off its walls, the soft occlusion in its corners, most of the colour a reference render shows.
 * The dynamic lights alone leave everything they do not reach flat. A consumer decodes the bake
 * into pages — one irradiance image and one direction image each — and every lightmapped surface
 * reads its own region of its page, at its second texture coordinates scaled and offset into it.
 *
 * **What a surface adds**, for its shading normal `n` (the normal map's, where it has one):
 *
 *     d     = direction * 2 - 1
 *     light = irradiance(uv) * max(0, dot(d.xyz, n) + d.w)
 *     diffuse += albedo * (1 - metal) * light
 *
 * Unreal's high-quality lightmap read, `GetLightMapColorHQ`, once its own vectors have decoded the
 * page — the first-order spherical harmonic its direction carries, in this engine's axes. **Added
 * to what the dynamic lights give**, and to the ambient: a consumer whose bake already holds the
 * sky's light zeroes the ambient for those draws itself, with `setAmbientSH` and nine zeros.
 *
 * **A shading model, because everything it would otherwise take is spent.** The page binds where a
 * model's map does and the region is the model's numbers (`lightmapModel`), so a lightmapped
 * material is a pipeline constant of its own and nothing else pays for it; the surface is otherwise
 * the standard model, unchanged. The second coordinates ride the grain and relief attributes
 * (`MeshData.lightmapUvs`, stored below zero by `withLightmapUvs`), and an instance's region rides
 * its tint and opacity (`MeshInstances.lightmapRegions`). **What it gives up**: a lightmapped
 * surface has no procedural grain or relief, no other shading model, and an instanced batch with
 * regions no tint. **What it does not do**: the GPU-driven pipeline and splats read no page.
 */
import type { MeshData } from '@driftengine/drft';
import { toHalfFloats } from './halfFloat.ts';

/** One page as a consumer decoded it. */
export interface LightmapPage {
  readonly width: number;
  readonly height: number;
  /**
   * Linear irradiance, three floats a texel, row-major from the top, in the same units every other
   * light here is in — a bake from another engine scaled by that engine's exposure, as its lights are.
   */
  readonly irradiance: Float32Array;
  /**
   * The direction the light arrives from, four bytes a texel: a first-order spherical harmonic in
   * this engine's world axes, each value stored as `v * 0.5 + 0.5` — xyz the axis, w the constant.
   */
  readonly direction: Uint8Array;
}

/** Layers a page is uploaded as: the irradiance, then the direction. */
export const LIGHTMAP_LAYERS = 2;

/**
 * Where a surface's region of its page is: `lightmapUv = uv2 * scale + bias`, as
 * `[scaleU, scaleV, biasU, biasV]`. The whole page is the identity.
 */
export type LightmapRegion = readonly [number, number, number, number];

/** The whole page. */
export const WHOLE_PAGE: LightmapRegion = [1, 1, 0, 0];

/** A page as both backends upload it: `layers` images of half-float RGBA, row-major from the top. */
export interface LightmapTexels {
  readonly kind: 'lightmap-texels';
  readonly width: number;
  readonly height: number;
  readonly layers: number;
  readonly texels: Uint16Array;
}

/** Whether a surface texture's source is a page's texels rather than an image or blocks. */
export function isLightmapTexels(source: unknown): source is LightmapTexels {
  return (
    typeof source === 'object' &&
    source !== null &&
    (source as { kind?: unknown }).kind === 'lightmap-texels'
  );
}

/**
 * A page as both backends upload it: two layers of half-float RGBA, the irradiance with an alpha of
 * one and the direction as the fractions its bytes are. Refuses a page whose arrays are not its
 * size, naming the one that is short.
 */
export function lightmapTexels(page: LightmapPage): LightmapTexels {
  const { width, height } = page;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error(`createLightmap: a ${width} by ${height} page has nothing in it`);
  }
  const texels = width * height;
  if (page.irradiance.length !== texels * 3) {
    throw new Error(
      `createLightmap: ${page.irradiance.length} irradiance floats for a ${width} by ${height} ` +
        `page, which wants ${texels * 3}: three a texel`,
    );
  }
  if (page.direction.length !== texels * 4) {
    throw new Error(
      `createLightmap: ${page.direction.length} direction bytes for a ${width} by ${height} ` +
        `page, which wants ${texels * 4}: four a texel`,
    );
  }
  const floats = new Float32Array(texels * 4 * LIGHTMAP_LAYERS);
  for (let t = 0; t < texels; t++) {
    floats[t * 4] = page.irradiance[t * 3] as number;
    floats[t * 4 + 1] = page.irradiance[t * 3 + 1] as number;
    floats[t * 4 + 2] = page.irradiance[t * 3 + 2] as number;
    floats[t * 4 + 3] = 1;
    const at = (texels + t) * 4;
    for (let c = 0; c < 4; c++) floats[at + c] = (page.direction[t * 4 + c] as number) / 255;
  }
  return {
    kind: 'lightmap-texels',
    width,
    height,
    layers: LIGHTMAP_LAYERS,
    texels: toHalfFloats(floats),
  };
}

/**
 * A mesh with its second coordinates moved onto the grain and relief streams they ride, or the
 * mesh itself where it has none. Called by both backends' `createMesh`, before anything records
 * which streams the mesh has.
 *
 * **Stored as `-1 - uv`, below zero, and that is what keeps the lanes safe to share.** Grain takes
 * effect only above zero and relief is read through `max(relief, 0)`, so the same mesh drawn by a
 * material that is not lightmapped is a mesh with no grain and no relief — rather than one mottled
 * and bumped by its own coordinates, which is what storing them as they are drew. **What it gives
 * up** is coordinates at or below −1, which read as nothing; a page's coordinates are from 0 to 1.
 */
export function withLightmapUvs(data: MeshData): MeshData {
  const uvs = data.lightmapUvs;
  if (uvs === undefined) return data;
  const vertices = uvs.length / 2;
  const grain = new Float32Array(vertices);
  const relief = new Float32Array(vertices);
  for (let v = 0; v < vertices; v++) {
    grain[v] = -1 - (uvs[v * 2] as number);
    relief[v] = -1 - (uvs[v * 2 + 1] as number);
  }
  return { ...data, grain, relief, lightmapUvs: undefined };
}

/** A material's region, checked: four finite numbers, the whole page where none was named. */
export function lightmapRegionOf(region: LightmapRegion | undefined): LightmapRegion {
  if (region === undefined) return WHOLE_PAGE;
  let finite = region.length === 4;
  for (let i = 0; i < region.length; i++) finite &&= Number.isFinite(region[i]);
  if (!finite) {
    throw new Error(
      'lightmapModel: a region is four numbers, [scaleU, scaleV, biasU, biasV], ' +
        `and was given ${String(region)}`,
    );
  }
  return region;
}

let warnedUnpaged = false;

/**
 * Says once that a lightmapped material was set with no page. The lit stage adds nothing for one,
 * which is the defined state; this is what keeps it from also being a silent one.
 */
export function warnUnpagedLightmap(
  model: { readonly kind: string } | null | undefined,
  map: unknown,
): void {
  if (warnedUnpaged || model?.kind !== 'lightmap' || (map !== null && map !== undefined)) return;
  warnedUnpaged = true;
  console.warn(
    'setMaterial: a lightmapModel material with no modelMap reads no page and adds no light. ' +
      'Pass the page createLightmap returned as its modelMap.',
  );
}

let warnedRegions = false;

/**
 * Says once that an instanced batch and its material disagree about lightmap regions: a batch with
 * regions drawn by a material that is not lightmapped, or a lightmapped one drawn without them. The
 * regions ride the lane a tint and an opacity do (`MeshInstances.lightmapRegions`), so either draw
 * reads one as the other: drawn, and wrong, which is why it is said rather than left.
 */
export function warnRegionsWithoutPage(
  model: { readonly kind: string } | null | undefined,
  regions: Float32Array | undefined,
): void {
  if (warnedRegions) return;
  const lightmapped = model?.kind === 'lightmap';
  if (lightmapped === (regions !== undefined)) return;
  warnedRegions = true;
  console.warn(
    lightmapped
      ? 'drawInstanced: a lightmapModel material drawing a batch with no lightmapRegions reads ' +
          'its tints as regions. Give each instance its region of the page.'
      : 'drawInstanced: a batch with lightmapRegions drawn by a material that is not a ' +
          'lightmapModel reads its regions as its tints and opacities. Draw it with its page, or ' +
          'without regions.',
  );
}
