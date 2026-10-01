/**
 * The tables the city's ground plan is built from: districts, the sector map, avenues, road
 * classes, block, court and alley kinds, the elevated and diagonal routes, and the city-wide
 * constants — read from the evaluated scripts, typed.
 *
 * **A district is its enum constant and its place in the enum's order**, which is the order the
 * scripts declare their `DistrictDef` rows in. The reference's host names per-district constants
 * two ways, and both are derived here rather than listed: by the constant's own suffix
 * (`lotWidthDowntown` for `DistrictDowntown`), and by a short name in enum order that its bitmasks
 * and prop spacings use (`dCore = 1`, `propSpacingCore`).
 *
 * The routes are authored at twice the city's scale and are scaled here, which the notes found
 * from where their ends land: unscaled, the elevated road would start two kilometres outside a
 * two-kilometre city.
 */
import type { ScriptWorld } from '../script/world.ts';
import { constants, pairTargets, rows } from './rows.ts';
import type { Rgba, Row } from './rows.ts';

/** The reference host's short district names, in enum order: bitmask bit and constant suffix. */
const SHORT_NAMES = ['Core', 'Row', 'Stacks', 'Port', 'Rise', 'OldTown'] as const;

export interface District {
  readonly kind: string;
  readonly index: number;
  /** The enum constant without `District`: `lotWidth${suffix}`. */
  readonly suffix: string;
  /** The short name: `propSpacing${short}`, and bit `index` of a district mask. */
  readonly short: string;
  readonly label: string | null;
  readonly seed: readonly [number, number];
  readonly share: number;
  readonly spacing: number;
  readonly accent: Rgba;
  readonly lotWidth: number;
  readonly lotDepth: number;
}

export interface Sector {
  readonly x0: number;
  readonly z0: number;
  readonly x1: number;
  readonly z1: number;
  readonly spacing: number;
  readonly district: string;
}

export interface Avenue {
  readonly vertical: boolean;
  readonly pos: number;
  readonly wide: boolean;
}

export interface RoadClass {
  readonly cls: string;
  readonly lanes: number;
  readonly laneWidth: number;
  readonly median: number;
  readonly sidewalk: number;
  readonly speed: number;
  readonly lightGap: number;
  readonly tile: number;
  readonly row: Row;
  /** Kerb to kerb plus both sidewalks. */
  readonly width: number;
}

export interface GroundKind {
  readonly kind: string;
  readonly district: string;
  readonly chance: number;
  readonly minSize: number;
  readonly template: string;
  readonly row: Row;
}

export interface Route {
  readonly points: readonly (readonly [number, number, number])[];
  readonly curved: boolean;
}

export interface CityTables {
  readonly constants: ReadonlyMap<string, number>;
  readonly districts: readonly District[];
  readonly sectors: readonly Sector[];
  readonly avenues: readonly Avenue[];
  readonly roads: ReadonlyMap<string, RoadClass>;
  readonly grounds: readonly GroundKind[];
  readonly courts: readonly GroundKind[];
  readonly alleys: readonly GroundKind[];
  readonly highway: Route;
  readonly diagonal: Route;
  readonly ramps: readonly Row[];
  /** A constant by name; a missing one is an error. */
  readonly value: (name: string) => number;
  readonly district: (kind: string) => District;
}

function route(world: ScriptWorld, name: string, scale: number): Route {
  const found = rows(world, 'Spline').find((r) => r.entity.name === name);
  if (found === undefined) throw new Error(`the scripts declare no spline named ${name}`);
  const points = found.v('points');
  if (points?.k !== 'vector') throw new Error(`${name} has no points`);
  return {
    points: points.items.map((p) => {
      const at = p.k === 'struct' ? p.items : [];
      const n = (i: number): number => {
        const v = at[i];
        return v?.k === 'num' ? v.v : 0;
      };
      return [n(0) * scale, n(1), n(2) * scale] as const;
    }),
    curved: found.s('kind') === 'CatmullRom',
  };
}

function ground(r: Row, kind: string): GroundKind {
  const template = pairTargets(r.entity, 'BuildsWith')[0];
  if (template === undefined) throw new Error(`${r.entity.name} names no template`);
  return {
    kind,
    district: r.s('district'),
    chance: r.n('chance', 1),
    minSize: r.n('min_size', 0),
    template,
    row: r,
  };
}

export function readCityTables(world: ScriptWorld): CityTables {
  const values = constants(world);
  const value = (name: string): number => {
    const v = values.get(name);
    if (v === undefined) throw new Error(`the scripts declare no constant ${name}`);
    return v;
  };
  const districts = rows(world, 'DistrictDef').map((r, index): District => {
    const kind = r.s('kind');
    const suffix = kind.replace(/^District/, '');
    return {
      kind,
      index,
      suffix,
      short: SHORT_NAMES[index] ?? suffix,
      label: r.entity.label,
      seed: [r.n('seed_x'), r.n('seed_z')],
      share: r.n('share'),
      spacing: r.n('spacing'),
      accent: r.c('accent'),
      lotWidth: value(`lotWidth${suffix}`),
      lotDepth: value(`lotDepth${suffix}`),
    };
  });
  const roads = new Map<string, RoadClass>();
  for (const r of rows(world, 'RoadStyle')) {
    const lanes = r.n('lanes');
    const laneWidth = r.n('lane_w');
    const median = r.n('median');
    const sidewalk = r.n('sidewalk');
    roads.set(r.s('cls'), {
      cls: r.s('cls'),
      lanes,
      laneWidth,
      median,
      sidewalk,
      speed: r.n('speed'),
      lightGap: r.n('light_gap'),
      tile: r.n('tile'),
      row: r,
      width: 2 * lanes * laneWidth + median + 2 * sidewalk,
    });
  }
  const scale = value('cityScale');
  return {
    constants: values,
    districts,
    sectors: rows(world, 'CitySector').map((r) => ({
      x0: r.n('x0'),
      z0: r.n('z0'),
      x1: r.n('x1'),
      z1: r.n('z1'),
      spacing: r.n('spacing'),
      district: r.s('home'),
    })),
    avenues: rows(world, 'CityAvenue').map((r) => ({
      vertical: r.n('vertical') !== 0,
      pos: r.n('pos'),
      wide: r.n('wide') !== 0,
    })),
    roads,
    grounds: rows(world, 'BlockStyle').map((r) => ground(r, r.s('kind'))),
    courts: rows(world, 'CourtStyle').map((r) => ground(r, 'Court')),
    alleys: rows(world, 'AlleyStyle').map((r) => ground(r, 'Alley')),
    highway: route(world, 'highway_route', scale),
    diagonal: route(world, 'diagonal_route', scale),
    ramps: rows(world, 'RampSpec'),
    value,
    district(kind) {
      const found = districts.find((d) => d.kind === kind);
      if (found === undefined) throw new Error(`no district ${kind}`);
      return found;
    },
  };
}
