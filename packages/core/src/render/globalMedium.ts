/**
 * A medium filling the whole frustum: what a caller may say about it, and what that resolves to.
 *
 * **Here rather than in either renderer, for the reason `lightVolumeDraw.ts` states at its own
 * top**: two copies of a clamp is a fog that thins on one backend and not the other, and nothing
 * raises, because either frame is a plausible one. Everything in this file is arithmetic both
 * backends run before they bind anything.
 *
 * The pass this feeds is described in `shaders/globalMedium.ts`. The short version of why it is
 * not `atmosphere.ts`: distance fog asks how much of a *surface* survives the journey to the eye,
 * and this asks what the journey adds — which is every point along it the sun can see, and is the
 * only one of the two that can put the shape of a doorway on a floor.
 */

import type { Vec3 } from '../math/color.ts';
import type { FogLayer } from './atmosphere.ts';
import { MAX_POINT_LIGHTS } from './lightBudget.ts';
import type { ResolvedPointLights } from './lightBudget.ts';
import type { ResolvedPointShadows } from './pointShadowImage.ts';

/**
 * The most steps a march may take, which is the shader's own loop bound.
 *
 * **Here rather than beside the GLSL, and the reason is bundle size rather than tidiness.**
 * `renderQuality.ts` clamps against this and is imported by everything; importing one integer out
 * of the shader module would carry seventeen kilobytes of shader text into every consumer's
 * bundle, tree-shaken or not. The engine has paid that once already — see
 * `docs/IMPROVEMENTS.md` on a constant imported from an offline module.
 *
 * Sixty-four is well past useful: at that count the step is centimetres across a room, and the
 * picture stopped changing somewhere around a third of it.
 */
export const MAX_GLOBAL_MEDIUM_STEPS = 64;

/**
 * The most steps a part `isWeakGpuFamily` names gets, whatever the profile asked for.
 *
 * **The march is the only ceiling in `RenderQuality` that is a per-pixel loop**, so it is the one
 * a weak part gains most from having lowered and the one a settings screen would otherwise have to
 * know about by name. Sixteen still resolves a shaft across a room; what it gives up is the
 * smoothness of a long march through a low sun, which is where the banding a step count buys off
 * actually lives.
 *
 * A floor and not a verdict, like the two clamps beside it: `capabilityClamp: false` means "this
 * person chose these numbers themselves", and a player who asks a weak part for a thick fog is
 * entitled to it and to the frame rate that comes with it.
 */
export const WEAK_GPU_MEDIUM_STEPS = 16;

/**
 * The most lamps the march lights the medium with, which is the lit stage's own per-pixel set:
 * the lamps a frame shades with uniforms, each with the shadow it already has.
 */
export const MAX_MEDIUM_LAMPS = MAX_POINT_LIGHTS;

/**
 * How thick the air is, this frame.
 *
 * A per-frame dial and not a quality setting, in the split `renderQuality.ts` draws for depth of
 * field: what a device can afford is `globalMediumSteps`, and what the weather is doing is this.
 * A game walks into a fog bank; a profile decides how expensive being in one is allowed to be.
 */
