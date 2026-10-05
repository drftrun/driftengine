/**
 * The hair model's lobes, as `shaders/flat/hair.ts` computes them: the reference its tests hold the
 * arithmetic to, and nothing at run time calls it.
 *
 * **A strand is a rough dielectric cylinder, index 1.55, after Marschner et al. 2003 in the
 * real-time form Karis gave in 2016.** Light leaves it three ways, each a longitudinal Gaussian in
 * `sinθi + sinθo` — the angles of light and eye out of the plane normal to the strand — times an
 * azimuthal term in φ, the turn between them around it:
 *
 * - **R**, reflected off the surface: white, and shifted toward the root by twice the tilt of the
 *   cuticle's scales, which point toward the tip;
 * - **TT**, through the strand and out: the glow of a backlit head, shifted toward the tip by the
 *   tilt, half as wide, and tinted by the fibre for the path it took;
 * - **TRT**, reflected once inside: the coloured second highlight, three tilts toward the tip and
 *   twice as wide;
 *
 * and a fourth, the light scattered through many strands, as a wrapped diffuse against a normal
 * turned toward the eye across the strand, tinted by a root of the fibre's colour.
 *
 * **The tangent runs from root to tip**, and the tilt is positive for a strand authored that way. A
 * card authored the other way round swaps its two highlights' ends, and takes a negative shift.
 *
 * **In this engine's light units.** A lamp's diffuse here is `albedo · cosθ` with no 1/π, so the
 * published lobes, which are per unit irradiance, are multiplied by π; the scatter term's 1/π cancels.
 * **What it gives up** is the fit's own: these are Karis's approximations to the azimuthal
 * integrals, not the integrals, and they do not conserve energy exactly — the tests hold the sum
 * under what a strand receives.
 */
import type { Vec3 } from '../math/color.ts';

/** Schlick's base for a strand at index 1.55: `((1 − n) / (1 + n))²`. */
export const HAIR_F0 = ((1 - 1.55) / (1 + 1.55)) ** 2;

/**
 * The narrowest longitudinal width a strand is drawn at, in radians.
 *
 * **Below every measured fibre**: Marschner gives the reflected lobe 5° to 10°, and this is about
 * 3°, so no real hair is clamped. What it stops is a roughness of 0 making a Gaussian narrower than
 * a pixel can sample — the speckle `MIN_LOBE_ALPHA` argues against for the standard lobe.
 */
export const HAIR_MIN_BETA = 0.05;

/**
 * The scatter term's answer to light arriving evenly from every side, per unit of it: the term's
 * shape integrated over the sphere and divided by π, which is how this engine's lamp units add up.
 *
 * Derived: the wrapped half `(N·L + 1) / 4` averages 1/4 over the sphere, `1 − |T·L|` averages 1/2,
 * and the shape is `mix(wrapped, 1 − |T·L|, 0.33)`, so its mean is 0.67 · 0.25 + 0.33 · 0.5 = 0.3325
 * and its integral 4π times that. Over π: **1.33**.
 */
export const HAIR_SCATTER_SPHERE = 1.33;

/** How much the scatter term leans toward the strand's own direction rather than the pseudo-normal. */
const KAJIYA_SHARE = 0.33;

/** A longitudinal lobe: a normalised Gaussian of width `beta` at `x` from its centre. */
export function hairLongitudinal(beta: number, x: number): number {
  return Math.exp((-0.5 * x * x) / (beta * beta)) / (Math.sqrt(2 * Math.PI) * beta);
}

/** Schlick's Fresnel for the strand at a cosine, clamped to the unit interval. */
export function hairFresnel(cosine: number): number {
  const c = 1 - Math.min(Math.max(cosine, 0), 1);
  return HAIR_F0 + (1 - HAIR_F0) * c * c * c * c * c;
}

function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  return (
    (a[0] as number) * (b[0] as number) +
    (a[1] as number) * (b[1] as number) +
    (a[2] as number) * (b[2] as number)
  );
}

const clamp = (x: number, low: number, high: number): number => Math.min(Math.max(x, low), high);

/** Where `hairLight` leaves its answer: R, then TT, TRT and the scatter, each a colour. */
export const HAIR_OUT = { r: 0, tt: 1, trt: 4, scatter: 7, length: 10 } as const;

/**
 * One light on a strand, in lamp units and unshadowed, into `out` (`HAIR_OUT`'s layout: R is grey,
 * the rest colours). `tangent`, `toLight` and `toEye` are unit vectors but for a tangent that could
 * not be made one, which comes in as zeros; `fibre` is the base colour.
 *
 * **A lamp with a size widens every lobe by the angle it subtends**, `sourceRadius / 2·dist` as
 * `sphereLobe` takes it, and the lobes are normalised Gaussians, so a wider one carries the same
 * light rather than more. The sun passes zeros.
 */
