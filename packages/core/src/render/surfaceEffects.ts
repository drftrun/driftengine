/**
 * What each layer of a surface array does beyond its picture: rooms behind its windows, windows that
 * light by night, wear, animation, and whether rain wets it.
 *
 * **Per layer, because a city region is one mesh.** Its facades are told apart by the layer each
 * vertex carries (`MeshData.layers`), so an effect's parameters cannot be a per-draw uniform — two facades of one
 * draw would share them. They are a table beside the array, six texels a layer, read at the vertex's
 * layer with `texelFetch`, and they bind whenever the array does.
 *
 * **Everything off is all zeros**, so a layer a scene names no effect for — and every layer of an
 * array given no table — costs the shader one size query and nothing else.
 *
 * Layout, six RGBA texels a layer, half floats on the GPU (every whole number here is under 2,048,
 * which a half holds exactly):
 * - 0: window cells across and up, glass mask (1: glass where the albedo's alpha is 0), seed;
 * - 1: room layer (0: none; the layer plus one), room depth (0 to 1 of a cell), share of rooms lit,
 *      window glow;
 * - 2: window colour, then 1 where rain leaves the surface dry;
 * - 3: dust, grime, streaks, the metres over which wear fades out with distance (0: never);
 * - 4: scroll along u and v in repeats a second, pulse rate in hertz, pulse depth;
 * - 5: flicker, flipbook frames, flipbook frames a second, the metres past which emission fades
 *      (0: never).
 */

/** Texels a layer takes in the table. */
export const SURFACE_EFFECT_TEXELS = 6;

export interface SurfaceLayerEffect {
  /**
   * Windows across and up one repeat of the layer, for everything that works window by window:
   * rooms, lit windows. With `glass`, a window is a hole in the albedo — glass where its alpha is 0,
   * wall where it is 1 — which is how a facade is drawn, and the other way round would lose the
   * wall's colour, which does not survive an upload at alpha 0.
   */
  readonly windows?: {
    readonly cells: readonly [number, number];
    readonly glass?: boolean;
    /** Varies which windows light and which rooms show, between facades wearing one layer. */
    readonly seed?: number;
    /** How bright a lit window glows, 0 for none. */
    readonly glow?: number;
    /**
     * The light a window shows where there is no room behind it. **A vertex that names an emissive
     * colour overrides it** — the window's colour, or a tint on the room where there is one — which
     * is how buildings sharing a layer each keep their own light: a window layer's vertex emissive
     * is otherwise unused, so the colour there, strength folded in, is free to say it.
     */
    readonly colour?: readonly [number, number, number];
  };
  /** A room seen in parallax behind each window, drawn from another layer of the same array. */
  readonly interior?: {
    readonly roomLayer: number;
    /** How deep a room is, as a share of a window's width. 0.5 unless stated. */
    readonly depth?: number;
    /** The share of rooms lit, 0 to 1. 1 unless stated. */
    readonly lit?: number;
  };
  /** Procedural wear, each 0 to 1, fading out past `fade` metres (never, unless stated). */
  readonly wear?: {
    readonly dust?: number;
    readonly grime?: number;
    readonly streaks?: number;
    readonly fade?: number;
  };
  /** Motion on the caller's clock (`Environment.surfaceTime`), so a held clock holds it. */
  readonly animation?: {
    /** Repeats a second along u and v. */
    readonly scroll?: readonly [number, number];
    /** Emission rising and falling: hertz, and how far it falls, 0 to 1. */
    readonly pulse?: readonly [number, number];
    /** Emission stuttering, 0 to 1. */
    readonly flicker?: number;
    /** Successive layers as frames: how many from this one, and how fast. */
    readonly flipbook?: readonly [number, number];
    /** Metres past which emission fades out, 0 for never. */
    readonly fade?: number;
  };
  /** Rain leaves it dry: a covered walkway, an interior floor. */
  readonly dry?: boolean;
}

/**
 * The table for `effects`, one entry a layer (`undefined` for a layer with none), as floats: six
 * RGBA texels a layer, a row a layer.
 */
export function packSurfaceEffects(
  effects: readonly (SurfaceLayerEffect | undefined)[],
): Float32Array {
  const out = new Float32Array(effects.length * SURFACE_EFFECT_TEXELS * 4);
  effects.forEach((effect, layer) => {
    if (effect === undefined) return;
    const at = layer * SURFACE_EFFECT_TEXELS * 4;
    const windows = effect.windows;
    if (windows !== undefined) {
      out[at] = windows.cells[0];
      out[at + 1] = windows.cells[1];
      out[at + 2] = windows.glass === true ? 1 : 0;
      out[at + 3] = windows.seed ?? 0;
      out[at + 7] = windows.glow ?? 0;
      const colour = windows.colour ?? [1, 0.82, 0.55];
      out[at + 8] = colour[0];
      out[at + 9] = colour[1];
      out[at + 10] = colour[2];
    }
    const interior = effect.interior;
    if (interior !== undefined) {
      out[at + 4] = interior.roomLayer + 1;
      out[at + 5] = interior.depth ?? 0.5;
      out[at + 6] = interior.lit ?? 1;
    }
    out[at + 11] = effect.dry === true ? 1 : 0;
    const wear = effect.wear;
    if (wear !== undefined) {
      out[at + 12] = wear.dust ?? 0;
      out[at + 13] = wear.grime ?? 0;
      out[at + 14] = wear.streaks ?? 0;
      out[at + 15] = wear.fade ?? 0;
    }
    const animation = effect.animation;
    if (animation !== undefined) {
      out[at + 16] = animation.scroll?.[0] ?? 0;
      out[at + 17] = animation.scroll?.[1] ?? 0;
      out[at + 18] = animation.pulse?.[0] ?? 0;
      out[at + 19] = animation.pulse?.[1] ?? 0;
      out[at + 20] = animation.flicker ?? 0;
      out[at + 21] = animation.flipbook?.[0] ?? 0;
      out[at + 22] = animation.flipbook?.[1] ?? 0;
      out[at + 23] = animation.fade ?? 0;
    }
  });
  return out;
}
