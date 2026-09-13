/**
 * Visible wind: how much of it to show, where it has drifted to, and its lattice.
 *
 * **Three rules and one geometry, held once for both backends.** Each of them is the kind of
 * thing a second implementation gets *nearly* right, which is the failure mode `AGENTS.md`
 * 2026-08-13 is about: debris that thins in at a different wind speed, or travels at a
 * different rate from the clouds, is weather that does not cohere, and nothing raises.
 */

/** What the caller wants of a lattice, before any of it reaches the device. */
export interface WindStreakSettings {
  /** How many streaks the lattice holds. */
  count?: number;
  /** Side of the box that follows the camera, metres. */
  cellSize?: number;
  /** Wind speed at which streaks begin to appear. */
  onsetSpeed?: number;
  /** Wind speed at which they are at full strength. */
  fullSpeed?: number;
}

/**
 * The defaults, in one place because two copies is two thresholds.
 *
 * Calibrated against the wind the game actually produces rather than against a
 * plausible-sounding number. An early pass used an onset of 3.4 and full strength at 8 while
 * the windiest day of the year peaked at 7.3, so the effect would have shipped essentially
 * invisible. Raised again afterwards: at the lower onset it showed on ordinary breezy days,
 * where visible debris is not what a breeze looks like. It belongs to storms, which is also the
 * only time it is telling the player anything.
 */
export const WIND_STREAK_DEFAULTS = {
  count: 520,
  cellSize: 110,
  onsetSpeed: 6,
  fullSpeed: 11,
} as const;

/**
 * How far the debris field trails the wind's own accumulated drift.
 *
 * Debris rides the same drift the clouds do, multiplied, so near and far weather travel
 * together instead of at two unrelated rates. A second copy of this number is exactly that
 * disagreement, and it would read as the sky and the air being blown by different winds.
 */
const DRIFT_GAIN = 14;

/** Six vertices a streak, as two triangles. Shared so both backends build one lattice. */
export const WIND_STREAK_CORNERS: readonly (readonly [number, number])[] = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, -1],
  [1, 1],
  [-1, 1],
];

/** The two static attribute streams a lattice is drawn from: the corner, and which streak. */
export interface WindStreakLattice {
  readonly corners: Float32Array;
  readonly indices: Float32Array;
  readonly vertexCount: number;
}

/**
 * Build the lattice for `count` streaks.
 *
 * Nothing here is per frame: the whole effect is a repeating box that follows the camera and
 * wraps, computed in the vertex shader from an index and the clock, so this runs once and the
 * frame loop uploads nothing.
 */
export function buildWindStreakLattice(count: number): WindStreakLattice {
  const perStreak = WIND_STREAK_CORNERS.length;
  const corners = new Float32Array(count * perStreak * 2);
  const indices = new Float32Array(count * perStreak);
  let c = 0;
  let i = 0;
  for (let streak = 0; streak < count; streak++) {
    for (const corner of WIND_STREAK_CORNERS) {
      corners[c++] = corner[0];
      corners[c++] = corner[1];
      indices[i++] = streak;
    }
  }
  return { corners, indices, vertexCount: count * perStreak };
}

/** What one frame's draw needs beyond the camera and the tint. */
export interface ResolvedWindStreaks {
  /** How visible the wind is right now, 0 to 1. */
  strength: number;
  /** Where the field has drifted to, in metres. */
  driftX: number;
  driftZ: number;
  /** Whether the draw is worth making at all. A calm day costs no draw, not a faded one. */
  visible: boolean;
}

export function createResolvedWindStreaks(): ResolvedWindStreaks {
  return { strength: 0, driftX: 0, driftZ: 0, visible: false };
}

/** How visible the wind is at one speed. Its own function because callers size budgets on it. */
export function windStreakStrength(speed: number, onsetSpeed: number, fullSpeed: number): number {
  const t = (speed - onsetSpeed) / Math.max(fullSpeed - onsetSpeed, 1e-4);
  return Math.min(Math.max(t, 0), 1);
}

/**
 * Settle a frame's streaks into a target the caller owns.
 *
 * **`submerged` is decided by the engine and not by the call site.** Every pass already knows
 * where the waterline is, and leaving it to each caller is how one of them ends up raining dust
 * into the sea. Nothing blows through water: it is the kind of detail that, once noticed,
 * cannot be unnoticed.
 */
export function resolveWindStreaks(
  speed: number,
  driftX: number,
  driftZ: number,
  onsetSpeed: number,
  fullSpeed: number,
  submerged: boolean,
  out: ResolvedWindStreaks,
): ResolvedWindStreaks {
  out.strength = windStreakStrength(speed, onsetSpeed, fullSpeed);
  out.driftX = driftX * DRIFT_GAIN;
  out.driftZ = driftZ * DRIFT_GAIN;
  out.visible = !submerged && out.strength > 0.001;
  return out;
}
