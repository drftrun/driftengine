/** Rectangular area lights: what a caller declares, and the arrays a shader wants. */

/**
 * How many rectangles the lit pass shades against at once.
 *
 * **Four, because a rectangle is a fixture rather than a lamp.** A window, a softbox, a lit panel:
 * a scene with more than a handful of these is a scene that wants them baked into an environment,
 * which is what the prefilter and the loader are for. Raising it is a uniform-array size and an
 * iteration of the loop, exactly as `MAX_POINT_LIGHTS` is.
 */
export const MAX_AREA_LIGHTS = 4;

/**
 * One rectangular emitter, as a consumer describes it.
 *
 * Positions, colours and sizes, and nothing that means anything in one game — the rule
 * `AGENTS.md` opens with. `right` and `up` are the rectangle's own in-plane axes, and their cross
 * product is the direction it emits.
 */
export interface AreaLightSource {
  x: number;
  y: number;
  z: number;
  r: number;
  g: number;
  b: number;
  /** In-plane axes. Normalised on the way in, because the form factor assumes unit length. */
  rightX: number;
  rightY: number;
  rightZ: number;
  upX: number;
  upY: number;
  upZ: number;
  /** Half extents along `right` and `up`, in metres. */
  halfWidth: number;
  halfHeight: number;
  /**
   * Whether the rectangle emits from both faces. Default false.
   *
   * A window is one-sided and a hanging panel is two-sided, and the difference is visible rather
   * than pedantic: a one-sided light must contribute nothing to a surface behind it, or the wall
   * it is set into is lit by it and reads as glowing.
   */
  twoSided?: boolean;
  /**
   * Whether this rectangle is worth a shadow layer at all. **Default false**, which is the
   * opposite of what a point light's identically named field defaults to.
   *
   * A point light has cast since before there was a budget to ration, so `true` is what its
   * existing callers already rely on. An area light shipped in 3.2.0 with no occlusion at all —
   * `AGENTS.md` calls that a bug rather than a limitation, and it is the row this field closes —
   * so every scene that already declares one was authored against a rectangle that lights
   * through walls. Defaulting to `true` here would hand each of them two octahedral layers,
   * 8.39 MB, and a six-face bake over the static world, for a change in the picture nobody asked
   * for. `RenderQuality`'s own rule is that a feature's default reproduces today's frame.
   *
   * **It also rides `RenderQuality.pointShadows`**, because an area light's occlusion is read out
   * of the same array texture a point light's is. WebGL2 guarantees sixteen texture units and the
   * lit pass binds sixteen, so a seventeenth sampler is not available to declare — see
   * `FlatShaderOptions.environmentProbe` for the same wall reached from the other side. With that
   * flag off there is no array to bake into, and the renderer says so once by name rather than
   * quietly drawing an unoccluded rectangle.
   */
  castsShadow?: boolean;
  /**
   * How far from the rectangle occlusion is tracked, in metres: the shadow map's far plane.
   *
   * **Required when `castsShadow` is true, and deliberately not defaulted.** A point light's map
   * gets its far plane from `radius`, the distance at which the light itself reaches zero — a
   * rectangle has no such distance, because its falloff is the solid angle it subtends and that is
   * never exactly zero. So the number is a statement about how much of the scene this fixture is
   * responsible for occluding, which is a decision about the content: a panel in a corridor wants
   * the corridor's length and a sky panel over a courtyard wants the courtyard's.
   *
   * Guessing it would produce one of two failures, both of which read as a renderer bug rather
   * than a missing field: too short and the shadow stops in a straight line partway across the
   * floor, too long and the depth precision spent on the near metres is what a fixture actually
   * needed. A rectangle that declares it casts and names no range is refused with a warning
   * naming the field.
   */
  shadowRange?: number;
  /**
   * Where casting begins, in metres from the rectangle's plane. Defaults to `POINT_SHADOW_NEAR`.
   *
   * The same knob a point light carries and for the same reason: a fixture's own housing sits
   * within centimetres of the emitter, occludes an enormous solid angle from it, and throws that
   * across the floor as a hard square much larger than the housing. Keep it small — it clips
   * every caster, not just the fixture.
   */
  shadowNear?: number;
}

