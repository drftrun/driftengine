/**
 * What moves through the city, put together once its scene and every mover's meshes are in: the
 * lane graph, the fleet on it, and the batches that draw them — stepped with the simulation and
 * drawn with the world.
 *
 * **The fleet is the reference's**: 2,900 cars and 140 taxis (`trafficCars`, `trafficTaxis`), each
 * civilian kind as common as its weights summed over the districts. The lanes are the grid's and
 * the elevated road's; the diagonal has none (`lanes.ts`). **So are the people**: 4,000 residents
 * keeping their jobs' hours (`npcCount`) and a crowd of 470 about the walker (`npcCrowdCount`),
 * crossing on the same signals the cars stop at. **And the drones**: 1,000 (`droneCount`) between
 * the depots and the pads; **the monorail**, each line's trains by its own row; and **the air
 * taxis** between the skyports.
 */
import type { MeshData, RendererApi, ShadowCasters } from '../../packages/core/src/index';
import type { MoverKindData } from './data/life';
import type { LaneGraph } from './laneEdges';
import { buildLanes } from './lanes';
import { MoverBatches } from './movers';
import type { CityScene } from './scene';
import { AirTaxis, taxiConfig } from './airTaxis';
import { Crowd } from './crowd';
import { Monorail } from './monorail';
import { Riding, rideConfig } from './riding';
import { TransitView } from './transitView';
import { Drones } from './drones';
import { DronesView } from './dronesView';
import { PavementGraph } from './pavements';
import { PeopleView } from './peopleView';
import { Places } from './places';
import { Residents } from './residents';
import { Traffic } from './traffic';
import { TrafficView } from './trafficView';
import { Walkers } from './walkers';
import { mulberry32 } from '../../packages/core/src/index';

const CARS = 2900;
const TAXIS = 140;
const RESIDENTS = 4000;
const CROWD = 470;
const DRONES = 1000;
/** The fleet's draws: its own, so a change to any other stage's draws never moves a car. */
const SEED = 20260930 + 14;
/** Instances a batch holds: a kind's full bodies near the eye, and the one distant body for all. */
const NEAR_CAP = 256;
const LITE_CAP = 1024;
const PERSON_CAP = 128;
const TAXI_CAP = 64;

export class CityLife {
  readonly graph: LaneGraph;
  readonly traffic: Traffic;
  private readonly batches: MoverBatches;
  private readonly view: TrafficView;
  readonly pavements: PavementGraph;
  readonly walkers: Walkers;
  private readonly residents: Residents;
  private readonly crowd: Crowd;
  private readonly people: PeopleView;
  readonly drones: Drones;
  private readonly flying: DronesView;
  readonly rail: Monorail;
  readonly air: AirTaxis;
  private readonly transit: TransitView;
  readonly riding: Riding;
  private t = 0;

  /** Whether `scene` carries life and every mesh it names has arrived. */
  static ready(scene: CityScene, meshes: ReadonlyMap<number, MeshData>): boolean {
    return (
      scene.life !== null &&
      scene.life.kinds.every((k) => k.meshes.every((m) => meshes.has(m.mesh)))
    );
  }

