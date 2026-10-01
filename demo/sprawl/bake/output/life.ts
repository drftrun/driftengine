/**
 * What moves through the city and by what numbers, read from the reference's own tables: its
 * vehicle styles and paints, its people's kinds, palettes and days, its drone kinds — and the meshes
 * of every template they name (`movers.ts`).
 *
 * **The numbers go to the runtime as the scripts state them**, colours made linear, so the
 * simulation reads one table and not two. What the tables leave to a host — which kind spawns where,
 * how a schedule's place is found — the runtime decides, and says so where it does.
 */
import { linear } from '../mesh/materials.ts';
import { pairTargets, rows } from '../layout/rows.ts';
import type { Row } from '../layout/rows.ts';
import type {
  CameraRow,
  JobRow,
  LifeData,
  PersonRow,
  Rgb,
  TaxiRow,
  VehicleRow,
} from '../../data/life.ts';
import { readCityTables } from '../layout/tables.ts';
import type { ScriptRead } from '../script/reader.ts';
import type { Value } from '../script/values.ts';
import { effective } from '../script/world.ts';
import { bakeMover } from './movers.ts';
import type { MoverKind } from './movers.ts';

const rgb = (row: Row, key: string): Rgb => {
  const [r, g, b] = row.c(key, [255, 255, 255, 255]);
  return [linear(r), linear(g), linear(b)];
};
const DISTRICTS = ['downtown', 'market', 'stacks', 'industrial', 'residential'] as const;
const byDistrict = (row: Row, prefix: string): Record<string, number> =>
  Object.fromEntries(DISTRICTS.map((d) => [d, row.n(`${prefix}${d}`, 0)]));

