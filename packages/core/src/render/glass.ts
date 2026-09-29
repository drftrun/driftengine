/**
 * Glass: how much light a surface lets through, how milky it is, and the colour it takes.
 *
 * **A thin pane, not a volume.** Glass here is a surface that shows the scene behind it — by
 * `transmission`, blurred by `frost`, tinted — keeps its own highlight and reflection, and glows
 * with the lights behind it in proportion to how frosted it is. The one depth it has is the path
 * absorption refraction already applies (`TranslucentMeshOptions.thicknessM`). What it gives up is
 * everything a solid of glass does inside itself: a sculpture or a thick block under-darkens and
 * does not bend light twice. What would make it wrong is a scene whose glass is mostly that.
 *
 * **Zero transmission is not glass**, whatever the frost says: a surface letting nothing through is
 * opaque, and every branch the shader gates on transmission is skipped for it. This module is also
 * the reference the shader's Fresnel is held to (`schlickFresnel`), stated once in TypeScript.
 */
import type { Vec3 } from '../math/color.ts';

export interface GlassOptions {
  /** Share of light that passes, 0 (opaque) to 1 (clear). */
  readonly transmission: number;
  /** How milky, 0 (see-through) to 1 (fully diffusing: what is behind is blurred away). */
  readonly frost: number;
  /** The colour light takes through it. White, the default, is clear glass. */
  readonly tint?: Vec3;
}

/** A `GlassOptions` clamped and defaulted, in a caller-owned object so a draw allocates nothing. */
export interface ResolvedGlass {
  transmission: number;
  frost: number;
  tint: [number, number, number];
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/**
 * Resolve `options` into `out`, and say whether it is glass at all.
 *
 * Not glass — absent, or letting nothing through — zeroes `out` and tints it white, so a binder that
 * uploads `out` either way uploads the state that switches the shader's glass branch off.
 */
export function resolveGlass(options: GlassOptions | undefined, out: ResolvedGlass): boolean {
  const transmission = clamp01(options?.transmission ?? 0);
  if (options === undefined || transmission <= 0) {
    out.transmission = 0;
    out.frost = 0;
    out.tint[0] = 1;
    out.tint[1] = 1;
    out.tint[2] = 1;
    return false;
  }
  out.transmission = transmission;
  out.frost = clamp01(options.frost);
  const tint = options.tint;
  out.tint[0] = tint === undefined ? 1 : clamp01(tint[0]);
  out.tint[1] = tint === undefined ? 1 : clamp01(tint[1]);
  out.tint[2] = tint === undefined ? 1 : clamp01(tint[2]);
  return true;
}

/**
 * Schlick's Fresnel for glass, `F0 = 0.04`: the share of light a pane reflects at a view angle.
 *
 * `cosView` is clamped at 0.05, the floor the shader's path length already uses, so a silhouette
 * seen exactly edge-on is a very reflective pane rather than a division by zero.
 */
export function schlickFresnel(cosView: number): number {
  const c = Math.min(1, Math.max(0.05, cosView));
  return 0.04 + 0.96 * (1 - c) ** 5;
}

/** How much of what is behind a pane is seen through it at a view angle. */
export function glassSeenShare(transmission: number, cosView: number): number {
  return transmission * (1 - schlickFresnel(cosView));
}
