/**
 * The layout's stages run in order over one evaluated script world, into one plain `CityLayout`.
 *
 * Each stage draws from its own `mulberry32` stream, seeded from the city seed and the stage's
 * number, so adding a draw to one stage never moves another's.
 */
import { mulberry32 } from '@driftengine/core';

import type { ScriptWorld } from '../script/world.ts';
import { assignGround, buildBlocks } from './blocks.ts';
import type { Block } from './blocks.ts';
import { placeBuildings } from './buildings.ts';
import { underRoute } from './corridor.ts';
import type { Building } from './buildings.ts';
import { depotParts, siteDepots, sitePads } from './drones.ts';
import { skyportParts } from './skyports.ts';
import type { Depot, DepotKind } from './drones.ts';
import { buildGrid } from './grid.ts';
import { placeLandmarks } from './landmarks.ts';
import type { Landmark } from './landmarks.ts';
import type { Vec2 } from './plane.ts';
import { placeLamps, placeSignals, sidewalkRuns } from './furniture.ts';
import type { Placed, SidewalkRun } from './furniture.ts';
import { buildLots } from './lots.ts';
import { buildMonorail } from './monorail.ts';
import type { RailLine, RailStop } from './monorail.ts';
import type { BlockPlan, Lot } from './lots.ts';
import type { CellDistrict, Grid } from './grid.ts';
import { buildRoads } from './roads.ts';
import type { RoadNetwork } from './roads.ts';
import { placeProps } from './props.ts';
import { rows } from './rows.ts';
import { readBuildingStyles } from './styleTables.ts';
import { readCityTables } from './tables.ts';
import type { CityTables } from './tables.ts';
import { buildWall, inBelt } from './wall.ts';
import type { Wall } from './wall.ts';

/** The one number the host's own choices grow from. */
export const CITY_SEED = 20260930;

export interface CityLayout {
  readonly tables: CityTables;
  readonly grid: Grid;
  readonly roads: RoadNetwork;
  readonly blocks: readonly Block[];
  readonly lots: readonly Lot[];
  readonly plans: readonly BlockPlan[];
  readonly buildings: readonly Building[];
  /** Lots no style fits, paved as open ground. */
  readonly vacant: readonly Lot[];
  readonly landmarks: readonly Landmark[];
  /** Road segments a landmark stands across, closed to traffic. */
  readonly closed: ReadonlySet<number>;
  readonly wall: Wall | null;
  readonly rail: { readonly lines: readonly RailLine[]; readonly stops: readonly RailStop[] };
  /** Stops the monorail stage could not seat, and why. */
  readonly dropped: readonly string[];
  readonly lamps: readonly Placed[];
  readonly signals: readonly Placed[];
  readonly props: readonly Placed[];
  /** The drones' yards and the pads they drop at; `parts` is every yard's pieces, as instances. */
  /** The air taxis' towers: where each stands, its deck's height, and its pieces as instances. */
  readonly skyports: {
    readonly sites: readonly Depot[];
    readonly deck: number;
    readonly parts: readonly Placed[];
  };
  readonly drones: {
    readonly depots: readonly Depot[];
    /** The landing deck's top, the charging grid's slots a side and their pitch. */
    readonly deck: number;
    readonly slots: number;
    readonly pitch: number;
    readonly parts: readonly Placed[];
    readonly pads: readonly Placed[];
  };
}

const stream = (stage: number): (() => number) => mulberry32(CITY_SEED + stage * 7919);

/** What the data folder may carry beside the scripts, read from the reference's own map. */
export interface LayoutData {
  readonly districts?: readonly CellDistrict[];
  readonly anchors?: ReadonlyMap<string, Vec2>;
}

/** The elevated deck's half-width, 11.6 m in its profile, and 2 m clear beyond it. */
const DECK_CLEAR = 13.6;
/** The pavement's top: the walk slab's 0.68 m, centred on the ground. */
const WALK_TOP = 0.34;
/** A yard's apron: a walk slab over its lot, 3 cm under whose top the yard's asphalt starts. */
export const APRON_TOP = WALK_TOP - 0.03;
/** Half a skyport's footprint, its 9.8 m apron: the lots it may stand on. */
const SKYPORT_HALF = 10;
/** Pads a street block apart, and clear of any pole or prop by a walker's stride. Ours. */
const PAD_SPACING = 60;
const PAD_CLEAR = 2.5;

