/**
 * The city's scene as the runtime reads it: the `ENTS` the bake wrote, read once into plain data —
 * the texture plan, each region's classes, where the walker starts, the streets and junctions the
 * traffic drives, the drones' depots and pads, and what moves.
 *
 * **Read by the component types it was written with** (`data/components.ts`): a field is found by
 * the id its type's schema gives it, and a scene whose saved schema for a type differs from the
 * type here is refused in words rather than misread. What that gives up is a migration across a
 * change of schema, which a bake and the runtime it was baked for never need: rebake.
 */
import {
  City,
  CityRegion,
  DropPad,
  DroneDepot,
  Junction,
  Life,
  Route,
  Spawn,
  Street,
  Venue,
  RailLine,
  RailStop,
  Skyport,
  Destination,
  District,
  MapBlock,
  LightShaft,
} from './data/components';
import type { LifeData, MoverKindData } from './data/life';
import type { MaterialClass, PlanClass } from './arrays';
import type { JunctionData, StreetData } from './lanes';
import type { RouteData } from './routeLanes';

/** A volume of light standing in the air, as `LightShaft` carries it. */
export interface ShaftData {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly dx: number;
  readonly dy: number;
  readonly dz: number;
  readonly near: number;
  readonly length: number;
  readonly spread: number;
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly fadeStart: number;
  readonly fadeEnd: number;
  readonly nearFade: number;
  readonly pulseHz: number;
  readonly pulseDepth: number;
}

/** A scene as `ENTS` carries it: saved schemas, and entities by component name and field id. */
export interface SavedScene {
  readonly schemas: Readonly<Record<string, unknown>>;
  readonly entities: readonly {
    readonly components: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  }[];
}

export interface CityScene {
  readonly regionSize: number;
  readonly lightUnit: number;
  readonly plan: readonly PlanClass[];
  /** Each region's classes: a level's in the order its meshes are listed, and a group's. */
  readonly regions: ReadonlyMap<
    number,
    {
      readonly levels: readonly (readonly MaterialClass[])[];
      readonly groups: readonly MaterialClass[];
    }
  >;
  readonly spawn: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly yaw: number;
  };
  readonly streets: readonly StreetData[];
  readonly junctions: readonly JunctionData[];
  readonly routes: readonly (RouteData & { readonly name: string })[];
  readonly depots: readonly {
    readonly x: number;
    readonly z: number;
    readonly yaw: number;
    readonly deck: number;
    readonly slots: number;
    readonly pitch: number;
  }[];
  readonly pads: readonly { readonly x: number; readonly y: number; readonly z: number }[];
  /** The light standing in the air, each as `LightShaft` names its fields. */
  readonly shafts: readonly ShaftData[];
  readonly venues: readonly { readonly x: number; readonly z: number; readonly kind: string }[];
  readonly districts: readonly {
    readonly index: number;
    readonly name: string;
    /** 0xRRGGBBAA. */
    readonly accent: number;
    readonly labelX: number;
    readonly labelZ: number;
  }[];
  /** Each block's district, and its outline, x z a corner. */
  readonly blocks: readonly { readonly district: number; readonly outline: readonly number[] }[];
  readonly lines: readonly LineData[];
  /** Each platform: its line by name, where it stands, and how far along its line's track. */
  readonly stops: readonly {
    readonly name: string;
    readonly line: string;
    readonly x: number;
    readonly z: number;
    readonly heading: number;
    readonly along: number;
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
  /** What moves, or null for a city baked without its life. */
  readonly life: { readonly kinds: readonly MoverKindData[]; readonly data: LifeData } | null;
}

/** A monorail line as the scene carries it: its closed track, x y z a point, and its numbers. */
export interface LineData {
  readonly name: string;
  readonly path: readonly number[];
  readonly trains: number;
  readonly minGap: number;
  readonly carLength: number;
  readonly cruise: number;
  readonly accel: number;
  readonly brake: number;
  readonly curveAccel: number;
  readonly dwell: number;
  readonly doorTime: number;
  /** 0xRRGGBBAA. */
  readonly tint: number;
  readonly deck: number;
  readonly cars: readonly { readonly kind: string; readonly flipped: boolean }[];
}

type Type =
  | typeof City
  | typeof CityRegion
  | typeof Spawn
  | typeof Street
  | typeof Junction
  | typeof Route
  | typeof DroneDepot
  | typeof DropPad
  | typeof Venue
  | typeof RailLine
  | typeof RailStop
  | typeof Skyport
  | typeof Destination
  | typeof District
  | typeof MapBlock
  | typeof Life
  | typeof LightShaft;
