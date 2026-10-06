/**
 * What a draw lays over its surface beyond its material: a rim of light, an emissive overlay that
 * dissolves the surface away, and a second normal map blended in by region. Set per draw with
 * `RendererApi.setSurfaceOverlay`, so one character's whole set of materials changes together
 * while another's does not.
 *
 * **Per draw and held, like `setEnvironmentGain`**: set before a character's draws, cleared after,
 * and every draw between them wears it. **Images come from one atlas** (`maps`), each named by the
 * rectangle it occupies — a scale and an offset in the atlas's uv — because the lit stage binds every
 * sampler a device is guaranteed and has none left for a texture of its own: the atlas is bound in
 * the slot the frame's refraction copy takes, which an opaque surface never reads. A draw that both
 * refracts and wears an overlay's images keeps its refraction and loses the images, said once.
 *
 * **Fifteen vectors of numbers**, in the material's uniform block. WebGPU has the room; WebGL2 has
 * room where its device reports more than the lit stage's 254 vectors, and refuses the overlay in
 * words where it does not. See `packSurfaceOverlay` for the layout.
 */
import type { Vec3 } from '../math/color.ts';
import type { SurfaceTextureHandle } from './backend/api.ts';

/** Where an image sits in the atlas: its size and its corner, each in the atlas's uv. */
export interface OverlayRegion {
  readonly scale: readonly [number, number];
  readonly offset: readonly [number, number];
}

/**
 * Light along the silhouette: the edge `(1 - N·V)^falloff`, leaning toward normals that face up,
 * raised to a contrast, times a noise laid in screen space, a slow pulse and a mask, in a colour.
 * Added to what the surface emits, and not gated on the night as emission is: it is a glow the
 * surface wears, not light it gives off.
 */
export interface SurfaceRim {
  readonly colour: Vec3;
  /** How bright, 0 for none. Multiplied with `alpha`. */
  readonly intensity: number;
  readonly alpha?: number;
  /** The edge's exponent: larger keeps the rim nearer the silhouette. 1.5 unless given. */
  readonly falloff?: number;
  /**
   * How far the rim leans toward normals that face up: the weight is `(N·up · ½ + ½)^upward`, so
   * 0 is no lean. 0.4 unless given.
   */
  readonly upward?: number;
  /** The exponent the whole edge is raised to. 1 unless given. */
  readonly contrast?: number;
  /** A noise image laid in screen space and scrolled, the rim taken times it, clamped to 1. */
  readonly noise?: {
    readonly region: OverlayRegion;
    /** Screens a second, along x and y. */
    readonly scroll?: readonly [number, number];
    /** Repeats across the screen's height. 1 unless given. */
    readonly tiling?: number;
  };
  /** A pulse `½ + ½ sin(rate · t)`, held between `low` and `high`, on `Environment.surfaceTime`. */
  readonly pulse?: { readonly rate: number; readonly low: number; readonly high: number };
  /** A mask in the mesh's uv where the rim is erased: the rim times `1 - weight · mask`. */
  readonly mask?: { readonly region: OverlayRegion; readonly weight: number };
}

/**
 * The surface cut away where a noise in its uv falls under `threshold`, with a glowing band just
 * above it, and a colour laid over the surface through the same noise.
 */
export interface SurfaceDissolve {
  readonly noise: { readonly region: OverlayRegion; readonly tiling?: readonly [number, number] };
  /** 0 keeps everything; 1 cuts everything. */
  readonly threshold: number;
  /** The band's width, in the noise's own units. 0.05 unless given. */
  readonly edge?: number;
  /** The band's light. */
  readonly edgeColour?: Vec3;
  readonly edgeIntensity?: number;
  /** A colour laid over the surface through the noise, as light, and how much of it. */
  readonly overlay?: { readonly colour: Vec3; readonly amount: number };
}

/**
 * A second normal map blended into the surface's by six region weights, read through two masks:
 * the first mask's red, green and blue carry regions 1 to 3, the second's regions 4 to 6. A face's
 * expressions, or veins brought up all over.
 */
export interface SurfaceWrinkle {
  readonly normal: OverlayRegion;
  readonly masks: readonly [OverlayRegion, OverlayRegion];
  readonly weights: readonly [number, number, number, number, number, number];
}

/**
 * What a draw lays over its surface beyond its material, for `setSurfaceOverlay`: a rim, a dissolve
 * and wrinkles, each optional, and the atlas their images are regions of.
 */
export interface SurfaceOverlay {
  /**
   * The atlas every image above is a region of. Absent: no image is read whatever regions are
   * named — rims are smooth, nothing dissolves and nothing wrinkles — because the slot then holds a
   * stand-in whose colour would read as a noise and a mask.
   */
  readonly maps?: SurfaceTextureHandle;
  readonly rim?: SurfaceRim;
  readonly dissolve?: SurfaceDissolve;
  readonly wrinkle?: SurfaceWrinkle;
}

