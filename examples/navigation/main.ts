/**
 * A town square: villagers walk the lanes between eight doors, and three dogs run where they like
 * across the open ground, round the fountain and the market stalls.
 *
 * Two kinds of navigation, for two shapes of world. The lanes are a graph, a network of places and
 * the ways between them, and the villagers' walking is a DriftScript module that routes and steers
 * through `drift/navigation`. The open ground is a navigation mesh built from the square's own
 * geometry, and the dogs path across it in TypeScript. Put the stalls out and the mesh is rebuilt
 * round them while everyone keeps walking.
 */
import {
  MeshBuilder,
  NavPath,
  NavSearch,
  buildNavGraph,
  computeLightMatrix,
  createEnvironment,
  createLineSegments,
  hashToUnit,
  srgbColor,
} from '@driftengine/core';
import type { MeshData, MeshHandle, NavEdge, NavGraph, Vec3 } from '@driftengine/core';
import {
  NavMeshQuery,
  buildContours,
  buildPolyMesh,
  buildRegions,
  polyVertexCount,
  voxeliseWalkable,
} from '@driftengine/nav';
import type { PolyMesh } from '@driftengine/nav';
import { patchModule } from 'driftscript';
import { createReadout } from '../common/readout';
import { exported, hostScript } from '../common/script';
import { controls, flag, openStage } from '../common/stage';
import * as walkScript from './walk.drs';

/** The background, picked by eye and so stated through `srgbColor`: the renderer grades a clear. */
const CLEAR = srgbColor(0.58, 0.66, 0.76);

const stage = await openStage({
  directionalShadows: true,
  outputTransform: 'aces',
  sceneSamples: 4,
});
const { renderer, camera } = stage;

// #region square
/** Four buildings round a cross of streets, a fountain in the middle, and four market stalls. */
const BUILDINGS: [number, number][] = [
  [-13.5, -13.5],
  [13.5, -13.5],
  [-13.5, 13.5],
  [13.5, 13.5],
];
const STALLS: [number, number][] = [
  [5, -3.5],
  [-4.5, 5],
  [3.5, 5.5],
  [-5.5, -4],
];

/** The square as triangles: what is drawn, and what the navigation mesh is built from. */
function square(stalls: boolean): MeshData {
  const builder = new MeshBuilder().addBox([0, -0.25, 0], [20, 0.25, 20], [0.55, 0.52, 0.47]);
  for (const [x, z] of BUILDINGS) builder.addBox([x, 2.5, z], [6.5, 2.5, 6.5], [0.78, 0.66, 0.52]);
  builder.addCylinder([0, 0.4, 0], 2.5, 0.4, 'y', [0.62, 0.62, 0.66], 0, 24);
  if (stalls) {
    for (const [x, z] of STALLS) builder.addBox([x, 0.6, z], [1.2, 0.6, 0.8], [0.55, 0.38, 0.24]);
  }
  return builder.build();
}
// #endregion

// #region mesh
/** Geometry in, convex walkable polygons out, sized for a dog: a metre tall and 0.4 m across. */
function bake(stalls: boolean): { mesh: PolyMesh; query: NavMeshQuery; ms: number } {
  const started = performance.now();
  const field = voxeliseWalkable(square(stalls), {
    cellSize: 0.3,
    cellHeight: 0.2,
    maxSlope: 45,
    agentHeight: 1,
    agentRadius: 0.4,
    maxStep: 2,
  });
  const regions = buildRegions(field, { minRegionSpans: 40, maxStep: 2 });
  const mesh = buildPolyMesh(buildContours(field, regions, 1.3), 6, field);
  return { mesh, query: new NavMeshQuery(mesh), ms: performance.now() - started };
}
// #endregion

// #region lanes
/**
 * The lanes, as places and the ways between them: eight doors, then the middle of each street,
 * then eight points round the fountain. The doors come first, so a door is a node below eight.
 */
