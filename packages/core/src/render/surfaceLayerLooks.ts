/**
 * Which layer of a layered material's arrays each of its layers reads, and how each looks: the
 * fifteen vectors `shaders/flat/layerLooks.ts` reads, packed from `SurfaceMaterial.layers`.
 *
 * **Why a material needs these at all.** Layers read from the material's own arrays in order, so
 * a texture worn by fifty materials in fifty tints had to be baked fifty times, each with its tint,
 * its roughness range and its normal strength in the pixels. Picked by index from arrays the
 * materials share, and given their look as numbers, each texture is held once: a set of layered
 * materials built from a few textures costs those textures rather than one copy per material.
 *
 * **What it gives up**: fifteen fragment uniform vectors, so it is a lit switch of its own,
 * `LAYER_LOOKS`, which a device short of vectors refuses while still drawing the layers; a layer's
 * look is a handful of numbers, not a graph; and every layer is still read wherever any shows, as
 * `surfaceLayers.ts` says, now from arrays that may be large.
 */
import type { Vec3 } from '../math/color.ts';
import type { SurfaceLayers } from './surfaceLayers.ts';
import { MAX_SURFACE_LAYERS, across } from './surfaceLayers.ts';

/**
 * One layer's own look, applied to what it reads before the layers are blended. Every field is the
 * identity where it is absent, so a material names only what differs.
 */
export interface SurfaceLayerLook {
  /** Multiplies the layer's colour, linear. Above 1 brightens it. Absent: `[1, 1, 1]`. */
  readonly tint?: Vec3;
  /** The roughness the ORM's green channel is spread over, from its 0 to its 1. Absent: `[0, 1]`. */
  readonly roughness?: readonly [number, number];
  /** The metalness the ORM's blue channel is spread over, the same way. Absent: `[0, 1]`. */
  readonly metalness?: readonly [number, number];
  /**
   * How far the layer's normal map bends the surface: its tangent-space x and y times this, before
   * the layers' normals are blended. 0 is flat, 1 the map as it is. Absent: 1.
   */
  readonly normalStrength?: number;
  /**
   * The layer's specular, in the units a mesh's vertices carry theirs: how strong a highlight is,
   * and under `physicalSpecular` the reflectance head-on, `0.08 × specular`. Blended across the
   * layers as their colours are. Absent: the surface's own, as its vertices give it.
   */
  readonly specular?: number;
}

/** What an occlusion read at the mesh's own coordinates darkens, and how far. */
export interface SurfaceMeshOcclusion {
  /** 0 to 1: what `into` names times `mix(1, occlusion, strength)`. Absent: 1. */
  readonly strength?: number;
  /**
   * `'color'`, the default, darkens the blended colour, and so every light on it, the sun's too.
   * `'ambient'` darkens the ambient light alone, sky, ground and probe, as an ambient occlusion
   * does, leaving the sun, the lamps and the reflections as they were.
   */
  readonly into?: 'color' | 'ambient';
  /**
   * The colour's own strength, from 0 up and past 1: the blended colour times
   * `max(0, 1 − colorStrength × (1 − occlusion))`, which up to 1 is the `mix` above and past it
   * darkens faster than the occlusion does. Absent: `strength` where `into` is the colour, and 0
   * where it is the ambient light — so named beside `into: 'ambient'` it darkens both, each at its
   * own strength, as a material taking its ambient occlusion and a darker colour from one map does.
   *
   * **What it gives up**: past 1 the colour is black wherever `1 − occlusion` reaches
   * `1 / colorStrength`, and black under every light, the sun's too, which is what such a material
   * asks for and what an ambient occlusion alone would never do.
   */
  readonly colorStrength?: number;
  /** The range the occlusion's red is spread over, from its 0 to its 1. Absent: `[0, 1]`. */
  readonly range?: readonly [number, number];
}

/** Floats `packLayerLooks` writes: fifteen vectors. */
export const LOOK_FLOATS = 60;

/** The specular a layer is packed with when it names none: the surface's own, as its vertices give it. */
const OWN_SPECULAR = -1;

/**
 * Whether a material asks for anything the `LAYER_LOOKS` switch carries: layers picked by index,
 * extra maps placed somewhere other than just past the layers, a look, a repeat that is a pair, or
 * a mesh occlusion.
 */
export function asksLayerLooks<Texture>(
  layers: SurfaceLayers<Texture> | null | undefined,
): boolean {
  if (layers === null || layers === undefined) return false;
  return (
    layers.arrayLayers !== undefined ||
    layers.extrasAt !== undefined ||
    layers.looks !== undefined ||
    layers.repeats.some((repeat) => typeof repeat !== 'number') ||
    colorOcclusion(layers.meshOcclusion) > 0 ||
    ambientOcclusion(layers.meshOcclusion) > 0
  );
}

