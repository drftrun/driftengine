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
   * How much of what the medium takes out of a ray comes back as light rather than as heat, 0 to 1.
   *
   * Near 1 for water droplets, which is fog, cloud and steam; lower for smoke, which is soot and
   * absorbs most of what it intercepts. It is the difference between a white fog that a torch
   * lights up and a black smoke that swallows the same torch.
   */
  readonly albedo: number;
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
   * Where the march stops, in metres. Beyond it the medium is not sampled and nothing is added.
   *
   * A bound on the *integral*, not on the fog: extinction is still integrated over the whole
   * distance a ray travels, so a far wall behind this bound is still obscured. What stops is the
   * search for light to scatter, which is what costs — and past a few extinction lengths there is
   * no transmittance left for a sample to contribute through.
   */
  readonly maxDistance: number;
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
export function resolveGlobalMedium(options: Partial<GlobalMediumOptions>): GlobalMediumOptions {
  const d = DEFAULT_GLOBAL_MEDIUM;
  return {
    density: Math.max(0, options.density ?? d.density),
    albedo: Math.min(1, Math.max(0, options.albedo ?? d.albedo)),
    /* Short of the poles, where `(1 - g^2)` over `(1 + g^2 - 2g)^1.5` is 0/0. */
    anisotropy: Math.min(0.95, Math.max(-0.95, options.anisotropy ?? d.anisotropy)),
    maxDistance: Math.max(1e-3, options.maxDistance ?? d.maxDistance),
  };
}

/**
 * Whether this frame draws the medium at all.
 *
 * Both halves, in one place, because both backends have to agree about it exactly: the claim that
 * `density: 0` is pixel-identical to the pass being absent is only true if neither backend runs a
 * composite at zero, and a second copy of this test is where that stops being true.
 */
export function mediumActive(options: GlobalMediumOptions, steps: number): boolean {
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
