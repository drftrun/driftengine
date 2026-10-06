/**
 * The `filmic` output transform: a parametric film curve, its five numbers, and the eight
 * constants the resolve reads, decided once here for both backends.
 *
 * **Why a second filmic curve beside `aces`.** `aces` is the reference RRT and ODT fit, which
 * holds a mid grey of 0.18 at about 0.11 of display linear: graded for a dark cinema and kept dark.
 * The curve here holds 0.18 at 0.18 by construction, and is shaped by five numbers a grading
 * volume carries — a slope through mid grey, a toe and a shoulder, and how far black and white are
 * clipped past the ends — so a look authored against such a curve is matched by passing its numbers
 * rather than by baking the difference into a colour lookup table, which has the fewest steps
 * exactly where two curves differ most: in the shadows.
 *
 * **What the curve is.** In the ACEScg working space, after the ACES reference's glow and red
 * modifier and a 4% desaturation: a straight line of `slope` through mid grey in log10, joined to a
 * logistic toe below `toeMatch` and a logistic shoulder above `shoulderMatch`, blended by a smooth
 * step between the two, then desaturated by 7% and taken back to linear sRGB. The toe's position is
 * solved so that 0.18 in is 0.18 out.
 *
 * **What it gives up.** It needs the composite to grade: `screenEffects` and `hdrScene`, since the
 * forward passes that grade a frame without one carry two uniforms between them and not eight.
 * Without them every pass grades with `aces` and the renderer says so once at construction.
 * **What would make it wrong** is a profile wanting this curve without a scene target, which would
 * then pay six floats in every forward program to have it.
 */

/** A film curve's five numbers, as a grading volume states them. */
export interface FilmicCurve {
  /** The straight segment's slope in log10, through mid grey. Positive. */
  readonly slope: number;
  /** How much of the curve below mid grey the toe takes, 0 to 1. Larger is a longer, softer toe. */
  readonly toe: number;
  /** How much of the curve above mid grey the shoulder takes, 0 to 1. Larger rolls off sooner. */
  readonly shoulder: number;
  /** How far below 0 the toe's asymptote sits: 0 holds black at black, more crushes it. */
  readonly blackClip: number;
  /** How far above 1 the shoulder's asymptote sits: 0 never reaches white, more lets it clip. */
  readonly whiteClip: number;
}

/** The defaults the curve ships with where a volume states nothing. */
export const DEFAULT_FILMIC_CURVE: FilmicCurve = {
  slope: 0.88,
  toe: 0.55,
  shoulder: 0.26,
  blackClip: 0,
  whiteClip: 0.04,
};

/** How many floats `resolveFilmicCurve` fills: two vectors of the resolve's uniforms. */
export const FILMIC_CONSTANTS = 8;

/** Mid grey, which the curve takes to itself. */
const MID_GREY = 0.18;

/** The largest toe or shoulder kept: at 1 the toe's or the shoulder's scale is zero. */
const MOST = 0.999;
/** The shallowest slope kept, which is still a curve rather than a flat line. */
const LEAST_SLOPE = 0.01;

/**
 * The eight constants the resolve reads, into `out`: `uFilmA` = (slope, black clip, white clip,
 * toe scale) and `uFilmB` = (shoulder scale, toe match, straight match, shoulder match). Returns
 * whether any of the five numbers had to be brought into range.
 *
 * Here rather than in the shader, because they are one solve a curve and would be one per pixel
 * there. **Clamped rather than refused**, because a grading volume is set from inside a frame and
 * the frame loop never throws: a slope below 0.01, a toe, shoulder or clip outside 0 to 1, and a
 * toe or shoulder of exactly 1 — whose scale is then zero and divides the curve by it — are each
 * a picture made of NaN otherwise. A number that is not finite takes the default's. The renderer
 * says once when anything was clamped.
 */
