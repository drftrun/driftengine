/**
 * How rough the sea is for a given wind.
 *
 * Wind does not push existing waves around — it *builds* them. A calm sea is
 * nearly flat with no whitecaps; a strong wind raises steep crests that break.
 * Steering the swell without changing its size would leave the water equally
 * choppy in a dead calm and a gale, which is the giveaway that the weather is
 * decoration rather than a cause.
 */
export interface SeaState {
  /** Multiplier on the Gerstner steepness the surface was authored with. */
  steepness: number;
  /** How readily crests break into foam, 0 for none. */
  foam: number;
}

/**
 * Wind speed at which the sea is fully developed. Beyond it, waves stop
 * growing — a real fetch-limited sea saturates, and more importantly the
 * islands sit about 1.8 m above the waterline, so an unbounded swell would
 * flood the route and turn weather into a movement bug.
 */
const FULLY_DEVELOPED = 7;
/** Never completely flat: dead-still water reads as glass, not as calm. */
const MINIMUM_STEEPNESS = 0.35;
const MAXIMUM_STEEPNESS = 1.35;
/** Whitecaps need real wind; ripples do not break. */
const FOAM_THRESHOLD = 2.5;

export function seaStateForWind(windSpeed: number): SeaState {
  const t = Math.min(Math.max(windSpeed, 0) / FULLY_DEVELOPED, 1);
  return {
    steepness: MINIMUM_STEEPNESS + (MAXIMUM_STEEPNESS - MINIMUM_STEEPNESS) * t,
    foam: Math.min(
      Math.max((windSpeed - FOAM_THRESHOLD) / (FULLY_DEVELOPED - FOAM_THRESHOLD), 0),
      1,
    ),
  };
}

/**
 * The same surface state, asked for directly instead of derived from wind.
 *
 * Shares this module's floor and ceiling so an indoor body and an outdoor one at the
 * same roughness look the same — the point is where the number *comes from*, not a
 * second scale with its own feel. Foam is deliberately reachable: a sluice or a pump
 * outfall breaks without any wind at all.
 */
export function seaStateForAgitation(agitation: number): SeaState {
  const t = Math.min(Math.max(agitation, 0), 1);
  return {
    steepness: MINIMUM_STEEPNESS + (MAXIMUM_STEEPNESS - MINIMUM_STEEPNESS) * t,
    foam: Math.min(Math.max((t - 0.55) / 0.45, 0), 1),
  };
}