/**
 * `layers` into `out`, fifteen vectors, the identity wherever a material says nothing — which is
 * also what a layered material that asks for none of this is drawn with once another has switched
 * `LAYER_LOOKS` on, so it must draw exactly as it did before.
 *
 * - **0 to 7**: the array layer each layer reads, base first (layer `i` where not given); where the
 *   maps beyond the layers start (the layer count where not given); the mesh occlusion's strength
 *   on the colour, from 0 up, and on the ambient light, 0 to 1.
 * - **8 to 47**: two vectors a layer, base first: its tint and its normal strength, then its
 *   roughness range and its metalness range.
 * - **48 to 59**: each layer's specular (−1 for the surface's own), each layer's repeat down (its
 *   repeat across where it gave one number), and the range the occlusion is spread over.
 *
 * An array layer that is not a whole number at or above 0 reads layer `i`; a start that is not one
 * is the count; a strength is held to 0..1, but for the colour's own, which is held at or above 0; a tint channel, a normal strength or a specular that is
 * not a number at or above 0 is the identity; a repeat down that is not a positive number is the
 * repeat across; a range end that is not a number is the identity's end.
 */
export function packLayerLooks<Texture>(
  layers: SurfaceLayers<Texture> | null | undefined,
  out: Float32Array,
): void {
  const count = Math.min(layers?.repeats.length ?? 0, MAX_SURFACE_LAYERS);
  const picks = layers?.arrayLayers;
  for (let i = 0; i < MAX_SURFACE_LAYERS; i++) out[i] = arrayLayer(picks?.[i], i);
  out[5] = arrayLayer(layers?.extrasAt, count);
  const occlusion = layers?.meshOcclusion;
  out[6] = colorOcclusion(occlusion);
  out[7] = ambientOcclusion(occlusion);
  for (let i = 0; i < MAX_SURFACE_LAYERS; i++) {
    const look = layers?.looks?.[i] ?? null;
    const at = 8 + i * 8;
    out[at] = atLeastZero(look?.tint?.[0], 1);
    out[at + 1] = atLeastZero(look?.tint?.[1], 1);
    out[at + 2] = atLeastZero(look?.tint?.[2], 1);
    out[at + 3] = atLeastZero(look?.normalStrength, 1);
    out[at + 4] = finiteOr(look?.roughness?.[0], 0);
    out[at + 5] = finiteOr(look?.roughness?.[1], 1);
    out[at + 6] = finiteOr(look?.metalness?.[0], 0);
    out[at + 7] = finiteOr(look?.metalness?.[1], 1);
    out[48 + i] = atLeastZero(look?.specular, OWN_SPECULAR);
    const repeat = layers?.repeats[i];
    const acrossIt = positiveOr(across(repeat), 1);
    out[53 + i] = typeof repeat === 'object' ? positiveOr(repeat[1], acrossIt) : acrossIt;
  }
  const range = typeof occlusion === 'object' ? occlusion.range : undefined;
  out[58] = finiteOr(range?.[0], 0);
  out[59] = finiteOr(range?.[1], 1);
}

/** The strength `meshOcclusion` names, held to 0..1: a number's own, an object's or 1, and 0 for none. */
function occlusionStrength(occlusion: number | SurfaceMeshOcclusion | undefined): number {
  const strength =
    typeof occlusion === 'number'
      ? occlusion
      : occlusion === undefined
        ? 0
        : (occlusion.strength ?? 1);
  return Number.isFinite(strength) ? Math.min(Math.max(strength, 0), 1) : 0;
}

/** How hard the occlusion darkens the colour: its own strength where named, else `into`'s. */
function colorOcclusion(occlusion: number | SurfaceMeshOcclusion | undefined): number {
  if (typeof occlusion === 'object' && occlusion.colorStrength !== undefined)
    return atLeastZero(occlusion.colorStrength, 0);
  return typeof occlusion === 'object' && occlusion.into === 'ambient'
    ? 0
    : occlusionStrength(occlusion);
}

/** How hard the occlusion darkens the ambient light: its strength where that is its target. */
function ambientOcclusion(occlusion: number | SurfaceMeshOcclusion | undefined): number {
  return typeof occlusion === 'object' && occlusion.into === 'ambient'
    ? occlusionStrength(occlusion)
    : 0;
}

function arrayLayer(value: number | undefined, otherwise: number): number {
  return value !== undefined && Number.isInteger(value) && value >= 0 ? value : otherwise;
}

function atLeastZero(value: number | undefined, otherwise: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : otherwise;
}

function positiveOr(value: number | undefined, otherwise: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : otherwise;
}

function finiteOr(value: number | undefined, otherwise: number): number {
  return value !== undefined && Number.isFinite(value) ? value : otherwise;
}
