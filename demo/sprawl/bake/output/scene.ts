/**
 * The scene `ENTS` carries: what the runtime needs of the city beyond its geometry and light, as
 * entities of the types in `data/components.ts` — the texture plan, each region's classes, where
 * the walker starts, the districts and blocks for the map, the streets and junctions its traffic
 * runs on, the routes off the grid, the monorail's lines and stops, the drones' depots and pads,
 * and what moves.
 *
 * **Built from plain data**, so what the layout means and how the scene is written are separate
 * questions: `sceneInputOf` reads a layout, `cityScene` writes whatever it is given.
 *
 * **The walker starts where the scripts' `player` stands**, facing its `Player` yaw, as the
 * reference does; where the scripts have none, at the origin facing +z.
 */
import { World, serializeWorld } from '../../../../packages/entities/src/index.ts';
import type { SerializedScene } from '../../../../packages/entities/src/index.ts';

import {
  City,
  CityRegion,
  District,
  DropPad,
  DroneDepot,
  Junction,
  Life,
  MapBlock,
  RailLine,
  RailStop,
  Route,
  SCENE_TYPES,
  Spawn,
  Street,
  Venue,
  Skyport,
  Destination,
  LightShaft,
} from '../../data/components.ts';
import { rows } from '../layout/rows.ts';
import { carKind } from './life.ts';
import type { CityLayout } from '../layout/layout.ts';
import type { Vec2 } from '../layout/plane.ts';
import { regionIdAt } from '../mesh/region.ts';
import type { BakedCity, MaterialClass } from '../mesh/region.ts';
import type { CityVolume } from '../mesh/volumes.ts';
import type { Value } from '../script/values.ts';
import type { ScriptWorld } from '../script/world.ts';
import { effective } from '../script/world.ts';
import type { CoarseCity } from './coarse.ts';
import type { MoverKind } from './movers.ts';

type P3 = readonly [number, number, number];

/** The carriageway's top: the road slab's 0.6 m, centred on the ground. */
const ROAD_TOP = 0.3;
/** How far in front of its building's face a door's place on the pavement is. */
const DOOR_OUT = 1;

export interface SceneInput {
  readonly regionSize: number;
  readonly lightUnit: number;
  /** The texture plan, as `planData` gives it, each picture named as `TEXS` names it. */
  readonly textures: unknown;
  readonly spawn: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly yaw: number;
  };
  readonly regions: readonly {
    readonly id: number;
    readonly levels: readonly (readonly MaterialClass[])[];
    readonly groups: readonly MaterialClass[];
  }[];
  readonly districts: readonly {
    readonly index: number;
    readonly name: string;
    readonly accent: readonly [number, number, number, number];
    readonly label: Vec2;
  }[];
  readonly blocks: readonly { readonly district: number; readonly outline: readonly Vec2[] }[];
  readonly streets: readonly {
    readonly vertical: boolean;
    readonly at: number;
    readonly from: number;
    readonly to: number;
    readonly lanes: number;
    readonly laneWidth: number;
    readonly median: number;
    readonly sidewalk: number;
    readonly speed: number;
    readonly closed: boolean;
    readonly green: number;
    readonly y: number;
  }[];
  readonly junctions: readonly {
    readonly x: number;
    readonly z: number;
    readonly streets: readonly number[];
  }[];
  readonly routes: readonly {
    readonly name: string;
    readonly points: readonly P3[];
    readonly lanes: number;
    readonly laneWidth: number;
    readonly median: number;
    readonly speed: number;
  }[];
  readonly lines: readonly {
    readonly name: string;
    readonly path: readonly P3[];
    readonly trains: number;
    readonly minGap: number;
    readonly carLength: number;
    readonly cruise: number;
    readonly accel: number;
    readonly brake: number;
    readonly curveAccel: number;
    readonly dwell: number;
    readonly doorTime: number;
    readonly tint: readonly [number, number, number, number];
    readonly deck: number;
    readonly cars: readonly { readonly kind: string; readonly flipped: boolean }[];
  }[];
  readonly skyports: readonly {
    readonly x: number;
    readonly z: number;
    readonly yaw: number;
    readonly deck: number;
  }[];
  readonly destinations: readonly {
    readonly x: number;
    readonly z: number;
    readonly name: string;
  }[];
  readonly depots: readonly {
    readonly x: number;
    readonly z: number;
    readonly yaw: number;
    readonly deck: number;
    readonly slots: number;
    readonly pitch: number;
  }[];
  readonly pads: readonly { readonly x: number; readonly y: number; readonly z: number }[];
  readonly venues: readonly { readonly x: number; readonly z: number; readonly kind: string }[];
  /** What moves, and by what numbers; each mover mesh by its ordinal. */
  readonly life?: { readonly kinds: unknown; readonly data: unknown };
  /** The light standing in the air. */
  readonly shafts?: readonly CityVolume[];
  readonly stops: readonly {
    readonly name: string;
    readonly line: string;
    readonly x: number;
    readonly z: number;
    readonly heading: number;
    readonly along: number;
  }[];
}

