/**
 * The road network: the grid's lines cut into segments at every junction, each given a road
 * class, plus the diagonal avenue and the elevated road.
 *
 * **A segment's class is the host's decision, and the tables leave it unsaid.** A wide avenue is
 * the avenue class. Any other segment takes its district's street class, the wider of the two where
 * it divides two districts. The narrow avenues are ordinary streets of their districts here,
 * because that is how the reference's own map draws them: at street width, continuous across the
 * city.
 *
 * The district's street class, in enum order: the core, market, industrial and old-town classes
 * are each named for their district; the tower district's streets are the plain street class and
 * the residential district's the lane, the quietest.
 *
 * What would make it wrong: a capture of the reference where a residential street has two lanes a
 * side, or a market street is as wide as a core one.
 */
import type { Cell, Grid, StreetLine } from './grid.ts';
import type { CityTables, RoadClass, Route } from './tables.ts';

/** Each district's street class, by the district's place in the enum. */
const STREET_CLASS = ['RoadCore', 'RoadRow', 'RoadStreet', 'RoadIndustrial', 'RoadLane', 'RoadOld'];

export interface Road {
  readonly id: number;
  readonly vertical: boolean;
  /** x for a vertical road, z for a horizontal one. */
  readonly at: number;
  readonly from: number;
  readonly to: number;
  readonly cls: RoadClass;
  readonly avenue: boolean;
}

export interface Junction {
  readonly x: number;
  readonly z: number;
  /** The segments that meet here. */
  readonly roads: readonly number[];
}

export interface Polyline {
  readonly points: readonly (readonly [number, number, number])[];
  readonly cls: RoadClass;
}

export interface RoadNetwork {
  readonly roads: readonly Road[];
  readonly junctions: readonly Junction[];
  readonly diagonal: Polyline;
  readonly highway: Polyline;
  /** The widest road along the line at `at` overlapping [from, to]; 0 where there is none. */
  width(vertical: boolean, at: number, from: number, to: number): number;
}

const SAME = 1e-3;

/** A uniform Catmull-Rom curve through `points`, `steps` pieces a span, ends held. */
export function sampleCurve(route: Route, steps: number): (readonly [number, number, number])[] {
  const p = route.points;
  if (!route.curved || p.length < 3) return [...p];
  const out: [number, number, number][] = [];
  for (let i = 0; i + 1 < p.length; i += 1) {
    const a = p[Math.max(0, i - 1)] as readonly number[];
    const b = p[i] as readonly number[];
    const c = p[i + 1] as readonly number[];
    const d = p[Math.min(p.length - 1, i + 2)] as readonly number[];
    for (let s = 0; s < steps; s += 1) {
      const t = s / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      const at = (k: number): number =>
        0.5 *
        (2 * (b[k] as number) +
          ((c[k] as number) - (a[k] as number)) * t +
          (2 * (a[k] as number) - 5 * (b[k] as number) + 4 * (c[k] as number) - (d[k] as number)) *
            t2 +
          (3 * (b[k] as number) - (a[k] as number) - 3 * (c[k] as number) + (d[k] as number)) * t3);
      out.push([at(0), at(1), at(2)]);
    }
  }
  out.push([...(p[p.length - 1] as readonly [number, number, number])]);
  return out;
}

/** The districts of the cells with a side on `line` overlapping [from, to]. */
function sides(line: StreetLine, from: number, to: number, cells: readonly Cell[]): Set<string> {
  const out = new Set<string>();
  for (const c of cells) {
    const [lo, hi, a, b] = line.vertical ? [c.z0, c.z1, c.x0, c.x1] : [c.x0, c.x1, c.z0, c.z1];
    if (hi <= from + SAME || lo >= to - SAME) continue;
    if (Math.abs(a - line.at) < SAME || Math.abs(b - line.at) < SAME) out.add(c.district);
  }
  return out;
}

export function buildRoads(tables: CityTables, grid: Grid): RoadNetwork {
  const roadClass = (cls: string): RoadClass => {
    const found = tables.roads.get(cls);
    if (found === undefined) throw new Error(`no road class ${cls}`);
    return found;
  };
  const wideAt = (vertical: boolean, at: number): boolean =>
    tables.avenues.some((a) => a.wide && a.vertical === vertical && Math.abs(a.pos - at) < SAME);
  const roads: Road[] = [];
  for (const line of grid.lines) {
    const cuts = new Set<number>([line.from, line.to]);
    for (const other of grid.lines) {
      if (other.vertical === line.vertical) continue;
      if (other.at < line.from - SAME || other.at > line.to + SAME) continue;
      if (line.at < other.from - SAME || line.at > other.to + SAME) continue;
      cuts.add(other.at);
    }
    const stops = [...cuts].sort((a, b) => a - b);
    for (let i = 0; i + 1 < stops.length; i += 1) {
      const from = stops[i] as number;
      const to = stops[i + 1] as number;
      if (to - from < SAME) continue;
      const avenue = wideAt(line.vertical, line.at);
      let cls = roadClass('RoadAvenue');
      if (!avenue) {
        const classes = [...sides(line, from, to, grid.cells)].map((kind) =>
          roadClass(STREET_CLASS[tables.district(kind).index] ?? 'RoadStreet'),
        );
        cls = classes.reduce(
          (w, c) => (c.width > w.width ? c : w),
          classes[0] ?? roadClass('RoadStreet'),
        );
      }
      roads.push({ id: roads.length, vertical: line.vertical, at: line.at, from, to, cls, avenue });
    }
  }
  const junctions = new Map<string, { x: number; z: number; roads: number[] }>();
  for (const road of roads) {
    for (const end of [road.from, road.to]) {
      const [x, z] = road.vertical ? [road.at, end] : [end, road.at];
      const key = `${Math.round(x / SAME)},${Math.round(z / SAME)}`;
      const j = junctions.get(key) ?? { x, z, roads: [] };
      j.roads.push(road.id);
      junctions.set(key, j);
    }
  }
  return {
    roads,
    junctions: [...junctions.values()].filter((j) => j.roads.length > 1),
    diagonal: { points: tables.diagonal.points, cls: roadClass('RoadDiagonal') },
    highway: { points: sampleCurve(tables.highway, 8), cls: roadClass('RoadHighway') },
    width(vertical, at, from, to) {
      let widest = 0;
      for (const road of roads) {
        if (road.vertical !== vertical || Math.abs(road.at - at) >= SAME) continue;
        if (road.to <= from + SAME || road.from >= to - SAME) continue;
        widest = Math.max(widest, road.cls.width);
      }
      return widest;
    },
  };
}
