/**
 * What MobileSAM computes on the host rather than the device: a prompt's tokens, the positions of
 * the embedding's grid, the size an image is prepared at, and a mask's stability.
 *
 * **A position is random Fourier features**: a point in the unit square, taken to [−1, 1], times a
 * fixed Gaussian matrix of the checkpoint's, times 2π, and the sine then the cosine of each of those
 * angles. The angles reach tens of radians, which the device's `sin` is only specified to 2^−11
 * over [−π, π] for, so they are taken here, to single precision, with the engine's reproducible
 * functions and in the upstream's order of roundings. That is also why a prompt is tokens given to
 * the decoder rather than coordinates: a few tokens a prompt, against a grid of positions laid out
 * once per size.
 *
 * **A prompt is the upstream's**: each point shifted to its pixel's centre and labelled on the
 * object or off it, a padding point appended when there is no box, and a box as its two corners.
 * Points and boxes are given in the original image's pixels and scaled to the prepared image as the
 * upstream's predictor scales them.
 */
import { exactCos, exactSin } from '@driftengine/core';
import type { WeightSource } from '@driftengine/texture';

export interface SamPrompt {
  /** Points in the original image's pixels, each labelled 1 on the object and 0 off it. */
  readonly points?: readonly (readonly [x: number, y: number, label: 0 | 1])[];
  /** A box in the original image's pixels: left, top, right, bottom. */
  readonly box?: readonly [number, number, number, number];
}

const f = Math.fround;
const TWO_PI = f(2 * Math.PI);

/**
 * Where a checkpoint keeps its prompt encoder, and how its processor places a prompt: SAM's and
 * MobileSAM's, or Transformers' SAM 2.
 */
export interface SamPromptLayout {
  /** The Fourier matrix, `[2, dim / 2]`. */
  readonly gaussian: string;
  /** A learned point embedding by kind — 0 off, 1 on, 2 and 3 a box's corners — as name and row. */
  readonly embedding: (kind: number) => readonly [name: string, row: number];
  readonly notAPoint: string;
  /** Whether a box is followed by a padding point, as SAM 2's is. */
  readonly boxPadding: boolean;
  /**
   * Whether a box's corners come first as points and a padding point always ends the prompt, as a
   * SAM 2 video session orders them — where a prompt of nothing is a point meaning none, padded.
   */
  readonly boxAsPoints: boolean;
  /**
   * The prepared image's size for an original one: the longest side to `size` for SAM, the whole
   * frame to a `size` square for SAM 2 — and whether a coordinate is scaled in double precision, as
   * SAM's predictor does with numpy, or single, as SAM 2's processor does with a tensor.
   */
  readonly prepared: (height: number, width: number, size: number) => readonly [number, number];
  readonly singleScale: boolean;
}

export const SAM_PROMPT: SamPromptLayout = {
  gaussian: 'prompt_encoder.pe_layer.positional_encoding_gaussian_matrix',
  embedding: (kind) => [`prompt_encoder.point_embeddings.${kind}.weight`, 0],
  notAPoint: 'prompt_encoder.not_a_point_embed.weight',
  boxPadding: false,
  boxAsPoints: false,
  prepared: (height, width, size) => samInputSize(height, width, size),
  singleScale: false,
};

export const SAM2_PROMPT: SamPromptLayout = {
  gaussian: 'prompt_encoder.shared_embedding.positional_embedding',
  embedding: (kind) => ['prompt_encoder.point_embed.weight', kind],
  notAPoint: 'prompt_encoder.not_a_point_embed.weight',
  boxPadding: true,
  boxAsPoints: false,
  prepared: (_height, _width, size) => [size, size],
  singleScale: true,
};

/** SAM 2 in a video session: the same encoder, a box as its two corner points first. */
export const SAM2_VIDEO_PROMPT: SamPromptLayout = {
  ...SAM2_PROMPT,
  boxPadding: false,
  boxAsPoints: true,
};

/** The upstream's `get_preprocess_shape`: the longest side to `longest`, each side rounded. */
export function samInputSize(
  height: number,
  width: number,
  longest: number,
): readonly [number, number] {
  const scale = (longest * 1.0) / Math.max(height, width);
  return [Math.floor(height * scale + 0.5), Math.floor(width * scale + 0.5)];
}

/** How many tokens a prompt is, in a layout. */
export function samTokenCount(request: SamPrompt, layout: SamPromptLayout = SAM_PROMPT): number {
  const points = request.points?.length ?? 0;
  if (layout.boxAsPoints) {
    const given = points + (request.box === undefined ? 0 : 2);
    return (given === 0 ? 1 : given) + 1;
  }
  const box = request.box === undefined ? 0 : layout.boxPadding ? 3 : 2;
  return points > 0 ? points + (box === 0 ? 1 : box) : box;
}