/** Six decimals: a millimetre is three, and JSON of a whole city's outlines is otherwise mostly noise. */
const fixed = (xs: readonly number[]): string =>
  JSON.stringify(xs.map((x) => Math.round(x * 1e6) / 1e6));

export function cityScene(input: SceneInput): SerializedScene {
  const world = new World();
  const add = (type: (typeof SCENE_TYPES)[number], values: Record<string, unknown>): void =>
    world.add(world.create(), type, values);
  add(City, {
    regionSize: input.regionSize,
    lightUnit: input.lightUnit,
    textures: JSON.stringify(input.textures),
  });
  add(Spawn, { ...input.spawn });
  for (const r of input.regions) {
    add(CityRegion, {
      id: r.id,
      levels: JSON.stringify(r.levels),
      groups: JSON.stringify(r.groups),
    });
  }
  for (const d of input.districts) {
    const [r, g, b, a] = d.accent;
    add(District, {
      index: d.index,
      name: d.name,
      accent: ((r << 24) | (g << 16) | (b << 8) | a) >>> 0,
      labelX: d.label[0],
      labelZ: d.label[1],
    });
  }
  for (const b of input.blocks)
    add(MapBlock, { district: b.district, outline: fixed(b.outline.flat()) });
  for (const s of input.streets) add(Street, { ...s });
  for (const j of input.junctions)
    add(Junction, { x: j.x, z: j.z, streets: JSON.stringify(j.streets) });
  for (const r of input.routes) add(Route, { ...r, points: fixed(r.points.flat()) });
  for (const l of input.lines) {
    const [r, g, b, a] = l.tint;
    add(RailLine, {
      ...l,
      path: fixed(l.path.flat()),
      tint: ((r << 24) | (g << 16) | (b << 8) | a) >>> 0,
      cars: JSON.stringify(l.cars),
    });
  }
  for (const s of input.skyports) add(Skyport, { ...s });
  for (const d of input.destinations) add(Destination, { ...d });
  for (const s of input.stops) add(RailStop, { ...s });
  for (const d of input.depots) add(DroneDepot, { ...d });
  for (const p of input.pads) add(DropPad, { ...p });
  for (const v of input.venues) add(Venue, { ...v });
  if (input.life !== undefined) {
    add(Life, { kinds: JSON.stringify(input.life.kinds), data: JSON.stringify(input.life.data) });
  }
  for (const v of input.shafts ?? []) {
    add(LightShaft, {
      x: v.apex[0],
      y: v.apex[1],
      z: v.apex[2],
      dx: v.axis[0],
      dy: v.axis[1],
      dz: v.axis[2],
      near: v.near,
      length: v.length,
      spread: v.spread,
      r: v.color[0],
      g: v.color[1],
      b: v.color[2],
      fadeStart: v.fadeStart,
      fadeEnd: v.fadeEnd,
      nearFade: v.nearFade,
      pulseHz: v.pulse[0],
      pulseDepth: v.pulse[1],
    });
  }
  return serializeWorld(world, SCENE_TYPES);
}

