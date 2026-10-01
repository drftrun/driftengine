/**
 * How the district's lights are judged at night: a gain for each kind of light, and how far each
 * light then reaches. Read by the bake, which sums the judged lights into the volume, and by the
 * runtime, which shades the near ones exactly — the two must judge alike, or the light changes
 * where the exact ones hand over to the volume.
 *
 * **The intensities are the source's own arithmetic** (`bake/lights.ts`): what a glowing surface
 * of that size and strength sheds. A gain is the look — how much of that a night in this district
 * shows — and it is the only place one enters. Lamps are judged up the furthest, because the
 * source models a road lamp's lens a few centimetres across at a strength a lens never has, and a
 * street at night is lit by its lamps first; a shop's ceiling is already large and is left nearer
 * what it says. Settled by eye on a street under a deck at night, between twenty, where the shops
 * are lit and the road is black, and a hundred and fifty, where the walls by every lamp are white.
 *
 * **A light reaches as far as it is worth shading**: inverse-square, it is `FLOOR` at
 * `sqrt(intensity / FLOOR)`, and the falloff is windowed to nought there. So a small light is a
 * small pool and costs a small slice of the clusters, and nothing is cut while still bright. What
 * would make it wrong is a floor high enough to see the edge of a pool, which on a dark street is
 * the first thing to look at.
 */

/** What a light is, carried in its LITE name as `night:<kind>`. */
export type LightKind = 'lamp' | 'neon' | 'screen' | 'plain' | 'source';

export const KIND_GAIN: Readonly<Record<LightKind, number>> = {
  lamp: 40,
  neon: 25,
  screen: 2,
  plain: 20,
  source: 1,
};

/**
 * The intensity at which a light is no longer worth shading, in LITE units: about a sixtieth of a
 * street lamp's pool. Lower, every light reaches forty metres, the exact choice is complete nowhere
 * and the volume — which is diffuse and draws no lamp in a wet street — stands in for all of them.
 */
const FLOOR = 0.06;
/**
 * A light no stronger than this, in LITE units: a fixture is never a floodlight. Judged at the
 * street from a few metres; a light on a wall at sixty lit the wall white for a storey either side.
 */
const CEILING = 20;
const REACH_MIN = 1;
const REACH_MAX = 40;

/** The kind a LITE name states, or `source` for a name that states none. */
export function kindOfLight(name: string): LightKind {
  const kind = name.startsWith('night:') ? name.slice(6) : '';
  return kind === 'lamp' || kind === 'neon' || kind === 'screen' || kind === 'plain'
    ? kind
    : 'source';
}

/** A light's intensity as the night judges it. */
export function judged(
  kind: LightKind,
  intensity: number,
  gains: Readonly<Record<LightKind, number>> = KIND_GAIN,
): number {
  return Math.min(CEILING, intensity * gains[kind]);
}

/** How far a light of judged `intensity` is shaded, metres. */
export function reachOf(intensity: number): number {
  return Math.min(REACH_MAX, Math.max(REACH_MIN, Math.sqrt(intensity / FLOOR)));
}