export function resolveFilmicCurve(
  curve: FilmicCurve,
  out: Float32Array,
  /**
   * The display's peak over paper white (`displayHeadroom`), 1 for a standard range. Above 1 the
   * white clip is raised by the difference, so the shoulder rolls off toward the display's peak
   * rather than toward white, and the toe and mid grey stay exactly where they were.
   */
  headroom = 1,
): boolean {
  let clamped = false;
  const within = (value: number, low: number, high: number, fallback: number): number => {
    const finite = Number.isFinite(value) ? value : fallback;
    const kept = Math.min(Math.max(finite, low), high);
    if (kept !== value) clamped = true;
    return kept;
  };
  const slope = within(curve.slope, LEAST_SLOPE, Number.MAX_VALUE, DEFAULT_FILMIC_CURVE.slope);
  const toe = within(curve.toe, 0, MOST, DEFAULT_FILMIC_CURVE.toe);
  const shoulder = within(curve.shoulder, 0, MOST, DEFAULT_FILMIC_CURVE.shoulder);
  const blackClip = within(curve.blackClip, 0, 1, DEFAULT_FILMIC_CURVE.blackClip);
  const whiteClip =
    within(curve.whiteClip, 0, 1, DEFAULT_FILMIC_CURVE.whiteClip) + Math.max(headroom, 1) - 1;
  const toeScale = 1 + blackClip - toe;
  const shoulderScale = 1 + whiteClip - shoulder;
  let toeMatch: number;
  if (toe > 0.8) {
    /* Mid grey falls on the straight segment. */
    toeMatch = (1 - toe - MID_GREY) / slope + Math.log10(MID_GREY);
  } else {
    /* Mid grey falls on the toe: solve the toe's logistic for 0.18 in, 0.18 out. */
    const bt = (MID_GREY + blackClip) / toeScale - 1;
    toeMatch = Math.log10(MID_GREY) - 0.5 * Math.log((1 + bt) / (1 - bt)) * (toeScale / slope);
  }
  const straightMatch = (1 - toe) / slope - toeMatch;
  const shoulderMatch = shoulder / slope - straightMatch;
  out[0] = slope;
  out[1] = blackClip;
  out[2] = whiteClip;
  out[3] = toeScale;
  out[4] = shoulderScale;
  out[5] = toeMatch;
  out[6] = straightMatch;
  out[7] = shoulderMatch;
  return clamped;
}

/** Said once a renderer, the first time `setFilmicCurve` was handed a number out of range. */
export const FILMIC_CLAMPED =
  '[driftengine] setFilmicCurve was handed a number outside its range — a slope under 0.01, a ' +
  'toe, shoulder or clip outside 0 to 1, or one that is not a number — and drew with it clamped.';

/**
 * Said once at construction where `filmic` was asked for and the frame has no composite that
 * grades: the passes grade with `aces`, which is the nearest curve they carry.
 */
export const FILMIC_WITHOUT_COMPOSITE =
  "[driftengine] outputTransform 'filmic' is applied by the composite, which grades only with " +
  "`screenEffects` and `hdrScene` both on: without them every pass grades itself, with 'aces'.";

/**
 * `filmicCurve(c)`: linear sRGB in, display-linear sRGB out, clamped to 0 to 1 — or, on a high
 * range display, to the shoulder's own asymptote. Reads `uFilmA`, `uFilmB` and `uDisplayHeadroom`,
 * which the including stage declares. The ACES helpers are the reference's own:
 * saturation, `yc`, the glow's sigmoid, and hue in degrees.
 */