const field = (v: Value | undefined, key: string): number => {
  const f = v?.k === 'struct' ? v.fields?.get(key) : undefined;
  return f?.k === 'num' ? f.v : 0;
};

/** Where the scripts' `player` stands and which way it faces. */
export function spawnOf(world: ScriptWorld): SceneInput['spawn'] {
  const player = world.root.named.get('player');
  if (player === undefined) return { x: 0, y: 0, z: 0, yaw: 0 };
  const at = effective(player, 'Position3');
  return {
    x: field(at, 'x'),
    y: field(at, 'y'),
    z: field(at, 'z'),
    yaw: field(effective(player, 'Player'), 'yaw'),
  };
}

/** What a layout gives the scene; the rest — regions, textures, spawn — is the caller's. */
export function sceneInputOf(
  layout: CityLayout,
  world: ScriptWorld,
): Pick<
  SceneInput,
  | 'districts'
  | 'blocks'
  | 'streets'
  | 'junctions'
  | 'routes'
  | 'lines'
  | 'stops'
  | 'depots'
  | 'pads'
  | 'venues'
  | 'skyports'
  | 'destinations'
> {
  const t = layout.tables;
  const labels = new Map<number, [number, number, number]>();
  const blocks = layout.blocks.map((b) => {
    const district = t.district(b.district).index;
    const sum = labels.get(district) ?? [0, 0, 0];
    labels.set(district, [
      sum[0] + (b.bounds.x0 + b.bounds.x1) / 2,
      sum[1] + (b.bounds.z0 + b.bounds.z1) / 2,
      sum[2] + 1,
    ]);
    return { district, outline: b.outline };
  });
  const route = (name: string, line: CityLayout['roads']['highway']) => ({
    name,
    points: line.points,
    lanes: line.cls.lanes,
    laneWidth: line.cls.laneWidth,
    median: line.cls.median,
    speed: line.cls.speed,
  });
  return {
    districts: t.districts.map((d) => {
      const sum = labels.get(d.index) ?? [0, 0, 1];
      return {
        index: d.index,
        name: d.label ?? d.suffix,
        accent: [d.accent[0], d.accent[1], d.accent[2], d.accent[3]] as const,
        label: [sum[0] / sum[2], sum[1] / sum[2]] as const,
      };
    }),
    blocks,
    streets: layout.roads.roads.map((r) => ({
      vertical: r.vertical,
      at: r.at,
      from: r.from,
      to: r.to,
      lanes: r.cls.lanes,
      laneWidth: r.cls.laneWidth,
      median: r.cls.median,
      sidewalk: r.cls.sidewalk,
      speed: r.cls.speed,
      closed: layout.closed.has(r.id),
      green: r.cls.row.n('green', 14),
      y: ROAD_TOP,
    })),
    junctions: layout.roads.junctions.map((j) => ({
      x: j.x,
      z: j.z,
      streets: j.roads.map((id) => layout.roads.roads.findIndex((r) => r.id === id)),
    })),
    routes: [
      route('highway', layout.roads.highway),
      route('diagonal', layout.roads.diagonal),
    ].filter((r) => r.points.length >= 2),
    lines: layout.rail.lines.map((l) => ({
      name: l.name,
      path: l.path.map((p, i) => [p[0], l.height[i] ?? 0, p[1]] as const),
      trains: l.row.n('trains', 0),
      minGap: l.row.n('min_gap', 60),
      carLength: l.row.n('car_length', 14.6),
      /* The spec's reading of a cap no train reaches between stations as metres a second: km/h. */
      cruise: l.row.n('cruise', 84) / 3.6,
      accel: l.row.n('accel', 4.4),
      brake: l.row.n('brake', 5.2),
      curveAccel: l.row.n('curve_accel', 3.2),
      dwell: l.row.n('dwell', 4),
      doorTime: l.row.n('door_time', 1),
      tint: l.row.c('tint', [255, 255, 255, 255]),
      deck: l.row.n('deck_y', 14.9),
      cars: rows(world, 'MonorailCar')
        .filter((c) => c.entity.parent === l.row.entity)
        .sort((a, b) => a.n('index', 0) - b.n('index', 0))
        .map((c) => ({
          kind: carKind(c.s('asset'), c.n('cab', 0)),
          flipped: c.n('flipped', 0) !== 0,
        })),
    })),
    skyports: layout.skyports.sites.map((s) => ({
      x: s.position[0],
      z: s.position[1],
      yaw: s.yaw + Math.PI,
      deck: layout.skyports.deck,
    })),
    /* Written unscaled, as the host scales them: by the city's scale, as every place is. */
    destinations: rows(world, 'Destination').map((d) => ({
      x: d.n('x', 0) * layout.tables.value('cityScale'),
      z: d.n('z', 0) * layout.tables.value('cityScale'),
      name: d.entity.name,
    })),
    stops: layout.rail.stops.map((s) => ({
      name: s.name,
      line: s.line,
      x: s.position[0],
      z: s.position[1],
      heading: s.heading,
      along: s.along,
    })),
    depots: layout.drones.depots.map((d) => ({
      x: d.position[0],
      z: d.position[1],
      yaw: d.yaw,
      deck: layout.drones.deck,
      slots: layout.drones.slots,
      pitch: layout.drones.pitch,
    })),
    pads: layout.drones.pads.map((p) => ({ x: p.position[0], y: p.y, z: p.position[1] })),
    venues: layout.buildings.flatMap((b) => {
      /* A metre out from the building's face, on the pavement: its local +z points at the street. */
      const out = b.depth / 2 + DOOR_OUT;
      const x = b.position[0] + Math.sin(b.yaw) * out;
      const z = b.position[1] + Math.cos(b.yaw) * out;
      return [...new Set(b.venues.map((v) => v.kind))].map((kind) => ({ x, z, kind }));
    }),
  };
}