/** Vectors the overlay takes in the material's block: `uOverlay[OVERLAY_VECTORS]`. */
export const OVERLAY_VECTORS = 15;
/** Floats `packSurfaceOverlay` fills. */
export const OVERLAY_FLOATS = OVERLAY_VECTORS * 4;

const finite = (value: number | undefined, fallback: number): number =>
  value !== undefined && Number.isFinite(value) ? value : fallback;

function region(out: Float32Array, at: number, r: OverlayRegion | undefined | null): void {
  out[at] = finite(r?.scale[0], 0);
  out[at + 1] = finite(r?.scale[1], 0);
  out[at + 2] = finite(r?.offset[0], 0);
  out[at + 3] = finite(r?.offset[1], 0);
}

/**
 * An overlay as the shader reads it, into `out` (`OVERLAY_FLOATS`); all zeros for `null`, which is
 * no overlay. A region with a zero scale is an image not given, and its term reads as none — a
 * noise of 1, a mask of 0, no wrinkle — and every region is one without `maps`. Fifteen vectors:
 *
 * - 0: rim colour, rim strength (intensity times alpha; 0 is no rim)
 * - 1: falloff, upward lean, contrast, mask weight
 * - 2: the rim's noise region; 3: its scroll along x and y, its tiling, the pulse's rate
 * - 4: the pulse's low and high (1 and 1 where none)
 * - 5: the rim's mask region
 * - 6: the dissolve's noise region (a zero scale is no dissolve); 7: its tiling, threshold, edge
 * - 8: the edge's light and its strength; 9: the laid-over colour and its amount
 * - 10: the wrinkle normal's region; 11 and 12: the two masks'; 13 and 14: the six weights
 */
export function packSurfaceOverlay(overlay: SurfaceOverlay | null, out: Float32Array): void {
  out.fill(0);
  if (overlay === null) return;
  /* No atlas, no region: see `SurfaceOverlay.maps`. */
  const images = overlay.maps !== undefined;
  const rim = overlay.rim;
  if (rim !== undefined) {
    out[0] = finite(rim.colour[0], 0);
    out[1] = finite(rim.colour[1], 0);
    out[2] = finite(rim.colour[2], 0);
    out[3] = Math.max(0, finite(rim.intensity, 0) * finite(rim.alpha, 1));
    out[4] = Math.max(0, finite(rim.falloff, 1.5));
    out[5] = Math.max(0, finite(rim.upward, 0.4));
    out[6] = Math.max(0, finite(rim.contrast, 1));
    out[7] = rim.mask === undefined ? 0 : Math.min(Math.max(finite(rim.mask.weight, 0), 0), 1);
    region(out, 8, images ? rim.noise?.region : null);
    out[12] = finite(rim.noise?.scroll?.[0], 0);
    out[13] = finite(rim.noise?.scroll?.[1], 0);
    out[14] = Math.max(0, finite(rim.noise?.tiling, 1));
    out[15] = finite(rim.pulse?.rate, 0);
    out[16] = rim.pulse === undefined ? 1 : finite(rim.pulse.low, 1);
    out[17] = rim.pulse === undefined ? 1 : finite(rim.pulse.high, 1);
    region(out, 20, images ? rim.mask?.region : null);
  }
  const dissolve = overlay.dissolve;
  if (dissolve !== undefined) {
    region(out, 24, images ? dissolve.noise.region : null);
    out[28] = finite(dissolve.noise.tiling?.[0], 1);
    out[29] = finite(dissolve.noise.tiling?.[1], 1);
    out[30] = Math.min(Math.max(finite(dissolve.threshold, 0), 0), 1);
    out[31] = Math.max(1e-4, finite(dissolve.edge, 0.05));
    const edge = dissolve.edgeColour ?? [0, 0, 0];
    out[32] = finite(edge[0], 0);
    out[33] = finite(edge[1], 0);
    out[34] = finite(edge[2], 0);
    out[35] = Math.max(0, finite(dissolve.edgeIntensity, 1));
    const laid = dissolve.overlay;
    if (laid !== undefined) {
      out[36] = finite(laid.colour[0], 0);
      out[37] = finite(laid.colour[1], 0);
      out[38] = finite(laid.colour[2], 0);
      out[39] = Math.max(0, finite(laid.amount, 0));
    }
  }
  const wrinkle = overlay.wrinkle;
  if (wrinkle !== undefined) {
    region(out, 40, images ? wrinkle.normal : null);
    region(out, 44, images ? wrinkle.masks[0] : null);
    region(out, 48, images ? wrinkle.masks[1] : null);
    for (let i = 0; i < 6; i++) {
      out[52 + i] = Math.min(Math.max(finite(wrinkle.weights[i], 0), 0), 1);
    }
  }
}

/** Whether an overlay lays anything at all, so a renderer can leave the lit switch off. */
export function overlayLays(overlay: SurfaceOverlay | null): boolean {
  return (
    overlay !== null &&
    (overlay.rim !== undefined || overlay.dissolve !== undefined || overlay.wrinkle !== undefined)
  );
}
