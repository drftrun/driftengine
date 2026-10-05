/**
 * The eye model's refraction, as `shaders/flat/eye.ts` computes it: the reference its tests hold the
 * arithmetic to, and nothing at run time calls it.
 *
 * **An iris is seen through a cornea**, a few millimetres of clear fluid above it with an index near
 * water's, so it is not where it is painted: the eye's ray bends at the cornea toward the axis and
 * meets the iris plane somewhere else, and the iris seems to lie deeper and to shift as the eye
 * turns away. The lit stage moves the iris's texture coordinate by that shift before any map of
 * the material is read, so the whole iris — colour, relief, its own channels — moves as one.
 *
 * **The shift**: refract the view at the cornea's surface, follow the refracted ray down until it
 * has descended the cornea's height above the iris plane along the eye's axis, and take what it
 * travelled across the plane. Head-on it is nothing; at an angle θ to a flat cornea it is
 * `height · tan(asin(sin θ / ior))`. The plane is perpendicular to the axis, so a cornea seen
 * almost edge-on sends the ray along it: the descent is floored, which bounds the shift at about a
 * thousand times the height rather than letting it run to infinity at the limb.
 */
import type { Vec3 } from '../math/color.ts';

/** Schlick's base for the cornea's highlight, at the model's default index 1.336. */
export const CORNEA_F0 = ((1 - 1.336) / (1 + 1.336)) ** 2;

/** How slowly a refracted ray may descend toward the iris plane before it is held there. */
export const EYE_MIN_DESCENT = 1e-3;

/** GLSL's `refract`, into `out`: the transmitted direction, or zeros past total internal reflection. */
export function refract(incident: Vec3, normal: Vec3, eta: number, out: Float64Array): void {
  const d = normal[0] * incident[0] + normal[1] * incident[1] + normal[2] * incident[2];
  const k = 1 - eta * eta * (1 - d * d);
  if (k < 0) {
    out.fill(0);
    return;
  }
  const s = eta * d + Math.sqrt(k);
  for (let c = 0; c < 3; c++) out[c] = eta * (incident[c] as number) - s * (normal[c] as number);
}

/**
 * How far across the iris plane the eye's ray lands from where it entered the cornea, in metres,
 * into `out`: `toEye` and `normal` at the cornea, `axis` the eye's, all unit vectors; `height` the
 * cornea's height above the iris plane there.
 */
export function eyeRefractionShift(
  toEye: Vec3,
  normal: Vec3,
  axis: Vec3,
  ior: number,
  height: number,
  out: Float64Array,
): void {
  const ray = new Float64Array(3);
  refract([-toEye[0], -toEye[1], -toEye[2]], normal, 1 / ior, ray);
  const descent = Math.max(
    -((ray[0] as number) * axis[0] + (ray[1] as number) * axis[1] + (ray[2] as number) * axis[2]),
    EYE_MIN_DESCENT,
  );
  const reach = height / descent;
  const along =
    ((ray[0] as number) * axis[0] + (ray[1] as number) * axis[1] + (ray[2] as number) * axis[2]) *
    reach;
  for (let c = 0; c < 3; c++) out[c] = (ray[c] as number) * reach - axis[c] * along;
}

/**
 * Where the iris is, without a map: 1 inside `irisRadius` of the texture's centre, 0 outside, across
 * an edge `edge` wide — a limbus, not a cut.
 */
export function irisMask(u: number, v: number, irisRadius: number, edge: number): number {
  const r = Math.hypot(u - 0.5, v - 0.5);
  const t = Math.min(Math.max((r - (irisRadius - edge)) / (2 * edge), 0), 1);
  return 1 - t * t * (3 - 2 * t);
}