export function buildLayout(world: ScriptWorld, data: LayoutData = {}): CityLayout {
  const districts = data.districts ?? [];
  const tables = readCityTables(world);
  const grid = buildGrid(tables, districts);
  const roads = buildRoads(tables, grid);
  const blocks = buildBlocks(grid, roads);
  const { landmarks, closed } = placeLandmarks(
    world,
    blocks,
    roads,
    tables,
    stream(3),
    data.anchors,
  );
  assignGround(blocks, tables, stream(1));
  const wall = buildWall(tables, blocks, roads);
  const cut = buildLots(blocks, tables);
  const lots = wall ? cut.lots.filter((lot) => !inBelt(lot, wall)) : cut.lots;
  /* Nothing is built under the elevated road: its deck's half-width and a margin either side. */
  const under = (lot: Lot): boolean => underRoute(lot.bounds, roads.highway.points, DECK_CLEAR);
  const placed = placeBuildings(
    lots.filter((lot) => !under(lot)),
    readBuildingStyles(world),
    tables,
    stream(2),
  );
  const vacant = [...placed.vacant, ...lots.filter(under)];
  /* The depots on open lots clear of the elevated road, whose deck their masts would stand
     through; the skyports on what is left of those, or on a building's lot, the building giving
     way — before anything is placed on its roof. */
  const depotKind = readDepotKind(world, tables);
  const depots =
    depotKind === null
      ? []
      : siteDepots(placed.vacant, tables.value('droneDepots'), depotKind.half);
  const taken = new Set(depots.map((d) => d.lot));
  const byId = new Map(lots.map((lot) => [lot.id, lot]));
  const built = placed.buildings
    .map((b) => byId.get(b.lot))
    .filter((lot): lot is Lot => lot !== undefined);
  const skyports = placeSkyports(world, tables, [
    ...placed.vacant.filter((lot) => !taken.has(lot)),
    ...built,
  ]);
  const towers = new Set(skyports.sites.map((s) => s.lot.id));
  const buildings = placed.buildings.filter((b) => !towers.has(b.lot));
  const { lines, stops, dropped } = buildMonorail(world);
  const runs = sidewalkRuns(roads, closed);
  const lamps = placeLamps(runs);
  const signals = placeSignals(roads, closed);
  const props = placeProps(world, tables, runs, lamps, blocks, cut.plans, buildings, stream(4));
  const drones = placeDrones(tables, depots, depotKind, runs, [...lamps, ...signals, ...props]);
  return {
    tables,
    grid,
    roads,
    blocks,
    lots,
    plans: cut.plans,
    buildings,
    vacant,
    landmarks,
    closed,
    wall,
    rail: { lines, stops },
    dropped,
    lamps,
    signals,
    props,
    skyports,
    drones,
  };
}

/** The skyports on the open lots the depots left, as far apart as the reference keeps them. */
function placeSkyports(
  world: ScriptWorld,
  tables: CityTables,
  lots: readonly Lot[],
): CityLayout['skyports'] {
  const [row] = rows(world, 'SkyportStyle');
  if (row === undefined) return { sites: [], deck: 0, parts: [] };
  const style = {
    template: row.s('prefab'),
    deck: row.n('deck_height', 12),
    spotX: row.n('spot_x', 0),
    spotZ: row.n('spot_z', 0),
    padLight: row.s('pad_light'),
  };
  const sites = siteDepots(
    lots,
    tables.value('skyportCount'),
    SKYPORT_HALF,
    tables.value('skyportSpacing'),
  );
  return {
    sites,
    deck: APRON_TOP + style.deck,
    parts: sites.flatMap((s) => skyportParts(s, style, APRON_TOP)),
  };
}

/** The first depot kind's yard on the open lots, and the pads along the pavements. */
/** The first depot kind's numbers, or null for scripts without one. */
function readDepotKind(
  world: ScriptWorld,
  tables: CityTables,
): (DepotKind & { deck: number; slots: number; pitch: number }) | null {
  const [row] = rows(world, 'DepotKind');
  if (row === undefined) return null;
  return {
    yard: row.s('yard'),
    beacon: row.s('beacon'),
    lamp: row.s('lamp'),
    half: row.n('half', 11),
    lampX: row.n('lamp_x', 0),
    lampY: row.n('lamp_y', 0),
    beaconX: row.n('beacon_x', 0),
    beaconY: row.n('beacon_y', 0),
    light: tables.value('droneDepotLight'),
    deck: row.n('deck', 7.6),
    slots: row.n('slots', 4),
    pitch: row.n('pitch', 3),
  };
}

/** The depots' pieces on their aprons, and the pads along the pavements. */
function placeDrones(
  tables: CityTables,
  depots: readonly Depot[],
  kind: ReturnType<typeof readDepotKind>,
  runs: readonly SidewalkRun[],
  furniture: readonly Placed[],
): CityLayout['drones'] {
  const pads = sitePads(
    runs,
    furniture,
    'DropPad',
    WALK_TOP,
    tables.value('droneDrops'),
    PAD_SPACING,
    PAD_CLEAR,
    stream(5),
  );
  if (kind === null) return { depots: [], deck: 0, slots: 0, pitch: 0, parts: [], pads };
  return {
    depots,
    deck: APRON_TOP + kind.deck,
    slots: kind.slots,
    pitch: kind.pitch,
    parts: depots.flatMap((d) => depotParts(d, kind, APRON_TOP)),
    pads,
  };
}