const lanePoints: number[] = [];
for (const [x, z] of BUILDINGS) {
  /* Each building has a door on the street running north and south, and one on the other. */
  lanePoints.push(Math.sign(x) * 6.2, 0, z, x, 0, Math.sign(z) * 6.2);
}
/* Nodes 8 to 11, the streets: south, east, north, west. */
for (const [x, z] of [
  [0, -13.5],
  [13.5, 0],
  [0, 13.5],
  [-13.5, 0],
]) {
  lanePoints.push(x ?? 0, 0, z ?? 0);
}
/* Nodes 12 to 19, the ring, starting east and turning toward the north. */
for (let k = 0; k < 8; k += 1) {
  lanePoints.push(Math.cos((k * Math.PI) / 4) * 4.5, 0, Math.sin((k * Math.PI) / 4) * 4.5);
}
/** Each door to its street, each street to the ring, and the ring round. Every way runs both ways. */
const DOOR_TO_STREET = [8, 11, 8, 9, 10, 11, 10, 9];
const STREET_TO_RING = [18, 12, 14, 16];
const laneEdges: NavEdge[] = [
  ...DOOR_TO_STREET.map((street, door) => ({ from: door, to: street })),
  ...STREET_TO_RING.map((ring, at) => ({ from: 8 + at, to: ring })),
  ...Array.from({ length: 8 }, (_, k) => ({ from: 12 + k, to: 12 + ((k + 1) % 8) })),
];
const lanes: NavGraph = buildNavGraph(lanePoints, laneEdges);
// #endregion

// #region script
/** The villagers' walking, hosted with the lanes it routes over, and a route for each villager. */
const walking = hostScript(walkScript, {
  navigation: { graph: lanes, search: new NavSearch(lanes) },
});
interface Villager {
  x: number;
  z: number;
  heading: number;
  pace: number;
  resting: number;
  trips: number;
  seed: number;
}
type Walk = (villager: Villager, route: NavPath, lanes: NavGraph, dt: number) => void;
const villagers = Array.from({ length: 6 }, (_, at) => {
  const villager = exported<() => Villager>(walking, 'createVillager')();
  villager.x = lanePoints[at * 3] ?? 0;
  villager.z = lanePoints[at * 3 + 2] ?? 0;
  villager.seed = at * 97;
  villager.pace = 1.1 + hashToUnit(at) * 0.5;
  return { villager, route: new NavPath(lanes, 32, { lookaheadM: 1.2, arriveM: 0.3 }) };
});
if (import.meta.hot) {
  import.meta.hot.accept('./walk.drs', (next) => {
    if (next !== undefined) {
      patchModule(walking, next as Record<string, unknown>, {
        Villager: villagers.map(({ villager }) => villager),
      });
    }
  });
}
// #endregion

let stallsOut = flag('stalls', 'out') === 'out';
let baked = bake(stallsOut);
let overlay = flag('overlay', 'mesh');

/** A dog runs to a random place it can reach, waits, and picks another. */
interface Dog {
  x: number;
  z: number;
  heading: number;
  path: Float64Array;
  count: number;
  next: number;
  goalX: number;
  goalZ: number;
  waiting: number;
  picks: number;
}
const dogs: Dog[] = [
  [-3, -16],
  [16, 3],
  [-15, 2],
].map(([x = 0, z = 0], at) => ({
  x,
  z,
  heading: 0,
  path: new Float64Array(256),
  count: 0,
  next: 1,
  goalX: x,
  goalZ: z,
  waiting: 0.5 + at,
  picks: at * 31,
}));

// #region route
/** Path from where the dog is to its goal, over whichever mesh is current. */
function route(dog: Dog): boolean {
  dog.count = baked.query.findPath(dog.x, dog.z, dog.goalX, dog.goalZ, 1.5, dog.path);
  dog.next = 1;
  return dog.count > 1;
}
// #endregion