export const FILMIC_GLSL = `
/* sRGB to ACEScg (through D60), ACEScg back, and ACEScg to and from ACES2065-1. Columns. */
const mat3 FILM_SRGB_TO_AP1 = mat3(
  0.61319, 0.07021, 0.02062,
  0.33951, 0.91634, 0.10957,
  0.04737, 0.01345, 0.86961
);
/* The inverse of the one above, computed rather than copied, so a round trip is the identity. */
const mat3 FILM_AP1_TO_SRGB = mat3(
   1.70480, -0.13027, -0.02401,
  -0.62168,  1.14082, -0.12900,
  -0.08325, -0.01055,  1.15324
);
const mat3 FILM_AP1_TO_AP0 = mat3(
   0.6954522414, 0.0447945634, -0.0055258826,
   0.1406786965, 0.8596711185,  0.0040252103,
   0.1638690622, 0.0955343182,  1.0015006723
);
const mat3 FILM_AP0_TO_AP1 = mat3(
   1.4514393161, -0.0765537734,  0.0083161484,
  -0.2365107469,  1.1762296998, -0.0060324498,
  -0.2149285693, -0.0996759264,  0.9977163014
);
const vec3 FILM_AP1_LUMA = vec3(0.2722287168, 0.6740817658, 0.0536895174);

float filmSaturation(vec3 c) {
  float hi = max(c.r, max(c.g, c.b));
  float lo = min(c.r, min(c.g, c.b));
  return (max(hi, 1e-10) - max(lo, 1e-10)) / max(hi, 1e-2);
}

float filmYc(vec3 c) {
  float chroma = sqrt(max(c.b * (c.b - c.g) + c.g * (c.g - c.r) + c.r * (c.r - c.b), 0.0));
  return (c.b + c.g + c.r + 1.75 * chroma) / 3.0;
}

float filmSigmoid(float x) {
  float t = max(1.0 - abs(x / 2.0), 0.0);
  return (1.0 + sign(x) * (1.0 - t * t)) / 2.0;
}

float filmGlow(float yc, float gain, float mid) {
  if (yc <= 2.0 / 3.0 * mid) return gain;
  if (yc >= 2.0 * mid) return 0.0;
  return gain * (mid / yc - 0.5);
}

/* Hue in degrees, -180 to 180 about red; 0 for a grey, which then takes no red modifier. */
float filmCentredHue(vec3 c) {
  float y = sqrt(3.0) * (c.g - c.b);
  float x = 2.0 * c.r - c.g - c.b;
  if (abs(x) < 1e-10 && abs(y) < 1e-10) return 0.0;
  return degrees(atan(y, x));
}

vec3 filmicCurve(vec3 linear) {
  vec3 ap0 = FILM_AP1_TO_AP0 * (FILM_SRGB_TO_AP1 * linear);
  /* The reference's glow, lifting dark saturated colours a little. */
  float saturation = filmSaturation(ap0);
  ap0 *= 1.0 + filmGlow(filmYc(ap0), 0.05 * filmSigmoid((saturation - 0.4) / 0.2), 0.08);
  /* And its red modifier, pulling saturated reds toward a pivot so they do not run to orange. */
  float weight = smoothstep(0.0, 1.0, 1.0 - abs(2.0 * filmCentredHue(ap0) / 135.0));
  ap0.r += weight * weight * saturation * (0.03 - ap0.r) * (1.0 - 0.82);
  vec3 work = max(FILM_AP0_TO_AP1 * ap0, vec3(0.0));
  work = mix(vec3(dot(work, FILM_AP1_LUMA)), work, 0.96);

  float slope = uFilmA.x;
  float black = uFilmA.y;
  float white = uFilmA.z;
  float toeScale = uFilmA.w;
  float shoulderScale = uFilmB.x;
  float toeMatch = uFilmB.y;
  float straightMatch = uFilmB.z;
  float shoulderMatch = uFilmB.w;
  /* log10, through log2: GLSL ES has no log10. */
  vec3 logc = log2(max(work, vec3(1e-10))) * 0.30102999566;
  vec3 straight = slope * (logc + straightMatch);
  vec3 toeC = -black + (2.0 * toeScale) / (1.0 + exp((-2.0 * slope / toeScale) * (logc - toeMatch)));
  vec3 shoulderC =
    (1.0 + white) - (2.0 * shoulderScale) / (1.0 + exp((2.0 * slope / shoulderScale) * (logc - shoulderMatch)));
  toeC = mix(straight, toeC, vec3(lessThan(logc, vec3(toeMatch))));
  shoulderC = mix(straight, shoulderC, vec3(greaterThan(logc, vec3(shoulderMatch))));
  vec3 t = clamp((logc - toeMatch) / (shoulderMatch - toeMatch), 0.0, 1.0);
  if (shoulderMatch < toeMatch) t = 1.0 - t;
  t = (3.0 - 2.0 * t) * t * t;
  vec3 tone = mix(toeC, shoulderC, t);
  tone = mix(vec3(dot(tone, FILM_AP1_LUMA)), tone, 0.93);
  /* White is the ceiling on a standard display; on a high range one the shoulder's asymptote is. */
  float ceiling = uDisplayHeadroom > 1.0 ? 1.0 + white : 1.0;
  return clamp(FILM_AP1_TO_SRGB * max(tone, vec3(0.0)), 0.0, ceiling);
}
`;