const TYPES: readonly Type[] = [
  City,
  CityRegion,
  Spawn,
  Street,
  Junction,
  Route,
  DroneDepot,
  DropPad,
  Venue,
  RailLine,
  RailStop,
  Skyport,
  Destination,
  District,
  MapBlock,
  Life,
  LightShaft,
];

export function readCityScene(scene: SavedScene): CityScene {
  for (const type of TYPES) {
    if (JSON.stringify(scene.schemas[type.name]) !== JSON.stringify(type.schema)) {
      throw new Error(
        `sprawl: the container's \`${type.name}\` was written with another schema than this ` +
          'runtime reads; bake the city again',
      );
    }
  }
  const having = (type: Type) =>
    scene.entities.filter((e) => e.components[type.name] !== undefined);
  const read = (e: SavedScene['entities'][number], type: Type, field: string): unknown => {
    const id = type.schema.fields.find((f) => f.name === field)?.id ?? '';
    return e.components[type.name]?.[id];
  };
  const [city] = having(City);
  const [spawn] = having(Spawn);
  if (city === undefined || spawn === undefined) {
    throw new Error('sprawl: the container carries no city or no spawn; bake it with --city');
  }
  const regions = new Map<number, { levels: MaterialClass[][]; groups: MaterialClass[] }>();
  for (const e of having(CityRegion)) {
    regions.set(read(e, CityRegion, 'id') as number, {
      levels: JSON.parse(read(e, CityRegion, 'levels') as string) as MaterialClass[][],
      groups: JSON.parse(read(e, CityRegion, 'groups') as string) as MaterialClass[],
    });
  }
  const textures = JSON.parse(read(city, City, 'textures') as string) as { classes: PlanClass[] };
  /* Every field of a type, by name, into a plain record. */
  const all = (e: SavedScene['entities'][number], type: Type): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const f of type.schema.fields) out[f.name] = e.components[type.name]?.[f.id];
    return out;
  };
  const [life] = having(Life);
  return {
    regionSize: read(city, City, 'regionSize') as number,
    lightUnit: read(city, City, 'lightUnit') as number,
    plan: textures.classes,
    regions,
    spawn: {
      x: read(spawn, Spawn, 'x') as number,
      y: read(spawn, Spawn, 'y') as number,
      z: read(spawn, Spawn, 'z') as number,
      yaw: read(spawn, Spawn, 'yaw') as number,
    },
    streets: having(Street).map((e) => {
      const f = all(e, Street);
      return {
        ...f,
        vertical: f.vertical === 1 || f.vertical === true,
        closed: f.closed === 1 || f.closed === true,
      } as unknown as StreetData;
    }),
    junctions: having(Junction).map((e) => ({
      x: read(e, Junction, 'x') as number,
      z: read(e, Junction, 'z') as number,
      streets: JSON.parse(read(e, Junction, 'streets') as string) as number[],
    })),
    routes: having(Route).map((e) => {
      const f = all(e, Route);
      return {
        ...f,
        points: JSON.parse(f.points as string) as number[],
      } as unknown as RouteData & { name: string };
    }),
    depots: having(DroneDepot).map(
      (e) => all(e, DroneDepot) as unknown as CityScene['depots'][number],
    ),
    pads: having(DropPad).map((e) => all(e, DropPad) as unknown as CityScene['pads'][number]),
    shafts: having(LightShaft).map((e) => all(e, LightShaft) as unknown as ShaftData),
    venues: having(Venue).map((e) => all(e, Venue) as unknown as CityScene['venues'][number]),
    districts: having(District).map(
      (e) => all(e, District) as unknown as CityScene['districts'][number],
    ),
    blocks: having(MapBlock).map((e) => ({
      district: read(e, MapBlock, 'district') as number,
      outline: JSON.parse(read(e, MapBlock, 'outline') as string) as number[],
    })),
    lines: having(RailLine).map((e) => {
      const f = all(e, RailLine);
      return {
        ...f,
        path: JSON.parse(f.path as string) as number[],
        cars: JSON.parse(f.cars as string) as LineData['cars'],
      } as unknown as LineData;
    }),
    stops: having(RailStop).map((e) => all(e, RailStop) as unknown as CityScene['stops'][number]),
    skyports: having(Skyport).map(
      (e) => all(e, Skyport) as unknown as CityScene['skyports'][number],
    ),
    destinations: having(Destination).map(
      (e) => all(e, Destination) as unknown as CityScene['destinations'][number],
    ),
    life:
      life === undefined
        ? null
        : {
            kinds: JSON.parse(read(life, Life, 'kinds') as string) as MoverKindData[],
            data: JSON.parse(read(life, Life, 'data') as string) as LifeData,
          },
  };
}