export interface GlobalMediumOptions {
  /**
   * Extinction per metre. **0 is off, and off is free** — no target is allocated, no pass is
   * built and the composite is skipped, so a game that never sets this pays nothing at all.
   *
   * As a scale: 0.02 leaves a wall at 50 m about a third obscured, 0.1 is thick weather, and
   * above about 0.5 nothing is visible past a room.
   */
  readonly density: number;
  /**
   * How much of what the medium takes out of a ray comes back as light rather than as heat, 0 to 1,
   * or a colour, a share a channel.
   *
   * Near 1 for water droplets, which is fog, cloud and steam; lower for smoke, which is soot and
   * absorbs most of what it intercepts. It is the difference between a white fog that a torch
   * lights up and a black smoke that swallows the same torch. A colour is a medium that keeps more
   * of one light than another: a faintly blue haze returns the sky's blue a little more readily.
   */
  readonly albedo: number | Vec3;
  /**
   * Henyey-Greenstein anisotropy, -1 back to 1 forward. 0 is isotropic.
   *
   * **This is the term that makes a medium read as weather rather than as a grey wash.** Real haze
   * is strongly forward-scattering, which is why the air around a low sun glows and the same air
   * behind the viewer does not. Around 0.6 for atmospheric haze; 0 for a medium with nothing
   * directional about it at all.
   */
  readonly anisotropy: number;
  /**
   * Where the medium ends, in metres: past it the air neither scatters nor absorbs.
   *
   * **This said extinction went on past it, and the march never did that**: it integrates from
   * the eye to here or to the surface, whichever is nearer, and nothing after. Which is what a
   * medium standing for the near part of the environment's haze wants: the haze takes the rest of
   * the ray when its `fogStart` is this distance, and the two never lay one stretch of air twice.
   * **What it gives up** is a medium of its own beyond the reach, which the haze has to be.
   */
  readonly maxDistance: number;
  /**
   * Reciprocal scale height, per metre: `density` is the extinction at `baseY`, thinning above it
   * as the haze does (`Atmosphere.fogHeightFalloff`). Absent or 0, the medium is as thick
   * everywhere, as it always was.
   */
  readonly heightFalloff?: number;
  /** The height `density` is measured at. Default 0. */
  readonly baseY?: number;
  /**
   * A second layer, summed with the first, its own density at its own height thinning by its own
   * falloff: `Atmosphere.fogLayer2`'s shape, so a medium standing for the near part of a two-layer
   * haze can be that haze.
   */
  readonly layer2?: FogLayer | null;
  /** How strongly the sun scatters in it, as a share of how strongly it lights a surface. Default 1. */
  readonly sunScatter?: number;
  /** The same for the sky's fill, which lights a shadowed medium from every side. Default 1. */
  readonly skyScatter?: number;
  /**
   * The same for the lamps, each through its own shadow and times its own `lightMediumScatter`.
   * **Default 0**: a medium was the sun's and the sky's until there was this, and a scene that
   * never asks keeps that picture and that cost. The lamps are the lit stage's per-pixel set,
   * shaped by their cones; a photometric profile and a cookie shape the pool on a surface and not
   * the shaft in the air.
   */
  readonly lampScatter?: number;
}

/** A medium with every field filled in and clamped: what both backends' passes are handed. */
export interface ResolvedGlobalMedium {
  readonly density: number;
  /** A colour, three shares. */
  readonly albedo: readonly [number, number, number];
  readonly anisotropy: number;
  readonly maxDistance: number;
  readonly heightFalloff: number;
  readonly baseY: number;
  /** The second layer's density at its own height, 0 for none, its falloff and that height. */
  readonly density2: number;
  readonly heightFalloff2: number;
  readonly baseY2: number;
  readonly sunScatter: number;
  readonly skyScatter: number;
  readonly lampScatter: number;
}

/**
 * What a renderer starts with: off, and everything else at a value that means "ordinary air".
 *
 * The three settings beside `density` are never consulted while it is zero, so they are chosen to
 * make `setGlobalMedium(0.02)`-shaped calls — one number, the rest defaulted — land somewhere
 * recognisable rather than on a black isotropic soup.
 */
export const DEFAULT_GLOBAL_MEDIUM: GlobalMediumOptions = {
  density: 0,
  albedo: 0.9,
  anisotropy: 0.6,
  maxDistance: 200,
};

/**
 * A caller's numbers, clamped to what the shader can be handed.
 *
 * **Every bound here is a picture rather than a guard.** A negative density is `exp(+x)` and a
 * frame that grows brighter with distance; an anisotropy of exactly 1 or -1 divides the phase
 * function by zero, which is a NaN that a half-float target spreads over the whole screen rather
 * than reporting; a `maxDistance` of zero is a march with no length that still costs its steps.
 */
