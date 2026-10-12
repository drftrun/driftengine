/**
 * Local exposure: each region of the frame brought part of the way toward the frame's own
 * brightness, so shade and sun can both be read in one picture.
 *
 * **A tone curve maps one range, and a sunlit courtyard is two.** Measured in a bought courtyard at
 * noon, the shaded arcades hold a fiftieth of the light the sunlit paving does, which is what the
 * place is: a canyon lit mostly by its own walls. Exposed for the paving the arcades go to black,
 * exposed for the arcades the paving goes to white, and no curve fixes both, because a curve is a
 * function of a pixel's brightness and the same brightness has to mean shade in one place and sun in
 * another. A photographer brackets; an eye adapts by region. This is the second.
 *
 * **A bilateral grid over the exposure meter's tiles.** The grid pass writes, for each of the
 * meter's 32 × 32 tiles and each of ten two-stop bands of log luminance, the sum and the share of
 * the tile's taps that fell in that band, and in an eleventh block the tile's mean. The composite
 * reads the grid at the pixel's place and in the pixel's own band, filtered in both, so a shaded
 * pixel beside sunlit ones takes the shade's level rather than the tile's: that is what keeps the
 * lift from haloing across the edge of a shadow. The band's level is blended 0.4 toward the tile's
 * mean, which is what stops a texture's own light and dark being flattened into one another.
 *
 * **The gain is `strength · (held − local)` stops**, clamped to three: at 0.5 a region five stops
 * under the frame is lifted two and a half, and one two over is brought down one. The held value is
 * eye adaptation's, so the frame as a whole still adapts and regions are moved relative to it.
 *
 * What it gives up is some of the contrast between regions, which is the point, and a halo a tile
 * wide where two regions share a band and differ in brightness. What would make it wrong is a scene
 * whose drama is the contrast itself: a single shaft into a dark room wants the room dark, and the
 * strength is the caller's for that reason.
 */
import { ADAPTED_KEY, METER_GRID, METER_MAX_LOG2, METER_MIN_LOG2, METER_TAPS } from './exposure.ts';

/** Bands of log luminance, and how many stops each is wide. */
export const LOCAL_BINS = 10;
export const LOCAL_BIN_STOPS = (METER_MAX_LOG2 - METER_MIN_LOG2) / LOCAL_BINS;
/** The grid's width in texels: a block of tiles per band, and one for the tiles' means. */
export const LOCAL_GRID_WIDTH = METER_GRID * (LOCAL_BINS + 1);
/** How far a pixel's band level is blended toward its tile's mean. */
export const LOCAL_BLURRED_BLEND = 0.4;
/** The furthest a region is moved either way, in stops. */
export const LOCAL_RANGE_STOPS = 3;

const BLOCKS = (LOCAL_BINS + 1).toFixed(1);
const GRID = METER_GRID.toFixed(1);
const MIN = METER_MIN_LOG2.toFixed(1);
const MAX = METER_MAX_LOG2.toFixed(1);
const STOPS = LOCAL_BIN_STOPS.toFixed(1);
const LAST = (LOCAL_BINS - 1).toFixed(1);

/**
 * The grid: one texel a tile a band. Each reads its tile's 8 × 8 taps, as the meter does, and keeps
 * the ones in its band; the last block keeps them all. Sum and count are both divided by the taps,
 * so the filtered pair in the composite is still a weighted mean.
 */
export const EXPOSURE_LOCAL_FRAG = `#version 300 es
precision highp float;

in vec2 vUv;

/** The finished scene, in scene light, before any exposure or curve. */
uniform highp sampler2D uScene;

out vec2 fragColor;

void main() {
  float uvBlock = vUv.x * ${BLOCKS};
  float band = floor(uvBlock);
  vec2 corner = vec2(fract(uvBlock), vUv.y) - vec2(0.5 / ${GRID});
  float sum = 0.0;
  float count = 0.0;
  for (int y = 0; y < ${METER_TAPS}; y++) {
    for (int x = 0; x < ${METER_TAPS}; x++) {
      vec2 uv = corner + (vec2(float(x), float(y)) + 0.5) / ${(METER_GRID * METER_TAPS).toFixed(1)};
      vec3 c = textureLod(uScene, uv, 0.0).rgb;
      float level = clamp(log2(max(dot(c, vec3(0.2126, 0.7152, 0.0722)), 1e-8)), ${MIN}, ${MAX});
      float tapBand = floor(clamp((level - ${MIN}) / ${STOPS}, 0.0, ${LAST}));
      float kept = band > ${LAST} || tapBand == band ? 1.0 : 0.0;
      sum += level * kept;
      count += kept;
    }
  }
  fragColor = vec2(sum, count) / ${(METER_TAPS * METER_TAPS).toFixed(1)};
}
`;