  constructor(
    private readonly renderer: RendererApi,
    scene: CityScene,
    meshes: ReadonlyMap<number, MeshData>,
    hour: number,
    at: { readonly x: number; readonly z: number },
  ) {
    const life = scene.life;
    if (life === null) throw new Error('sprawl: this city was baked without its life');
    const rows = life.data.vehicles;
    this.graph = buildLanes(
      scene.streets,
      scene.junctions,
      scene.routes.filter((r) => r.name === 'highway'),
    );
    this.traffic = new Traffic(
      this.graph,
      rows.map((r) => ({
        length: r.length,
        maxSpeed: r.maxSpeed,
        accel: r.accel,
        brake: r.brake,
        weight: r.taxi ? 0 : Object.values(r.weights).reduce((a, b) => a + b, 0),
      })),
      CARS,
      TAXIS,
      rows.findIndex((r) => r.taxi),
      life.data.paints.length,
      SEED,
    );
    this.batches = new MoverBatches(renderer, life.kinds, meshes, capacityOf);
    this.view = new TrafficView(this.traffic, this.graph, this.batches, life.data);
    this.pavements = new PavementGraph(scene.streets, scene.junctions, this.graph.junctionSignal);
    const random = mulberry32(SEED + 1);
    this.walkers = new Walkers(this.pavements, RESIDENTS + CROWD, random);
    const places = new Places(scene.venues, this.pavements);
    const kinds = life.data.people;
    this.residents = new Residents(
      this.walkers,
      RESIDENTS,
      kinds,
      life.data.jobs,
      places,
      random,
      hour,
    );
    this.crowd = new Crowd(this.walkers, RESIDENTS, CROWD, kinds, this.pavements, random);
    /* About the walker from the first frame, held or not. */
    this.crowd.step(at.x, at.z);
    this.people = new PeopleView(this.walkers, this.residents, this.crowd, kinds, this.batches);
    this.drones = new Drones(DRONES, life.data.drones, scene.depots, scene.pads, SEED + 2);
    this.flying = new DronesView(this.drones, life.data.drones, this.batches);
    this.rail = new Monorail(scene.lines, scene.stops);
    this.air = new AirTaxis(
      scene.skyports,
      life.data.taxis,
      taxiConfig(life.data.config),
      SEED + 3,
    );
    this.transit = new TransitView(
      this.rail,
      this.air,
      life.data.taxis.map((t) => t.prefab),
      this.batches,
    );
    this.riding = new Riding(
      this.rail,
      this.air,
      scene.stops,
      scene.skyports,
      scene.destinations,
      rideConfig(life.data.config),
      life.data.cameras,
    );
  }

  /** One fixed step at the city's `hour`, the walker at (x, z). */
  step(dt: number, hour: number, x: number, z: number): void {
    this.traffic.step(dt, this.t);
    this.residents.step(hour);
    this.crowd.step(x, z);
    this.walkers.step(dt, this.t, this.graph.signals, x, z);
    this.drones.step(dt);
    this.rail.step(dt);
    this.air.step(dt);
    this.riding.step();
    this.t += dt;
  }

  /** What is near (x, y, z) this frame, `alpha` of the way to the latest step, sent to the device. */
  fill(x: number, y: number, z: number, alpha: number): void {
    this.batches.begin();
    this.view.fill(x, z, alpha);
    this.people.fill(x, z, alpha);
    this.flying.fill(x, y, z, alpha, this.t);
    this.transit.fill(x, y, z, alpha);
    this.batches.upload(this.renderer);
  }

  readonly casters: ShadowCasters = (sink) => this.batches.casters(sink);

  /** What the frame shows of the fleet, for the readout. */
  describe(): string {
    return (
      `${this.view.near} cars near, ${this.view.far} far · ` +
      `${this.people.near} people near, ${this.people.far} far · ` +
      `${this.flying.near + this.flying.far} drones · ` +
      `${this.transit.cars} train cars, ${this.transit.taxis} air taxis`
    );
  }

  /** Draw what `fill` sent; the draws it issued. */
  draw(): number {
    this.renderer.setMaterial(null);
    return this.batches.draw(this.renderer);
  }
}

function capacityOf(kind: MoverKindData): number {
  if (kind.role === 'vehicle') return kind.name === 'VehicleLite' ? LITE_CAP : NEAR_CAP;
  if (kind.role === 'person') return kind.name === 'NpcLite' ? LITE_CAP : PERSON_CAP;
  if (kind.role === 'train') return NEAR_CAP;
  if (kind.role === 'aircraft') return TAXI_CAP;
  return kind.name.endsWith('Lite') ? LITE_CAP : NEAR_CAP;
}
