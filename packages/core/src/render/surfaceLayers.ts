/**
 * A material blended from layers by a mask: `SurfaceMaterial.layers`, the four vectors
 * `shaders/flat/layered.ts` reads it from, and the decisions both backends take about it.
 */
import type { SurfaceLayerLook, SurfaceMeshOcclusion } from './surfaceLayerLooks.ts';
import type { SurfaceProjection } from './surfaceProjection.ts';

/** The most layers a material blends: a base and one for each of the mask's four channels. */
export const MAX_SURFACE_LAYERS = 5;

/**
 * Up to five layers, each its own colour, normal and roughness at its own repeat, blended by a mask.
 *
 * **Layer `i` is layer `i` of the material's arrays**, unless `arrayLayers` picks another: `albedo`,
 * `normal` and `orm` each an array whose layers are the material's layers, read at the mesh's
 * coordinates times
 * `repeats[i]`, so rock can repeat forty times across a cliff while the moss on it repeats three.
 * Where the material has a `projection`, the layers are read at the world's horizontal position
 * instead, so a repeat is so many a metre (with the projection's own scale at 1). **The mask** is
 * read at the mesh's own coordinates and lays each layer over those before it: red lays layer 1
 * over the base, green layer 2 over that, blue layer 3, alpha layer 4. `emissiveLayer` gives the
 * material's emissive map to one layer, glowing where that layer shows and nowhere it is covered;
 * absent, the map glows as on any material.
 *
 * **Maps beyond the layers ride the material's own arrays, after its layers**, so they take no
 * texture binding of their own — the lit stage has none to spare: a mask the ORM array carries
 * (`mask: 'orm'`) is the ORM array's layer just past the layers, an `addMask` the one after that,
 * a `meshOcclusion` the one after any of those, and `meshNormal` the normal array's layer just past
 * the layers. `extrasAt` moves where "just past" is, for materials that share arrays. Each shares
 * its array's size and format, so a four-channel mask wants an array that stores four.
 *
 * **Shared arrays and a look of each layer's own** — `arrayLayers`, `extrasAt`, `looks` and
 * `meshOcclusion` — are a lit switch of their own, `LAYER_LOOKS`, and `surfaceLayerLooks.ts` says
 * what they cost.
 *
 * **What it gives up**: every layer's maps are read wherever any shows, three reads a layer, so five
 * layers are fifteen reads where one material is three; layers share an array's size and format; a
 * cutout reads the base layer's alpha; a mask read where a model's map goes leaves no room for one,
 * so a lightmapped surface carries its mask in its ORM array or its vertices; a triplanar projection
 * lays layers on the horizontal plane alone; and a mask is sampled linear, so it is uploaded as data
 * (`colorSpace: 'linear'`).
 */
export interface SurfaceLayers<Texture> {
  /**
   * Where the weights come from, red to alpha laying layers 1 to 4: a map read where a shading
   * model's map goes; `'orm'`, the ORM array's layer just past the layers; or `'vertex'`, the
   * vertex colour's red, green and blue, which then weights the layers instead of tinting them.
   */
  readonly mask: Texture | 'orm' | 'vertex';
  /**
   * Each layer's repeats across the mesh's coordinates, base first: one to five of them. A pair is a
   * repeat across and a repeat down apart, moss stretched along a trunk; a pair is drawn through the
   * `LAYER_LOOKS` switch, which a single number does not need.
   */
  readonly repeats: readonly (number | readonly [number, number])[];
  /** The layer the emissive map glows on, 0 to 4. Absent: everywhere, as on any material. */
  readonly emissiveLayer?: number;
  /**
   * How the layers combine. `'over'`, the default, lays each over the ones before it by its
   * channel. `'sum'` mixes the base toward the sum of each layer times its channel, by the channels'
   * sum held to 1: two layers at half each are both half there, where laying over would let the
   * second cover half of the first.
   */
  readonly blend?: 'over' | 'sum';
  /**
   * A second mask added to one layer's weight, read where the layers are (the world, under a
   * `projection`) times `repeat`, its red times `intensity`: sand drifting into the gravel's layer at
   * a scale of its own. The ORM array's layer after the layers and any mask it carries.
   */
  readonly addMask?: {
    readonly layer: number;
    readonly repeat: number;
    readonly intensity: number;
  };
  /**
   * One layer weighted by how much the surface faces up rather than by its mask channel:
   * `saturate(bias + sharpness × (up / 2 + 1/2))`, `up` the world normal's upward share before any
   * normal map. Snow on the tops of rocks, moss on a ledge.
   */
  readonly facing?: {
    readonly layer: number;
    readonly bias: number;
    readonly sharpness: number;
  };
  /**
   * A normal map read at the mesh's own coordinates and tangents, the normal array's layer just past
   * the layers, under the layers' blended normal: the large shapes of a rock or a cliff, which a
   * layer repeating forty times across it cannot carry.
   */
  readonly meshNormal?: boolean;
  /**
   * Which layer of the material's albedo, normal and ORM arrays each layer reads, base first, so
   * many materials can share one array of each kind and hold every texture once. Absent, or past
   * its end, layer `i` reads layer `i`. The same index reads all three arrays, so a texture's three
   * maps sit at the same layer of each.
   */
  readonly arrayLayers?: readonly number[];
  /**
   * The layer of each array where the maps beyond the layers start: the ORM array's mask, added
   * mask and mesh occlusion, in that order, and the normal array's mesh normal. Absent: just past
   * the layers, at the layer count — which is no place for them once materials share arrays.
   */
  readonly extrasAt?: number;
  /**
   * Each layer's own look, base first: a tint, the ranges its ORM's roughness and metalness are
   * spread over, and how far its normal map bends the surface. Absent or null for a layer: the map
   * as it is.
   */
  readonly looks?: readonly (SurfaceLayerLook | null | undefined)[];
  /**
   * An occlusion read at the mesh's own coordinates — the red of the ORM array's layer after the
   * layers and any mask or added mask the array carries — darkening the surface by a strength from 0
   * to 1: the large shading of a cliff that layers repeating across it cannot carry, as
   * `meshNormal` carries its shape. A number is that strength, darkening the blended colour; the
   * object form also chooses what it darkens, the colour and the ambient light at strengths of their
   * own, and the range its red is spread over. Absent or 0: none.
   */
  readonly meshOcclusion?: number | SurfaceMeshOcclusion;
}

