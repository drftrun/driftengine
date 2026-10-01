/**
 * The elevated road and the diagonal avenue as the reference's host builds them from its own
 * templates: decks and roadway swept along each route in spans, piers under the elevated deck, sign
 * gantries across it and lamps down its median, and a crossing slab wherever the diagonal crosses
 * a street.
 *
 * **Both routes are the layout's**, which scales the scripts' own splines; each is registered as a
 * spline entity its templates' sweeps and placements find it by. **A pier carries the deck's
 * underside**, which its profile puts 2.3 m under the route; none stands where the deck is lower
 * than a pier can be, where the road comes down. **A crossing covers the street it crosses**,
 * widened by how obliquely it crosses it.
 *
 * What is not here: the ramps between the elevated road and the streets, whose joins the scripts
 * leave to a host that is not published — **the elevated road stands apart from the grid** until
 * they are reconstructed.
 */
import type { Value } from '../script/values.ts';
import type { ScriptWorld } from '../script/world.ts';
import type { CityLayout } from '../layout/layout.ts';
import type { Instance } from './instances.ts';
import { chunks, planAlong, spansOf, splineEntity } from './spans.ts';
import type { P3 } from './spans.ts';

const f32 = (v: number): Value => ({ k: 'num', type: 'f32', v: Math.fround(v) });
const i32 = (v: number): Value => ({ k: 'num', type: 'i32', v: Math.round(v) });

/** How far under the route the deck's underside is: its profile's lowest point. */
const DECK_UNDERSIDE = 2.3;
/** The shortest pier the template builds, and the spacing, lamp gap and gantry gap along the deck. */
const PIER_MIN = 3;
const PIER_GAP = 40;
const GANTRY_GAP = 450;
const LAMP_GAP = 52;
/** How long a deck or roadway instance runs along its route. */
const PIECE = 100;

interface Along {
  readonly point: P3;
  /** Unit direction along the route in plan. */
  readonly dir: readonly [number, number];
}

/** Where a polyline is at distance `s` along it in plan, and which way it runs there. */
function sample(points: readonly P3[], along: readonly number[], s: number): Along {
  let i = 0;
  while (i < points.length - 2 && (along[i + 1] as number) < s) i++;
  const [a, b] = [points[i] as P3, points[i + 1] as P3];
  const len = (along[i + 1] as number) - (along[i] as number) || 1;
  const t = Math.min(Math.max((s - (along[i] as number)) / len, 0), 1);
  const dl = Math.hypot(b[0] - a[0], b[2] - a[2]) || 1;
  return {
    point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
    dir: [(b[0] - a[0]) / dl, (b[2] - a[2]) / dl],
  };
}

/** The yaw that turns a template's local +x onto (dx, dz). */
const yawOf = (dx: number, dz: number): number => Math.atan2(-dz, dx);

function swept(
  name: string,
  spline: Value,
  points: readonly P3[],
  along: readonly number[],
): Instance[] {
  return chunks(along, PIECE).map(([i0, i1]) => ({
    name,
    props: new Map([
      ['sp', spline],
      ['s0', f32(along[i0] as number)],
      ['s1', f32(along[i1] as number)],
      ['spans', spansOf(points, false, i0, i1)],
    ]),
    position: [0, 0] as const,
    y: 0,
    yaw: 0,
    source: 'highway',
  }));
}

export function highwayInstances(layout: CityLayout, world: ScriptWorld): Instance[] {
  const out: Instance[] = [];
  const deck = layout.roads.highway.points;
  if (deck.length >= 2) {
    const along = planAlong(deck);
    const spline: Value = { k: 'entity', entity: splineEntity(world, 'highway_path', deck) };
    out.push(...swept('HighwayDeck', spline, deck, along));
    const length = along[along.length - 1] as number;
    let seed = 1;
    for (let s = PIER_GAP / 2; s < length; s += PIER_GAP) {
      const { point, dir } = sample(deck, along, s);
      const h = point[1] - DECK_UNDERSIDE;
      if (h < PIER_MIN) continue;
      out.push({
        name: 'HighwayPier',
        props: new Map([
          ['h', f32(h)],
          ['seed', i32(seed++)],
        ]),
        position: [point[0], point[2]],
        y: 0,
        yaw: yawOf(dir[0], dir[1]),
        source: 'highway',
      });
    }
    for (let s = GANTRY_GAP / 2; s < length; s += GANTRY_GAP) {
      const { point, dir } = sample(deck, along, s);
      out.push({
        name: 'HighwayGantry',
        props: new Map([['seed', i32(seed++)]]),
        position: [point[0], point[2]],
        y: point[1],
        /* Its legs stand either side along its own +x: across the road. */
        yaw: yawOf(dir[1], -dir[0]),
        source: 'highway',
      });
    }
    for (let s = LAMP_GAP / 2; s < length; s += LAMP_GAP) {
      const { point, dir } = sample(deck, along, s);
      out.push({
        name: 'DeckLight',
        props: new Map(),
        position: [point[0], point[2]],
        y: point[1],
        yaw: yawOf(dir[0], dir[1]),
        source: 'highway',
      });
    }
  }
  const diagonal = layout.roads.diagonal.points;
  if (diagonal.length >= 2) {
    const along = planAlong(diagonal);
    const spline: Value = { k: 'entity', entity: splineEntity(world, 'diagonal_path', diagonal) };
    out.push(...swept('DiagonalRoad', spline, diagonal, along));
    out.push(...crossings(layout, diagonal, along, spline));
  }
  return out;
}

/** A crossing slab where the diagonal meets each street, as wide as the street across it. */
function crossings(
  layout: CityLayout,
  diagonal: readonly P3[],
  along: readonly number[],
  spline: Value,
): Instance[] {
  const out: Instance[] = [];
  for (const road of layout.roads.roads) {
    for (let i = 0; i < diagonal.length - 1; i++) {
      const [a, b] = [diagonal[i] as P3, diagonal[i + 1] as P3];
      /* Where the diagonal's segment meets the street's centre line, if it does within both. */
      const [ax, az, bx, bz] = [a[0], a[2], b[0], b[2]];
      const t = road.vertical ? (road.at - ax) / (bx - ax) : (road.at - az) / (bz - az);
      if (!(t >= 0 && t <= 1)) continue;
      const cross = road.vertical ? az + (bz - az) * t : ax + (bx - ax) * t;
      if (cross < road.from || cross > road.to) continue;
      const seg = Math.hypot(bx - ax, bz - az) || 1;
      /* The share of the diagonal's heading across the street: 1 square to it, less obliquely. */
      const across = Math.abs(road.vertical ? (bx - ax) / seg : (bz - az) / seg);
      const half = road.cls.width / 2 / Math.max(0.3, across);
      const s = (along[i] as number) + seg * t;
      out.push({
        name: 'DiagonalCrossing',
        props: new Map([
          ['sp', spline],
          ['s0', f32(s - half)],
          ['s1', f32(s + half)],
        ]),
        position: [0, 0],
        y: 0,
        yaw: 0,
        source: 'highway',
      });
    }
  }
  return out;
}