export function resolveGlobalMedium(options: Partial<GlobalMediumOptions>): ResolvedGlobalMedium {
  const d = DEFAULT_GLOBAL_MEDIUM;
  const albedo = options.albedo ?? d.albedo;
  const share = (value: number | undefined): number =>
    Math.min(1, Math.max(0, Number.isFinite(value) ? (value as number) : 0));
  const layer2 = options.layer2 ?? null;
  const density2 = layer2 === null ? 0 : Math.max(0, layer2.density);
  const finite = (value: number | undefined, fallback: number): number =>
    value !== undefined && Number.isFinite(value) ? value : fallback;
  return {
    density: Math.max(0, options.density ?? d.density),
    albedo:
      typeof albedo === 'number'
        ? [share(albedo), share(albedo), share(albedo)]
        : [share(albedo[0]), share(albedo[1]), share(albedo[2])],
    /* Short of the poles, where `(1 - g^2)` over `(1 + g^2 - 2g)^1.5` is 0/0. */
    anisotropy: Math.min(0.95, Math.max(-0.95, options.anisotropy ?? d.anisotropy)),
    maxDistance: Math.max(1e-3, options.maxDistance ?? d.maxDistance),
    heightFalloff: finite(options.heightFalloff, 0),
    baseY: finite(options.baseY, 0),
    density2,
    heightFalloff2: layer2 === null ? 0 : finite(layer2.heightFalloff, 0),
    baseY2: layer2 === null ? 0 : finite(layer2.baseY, 0),
    sunScatter: Math.max(0, finite(options.sunScatter, 1)),
    skyScatter: Math.max(0, finite(options.skyScatter, 1)),
    lampScatter: Math.max(0, finite(options.lampScatter, 0)),
  };
}

/** `setGlobalMedium`'s object form: a density, and any of the rest. */
export type GlobalMediumSettings = Partial<GlobalMediumOptions> & { readonly density: number };

/**
 * `setGlobalMedium`'s two forms, its four numbers or the object, read one way for both backends:
 * a density that is not a number is none.
 */
export function resolveGlobalMediumSettings(
  density: number | GlobalMediumSettings,
  albedo?: number | Vec3,
  anisotropy?: number,
  maxDistance?: number,
): ResolvedGlobalMedium {
  if (typeof density === 'object') {
    return resolveGlobalMedium({
      ...density,
      density: Number.isFinite(density.density) ? density.density : 0,
    });
  }
  return resolveGlobalMedium({
    density: Number.isFinite(density) ? density : 0,
    albedo,
    anisotropy,
    maxDistance,
  });
}

/**
 * Whether this frame draws the medium at all.
 *
 * Both halves, in one place, because both backends have to agree about it exactly: the claim that
 * `density: 0` is pixel-identical to the pass being absent is only true if neither backend runs a
 * composite at zero, and a second copy of this test is where that stops being true.
 */
export function mediumActive(
  options: Pick<GlobalMediumOptions, 'density'>,
  steps: number,
): boolean {
  return options.density > 0 && steps > 0;
}

/**
 * The march's target size.
 *
 * **Half each way is a quarter of the march, which is the whole reason a global medium is
 * affordable.** A step is a shadow lookup and an exponential, tens of times a pixel, where an
 * occlusion tap is one depth fetch — which is why `ambientOcclusionPass.ts` can run at the frame's
 * own size and this cannot. What half resolution costs is bought back by the upsample, which is
 * depth-aware precisely because the one place a half-res medium is visible is a silhouette.
 *
 * Rounded up, never below one: a frame one pixel tall halved is zero, and a zero-height target is
 * refused by both backends at creation.
 */
export function mediumTargetSize(
  width: number,
  height: number,
  halfResolution: boolean,
): { width: number; height: number } {
  const divisor = halfResolution ? 2 : 1;
  return {
    width: Math.max(1, Math.ceil(Math.max(1, width) / divisor)),
    height: Math.max(1, Math.ceil(Math.max(1, height) / divisor)),
  };
}

/**
 * The lamps as the march reads them: eight vectors a lamp, each array `MAX_MEDIUM_LAMPS` of them.
 *
 * **Decided here and bound twice**, on the split `resolvePointLights` draws: which lamps light the
 * medium, how bright and through which maps is arithmetic both backends run, and a backend only
 * uploads the arrays. A lamp's shadows are the lit stage's own, the static map and the live one,
 * read where the frame left them, so the shaft in the air and the pool on the floor are cut by the
 * same casters.
 */
