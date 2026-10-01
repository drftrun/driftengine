/**
 * Where the drones work: their depots, fenced yards on open lots, and their drop pads, discs set
 * into the pavements.
 *
 * The scripts give the counts, the yard's size and where its lamps and beacon stand, and leave
 * placing them to the host, so the rules are ours. **A depot stands on a vacant lot its yard fits,
 * the depots as far apart as the lots allow**: the first on the lot farthest from the centre, each
 * next on the lot farthest from every depot already placed — no draw, so the yards never move with
 * a seed. **A pad stands mid-pavement on a run drawn by its length**, facing the road, at least
 * `spacing` from every other pad and `clear` from every pole, signal and prop.
 *
 * What gives: the vacant lots are the paved squares the building styles left, so the yards stand
 * where the city had room rather than where a fleet would want them, and none stands downtown; a
 * lot a yard takes loses its square, whose centrepiece would stand through the deck.
 */
import type { Placed, SidewalkRun } from './furniture.ts';
import { roadPoint, towardRoad } from './furniture.ts';
import type { Lot } from './lots.ts';
import type { Vec2 } from './plane.ts';

/** A depot kind's numbers, as its row states them. */
export interface DepotKind {
  readonly yard: string;
  readonly beacon: string;
  readonly lamp: string;
  readonly half: number;
  readonly lampX: number;
  readonly lampY: number;
  readonly beaconX: number;
  readonly beaconY: number;
  /** The floodlight's intensity: `cfg.droneDepotLight`. */
  readonly light: number;
}

/** What a floodlight reaches: the deck and the yard below it, 12.4 m and 22 m across. Ours. */
const FLOOD_RANGE = 18;

export interface Depot {
  readonly position: Vec2;
  readonly yaw: number;
  /** The lot it stands on, paved plain around the yard in place of the square. */
  readonly lot: Lot;
}

/**
 * `count` lots a footprint `half` either way fits, each farthest from those before it, and none
 * nearer to another than `spacing`: fewer when the lots run out first.
 */
export function siteDepots(
  lots: readonly Lot[],
  count: number,
  half: number,
  spacing = 0,
): Depot[] {
  const fits = lots.filter((l) => Math.min(l.width, l.depth) >= 2 * half);
  const centre = (l: Lot): Vec2 => [
    (l.bounds.x0 + l.bounds.x1) / 2,
    (l.bounds.z0 + l.bounds.z1) / 2,
  ];
  const nearest = fits.map((l) => Math.hypot(...centre(l)));
  const out: Depot[] = [];
  while (out.length < count) {
    let best = -1;
    for (let i = 0; i < fits.length; i += 1) {
      if (
        (nearest[i] as number) > 0 &&
        (best < 0 || (nearest[i] as number) > (nearest[best] as number))
      )
        best = i;
    }
    if (best < 0 || (out.length > 0 && (nearest[best] as number) < spacing)) break;
    const lot = fits[best] as Lot;
    const at = centre(lot);
    out.push({ position: at, yaw: Math.atan2(lot.facing[0], lot.facing[1]), lot });
    for (let i = 0; i < fits.length; i += 1) {
      const [x, z] = centre(fits[i] as Lot);
      /* After the first, which the centre chose, nearest means nearest to a site already taken. */
      const d = Math.hypot(x - at[0], z - at[1]);
      nearest[i] = out.length === 1 ? d : Math.min(nearest[i] as number, d);
    }
  }
  return out;
}

/**
 * A depot's yard, its beacon on the mast and its two floodlights, as the host adds them, all
 * standing on `ground`.
 */
export function depotParts(depot: Depot, kind: DepotKind, ground: number): Placed[] {
  const c = Math.cos(depot.yaw);
  const s = Math.sin(depot.yaw);
  /* Local (x, z) turned by the yaw about +y, as a template's own Rotation3 would. */
  const at = (x: number, z: number): Vec2 => [
    depot.position[0] + c * x + s * z,
    depot.position[1] - s * x + c * z,
  ];
  const light = { intensity: kind.light, range: FLOOD_RANGE, y: ground + kind.lampY };
  const part = (template: string, p: Vec2, y: number): Placed => ({
    template,
    position: p,
    y: ground + y,
    yaw: depot.yaw,
    props: new Map(),
  });
  return [
    part(kind.yard, depot.position, 0),
    part(kind.beacon, at(kind.beaconX, kind.beaconX), kind.beaconY),
    { ...part(kind.lamp, at(kind.lampX, kind.lampX), kind.lampY), light },
    { ...part(kind.lamp, at(-kind.lampX, -kind.lampX), kind.lampY), light },
  ];
}

/**
 * `count` pads on the runs, each at least `spacing` from the others and `clear` from `furniture`,
 * standing at `y` on the pavement. Gives up after `count` × 40 draws, so a crowded city gets fewer.
 */
export function sitePads(
  runs: readonly SidewalkRun[],
  furniture: readonly Placed[],
  template: string,
  y: number,
  count: number,
  spacing: number,
  clear: number,
  random: () => number,
): Placed[] {
  const cumulative: number[] = [];
  let total = 0;
  for (const run of runs) {
    total += run.to - run.from;
    cumulative.push(total);
  }
  const out: Placed[] = [];
  const far = (p: Vec2, list: readonly { position: Vec2 }[], d: number): boolean =>
    list.every((q) => Math.hypot(q.position[0] - p[0], q.position[1] - p[1]) >= d);
  for (let tries = 0; tries < count * 40 && out.length < count && total > 0; tries += 1) {
    const pick = random() * total;
    let lo = 0;
    let hi = cumulative.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((cumulative[mid] as number) > pick) hi = mid;
      else lo = mid + 1;
    }
    const run = runs[lo] as SidewalkRun;
    const along = run.from + random() * (run.to - run.from);
    const at = roadPoint(run.road, along, (run.side * (run.kerb + run.edge)) / 2);
    if (!far(at, out, spacing) || !far(at, furniture, clear)) continue;
    const toward = towardRoad(run.road, run.side);
    out.push({
      template,
      position: at,
      y,
      yaw: Math.atan2(toward[0], toward[1]),
      props: new Map(),
    });
  }
  return out;
}