function run(dog: Dog, dt: number): void {
  if (dog.waiting > 0) {
    dog.waiting -= dt;
    if (dog.waiting > 0) return;
    /* A goal on the open ground; one inside a building or past the edge gives no route, so try again. */
    for (let attempt = 0; attempt < 8; attempt += 1) {
      dog.picks += 1;
      dog.goalX = (hashToUnit(dog.picks * 2) - 0.5) * 36;
      dog.goalZ = (hashToUnit(dog.picks * 2 + 1) - 0.5) * 36;
      if (route(dog)) return;
    }
    dog.waiting = 0.5;
    return;
  }
  const tx = dog.path[dog.next * 2] ?? dog.x;
  const tz = dog.path[dog.next * 2 + 1] ?? dog.z;
  const dx = tx - dog.x;
  const dz = tz - dog.z;
  const distance = Math.hypot(dx, dz);
  const step = 3.2 * dt;
  if (distance <= step) {
    dog.x = tx;
    dog.z = tz;
    dog.next += 1;
    if (dog.next >= dog.count) dog.waiting = 1 + hashToUnit(dog.picks) * 2;
    return;
  }
  dog.x += (dx / distance) * step;
  dog.z += (dz / distance) * step;
  dog.heading = Math.atan2(dx, dz);
}

controls([
  {
    key: 'stalls',
    label: 'stalls',
    value: stallsOut ? 'out' : 'packed',
    options: ['out', 'packed'].map((s) => ({ text: s, value: s })),
    change: (value) => {
      stallsOut = value === 'out';
      baked = bake(stallsOut);
      /* Every dog on its way somewhere is routed again over the new mesh, from where it is. */
      for (const dog of dogs) if (dog.waiting <= 0 && !route(dog)) dog.waiting = 0.2;
      outline();
    },
  },
  {
    key: 'overlay',
    label: 'show',
    value: overlay,
    options: ['mesh', 'lanes', 'nothing'].map((o) => ({ text: o, value: o })),
    change: (value) => {
      overlay = value;
    },
  },
]);

/* Drawing: the square, the people, the dogs, and the overlay lines. */
const ground = renderer.createMesh(
  new MeshBuilder()
    .addBox([0, -0.25, 0], [20, 0.25, 20], [0.55, 0.52, 0.47])
    /* The fields round the town, drawn and not walked: they are not in the mesh's geometry. */
    .addBox([0, -0.4, 0], [90, 0.1, 90], [0.32, 0.42, 0.26])
    .build(),
);
const houses = BUILDINGS.reduce((builder, [x, z]) => {
  builder.addBox([x, 2.5, z], [6.5, 2.5, 6.5], [0.78, 0.66, 0.52]);
  builder.addBox([x, 5.2, z], [6.7, 0.2, 6.7], [0.45, 0.27, 0.2]);
  /* The doors, a little proud of the walls. */
  builder.addBox([Math.sign(x) * 6.96, 1.1, z], [0.06, 1.1, 0.6], [0.28, 0.18, 0.12]);
  builder.addBox([x, 1.1, Math.sign(z) * 6.96], [0.6, 1.1, 0.06], [0.28, 0.18, 0.12]);
  return builder;
}, new MeshBuilder());
const housesMesh = renderer.createMesh(houses.build());
const fountain = renderer.createMesh(
  new MeshBuilder()
    .addCylinder([0, 0.4, 0], 2.5, 0.4, 'y', [0.62, 0.62, 0.66], 0, 24)
    .addCylinder([0, 0.79, 0], 2.2, 0.02, 'y', [0.25, 0.45, 0.6], 0.15, 24)
    .addCylinder([0, 1.2, 0], 0.25, 0.8, 'y', [0.62, 0.62, 0.66], 0, 12)
    .build(),
);
const stallsMesh = renderer.createMesh(
  STALLS.reduce((builder, [x, z], at) => {
    const awning: Vec3 = at % 2 === 0 ? [0.75, 0.2, 0.18] : [0.2, 0.45, 0.7];
    builder.addBox([x, 0.6, z], [1.2, 0.6, 0.8], [0.55, 0.38, 0.24]);
    builder.addBox([x, 2.1, z], [1.4, 0.06, 1.0], awning);
    for (const [px, pz] of [
      [-1.15, -0.75],
      [1.15, -0.75],
      [-1.15, 0.75],
      [1.15, 0.75],
    ] as const) {
      builder.addCylinder([x + px, 1.65, z + pz], 0.04, 0.45, 'y', [0.35, 0.3, 0.25]);
    }
    return builder;
  }, new MeshBuilder()).build(),
);
const VILLAGER_COLOURS: Vec3[] = [
  [0.75, 0.25, 0.2],
  [0.25, 0.45, 0.75],
  [0.85, 0.7, 0.25],
  [0.3, 0.6, 0.35],
  [0.6, 0.35, 0.65],
  [0.85, 0.5, 0.3],
];
const villagerMeshes: MeshHandle[] = VILLAGER_COLOURS.map((colour) =>
  renderer.createMesh(
    new MeshBuilder()
      .addCapsule([0, 0.75, 0], 0.22, 0.4, colour)
      .addSphere([0, 1.6, 0], 0.17, [0.85, 0.68, 0.55])
      .addBox([0, 1.6, 0.15], [0.05, 0.03, 0.04], [0.3, 0.2, 0.15])
      .build(),
  ),
);
const dogMesh = renderer.createMesh(
  new MeshBuilder()
    .addBox([0, 0.4, 0], [0.16, 0.14, 0.38], [0.5, 0.36, 0.22])
    .addBox([0, 0.6, 0.42], [0.12, 0.12, 0.14], [0.5, 0.36, 0.22])
    .addBox([0, 0.55, -0.45], [0.03, 0.03, 0.12], [0.45, 0.32, 0.2])
    .addBox([-0.1, 0.13, 0.25], [0.04, 0.13, 0.04], [0.4, 0.28, 0.17])
    .addBox([0.1, 0.13, 0.25], [0.04, 0.13, 0.04], [0.4, 0.28, 0.17])
    .addBox([-0.1, 0.13, -0.25], [0.04, 0.13, 0.04], [0.4, 0.28, 0.17])
    .addBox([0.1, 0.13, -0.25], [0.04, 0.13, 0.04], [0.4, 0.28, 0.17])
    .build(),
);