export function hairLight(
  tangent: ArrayLike<number>,
  toLight: ArrayLike<number>,
  toEye: ArrayLike<number>,
  fibre: Vec3,
  roughness: number,
  shift: number,
  scatter: number,
  backlit: number,
  sourceRadius: number,
  dist: number,
  out: Float64Array,
): void {
  const sinI = clamp(dot(tangent, toLight), -1, 1);
  const sinO = clamp(dot(tangent, toEye), -1, 1);
  /*
   * The half difference angle, rounded to single precision as the device holds it: at its limit,
   * light and eye at opposite ends of the strand, that is π/2 rounded up, whose cosine is −4.4e-8
   * rather than double precision's +6e-17 — and the transmitted powers divide by it. The floor is
   * for the device's number, and the rounding is what lets a test here see it.
   */
  const cosD = Math.max(
    Math.cos(Math.fround(0.5 * Math.abs(Math.asin(sinO) - Math.asin(sinI)))),
    1e-3,
  );
  let lp2 = 0;
  let vp2 = 0;
  let lpvp = 0;
  for (let c = 0; c < 3; c++) {
    const lp = (toLight[c] as number) - sinI * (tangent[c] as number);
    const vp = (toEye[c] as number) - sinO * (tangent[c] as number);
    lp2 += lp * lp;
    vp2 += vp * vp;
    lpvp += lp * vp;
  }
  const cosPhi = lpvp / Math.sqrt(lp2 * vp2 + 1e-4);
  const cosHalfPhi = Math.sqrt(clamp(0.5 + 0.5 * cosPhi, 0, 1));
  const beta = Math.max(roughness * roughness, HAIR_MIN_BETA);
  const grow = sourceRadius / Math.max(2 * dist, 1e-3);
  const x = sinI + sinO;

  const r =
    hairLongitudinal(beta + grow, x + 2 * shift) *
    0.25 *
    cosHalfPhi *
    hairFresnel(Math.sqrt(clamp(0.5 + 0.5 * dot(toLight, toEye), 0, 1)));

  const a = 1 / (1.19 / cosD + 0.36 * cosD);
  const h = cosHalfPhi * (1 + a * (0.6 - 0.8 * cosPhi));
  const fTT = hairFresnel(cosD * Math.sqrt(clamp(1 - h * h, 0, 1)));
  const tt =
    hairLongitudinal(0.5 * beta + grow, x - shift) *
    Math.exp(-3.65 * cosPhi - 3.98) *
    (1 - fTT) *
    (1 - fTT) *
    backlit;
  const ttPower = (0.5 * Math.sqrt(clamp(1 - h * h * a * a, 0, 1))) / cosD;

  const fTRT = hairFresnel(0.5 * cosD);
  const trt =
    hairLongitudinal(2 * beta + grow, x - 3 * shift) *
    Math.exp(17 * cosPhi - 16.78) *
    (1 - fTRT) *
    (1 - fTRT) *
    fTRT;
  const trtPower = 0.8 / cosD;

  let across0 = (toEye[0] as number) - (tangent[0] as number) * sinO;
  let across1 = (toEye[1] as number) - (tangent[1] as number) * sinO;
  let across2 = (toEye[2] as number) - (tangent[2] as number) * sinO;
  const acrossLength = Math.hypot(across0, across1, across2);
  if (acrossLength > 1e-4) {
    across0 /= acrossLength;
    across1 /= acrossLength;
    across2 /= acrossLength;
  }
  const wrapped = clamp(
    (across0 * (toLight[0] as number) +
      across1 * (toLight[1] as number) +
      across2 * (toLight[2] as number) +
      1) /
      4,
    0,
    1,
  );
  const shape = wrapped + (1 - Math.abs(sinI) - wrapped) * KAJIYA_SHARE;

  out[HAIR_OUT.r] = Math.PI * r;
  for (let c = 0; c < 3; c++) {
    /*
     * Above zero, so the device's `pow` never forms the logarithm of zero: an infinity in the
     * middle of an expression is something a shader compiler may assume never happens. Nothing in
     * double precision can show the difference, so no test here does.
     */
    const colour = Math.max(fibre[c], 1e-4);
    out[HAIR_OUT.tt + c] = Math.PI * tt * colour ** ttPower;
    out[HAIR_OUT.trt + c] = Math.PI * trt * colour ** trtPower;
    out[HAIR_OUT.scatter + c] = Math.sqrt(fibre[c]) * scatter * shape;
  }
}
