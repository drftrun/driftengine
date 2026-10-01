/**
 * Street furniture a road class decides: lamp poles and their bulbs, and signal heads at the
 * junctions — plus the sidewalk runs every later prop stage walks along.
 *
 * **Lamps follow their class's row**: `light_gap` apart, clear of each junction; a median-mounted
 * class stands one pole on the centre line with a bulb `lamp_offset` either side, and a kerbside
 * class stands poles `lamp_offset` outside the carriageway on both sides, staggered by half a gap,
 * each bulb `lamp_reach` back over the road at `lamp_y`. The bulb is its own entity and carries the
 * class's point light, as the reference's host makes it. **Signals** stand at every junction of
 * three or more roads, one per approach on the driver's right — traffic keeps right — facing the
 * traffic that comes at it.
 *
 * What gives: a pole on each side staggered is ours; the scripts give the gap and not the pattern.
 */
import type { Value } from '../script/values.ts';
import type { Vec2 } from './plane.ts';
import type { Road, RoadNetwork } from './roads.ts';

export interface Placed {
  readonly template: string;
  readonly position: Vec2;
  /** Height of the base: 0 on the ground, the roof for a roof prop. */
  readonly y: number;
  /** Turns local +z toward what it faces: the road, or oncoming traffic. */
  readonly yaw: number;
  readonly props: Map<string, Value>;
  /** A real point light the entity carries, or a glow sprite; absent for neither. */
  readonly light?: { readonly intensity: number; readonly range: number; readonly y: number };
  readonly glow?: number;
}

/** One side of one road segment, where a pedestrian walks. */
export interface SidewalkRun {
  readonly road: Road;
  /** +1 for the side the road's left normal points to, −1 for the other. */
  readonly side: 1 | -1;
  /** Along the road, clear of the junctions at both ends. */
  readonly from: number;
  readonly to: number;
  /** Distances from the centre line: the kerb, and the building line. */
  readonly kerb: number;
  readonly edge: number;
}

const yawFacing = (f: Vec2): number => Math.atan2(f[0], f[1]);

/** The point `along` the road and `across` it on `side`, and the unit normal toward that side. */
export function roadPoint(road: Road, along: number, across: number): Vec2 {
  return road.vertical ? [road.at + across, along] : [along, road.at + across];
}

/** Unit vector from a point on `side` of `road` toward its centre line. */
export function towardRoad(road: Road, side: 1 | -1): Vec2 {
  return road.vertical ? [-side, 0] : [0, -side];
}

/** The widest road crossing each junction, keyed by position, for keeping furniture clear. */
function junctionWidths(roads: RoadNetwork, closed: ReadonlySet<number>): Map<string, number> {
  const out = new Map<string, number>();
  for (const j of roads.junctions) {
    let widest = 0;
    for (const id of j.roads)
      if (!closed.has(id)) widest = Math.max(widest, roads.roads[id]?.cls.width ?? 0);
    out.set(`${Math.round(j.x)},${Math.round(j.z)}`, widest);
  }
  return out;
}

export function sidewalkRuns(roads: RoadNetwork, closed: ReadonlySet<number>): SidewalkRun[] {
  const widths = junctionWidths(roads, closed);
  const clear = (road: Road, end: number): number => {
    const [x, z] = road.vertical ? [road.at, end] : [end, road.at];
    return (widths.get(`${Math.round(x)},${Math.round(z)}`) ?? 0) / 2 + 2;
  };
  const runs: SidewalkRun[] = [];
  for (const road of roads.roads) {
    if (closed.has(road.id)) continue;
    const from = road.from + clear(road, road.from);
    const to = road.to - clear(road, road.to);
    if (to - from < 4) continue;
    const c = road.cls;
    const kerb = c.lanes * c.laneWidth + c.median / 2;
    for (const side of [1, -1] as const)
      runs.push({ road, side, from, to, kerb, edge: c.width / 2 });
  }
  return runs;
}

export function placeLamps(runs: readonly SidewalkRun[]): Placed[] {
  const out: Placed[] = [];
  for (const run of runs) {
    const r = run.road.cls.row;
    const gap = r.n('light_gap');
    const length = run.to - run.from;
    const count = Math.floor(length / gap) + 1;
    const start = run.from + (length - (count - 1) * gap) / 2;
    const median = r.n('mount_median', 0) !== 0;
    /* A median pole serves both sides: place it once, from the left run. */
    if (median && run.side === -1) continue;
    const stagger = !median && run.side === -1 ? gap / 2 : 0;
    const lamp = r.s('lamp');
    const bulb = r.s('bulb');
    const light = { intensity: r.n('lamp_light'), range: r.n('lamp_range'), y: r.n('lamp_y') };
    for (let i = 0; i < count; i += 1) {
      const along = start + i * gap + stagger;
      if (along > run.to) break;
      const toward = towardRoad(run.road, run.side);
      if (median) {
        const pole = roadPoint(run.road, along, 0);
        out.push({
          template: lamp,
          position: pole,
          y: 0,
          yaw: yawFacing(toward),
          props: new Map(),
        });
        for (const s of [1, -1]) {
          out.push({
            template: bulb,
            position: roadPoint(run.road, along, s * run.side * r.n('lamp_offset')),
            y: light.y,
            yaw: 0,
            props: new Map(),
            light,
          });
        }
        continue;
      }
      const across = run.side * (run.kerb + r.n('lamp_offset'));
      out.push({
        template: lamp,
        position: roadPoint(run.road, along, across),
        y: 0,
        yaw: yawFacing(toward),
        props: new Map(),
      });
      out.push({
        template: bulb,
        position: roadPoint(run.road, along, across - run.side * r.n('lamp_reach', 0)),
        y: light.y,
        yaw: 0,
        props: new Map(),
        light,
      });
    }
  }
  return out;
}

export function placeSignals(roads: RoadNetwork, closed: ReadonlySet<number>): Placed[] {
  const out: Placed[] = [];
  for (const j of roads.junctions) {
    const open = j.roads.filter((id) => !closed.has(id));
    if (open.length < 3) continue;
    const widest = Math.max(...open.map((id) => roads.roads[id]?.cls.width ?? 0));
    for (const id of open) {
      const road = roads.roads[id] as Road;
      /* The direction traffic travels toward this junction along this segment. */
      const endsHere = road.vertical
        ? Math.abs(road.to - j.z) < 1e-3
        : Math.abs(road.to - j.x) < 1e-3;
      const sign = endsHere ? 1 : -1;
      const d: Vec2 = road.vertical ? [0, sign] : [sign, 0];
      const right: Vec2 = [-d[1], d[0]];
      const c = road.cls;
      const back = widest / 2 + 2;
      const out1 = c.lanes * c.laneWidth + c.median / 2 + 1;
      out.push({
        template: c.row.s('signal'),
        position: [j.x - d[0] * back + right[0] * out1, j.z - d[1] * back + right[1] * out1],
        y: 0,
        yaw: yawFacing([-d[0], -d[1]]),
        props: new Map(),
      });
    }
  }
  return out;
}
