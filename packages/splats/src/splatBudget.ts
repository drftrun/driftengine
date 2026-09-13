/** How many splats a device should be asked to draw, before anybody has measured that device. */

import { isWeakGpuFamily } from '@driftengine/core';

/**
 * The count a part this engine has no evidence against is asked to draw.
 *
 * **This is an estimate and it is not measured, which is the first thing to know about it.**
 * `AGENTS.md` says fidelity is cut on a measurement and not on a fear, and the measurement that
 * settles this one is a frame time from a real mid-range Android phone drawing a real capture —
 * which this repository does not have. What is here instead is the arithmetic: a splat pass is
 * fill-bound, a splat at ±2σ covers a few dozen blended fragments, and a mid-range mobile part has
 * something under half a gigapixel a frame of blended fill at 60 Hz. Four hundred thousand splats
 * is what that budget divides into, and it is the range published mobile viewers of this technique
 * report.
 *
 * **What it costs if it is too low** is a capture thinner than the device could have drawn, which
 * is visible as a sparser cloud and nothing worse. **What would make it wrong** is a measurement,
 * in either direction, and a consumer holding one should pass its own number rather than wait for
 * this line to be corrected. `docs/IMPROVEMENTS.md` carries it as an open measurement.
 */
export const SPLAT_BUDGET_DEFAULT = 400_000;

/**
 * The count a part measured to struggle with the good profile is asked to draw.
 *
 * The same estimate against the family `isWeakGpuFamily` names — an Adreno 619 measured at 156 ms
 * a frame on this engine's desktop profile, an Adreno 710 at 112 ms, a UHD 630 unplayable
 * fullscreen. Those are three to ten times the frame time the default is reasoned against, so this
 * is the default cut by that factor rather than a second guess.
 */
export const SPLAT_BUDGET_WEAK = 120_000;

/**
 * The budget to hand `SplatSorter` when the consumer has no number of its own.
 *
 * Takes the renderer's own name — `renderer.rendererName`, which every backend answers — rather
 * than reaching for an adapter itself, because `AGENTS.md`'s rule is that a package takes a
 * platform capability as a parameter and never queries one.
 *
 * **An unknown part is not weak**, which is `isWeakGpuFamily`'s own decision and the reason it is
 * reused rather than re-tabulated here: a device table is wrong about every GPU nobody has tested,
 * and guessing weak on the unknown thins a capture for every part released after this line.
 */
export function defaultSplatBudget(rendererName?: string): number {
  if (rendererName !== undefined && isWeakGpuFamily(rendererName)) return SPLAT_BUDGET_WEAK;
  return SPLAT_BUDGET_DEFAULT;
}
