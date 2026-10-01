/**
 * The air taxis' skyports: free-standing towers on open lots, their deck 12 m up, placed as the
 * depots are — farthest-point over the vacant lots left once the depots have theirs — but kept the
 * reference's 460 m apart (`skyportSpacing`), so fewer stand when the lots run out.
 *
 * **The stair and the ground door face the street**: the template puts them on its −z side, so a
 * skyport is turned half round from a building on the same lot. Its pad light stands over the
 * deck's spot, as the host adds it.
 *
 * What gives: the reference wants 21 m clear about each (`skyportClear`); the open lots here are as
 * narrow as 20 m, so a tower may stand closer to its neighbours' walls than that. Its door light is
 * not placed: the scripts give it no place to stand.
 */
import type { Depot } from './drones.ts';
import type { Placed } from './furniture.ts';
import type { Vec2 } from './plane.ts';

export interface SkyportStyle {
  readonly template: string;
  readonly deck: number;
  readonly spotX: number;
  readonly spotZ: number;
  readonly padLight: string;
}

/** A pad light's reach and strength over its deck: ours, the scripts give neither. */
const PAD_LIGHT = { intensity: 13, range: 18 };

/** A skyport's tower and its pad light, standing on `ground`, its door toward the street. */
export function skyportParts(site: Depot, style: SkyportStyle, ground: number): Placed[] {
  const yaw = site.yaw + Math.PI;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const spot: Vec2 = [
    site.position[0] + c * style.spotX + s * style.spotZ,
    site.position[1] - s * style.spotX + c * style.spotZ,
  ];
  const deck = ground + style.deck;
  return [
    { template: style.template, position: site.position, y: ground, yaw, props: new Map() },
    {
      template: style.padLight,
      position: spot,
      y: deck,
      yaw,
      props: new Map(),
      light: { ...PAD_LIGHT, y: deck + 0.3 },
    },
  ];
}