export function cityLife(read: ScriptRead): { kinds: MoverKind[]; data: LifeData } {
  const world = read.world;
  const templates = new Map<string, MoverKind['role']>();
  const vehicles = rows(world, 'VehicleStyle').map((r): VehicleRow => {
    const template = pairTargets(r.entity, 'BuildsWith')[0]?.split('.').pop() ?? '';
    templates.set(template, 'vehicle');
    const spec = read.world.templates.get(template);
    const vehicle = spec === undefined ? undefined : templateComponent(read, template, 'Vehicle');
    const n = (key: string, fallback: number): number => {
      const f = vehicle?.k === 'struct' ? vehicle.fields?.get(key) : undefined;
      return f?.k === 'num' ? f.v : fallback;
    };
    return {
      kind: r.entity.name.replace(/_kind$/, ''),
      template,
      taxi: r.n('taxi', 0) !== 0,
      length: n('length', 4.6),
      width: n('width', 1.9),
      maxSpeed: n('max_speed', 20),
      accel: n('accel', 3),
      brake: n('brake', 7),
      weights: byDistrict(r, ''),
      lite: [r.n('lite_x', 1), r.n('lite_y', 1), r.n('lite_z', 1)],
    };
  });
  templates.set('VehicleLite', 'vehicle');
  const [palette] = rows(world, 'TrafficPalette');
  const people = rows(world, 'NpcKind').map((r): PersonRow => {
    templates.set(r.s('body'), 'person');
    templates.set(r.s('lite'), 'person');
    return {
      kind: r.entity.name,
      body: r.s('body'),
      lite: r.s('lite'),
      job: r.s('job'),
      weight: r.n('weight', 1),
      scale: r.n('scale', 1),
      speed: [r.n('speed_min', 1.2), r.n('speed_max', 1.5)],
      homes: byDistrict(r, 'home_'),
      streets: byDistrict(r, 'street_'),
      jaywalk: r.n('jaywalk', 0),
      transit: r.n('transit', 0),
      palettes: r.entity.children
        .filter((c) => effective(c, 'NpcPalette') !== undefined)
        .map((c) => {
          const p = rows(world, 'NpcPalette').find((x) => x.entity === c) as Row;
          return {
            weight: p.n('weight', 1),
            skin: rgb(p, 'skin'),
            cloth: rgb(p, 'cloth'),
            cloth2: rgb(p, 'cloth2'),
            hair: rgb(p, 'hair'),
            accent: rgb(p, 'accent'),
            glow: p.n('glow', 1),
          };
        }),
    };
  });
  const jobs = Object.fromEntries(
    rows(world, 'NpcJob').map((j) => [
      j.entity.name,
      {
        home: j.s('home_kind', ''),
        work: j.s('work_kind', ''),
        favorite: j.s('favorite_kind', ''),
        workRadius: j.n('work_radius', 1000),
        favoriteRadius: j.n('favorite_radius', 600),
        steps: rows(world, 'NpcStep')
          .filter((s) => s.entity.parent === j.entity)
          .map((s) => ({
            hour: s.n('hour', 0),
            jitter: s.n('jitter', 0),
            place: s.s('place', 'PlaceHome'),
            kind: s.s('kind', ''),
            radius: s.n('radius', 0),
            dwell: s.n('dwell', 0),
            repeat: s.n('repeat', 1),
            outside: s.n('outside', 0),
          })),
      },
    ]),
  );
  const drones = rows(world, 'DroneKind').map((r) => {
    templates.set(r.s('body'), 'drone');
    templates.set(r.s('lite'), 'drone');
    return {
      kind: r.entity.name,
      body: r.s('body'),
      lite: r.s('lite'),
      weight: r.n('weight', 1),
      scale: r.n('scale', 1),
      speed: r.n('speed', 15),
      speedVar: r.n('speed_var', 0),
      altitude: r.n('altitude', 0),
      hover: r.n('hover', 3),
    };
  });
  const taxis = rows(world, 'AirTaxiKind').map((r): TaxiRow => {
    templates.set(r.s('prefab'), 'aircraft');
    return {
      kind: r.entity.name,
      prefab: r.s('prefab'),
      weight: r.n('weight', 1),
      cruise: r.n('cruise_speed', 44),
      bias: r.n('cruise_bias', 0),
      dwellScale: r.n('dwell_scale', 1),
    };
  });
  const kinds: MoverKind[] = [];
  for (const [name, role] of templates) {
    const kind = name === '' ? null : bakeMover(read, name, role);
    if (kind !== null) kinds.push(kind);
  }
  /* Each train car its line names, by its template and whether it is a cab, painted by its line. */
  const cars = new Set(rows(world, 'MonorailCar').map((r) => `${r.s('asset')}|${r.n('cab', 0)}`));
  for (const car of cars) {
    const [asset, cab] = car.split('|') as [string, string];
    const kind = bakeMover(read, asset, 'train', {
      as: carKind(asset, Number(cab)),
      props: new Map<string, Value>([
        ['cab', { k: 'num', type: 'i32', v: Number(cab) }],
        ['line_color', rgbaValue(SENTINEL)],
      ]),
      sentinel: SENTINEL,
    });
    if (kind !== null) kinds.push(kind);
  }
  const cameras = Object.fromEntries(
    rows(world, 'RideCamera').map((r): [string, CameraRow] => [
      r.s('kind'),
      {
        forward: r.n('forward', 0),
        side: r.n('side', 0),
        eye: r.n('eye', 0),
        near: r.n('near_', 0.25),
        far: r.n('far_', 5000),
        fov: r.n('fov', 75),
        smooth: r.n('smooth', 0),
      },
    ]),
  );
  return {
    kinds,
    data: {
      vehicles,
      paints: rows(world, 'VehiclePaint').map((p) => rgb(p, 'color')),
      glows: rows(world, 'VehicleGlow').map((p) => rgb(p, 'color')),
      palette:
        palette === undefined
          ? {}
          : Object.fromEntries(
              ['head', 'tail', 'taxi_paint', 'taxi_glow'].map((k) => [k, rgb(palette, k)]),
            ),
      people,
      jobs,
      drones,
      taxis,
      cameras,
      config: Object.fromEntries(readCityTables(world).constants),
    },
  };
}

/** A component a template sets on its own root, evaluated by instantiating it. */
function templateComponent(read: ScriptRead, name: string, component: string): Value | undefined {
  const holder = read.world.create('', null);
  try {
    const entity = read.instantiate(name, new Map(), holder);
    return effective(entity, component);
  } catch {
    return undefined;
  } finally {
    holder.children.length = 0;
  }
}

/** A colour no template wears of its own, handed in as a line's so its paint can be found. */
const SENTINEL = [255, 0, 255] as const;

/** A train car's kind: its template, and a cab's mark. */
export function carKind(asset: string, cab: number): string {
  return cab === 0 ? asset : `${asset}.cab`;
}

function rgbaValue([r, g, b]: readonly [number, number, number]): Value {
  const u8 = (v: number): Value => ({ k: 'num', type: 'u8', v });
  return {
    k: 'struct',
    fields: new Map([
      ['r', u8(r)],
      ['g', u8(g)],
      ['b', u8(b)],
      ['a', u8(255)],
    ]),
    items: [],
  };
}