/** The overlay: the mesh's polygon edges or the lanes, and each dog's path. */
const outlineSegments = createLineSegments(4096);
const outlineBatch = renderer.createLines(4096, 'navigation-mesh');
const laneSegments = createLineSegments(laneEdges.length);
const laneBatch = renderer.createLines(laneEdges.length, 'lanes');
const pathSegments = createLineSegments(dogs.length * 128);
const pathBatch = renderer.createLines(dogs.length * 128, 'dog-paths');

/** Every polygon edge of the current mesh, a few centimetres above the ground. */
function outline(): void {
  const { mesh } = baked;
  let count = 0;
  for (let poly = 0; poly < mesh.polyCount; poly += 1) {
    const corners = polyVertexCount(mesh, poly);
    for (let at = 0; at < corners && count < outlineSegments.capacity; at += 1) {
      const a = mesh.polys[poly * mesh.maxVertsPerPoly + at] ?? 0;
      const b = mesh.polys[poly * mesh.maxVertsPerPoly + ((at + 1) % corners)] ?? 0;
      outlineSegments.from.set(
        [
          mesh.originX + (mesh.vertices[a * 2] ?? 0) * mesh.cellSize,
          0.04,
          mesh.originZ + (mesh.vertices[a * 2 + 1] ?? 0) * mesh.cellSize,
        ],
        count * 3,
      );
      outlineSegments.to.set(
        [
          mesh.originX + (mesh.vertices[b * 2] ?? 0) * mesh.cellSize,
          0.04,
          mesh.originZ + (mesh.vertices[b * 2 + 1] ?? 0) * mesh.cellSize,
        ],
        count * 3,
      );
      count += 1;
    }
  }
  outlineSegments.count = count;
}
outline();
laneEdges.forEach(({ from, to }, at) => {
  laneSegments.from.set([lanePoints[from * 3] ?? 0, 0.05, lanePoints[from * 3 + 2] ?? 0], at * 3);
  laneSegments.to.set([lanePoints[to * 3] ?? 0, 0.05, lanePoints[to * 3 + 2] ?? 0], at * 3);
});
laneSegments.count = laneEdges.length;

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const placed = (x: number, z: number, heading: number, out: Float32Array): Float32Array => {
  const c = Math.cos(heading);
  const s = Math.sin(heading);
  out.set([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, x, 0, z, 1]);
  return out;
};
const villagerModels = villagers.map(() => new Float32Array(16));
const dogModels = dogs.map(() => new Float32Array(16));