/** Floats `packSurfaceLayers` writes: four vectors. */
export const LAYER_FLOATS = 16;

/** Where the mask is read, as the fourth float of the second vector carries it. */
const MASK_SOURCE = { map: 0, orm: 1, vertex: 2 } as const;

/**
 * `layers` into `out`, four vectors. The first five floats are the repeats (1 for a layer not
 * given), then how many layers there are, which one glows (−1 for none) and where the mask comes
 * from (0 a map, 1 the ORM array, 2 the vertex colour). Then the blend (0 over, 1 sum), whether a
 * mesh normal is laid under the layers, the added mask's layer (−1 for none) and repeat; its
 * intensity; and the facing layer (−1 for none), its bias and its sharpness. Zeros, no layers, where
 * there are none.
 *
 * A repeat that is not a positive number is 1, so a layer is never laid at a scale that collapses it
 * to a point; a glow, an added mask or a facing layer naming a layer there is not is none, and the
 * base, which no channel lays, is not one an added mask or the facing can name.
 */
export function packSurfaceLayers<Texture>(
  layers: SurfaceLayers<Texture> | null | undefined,
  out: Float32Array,
): void {
  out.fill(0);
  if (layers === null || layers === undefined || layers.repeats.length === 0) return;
  const count = Math.min(layers.repeats.length, MAX_SURFACE_LAYERS);
  for (let i = 0; i < MAX_SURFACE_LAYERS; i++)
    out[i] = positive(i < count ? across(layers.repeats[i]) : 1);
  out[5] = count;
  const glow = layers.emissiveLayer;
  out[6] = glow !== undefined && Number.isInteger(glow) && glow >= 0 && glow < count ? glow : -1;
  out[7] =
    layers.mask === 'orm'
      ? MASK_SOURCE.orm
      : layers.mask === 'vertex'
        ? MASK_SOURCE.vertex
        : MASK_SOURCE.map;
  out[8] = layers.blend === 'sum' ? 1 : 0;
  out[9] = layers.meshNormal === true ? 1 : 0;
  const added = layers.addMask;
  const addLayer = laidLayer(added?.layer, count);
  out[10] = addLayer;
  out[11] = addLayer < 0 ? 0 : positive(added?.repeat);
  out[12] = addLayer < 0 ? 0 : finite(added?.intensity);
  const facing = layers.facing;
  const faceLayer = laidLayer(facing?.layer, count);
  out[13] = faceLayer;
  out[14] = faceLayer < 0 ? 0 : finite(facing?.bias);
  out[15] = faceLayer < 0 ? 0 : finite(facing?.sharpness);
}

/** The texture a layered material's mask is, where it is one rather than another array or the vertices. */
export function layerMaskMap<Texture>(
  layers: SurfaceLayers<Texture> | null | undefined,
): Texture | null {
  const mask = layers?.mask;
  return mask === undefined || mask === 'orm' || mask === 'vertex' ? null : mask;
}

/**
 * Whether a material's layers can be drawn beside its `modelMap`: always, unless the mask is a map,
 * which is read where a model's map goes and so cannot share the slot with one — a lightmap's page
 * among them. The backends draw such a material as one layer and say so once.
 */
export function layersFitBeside<Texture>(
  layers: SurfaceLayers<Texture>,
  modelMap: Texture | null | undefined,
): boolean {
  return modelMap === null || modelMap === undefined || layerMaskMap(layers) === null;
}

/**
 * The projection a layered material is drawn with: a triplanar one is laid on the horizontal plane,
 * at its own scale, since every layer's maps read three times over would be forty-five reads a pixel.
 * Anything else as it was. Whether to say so is the caller's.
 */
export function layeredProjection<Texture>(
  projection: SurfaceProjection | null | undefined,
  layers: SurfaceLayers<Texture> | null | undefined,
): SurfaceProjection | null {
  if (projection === null || projection === undefined) return null;
  if (layers === null || layers === undefined || projection.kind !== 'triplanar') return projection;
  return { kind: 'planar', scale: projection.scale };
}

/** A layer's repeat across: the number, or the first of a pair. The second is `LAYER_LOOKS`'. */
export function across(repeat: number | readonly [number, number] | undefined): number | undefined {
  return typeof repeat === 'number' || repeat === undefined ? repeat : repeat[0];
}

/** A layer an added mask or the facing may name: one a channel lays, 1 to `count − 1`, or −1. */
function laidLayer(layer: number | undefined, count: number): number {
  return layer !== undefined && Number.isInteger(layer) && layer >= 1 && layer < count ? layer : -1;
}

function positive(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 1;
}

function finite(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? value : 0;
}
