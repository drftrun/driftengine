/**
 * A material blended from layers by a mask: `SurfaceMaterial.layers`, and the two vectors
 * `shaders/flat/layered.ts` reads it from.
 */

/** The most layers a material blends: a base and one for each of the mask's four channels. */
export const MAX_SURFACE_LAYERS = 5;

/**
 * Up to five layers, each its own colour, normal and roughness at its own repeat, blended by a mask.
 *
 * **Layer `i` is layer `i` of the material's arrays**: `albedo`, `normal` and `orm` each an array
 * whose layers are the material's layers in order, read at the mesh's coordinates times
 * `repeats[i]`, so rock can repeat forty times across a cliff while the moss on it repeats three.
 * **The mask** is read at the mesh's own coordinates and lays each layer over those before it: red
 * lays layer 1 over the base, green layer 2 over that, blue layer 3, alpha layer 4. Its layer 0 is
 * read, from where a shading model's map goes, which is why a layered material carries no
 * `modelMap`. `emissiveLayer` gives the material's emissive map to one layer, glowing where that
 * layer shows and nowhere it is covered; absent, the map glows as on any material.
 *
 * **What it gives up**: every layer's maps are read wherever any shows, three reads a layer, so five
 * layers are fifteen reads where one material is three; layers share an array's size and format; a
 * cutout reads the base layer's alpha; and the mask is sampled linear, so it is uploaded as data
 * (`colorSpace: 'linear'`).
 */
export interface SurfaceLayers<Texture> {
  /** The weights, red to alpha laying layers 1 to 4, read at the mesh's coordinates. */
  readonly mask: Texture;
  /** Each layer's repeats across the mesh's coordinates, base first: one to five of them. */
  readonly repeats: readonly number[];
  /** The layer the emissive map glows on, 0 to 4. Absent: everywhere, as on any material. */
  readonly emissiveLayer?: number;
}

/** Floats `packSurfaceLayers` writes: two vectors. */
export const LAYER_FLOATS = 8;

/**
 * `layers` into `out`: the five repeats (1 for a layer not given), then how many layers there are
 * and which one glows (−1 for none); zeros, no layers, where there are none. A repeat that is not a
 * positive number is 1, so a layer is never laid at a scale that collapses it to a point.
 */
export function packSurfaceLayers<Texture>(
  layers: SurfaceLayers<Texture> | null | undefined,
  out: Float32Array,
): void {
  out.fill(0);
  if (layers === null || layers === undefined || layers.repeats.length === 0) return;
  const count = Math.min(layers.repeats.length, MAX_SURFACE_LAYERS);
  for (let i = 0; i < MAX_SURFACE_LAYERS; i++) {
    const repeat = i < count ? (layers.repeats[i] as number) : 1;
    out[i] = Number.isFinite(repeat) && repeat > 0 ? repeat : 1;
  }
  out[5] = count;
  const glow = layers.emissiveLayer;
  out[6] = glow !== undefined && Number.isInteger(glow) && glow >= 0 && glow < count ? glow : -1;
}