/** The whole scene for the regions `keep` accepts: the layout's part, and the bake's. */
export function sceneOf(args: {
  readonly city: BakedCity;
  readonly coarse: CoarseCity;
  readonly layout: CityLayout;
  readonly world: ScriptWorld;
  readonly textures: unknown;
  readonly regionSize: number;
  readonly lightUnit: number;
  readonly keep?: (id: number) => boolean;
  /** The movers the container carries first, and their numbers. */
  readonly life?: { readonly kinds: readonly MoverKind[]; readonly data: unknown };
}): SerializedScene {
  const { city, coarse } = args;
  return cityScene({
    ...sceneInputOf(args.layout, args.world),
    regionSize: args.regionSize,
    lightUnit: args.lightUnit,
    textures: args.textures,
    spawn: spawnOf(args.world),
    ...(args.life === undefined ? {} : { life: lifeOf(args.life.kinds, args.life.data) }),
    shafts: city.volumes.filter(
      (v) => args.keep?.(regionIdAt(v.apex[0], v.apex[2], args.regionSize)) ?? true,
    ),
    regions: city.regions
      .filter((r) => args.keep?.(r.id) ?? true)
      .map((r) => ({
        id: r.id,
        levels: [r.assemblies.map((a) => a.cls), (coarse.levels.get(r.id) ?? []).map((a) => a.cls)],
        groups: r.groups.map((g) => (city.prototypes[g.prototype] as { cls: MaterialClass }).cls),
      })),
  });
}

/** The movers as the scene describes them: each mesh by its ordinal, the movers being first. */
export function lifeOf(
  kinds: readonly MoverKind[],
  data: unknown,
): { kinds: unknown; data: unknown } {
  let ordinal = 0;
  return {
    kinds: kinds.map((k) => ({
      name: k.name,
      role: k.role,
      meshes: k.meshes.map((m) => ({ mesh: ordinal++, tint: m.tint, limb: m.limb })),
      limbs: k.limbs,
      ...(k.blink === undefined ? {} : { blink: k.blink }),
    })),
    data,
  };
}
