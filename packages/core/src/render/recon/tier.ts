/**
 * Which reconstruction tier a request gets.
 *
 * **Tier 0, DriftTR, is analytic** and runs wherever compute does. **Tier 2, DriftFG**, generates
 * frames between rendered ones, over tier 0.
 *
 * **Tier 1, DriftNeural, was withdrawn before 4.0.0 by the spec's own stop condition**, and a request
 * for it is tier 0 on every device. Measured (the plan's Tasks 8 and 9): a network refining the
 * finished frame averaged +0.01 dB on scenes it had not seen, and lost the one clear difference in a
 * blind comparison. The analytic tier was designed to stand without it, so this is the degradation
 * the design was built around rather than a gap in it.
 *
 * **Tier 2 used to fall to tier 0 wherever tier 1 could not run**, so that a device lacking half
 * precision could not choose frame generation over the analytic tier for a consumer who had asked
 * for the learned base. With no learned base there is nothing to choose between, and a request for
 * tier 2 is a request for exactly that. **What would make this wrong** is a learned tier that
 * measures better — a network inside the resolve rather than after it — which brings the rule back.
 */
import type { GpuCapabilities } from '../deviceFeatures.ts';

export type ReconTier = 0 | 1 | 2;

/** Whether this device can reconstruct at all: the tiers are compute dispatches. */
export function reconstructionSupported(caps: GpuCapabilities): boolean {
  return caps.indirect;
}

/** The tier a request gets, wherever `reconstructionSupported` says reconstruction runs at all. */
export function selectTier(requested: ReconTier): ReconTier {
  return requested === 1 ? 0 : requested;
}