/**
 * The composite's half. Needs `AUTO_EXPOSURE_GLSL` and `uOutputExposure` before it, for the held
 * brightness and the frame's exposure.
 *
 * A block is read clamped half a texel inside its own tiles, so the filter never reaches into the
 * neighbouring band's block. Every fetch is at level zero: the grid has one level, and the branch
 * on the strength above them is uniform but the pixel's band is not.
 */
export const LOCAL_EXPOSURE_GLSL = `
/** Above 0 when regions move at all: 0 is off and the whole of the off path. */
uniform float uLocalExposure;
/**
 * How regions move, as \`resolveLocalExposure\` packs it: the share of a region's stops from the
 * pivot it keeps above the pivot and below it, each less one; the share of a pixel's own stops
 * from its region it keeps, less one; and how far a region's level leans toward its tile's mean.
 */
uniform vec4 uLocalShape;
/**
 * What they move about: 1 for the frame's held brightness, 0 for middle grey at the frame's
 * exposure; stops added to it; and the furthest a region moves either way.
 */
uniform vec4 uLocalPivot;
/** The bilateral grid: a block of tiles per band of brightness, and one of the tiles' means. */
uniform highp sampler2D uExposureLocal;

vec2 localBlock(vec2 uv, float block) {
  vec2 inside = clamp(uv, vec2(0.5 / ${GRID}), vec2(1.0 - 0.5 / ${GRID}));
  return textureLod(uExposureLocal, vec2((block + inside.x) / ${BLOCKS}, inside.y), 0.0).rg;
}

float localExposureGain(vec2 uv, vec3 light) {
  if (uLocalExposure <= 0.0) return 1.0;
  float held = texelFetch(uExposureHeld, ivec2(0, 0), 0).r;
  float pixel = clamp(log2(max(dot(light, vec3(0.2126, 0.7152, 0.0722)), 1e-8)), ${MIN}, ${MAX});
  float b = (pixel - ${MIN}) / ${STOPS} - 0.5;
  float lower = clamp(floor(b), 0.0, ${LAST});
  float upper = min(lower + 1.0, ${LAST});
  vec2 banded = mix(localBlock(uv, lower), localBlock(uv, upper), clamp(b - lower, 0.0, 1.0));
  float tileMean = localBlock(uv, ${LOCAL_BINS.toFixed(1)}).r;
  float bilateral = banded.y > 1e-3 ? banded.x / banded.y : tileMean;
  float local = mix(bilateral, tileMean, uLocalShape.w);
  /* Middle grey at the frame's exposure, in the scene light the grid measured. */
  float pivot = uLocalPivot.x > 0.5
    ? held
    : ${Math.log2(ADAPTED_KEY).toFixed(6)} - log2(max(autoExposureGain() * uOutputExposure, 1e-8));
  pivot += uLocalPivot.y;
  float keep = local > pivot ? uLocalShape.x : uLocalShape.y;
  float stops = (local - pivot) * keep + (pixel - local) * uLocalShape.z;
  return exp2(clamp(stops, -uLocalPivot.z, uLocalPivot.z));
}
`;

const clamp = (value: number, low: number, high: number): number =>
  Math.min(Math.max(value, low), high);

/** The two bands a pixel at `pixelLog2` reads, and how much of the upper, as the shader finds them. */
export function localBin(pixelLog2: number): { lower: number; upper: number; weight: number } {
  const pixel = clamp(pixelLog2, METER_MIN_LOG2, METER_MAX_LOG2);
  const b = (pixel - METER_MIN_LOG2) / LOCAL_BIN_STOPS - 0.5;
  const lower = clamp(Math.floor(b), 0, LOCAL_BINS - 1);
  return { lower, upper: Math.min(lower + 1, LOCAL_BINS - 1), weight: clamp(b - lower, 0, 1) };
}

/** A pixel's local level from its two bands' sums and counts and its tile's mean, as the shader. */
export function sliceLocal(
  sumLower: number,
  countLower: number,
  sumUpper: number,
  countUpper: number,
  weight: number,
  tileMean: number,
): number {
  const sum = sumLower + (sumUpper - sumLower) * weight;
  const count = countLower + (countUpper - countLower) * weight;
  const bilateral = count > 1e-3 ? sum / count : tileMean;
  return bilateral + (tileMean - bilateral) * LOCAL_BLURRED_BLEND;
}