/** The five arrays the shader declares, filled once a frame from whatever a caller supplied. */
export interface AreaLightBuffer {
  count: number;
  readonly positions: Float32Array;
  readonly colors: Float32Array;
  readonly right: Float32Array;
  readonly up: Float32Array;
  readonly sizes: Float32Array;
  readonly twoSided: Float32Array;
}

export function createAreaLightBuffer(capacity: number = MAX_AREA_LIGHTS): AreaLightBuffer {
  return {
    count: 0,
    positions: new Float32Array(capacity * 3),
    colors: new Float32Array(capacity * 3),
    right: new Float32Array(capacity * 3),
    up: new Float32Array(capacity * 3),
    sizes: new Float32Array(capacity * 2),
    twoSided: new Float32Array(capacity),
  };
}

/**
 * Fill the buffer from a caller's list, normalising the axes and orthogonalising them.
 *
 * **Both corrections are here rather than trusted**, and neither is defensive tidying:
 *
 * - The form factor treats `right` and `up` as unit vectors, so a caller's un-normalised axis
 *   scales the rectangle it describes. That is a light of the wrong *size*, which reads as the
 *   half extents having been set wrong.
 * - The two axes are made perpendicular, because a rectangle whose axes are not describes a
 *   parallelogram — and the form factor is defined for the polygon its four corners make, so what
 *   comes out is the irradiance of a shape the caller did not ask for and cannot see the outline
 *   of.
 *
 * Allocation-free: it fills a target the caller owns, because this runs per frame.
 */
export function selectAreaLights(
  lights: readonly AreaLightSource[],
  out: AreaLightBuffer,
): AreaLightBuffer {
  const capacity = Math.floor(out.sizes.length / 2);
  const count = Math.min(lights.length, capacity);
  out.count = count;

  for (let slot = 0; slot < count; slot++) {
    const light = lights[slot];
    if (light === undefined) continue;

    out.positions[slot * 3] = light.x;
    out.positions[slot * 3 + 1] = light.y;
    out.positions[slot * 3 + 2] = light.z;
    out.colors[slot * 3] = light.r;
    out.colors[slot * 3 + 1] = light.g;
    out.colors[slot * 3 + 2] = light.b;

    const rx = light.rightX;
    const ry = light.rightY;
    const rz = light.rightZ;
    const rLen = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1;
    const nrx = rx / rLen;
    const nry = ry / rLen;
    const nrz = rz / rLen;

    /* Gram-Schmidt: up loses whatever component it shared with right, then is normalised. */
    const ux = light.upX;
    const uy = light.upY;
    const uz = light.upZ;
    const along = ux * nrx + uy * nry + uz * nrz;
    let oux = ux - nrx * along;
    let ouy = uy - nry * along;
    let ouz = uz - nrz * along;
    const uLen = Math.sqrt(oux * oux + ouy * ouy + ouz * ouz);
    if (uLen < 1e-6) {
      /*
       * Parallel axes describe no rectangle at all. Any perpendicular will do rather than leaving
       * a zero vector, which would make every corner the same point and every form factor NaN —
       * a light that blanks whatever it touches, from two numbers a caller got wrong.
       */
      const fallback = Math.abs(nry) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      oux = (fallback[1] ?? 0) * nrz - (fallback[2] ?? 0) * nry;
      ouy = (fallback[2] ?? 0) * nrx - (fallback[0] ?? 0) * nrz;
      ouz = (fallback[0] ?? 0) * nry - (fallback[1] ?? 0) * nrx;
    }
    const finalLen = Math.sqrt(oux * oux + ouy * ouy + ouz * ouz) || 1;

    out.right[slot * 3] = nrx;
    out.right[slot * 3 + 1] = nry;
    out.right[slot * 3 + 2] = nrz;
    out.up[slot * 3] = oux / finalLen;
    out.up[slot * 3 + 1] = ouy / finalLen;
    out.up[slot * 3 + 2] = ouz / finalLen;

    /* Never zero: a rectangle with no extent has no solid angle and no light. */
    out.sizes[slot * 2] = Math.max(1e-4, light.halfWidth);
    out.sizes[slot * 2 + 1] = Math.max(1e-4, light.halfHeight);
    out.twoSided[slot] = light.twoSided === true ? 1 : 0;
  }

  return out;
}
