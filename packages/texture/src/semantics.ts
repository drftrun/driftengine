/**
 * What a channel *is*, declared rather than conventional.
 *
 * **The family of defects this removes is the one nobody attributes correctly.** A normal map
 * upside down in one asset and not in another; an albedo that is linear here and sRGB there; a
 * gloss map read as roughness, which inverts every highlight in the scene. Each is a convention
 * held in somebody's head, and each survives review because the file looks fine on its own.
 *
 * Declared, the format knows. A consumer never sees a convention at all, because `normaliseSample`
 * has already applied it — a Y-down normal comes back Y-up, an sRGB value comes back linear, and
 * gloss comes back as the roughness the engine shades with.
 */
export type ChannelSemantic =
  | 'albedo-srgb'
  | 'albedo-linear'
  | 'normal-tangent-yup'
  | 'normal-tangent-ydown'
  | 'roughness-linear'
  | 'gloss-linear'
  | 'metallic-linear'
  | 'occlusion-linear'
  | 'height-linear'
  | 'emissive-srgb'
  | 'mask-linear';

/**
 * Every semantic, in the order a file stores them by.
 *
 * **A name crosses a package boundary as a number**, because `@driftengine/drft` is the container
 * and knows nothing about what a channel means — a `DTEX` chunk stores `(semanticIndex << 4) |
 * component` and would have to carry strings otherwise. The index is therefore part of the format:
 * **a semantic may be appended and none may be reordered or removed**, or every file written before
 * the change decodes its channels as something else. `semantics.test.ts` holds the order.
 */
export const CHANNEL_SEMANTICS: readonly ChannelSemantic[] = [
  'albedo-srgb',
  'albedo-linear',
  'normal-tangent-yup',
  'normal-tangent-ydown',
  'roughness-linear',
  'gloss-linear',
  'metallic-linear',
  'occlusion-linear',
  'height-linear',
  'emissive-srgb',
  'mask-linear',
];

/** Where a semantic sits in that order, or −1 for one this build does not know. */
export function semanticIndex(semantic: ChannelSemantic): number {
  return CHANNEL_SEMANTICS.indexOf(semantic);
}

/** The semantic an index names, or null where a file names one from a later version. */
export function semanticAt(index: number): ChannelSemantic | null {
  return CHANNEL_SEMANTICS[index] ?? null;
}

export interface ChannelSpec {
  readonly semantic: ChannelSemantic;
  /** Which component of the decoded vector this channel occupies. */
  readonly component: number;
}

/** Whether this channel carries colour, and therefore whether a transfer curve applies to it. */
export function isColour(semantic: ChannelSemantic): boolean {
  return semantic === 'albedo-srgb' || semantic === 'albedo-linear' || semantic === 'emissive-srgb';
}

/** Whether mipping this channel must preserve the normal distribution. See `mipNdf.ts`. */
export function needsVarianceMips(semantic: ChannelSemantic): boolean {
  return semantic === 'normal-tangent-yup' || semantic === 'normal-tangent-ydown';
}

/**
 * The exact sRGB transfer function, piecewise, not the 2.2 power approximation.
 *
 * The approximation is within about two percent almost everywhere and wrong by more than that in
 * the dark end, which in a texture pipeline is a colour shift nobody attributes to the right cause
 * for weeks. The midpoint is the value that tells them apart: 0.5 linearises to 0.2140 exactly and
 * to 0.2176 approximately.
 */
export function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(value: number): number {
  return value <= 0.0031308 ? value * 12.92 : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
}

/**
 * Write one raw channel value into its component of `out`, with its convention already applied.
 *
 * A consumer of this never asks which way a normal points or which curve an albedo carries.
 */
export function normaliseSample(out: Float32Array, spec: ChannelSpec, raw: number): void {
  const at = spec.component;
  switch (spec.semantic) {
    case 'albedo-srgb':
    case 'emissive-srgb':
      out[at] = srgbToLinear(raw);
      return;
    case 'normal-tangent-ydown':
      /* Flipped about the midpoint, because a tangent-space normal is stored biased into 0..1. */
      out[at] = 1 - raw;
      return;
    case 'gloss-linear':
      /* The engine shades with roughness. One of the two has to win, and it is not this one. */
      out[at] = 1 - raw;
      return;
    default:
      out[at] = raw;
  }
}