export interface ResolvedMediumLamps {
  /** How many lamps light the medium: none while `lampScatter` is 0. */
  count: number;
  /** 1 for inverse-square, 0 for the smooth falloff: the frame's own rule. */
  falloff: number;
  /** Where each lamp is, and how far it reaches. */
  readonly position: Float32Array;
  /** Its colour, times its presence and its scatter, and its own falloff exponent (0 for none). */
  readonly color: Float32Array;
  /** The direction it shines, a spot's axis: `lightDirections`. */
  readonly aim: Float32Array;
  /** Its cone's two cosines, inner and outer, as the lit stage takes them. */
  readonly cone: Float32Array;
  /** Its static shadow: the layer (−1 for none), the near plane, and how present the map is. */
  readonly shadow: Float32Array;
  /** The static map's projection: its origin and its far plane. */
  readonly shadowAt: Float32Array;
  /** Its live shadow, by the same layout, and the live map's projection. */
  readonly live: Float32Array;
  readonly liveAt: Float32Array;
}

/** A target for `resolveMediumLamps`, made once outside the frame loop. */
export function createResolvedMediumLamps(): ResolvedMediumLamps {
  const vectors = (): Float32Array => new Float32Array(MAX_MEDIUM_LAMPS * 4);
  return {
    count: 0,
    falloff: 0,
    position: vectors(),
    color: vectors(),
    aim: vectors(),
    cone: vectors(),
    shadow: vectors(),
    shadowAt: vectors(),
    live: vectors(),
    liveAt: vectors(),
  };
}

/**
 * The frame's lamps as the medium is lit by them, into `out`: the lit stage's resolved lamps and
 * their resolved shadows, a lamp's scatter `lampScatter` times its own `lightMediumScatter` (1 where
 * absent). Allocates nothing; a lamp past the count keeps whatever it held, which nothing reads.
 */
export function resolveMediumLamps(
  medium: ResolvedGlobalMedium,
  lights: ResolvedPointLights,
  shadows: ResolvedPointShadows | null,
  scatter: Float32Array | undefined,
  out: ResolvedMediumLamps,
): ResolvedMediumLamps {
  const count = medium.lampScatter > 0 ? Math.min(lights.count, MAX_MEDIUM_LAMPS) : 0;
  out.count = count;
  out.falloff = lights.falloff;
  const own = scatter !== undefined && scatter.length >= count ? scatter : undefined;
  for (let i = 0; i < count; i++) {
    const at = i * 4;
    const strength =
      medium.lampScatter * Math.max(0, own?.[i] ?? 1) * (lights.weights[i] as number);
    for (let c = 0; c < 3; c++) {
      out.position[at + c] = lights.positions[i * 3 + c] as number;
      out.color[at + c] = (lights.colors[i * 3 + c] as number) * strength;
      out.aim[at + c] = lights.directions[i * 3 + c] as number;
    }
    out.position[at + 3] = lights.radii[i] as number;
    out.color[at + 3] = lights.conesAndFalloffs[at + 2] as number;
    out.aim[at + 3] = 0;
    out.cone[at] = lights.conesAndFalloffs[at] as number;
    out.cone[at + 1] = lights.conesAndFalloffs[at + 1] as number;
    out.cone[at + 2] = 0;
    out.cone[at + 3] = 0;
    out.shadow[at] = shadows === null ? -1 : (shadows.layers[i] as number);
    out.shadow[at + 1] = shadows === null ? 0 : (shadows.near[i] as number);
    out.shadow[at + 2] = shadows === null ? 0 : (shadows.presence[i] as number);
    out.shadow[at + 3] = 0;
    out.live[at] = shadows === null ? -1 : (shadows.liveLayers[i] as number);
    out.live[at + 1] = shadows === null ? 0 : (shadows.liveNear[i] as number);
    out.live[at + 2] = shadows === null ? 0 : (shadows.liveWeights[i] as number);
    out.live[at + 3] = 0;
    for (let k = 0; k < 4; k++) {
      out.shadowAt[at + k] = shadows === null ? 1 : (shadows.projections[at + k] as number);
      out.liveAt[at + k] = shadows === null ? 1 : (shadows.liveProjections[at + k] as number);
    }
  }
  return out;
}
