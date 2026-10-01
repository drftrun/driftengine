import { describe, expect, it } from 'vitest';

import { World, deserializeWorld } from '../../../../packages/entities/src/index.ts';
import type { Entity } from '../../../../packages/entities/src/index.ts';
import type { MeshData } from '@driftengine/drft';

import {
  City,
  CityRegion,
  District,
  DropPad,
  DroneDepot,
  Junction,
  SCENE_TYPES,
  Spawn,
  Street,
} from '../../data/components.ts';
import { readScripts } from '../script/reader.ts';
import type { MoverKind } from './movers.ts';
import { cityScene, lifeOf, spawnOf } from './scene.ts';
import type { SceneInput } from './scene.ts';

const opaque = { blend: 'opaque', texture: 1, alpha: 1, sway: false } as const;
const glow = { blend: 'additive', texture: 0, alpha: 1, sway: false } as const;

const input: SceneInput = {
  regionSize: 100,
  lightUnit: 1,
  textures: { classes: [{ size: 4, layers: [] }] },
  spawn: { x: 130, y: 0, z: 78, yaw: 0.6 },
  regions: [{ id: 7, levels: [[opaque, glow], [opaque]], groups: [glow] }],
  districts: [{ index: 2, name: 'north', accent: [255, 128, 0, 255], label: [10, 20] }],
  blocks: [
    {
      district: 2,
      outline: [
        [0, 0],
        [10, 0],
        [10, 10],
      ],
    },
  ],
  streets: [
    {
      vertical: true,
      at: 50,
      from: -100,
      to: 100,
      lanes: 2,
      laneWidth: 3.5,
      median: 0,
      sidewalk: 4,
      speed: 13.9,
      closed: false,
      green: 22,
      y: 0.3,
    },
    {
      vertical: false,
      at: 0,
      from: 0,
      to: 100,
      lanes: 1,
      laneWidth: 3,
      median: 0,
      sidewalk: 3,
      speed: 8.3,
      closed: true,
      green: 14,
      y: 0.3,
    },
  ],
  junctions: [{ x: 50, z: 0, streets: [0, 1] }],
  routes: [],
  lines: [
    {
      name: 'loop',
      path: [
        [0, 14, 0],
        [10, 14, 0],
      ],
      trains: 12,
      minGap: 60,
      carLength: 14.6,
      cruise: 23.3,
      accel: 4.4,
      brake: 5.2,
      curveAccel: 3.2,
      dwell: 4,
      doorTime: 1,
      tint: [96, 200, 255, 255],
      deck: 14.9,
      cars: [
        { kind: 'Car.cab', flipped: false },
        { kind: 'Car', flipped: false },
        { kind: 'Car.cab', flipped: true },
      ],
    },
  ],
  stops: [{ name: 'first', line: 'loop', x: 5, z: 0, heading: 0, along: 5 }],
  depots: [{ x: 300, z: -40, yaw: 1.5, deck: 7.91, slots: 4, pitch: 3 }],
  pads: [
    { x: 12, y: 0.34, z: 8 },
    { x: 80, y: 0.34, z: -8 },
  ],
  venues: [{ x: 20, z: 9, kind: 'VenueCafe' }],
  skyports: [{ x: 400, z: -200, yaw: 3.14, deck: 12.31 }],
  destinations: [{ x: 0, z: 0, name: 'middle' }],
};

describe("the runtime's scene", () => {
  it('THE SCENE LOADS INTO THE TYPES THE RUNTIME HOLDS, AND EVERY REGION NAMES A CLASS FOR EACH OF ITS MESHES', () => {
    const scene = cityScene(input);
    const world = new World();
    const result = deserializeWorld(world, scene, SCENE_TYPES);
    expect(result.loaded).toBe(true);
    const entities = result.loaded ? result.entities : [];
    const having = (type: (typeof SCENE_TYPES)[number]): Entity[] =>
      entities.filter((e) => world.has(e, type));
    /* One city, one spawn, one region, one district, two streets, one junction, one depot, two pads. */
    expect(
      [City, Spawn, CityRegion, District, Street, Junction, DroneDepot, DropPad].map(
        (t) => having(t).length,
      ),
    ).toEqual([1, 1, 1, 1, 2, 1, 1, 2]);
    const [depot] = having(DroneDepot);
    expect(['x', 'z', 'slots'].map((f) => world.read(depot as Entity, DroneDepot, f))).toEqual([
      300, -40, 4,
    ]);
    const [region] = having(CityRegion);
    const levels = JSON.parse(world.read(region as Entity, CityRegion, 'levels') as string);
    expect(levels.map((l: unknown[]) => l.length)).toEqual([2, 1]);
    expect(levels[0][1].blend).toBe('additive');
    const [spawn] = having(Spawn);
    expect(['x', 'z'].map((f) => world.read(spawn as Entity, Spawn, f))).toEqual([130, 78]);
    /* A district's accent packs as 0xRRGGBBAA. */
    const [district] = having(District);
    expect(world.read(district as Entity, District, 'accent')).toBe(0xff8000ff);
    expect(world.read(district as Entity, District, 'name')).toBe('north');
    /* A street a landmark closes says so; a junction names its streets by index. */
    const closed = having(Street).map((s) => world.read(s, Street, 'closed'));
    expect(closed).toEqual([0, 1]);
    const [junction] = having(Junction);
    expect(JSON.parse(world.read(junction as Entity, Junction, 'streets') as string)).toEqual([
      0, 1,
    ]);
  });

  it('EACH MOVER MESH IS NAMED BY ITS PLACE IN THE CONTAINER, THE MOVERS COUNTED FIRST IN KIND ORDER', () => {
    const mesh = { positions: [], normals: [], colors: [], indices: [] } as unknown as MeshData;
    const kinds: MoverKind[] = [
      {
        name: 'Car',
        role: 'vehicle',
        meshes: [
          { mesh, tint: 'paint', limb: -1 },
          { mesh, tint: null, limb: -1 },
        ],
        limbs: [],
      },
      {
        name: 'Walker',
        role: 'person',
        meshes: [{ mesh, tint: 'cloth', limb: 0 }],
        limbs: [{ pivot: [0.1, 0.9, 0], phase: 0, swing: 0.6, lift: 1 }],
      },
    ];
    const { kinds: described } = lifeOf(kinds, {}) as {
      kinds: { meshes: { mesh: number; tint: string | null; limb: number }[] }[];
    };
    expect(described.map((k) => k.meshes.map((m) => [m.mesh, m.tint, m.limb]))).toEqual([
      [
        [0, 'paint', -1],
        [1, null, -1],
      ],
      [[2, 'cloth', 0]],
    ]);
  });

  it("THE WALKER STARTS WHERE THE SCRIPTS' PLAYER STANDS, FACING ITS WAY", () => {
    const read = readScripts(['s.flecs'], (f) =>
      f === 's.flecs' ? 'player {\n  Player: {yaw: 0.6}\n  Position3: {130, 0, 78}\n}' : null,
    );
    const spawn = spawnOf(read.world);
    expect([spawn.x, spawn.y, spawn.z, Math.round(spawn.yaw * 1000) / 1000]).toEqual([
      130, 0, 78, 0.6,
    ]);
  });
});
