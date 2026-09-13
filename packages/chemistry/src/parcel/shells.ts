/**
 * A parcel's depth, as nested shells of equal mass.
 *
 * **Without this a fire model cannot be right, and `§4` is the argument.** The time for a heat
 * front to reach depth `d` goes as `ρ·c·d²/k`. For wood that is about six seconds at one
 * millimetre and four hours at fifty, so a parcel with a single temperature is wrong by that whole
 * factor — in the direction that flashes every log in the world over at once. Thin things ignite
 * and thick things do not, and nothing else in the model produces that.
 *
 * **Equal mass rather than equal thickness**, which for a cylinder or a sphere puts the resolution
 * where the gradient is: the outer shell of a large object is thin and the core is fat. For a slab
 * the two are the same thing, because a slab's cross-section does not shrink inward.
 *
 * Shell 0 is the surface and shell `count - 1` is the core.
 *
 * The fractions here are pure functions of a shape and a count, so they are computed **once per
 * substance at registration** and multiplied by a parcel's own depth at use. That is not tidiness:
 * `Math.cbrt` is not exactly specified by ECMAScript, and `§15` keeps every operation the
 * specification declines to pin down off the simulation path.
 */

export const SHAPE_SLAB = 0;
export const SHAPE_CYLINDER = 1;
export const SHAPE_SPHERE = 2;

export type Shape = typeof SHAPE_SLAB | typeof SHAPE_CYLINDER | typeof SHAPE_SPHERE;

/**
 * The most shells a parcel may have.
 *
 * Sixteen because that is the design's `Hero` tier in `§14`, and because a parcel's enthalpy column
 * is strided by this constant: every parcel pays sixteen doubles whether it uses them or not, which
 * is 128 bytes and is the price of not needing a per-parcel offset table.
 */
export const MAX_SHELLS = 16;

export interface ShellGeometry {
  readonly shape: Shape;
  readonly count: number;
  /** Radius of shell `i`'s **inner** boundary, as a fraction of the characteristic depth. */
  readonly innerFraction: Float64Array;
  /** Area of that boundary, as a fraction of the exposed surface area. */
  readonly areaFactor: Float64Array;
  /** Shell `i`'s own thickness, as a fraction of the characteristic depth. These sum to one. */
  readonly thicknessFraction: Float64Array;
  /**
   * Characteristic depth is this times volume over area: 1 for a slab, 2 for a cylinder, 3 for a
   * sphere. It is what makes `V/A` mean "half-thickness" for a cylinder and "a third of the radius"
   * for a sphere, which is the same relation fire engineering uses.
   */
  readonly depthFactor: number;
}

/** The exponent relating enclosed volume to radius: `V ∝ r^(m+1)`. */
function volumeExponent(shape: Shape): number {
  switch (shape) {
    case SHAPE_SLAB:
      return 1;
    case SHAPE_CYLINDER:
      return 2;
    case SHAPE_SPHERE:
      return 3;
    default:
      throw new Error(`shape ${shape} is not a slab, a cylinder or a sphere`);
  }
}

export function shellGeometry(shape: Shape, count: number): ShellGeometry {
  if (!Number.isInteger(count) || count < 1 || count > MAX_SHELLS) {
    throw new Error(`a parcel has between 1 and ${MAX_SHELLS} shells, not ${count}`);
  }
  const exponent = volumeExponent(shape);

  const innerFraction = new Float64Array(count);
  const areaFactor = new Float64Array(count);
  const thicknessFraction = new Float64Array(count);

  /* Shell `i`'s inner boundary encloses `(count - 1 - i) / count` of the volume, which is what
     equal mass means, and radius follows by the shape's own exponent. */
  // determinism: build-time — shell geometry is computed at registration, per §15 of the design
  const radiusAt = (volumeFraction: number): number => volumeFraction ** (1 / exponent);

  for (let i = 0; i < count; i++) {
    const inner = radiusAt((count - 1 - i) / count);
    const outer = radiusAt((count - i) / count);
    innerFraction[i] = inner;
    // determinism: build-time — the same registration-time geometry as the line above
    areaFactor[i] = inner ** (exponent - 1);
    thicknessFraction[i] = outer - inner;
  }

  return {
    shape,
    count,
    innerFraction,
    areaFactor,
    thicknessFraction,
    depthFactor: exponent,
  };
}