/** A region's gain for a local level and the frame's held one at `strength`, as the composite. */
export function localExposureGain(localLog2: number, heldLog2: number, strength: number): number {
  if (!(strength > 0)) return 1;
  const stops = strength * (heldLog2 - localLog2);
  return 2 ** clamp(stops, -LOCAL_RANGE_STOPS, LOCAL_RANGE_STOPS);
}

/**
 * Local exposure as a shape rather than one strength: each region turned about middle grey at the
 * frame's exposure, the real-time form most engines expose.
 *
 * A region's level is its stops from that grey: it keeps `highlightContrast` of them where it is
 * brighter and `shadowContrast` where it is darker, so 1 leaves it where it is and 0 brings it all
 * the way to grey. A pixel keeps `detail` of its own stops from its region, so above 1 sharpens the
 * texture inside a region a curve would have flattened. **What it gives up** is the held level the
 * one-number form turns about: a frame metered far from grey, a night, is pulled toward grey rather
 * than toward itself, which is what the form is for and what a caller holding a night dark leaves
 * off.
 */
export interface LocalExposureOptions {
  /** The share of a region's stops above middle grey it keeps. 1 is none moved. */
  readonly highlightContrast: number;
  /** The share it keeps below. */
  readonly shadowContrast: number;
  /** The share of a pixel's own stops from its region it keeps. Default 1. */
  readonly detail?: number;
  /** How far a region's level leans from its bilateral band toward its tile's mean. Default 0.4. */
  readonly blurredBlend?: number;
  /** Stops added to middle grey, the level regions turn about. Default 0. */
  readonly middleGreyBias?: number;
  /** The furthest a region moves either way, in stops. Default 8. */
  readonly range?: number;
}

/** Floats `resolveLocalExposure` fills: `uLocalShape`, then `uLocalPivot`. */
export const LOCAL_EXPOSURE_FLOATS = 8;

/**
 * Either form of `setLocalExposure` as the composite reads it, into `out`, and whether regions move
 * at all. The one number is the shape it always was, both shares `1 − strength` about the held
 * level, at most three stops: so a strength draws what it drew, to the bit.
 */
export function resolveLocalExposure(
  setting: number | LocalExposureOptions,
  out: Float32Array,
): boolean {
  if (typeof setting === 'number') {
    const strength = clampLocalExposure(setting);
    out[0] = -strength;
    out[1] = -strength;
    out[2] = 0;
    out[3] = LOCAL_BLURRED_BLEND;
    out[4] = 1;
    out[5] = 0;
    out[6] = LOCAL_RANGE_STOPS;
    out[7] = 0;
    return strength > 0;
  }
  const share = (value: number | undefined, fallback: number): number =>
    value !== undefined && Number.isFinite(value) ? Math.max(0, value) : fallback;
  const highlight = share(setting.highlightContrast, 1);
  const shadow = share(setting.shadowContrast, 1);
  const detail = share(setting.detail, 1);
  out[0] = highlight - 1;
  out[1] = shadow - 1;
  out[2] = detail - 1;
  out[3] = clamp(share(setting.blurredBlend, LOCAL_BLURRED_BLEND), 0, 1);
  out[4] = 0;
  const bias = setting.middleGreyBias;
  out[5] = bias !== undefined && Number.isFinite(bias) ? bias : 0;
  out[6] = share(setting.range, 8);
  out[7] = 0;
  return highlight !== 1 || shadow !== 1 || detail !== 1;
}

/**
 * A pixel's gain from either form, as the composite computes it: `pixelLog2` its own level,
 * `localLog2` its region's before the blend, `tileMean` its tile's, `heldLog2` the frame's held
 * brightness and `exposure` the frame's exposure, gain and all; `shape` is `resolveLocalExposure`'s.
 */
export function localExposureShapedGain(
  pixelLog2: number,
  localLog2: number,
  tileMean: number,
  heldLog2: number,
  exposure: number,
  shape: ArrayLike<number>,
): number {
  const local = localLog2 + (tileMean - localLog2) * (shape[3] as number);
  const pivot =
    ((shape[4] as number) > 0.5 ? heldLog2 : Math.log2(ADAPTED_KEY) - Math.log2(exposure)) +
    (shape[5] as number);
  const keep = local > pivot ? (shape[0] as number) : (shape[1] as number);
  const stops = (local - pivot) * keep + (pixelLog2 - local) * (shape[2] as number);
  const range = shape[6] as number;
  return 2 ** clamp(stops, -range, range);
}

/** A local exposure strength as the shader takes it: 0 to 1, anything else off. */
export function clampLocalExposure(strength: number): number {
  return Number.isFinite(strength) ? clamp(strength, 0, 1) : 0;
}
