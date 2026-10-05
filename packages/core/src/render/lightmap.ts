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
import { packRgb9e5 } from './rgb9e5.ts';

/** One page as a consumer decoded it. */
export interface LightmapPage {
  readonly width: number;
  readonly height: number;
  /**
   * Linear irradiance, row-major from the top, in the same units every other light here is in — a
   * bake from another engine scaled by that engine's exposure, as its lights are. Either three
   * floats a texel, or one word a texel already packed as rgb9e5 (`rgb9e5.ts`), which is how such a
   * bake usually arrives and which uploads with no conversion at all.
   */
  readonly irradiance: Float32Array | Uint32Array;
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

/**
 * A page as both backends upload it: two layers of four bytes a texel, row-major from the top. The
 * first is the irradiance's rgb9e5 word, byte by byte from its lowest; the second is the direction.
 *
 * **Eight bytes a texel, and the shader filters it.** Half floats were sixteen: a stage of 49 pages
 * and 21.8 million texels held 348 MB, where this holds 174. The price is that the irradiance cannot
 * be filtered as it is stored — a bilinear blend of two words with different exponents is not the
 * blend of the colours they hold — so the lit stage fetches a texel's four neighbours, decodes each
 * and blends the colours (`modelBaked` in `shaders/flat/models.ts`): four fetches a layer where one
 * filtered sample was, on lightmapped surfaces alone. **What would make it wrong** is every device
 * a page reaches sampling `rgb9e5ufloat`, which WebGL2 does as `RGB9_E5` too; it would then be a
 * texture of its own, filtered by the device, and a binding the lit stage has no room for.
 */
export interface LightmapTexels {
  readonly kind: 'lightmap-texels';
  readonly width: number;
  readonly height: number;
  /** Each layer's bytes, in layer order: the irradiance, then the direction. */
  readonly layers: readonly Uint8Array[];
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
 * A page as both backends upload it (see `LightmapTexels`). Refuses a page whose arrays are not its
 * size, naming the one that is short. Packed irradiance is read where it lies, with no copy; float
 * irradiance is packed once, here.
 */
export function lightmapTexels(page: LightmapPage): LightmapTexels {
  const { width, height } = page;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error(`createLightmap: a ${width} by ${height} page has nothing in it`);
  }
  const texels = width * height;
  const irradiance = page.irradiance;
  const packed = irradiance instanceof Uint32Array;
  const wanted = packed ? texels : texels * 3;
  if (irradiance.length !== wanted) {
    throw new Error(
      `createLightmap: ${irradiance.length} irradiance ${packed ? 'words' : 'floats'} for a ` +
        `${width} by ${height} page, which wants ${wanted}: ` +
        (packed ? 'one rgb9e5 word a texel' : 'three a texel'),
    );
  }
  if (page.direction.length !== texels * 4) {
    throw new Error(
      `createLightmap: ${page.direction.length} direction bytes for a ${width} by ${height} ` +
        `page, which wants ${texels * 4}: four a texel`,
    );
  }
  let words: Uint32Array;
  if (packed) {
    words = irradiance;
  } else {
    words = new Uint32Array(texels);
    for (let t = 0; t < texels; t++) {
      words[t] = packRgb9e5(
        irradiance[t * 3] as number,
        irradiance[t * 3 + 1] as number,
        irradiance[t * 3 + 2] as number,
      );
    }
  }
  return {
    kind: 'lightmap-texels',
    width,
    height,
    layers: [littleEndianBytes(words), page.direction],
  };
}

/** Whether this platform lays a word out lowest byte first, which the shader's decode assumes. */
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/**
 * A page's words as bytes, lowest first: a view of the same memory on every little-endian platform,
 * which is every one a browser runs on, and a reordered copy anywhere else.
 */
function littleEndianBytes(words: Uint32Array): Uint8Array {
  const bytes = new Uint8Array(words.buffer, words.byteOffset, words.length * 4);
  if (LITTLE_ENDIAN) return bytes;
  const swapped = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 4) {
    swapped[i] = bytes[i + 3] as number;
    swapped[i + 1] = bytes[i + 2] as number;
    swapped[i + 2] = bytes[i + 1] as number;
    swapped[i + 3] = bytes[i] as number;
  }
  return swapped;
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
