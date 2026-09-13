/**
 * One wind, sampled by everything that moves in it.
 *
 * Grass, foliage, smoke, clouds and water all bend to weather. If each system
 * animates on its own noise they disagree — smoke drifting one way while grass
 * leans another is the single clearest tell that a scene is a collection of
 * effects rather than a place. So the signal lives here, once, and every
 * consumer samples it.
 *
 * Cyclic by construction: the sum of a fundamental and integer harmonics
 * repeats exactly at the fundamental's period. That matters because a run is
 * recorded and replayed — a replay watched an hour later must see the same gust
 * the character did, and a signal that drifts cannot offer that.
 *
 * Game-agnostic: a profile carries no date, no biome, no game-specific meaning.
 */
export interface WindProfile {
  /** Prevailing direction; normalised on sampling, so any non-zero pair works. */
  directionX: number;
  directionZ: number;
  /** Speed with no gust, in metres per second. */
  baseSpeed: number;
  /** Peak deviation from the base, either way. */
  gustSpeed: number;
  /** How far the direction swings from prevailing, radians. */
  directionWander: number;
  /** Period after which the whole signal repeats exactly. */
  cycleSeconds: number;
  /** Offset into the cycle, so two profiles are not in lockstep. */
  phase: number;
}

export interface WindState {
  velocityX: number;
  velocityZ: number;
  /** Magnitude of the velocity, always non-negative. */
  speed: number;
  /** Gust component alone, -1..1, for effects that want the deviation. */
  gust: number;
}

export function createWindState(): WindState {
  return { velocityX: 0, velocityZ: 0, speed: 0, gust: 0 };
}

/**
 * Sample the profile at a time. Writes into `out` and allocates nothing — this
 * runs every frame for every system that cares about weather.
 */
export function sampleWind(profile: WindProfile, timeSeconds: number, out: WindState): void {
  if (!(profile.cycleSeconds > 0)) {
    throw new Error('WindProfile.cycleSeconds must be positive');
  }

  const fundamental = (Math.PI * 2) / profile.cycleSeconds;
  const t = timeSeconds + profile.phase;

  /*
   * Integer harmonics only. A non-integer multiple would give a signal that
   * looks organic but never actually closes, so a replay hours later would show
   * different weather from the run it is replaying.
   */
  const a = Math.sin(fundamental * t);
  const b = Math.sin(fundamental * 2 * t + 1.1);
  const c = Math.sin(fundamental * 3 * t + 2.7);

  // Weights sum to 1, so the gust stays inside ±gustSpeed however the
  // harmonics happen to line up.
  const gust = a * 0.55 + b * 0.3 + c * 0.15;
  const speed = Math.max(0, profile.baseSpeed + gust * profile.gustSpeed);

  const baseAngle = Math.atan2(profile.directionZ, profile.directionX);
  const angle = baseAngle + (b * 0.6 + c * 0.4) * profile.directionWander;

  out.gust = gust;
  out.speed = speed;
  out.velocityX = Math.cos(angle) * speed;
  out.velocityZ = Math.sin(angle) * speed;
}