const env = createEnvironment({
  directionalDir: [0.45, 0.8, -0.35],
  directionalColor: [1.7, 1.6, 1.45],
  ambient: [0.34, 0.37, 0.44],
  ambientGround: [0.14, 0.13, 0.12],
});
const lightMatrix = new Float32Array(16);
env.lightViewProj = lightMatrix;
env.shadowStrength = 0.8;
env.shadowDepthSpan = computeLightMatrix(
  env.directionalDir,
  0,
  2,
  0,
  30,
  renderer.shadowMapSize,
  lightMatrix,
);
const readout = createReadout(renderer, 2);
let time = 0;

stage.run({
  simulate(dt) {
    time += dt;
    const walk = exported<Walk>(walking, 'walk');
    for (const { villager, route: path } of villagers) walk(villager, path, lanes, dt);
    for (const dog of dogs) run(dog, dt);
  },
  render() {
    camera.fovYDeg = 45;
    camera.position[0] = Math.sin(time * 0.05) * 5;
    camera.position[1] = 34;
    camera.position[2] = 24;
    camera.lookAt(0, 0, 1.5);
    villagers.forEach(({ villager }, at) =>
      placed(villager.x, villager.z, villager.heading, villagerModels[at] as Float32Array),
    );
    dogs.forEach((dog, at) => placed(dog.x, dog.z, dog.heading, dogModels[at] as Float32Array));
    const drawAll = (draw: (mesh: MeshHandle, model: Float32Array) => void): void => {
      draw(ground, IDENTITY);
      draw(housesMesh, IDENTITY);
      draw(fountain, IDENTITY);
      if (stallsOut) draw(stallsMesh, IDENTITY);
      villagerMeshes.forEach((mesh, at) => draw(mesh, villagerModels[at] as Float32Array));
      for (const model of dogModels) draw(dogMesh, model);
    };
    renderer.beginShadowPass(lightMatrix, 'static');
    renderer.drawShadowCasters((sink) => drawAll((mesh, model) => sink.mesh(mesh, model)));
    renderer.endShadowPass();
    renderer.beginFrame(CLEAR);
    renderer.bindMeshPass(camera, env);
    drawAll((mesh, model) => renderer.drawMesh(mesh, model));

    if (overlay === 'mesh') {
      renderer.drawLines(
        outlineBatch,
        outlineSegments,
        IDENTITY,
        camera,
        env,
        [0.2, 0.9, 0.7],
        0.08,
        0.9,
        0.5,
      );
      /* Each dog's path from where it is, over the polygons it was found across. */
      let count = 0;
      for (const dog of dogs) {
        if (dog.waiting > 0) continue;
        let fromX = dog.x;
        let fromZ = dog.z;
        for (let at = dog.next; at < dog.count && count < pathSegments.capacity; at += 1) {
          const toX = dog.path[at * 2] ?? fromX;
          const toZ = dog.path[at * 2 + 1] ?? fromZ;
          pathSegments.from.set([fromX, 0.08, fromZ], count * 3);
          pathSegments.to.set([toX, 0.08, toZ], count * 3);
          fromX = toX;
          fromZ = toZ;
          count += 1;
        }
      }
      pathSegments.count = count;
      renderer.drawLines(
        pathBatch,
        pathSegments,
        IDENTITY,
        camera,
        env,
        [1.6, 0.8, 0.2],
        0.09,
        1,
        0.5,
      );
    }
    if (overlay === 'lanes') {
      renderer.drawLines(
        laneBatch,
        laneSegments,
        IDENTITY,
        camera,
        env,
        [1.5, 1.2, 0.4],
        0.08,
        0.9,
        0.5,
      );
    }
    readout.set(0, `MESH ${baked.mesh.polyCount} POLYGONS, BUILT IN ${baked.ms.toFixed(0)} MS`);
    readout.set(
      1,
      `${villagers.reduce((sum, { villager }) => sum + villager.trips, 0)} DOORS VISITED ON ${lanes.nodeCount} LANE NODES`,
    );
    readout.draw(time);
    renderer.endFrame();
  },
});