/* Sines then cosines of a point in the unit square's angles, `2 · half` values from `at`. */
function fourier(
  gaussian: Float32Array,
  half: number,
  x: number,
  y: number,
  out: Float32Array,
  at: number,
): void {
  const u = f(2 * x - 1);
  const v = f(2 * y - 1);
  for (let k = 0; k < half; k += 1) {
    const angle = f(TWO_PI * f(u * (gaussian[k] as number) + v * (gaussian[half + k] as number)));
    out[at + k] = exactSin(angle);
    out[at + half + k] = exactCos(angle);
  }
}

function weight(weights: WeightSource, name: string, length: number, row = 0): Float32Array {
  const tensor = weights.get(name);
  if (tensor === undefined || tensor.data.length < (row + 1) * length) {
    throw new Error(`the prompt encoder has no "${name}" of ${length} values in row ${row}`);
  }
  return tensor.data.subarray(row * length, (row + 1) * length);
}

/**
 * `[grid · grid, dim]`: the position of each cell of the embedding's grid, at its centre, as the
 * upstream's `get_dense_pe` lays it out and the decoder reads it as tokens.
 */
export function samGridPositions(gaussian: Float32Array, dim: number, grid: number): Float32Array {
  const out = new Float32Array(grid * grid * dim);
  for (let y = 0; y < grid; y += 1) {
    for (let x = 0; x < grid; x += 1) {
      fourier(
        gaussian,
        dim / 2,
        f((x + 0.5) / grid),
        f((y + 0.5) / grid),
        out,
        (y * grid + x) * dim,
      );
    }
  }
  return out;
}

/**
 * The tokens of `request`, `[samTokenCount(request, layout), dim]`, into `out`, for an original
 * image of `height` by `width` prepared at `size` as `layout`'s processor prepares it.
 */
export function samPromptTokens(
  weights: WeightSource,
  dim: number,
  size: number,
  request: SamPrompt,
  height: number,
  width: number,
  out: Float32Array,
  layout: SamPromptLayout = SAM_PROMPT,
): void {
  const half = dim / 2;
  const gaussian = weight(weights, layout.gaussian, 2 * half);
  const [inputHeight, inputWidth] = layout.prepared(height, width, size);
  const scaleX = layout.singleScale ? f(inputWidth / width) : inputWidth / width;
  const scaleY = layout.singleScale ? f(inputHeight / height) : inputHeight / height;
  const place = (value: number, scale: number): number =>
    f(f(f(layout.singleScale ? f(value) * scale : value * scale) + 0.5) / size);
  let at = 0;
  /* A token: the position of a point at its pixel's centre, or none, and a learned embedding. */
  const token = (x: number, y: number, positioned: boolean, name: string, row: number): void => {
    if (positioned) {
      fourier(gaussian, half, place(x, scaleX), place(y, scaleY), out, at);
    } else {
      out.fill(0, at, at + dim);
    }
    const learned = weight(weights, name, dim, row);
    for (let c = 0; c < dim; c += 1) {
      out[at + c] = f((out[at + c] as number) + (learned[c] as number));
    }
    at += dim;
  };
  if (layout.boxAsPoints) {
    if (request.box !== undefined) {
      const [left, top, right, bottom] = request.box;
      token(left, top, true, ...layout.embedding(2));
      token(right, bottom, true, ...layout.embedding(3));
    }
    for (const [x, y, label] of request.points ?? []) token(x, y, true, ...layout.embedding(label));
    if (request.box === undefined && (request.points?.length ?? 0) === 0) {
      token(0, 0, false, layout.notAPoint, 0);
    }
    token(0, 0, false, layout.notAPoint, 0);
    return;
  }
  for (const [x, y, label] of request.points ?? []) token(x, y, true, ...layout.embedding(label));
  if ((request.points?.length ?? 0) > 0 && request.box === undefined) {
    token(0, 0, false, layout.notAPoint, 0);
  }
  if (request.box !== undefined) {
    const [left, top, right, bottom] = request.box;
    token(left, top, true, ...layout.embedding(2));
    token(right, bottom, true, ...layout.embedding(3));
    if (layout.boxPadding) token(0, 0, false, layout.notAPoint, 0);
  }
}

/**
 * The upstream's stability score: the share of the pixels above `threshold − offset` that are also
 * above `threshold + offset` — one over the other of the mask thresholded high and thresholded low,
 * since one always lies inside the other. A mask with no pixel above the lower threshold scores
 * NaN, as the upstream's does.
 */
export function stabilityScore(logits: Float32Array, threshold: number, offset: number): number {
  let inside = 0;
  let union = 0;
  for (let i = 0; i < logits.length; i += 1) {
    const value = logits[i] as number;
    if (value > threshold + offset) inside += 1;
    if (value > threshold - offset) union += 1;
  }
  return inside / union;
}
