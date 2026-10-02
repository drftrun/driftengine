/**
 * A room of crates and balls pushed about by a sliding wall, a laser on a post asking the world
 * what it meets, and a square of floor that knows what is standing on it.
 *
 * The laser is a DriftScript module casting a ray through `drift/physics`; the body it hits is
 * drawn lit. The square is a sensor, a body that reports overlap and is never pushed, and the page
 * drains the tick's contact events to count what has entered and left. The wall is kinematic: it
 * moves where it is told and pushes everything else out of its way.
 */
import {
  MeshBuilder,
  computeLightMatrix,
  createEnvironment,
  createLineSegments,
  hashToUnit,
  setPolyline,
} from '@driftengine/core';
import type { MeshHandle, Vec3 } from '@driftengine/core';
import {
  BODY_DYNAMIC,
  BODY_KINEMATIC,
  BODY_STATIC,
  EVENT_ENTER,
  EVENT_EXIT,
  PhysicsWorld,
  boxShape,
  sphereShape,
} from '@driftengine/physics';
import { patchModule } from 'driftscript';
import { createReadout } from '../common/readout';
import { exported, hostScript } from '../common/script';
import { controls, flag, openStage } from '../common/stage';
import * as laserScript from './laser.drs';

const stage = await openStage({
  directionalShadows: true,
  outputTransform: 'aces',
  sceneSamples: 4,
});
const { renderer, camera } = stage;

// #region world
/** The floor and four walls, the things on it, the sliding wall and the sensor square. */
const world = new PhysicsWorld();
world.addBody({ type: BODY_STATIC, shape: boxShape(8, 0.5, 8), y: -0.5 });
for (const [x, z, hx, hz] of [
  [8.25, 0, 0.25, 8],
  [-8.25, 0, 0.25, 8],
  [0, 8.25, 8, 0.25],
  [0, -8.25, 8, 0.25],
] as const) {
  world.addBody({ type: BODY_STATIC, shape: boxShape(hx, 1, hz), x, y: 1, z });
}

const things: { body: number; mesh: MeshHandle }[] = [];
const crate = renderer.createMesh(
  new MeshBuilder().addBox([0, 0, 0], [0.4, 0.4, 0.4], [0.72, 0.56, 0.38]).build(),
);
const ball = renderer.createMesh(
  new MeshBuilder().addSphere([0, 0, 0], 0.35, [0.35, 0.6, 0.85], 0, 18, 9).build(),
);
for (let i = 0; i < 18; i += 1) {
  const x = (hashToUnit(i * 2) - 0.5) * 12;
  const z = (hashToUnit(i * 2 + 1) - 0.5) * 12;
  const round = i % 3 === 0;
  const body = world.addBody({
    type: BODY_DYNAMIC,
    shape: round ? sphereShape(0.35) : boxShape(0.4, 0.4, 0.4),
    x: Math.abs(x) < 1 ? x + 2 : x,
    y: 0.5,
    z,
    density: 200,
  });
  things.push({ body, mesh: round ? ball : crate });
}

/** A wall that slides back and forth across the room: kinematic, so it pushes and is not pushed. */
const sweeper = world.addBody({
  type: BODY_KINEMATIC,
  shape: boxShape(0.2, 0.6, 3),
  x: 0,
  y: 0.6,
  z: -3.5,
});

/** A square of floor that reports what overlaps it and stops nothing. */
const zone = world.addBody({
  type: BODY_STATIC,
  shape: boxShape(1.5, 0.3, 1.5),
  x: 5,
  y: 0.3,
  z: -5,
  sensor: true,
});
// #endregion

// #region script
/** The laser, hosted. Its record is the page's, so an edited script keeps the beam where it was. */
const laserModule = hostScript(laserScript);
interface Laser {
  angle: number;
  reach: number;
  hit: number;
  distance: number;
}
const laser = exported<() => Laser>(laserModule, 'createLaser')();
type Scan = (laser: Laser, world: PhysicsWorld, dt: number) => void;
if (import.meta.hot) {
  import.meta.hot.accept('./laser.drs', (next) => {
    if (next !== undefined)
      patchModule(laserModule, next as Record<string, unknown>, { Laser: [laser] });
  });
}
// #endregion

let sweeping = flag('wall', 'sliding') === 'sliding';
controls([
  {
    key: 'wall',
    label: 'wall',
    value: sweeping ? 'sliding' : 'still',
    options: ['sliding', 'still'].map((w) => ({ text: w, value: w })),
    change: (value) => {
      sweeping = value === 'sliding';
    },
  },
]);

// #region events
/** Who is in the square: entered on one tick, still there until an exit says otherwise. */
const inside = new Set<number>();
function drainEvents(): void {
  const events = world.events;
  for (let i = 0; i < events.count; i += 1) {
    const kind = events.data[i * 3];
    const a = events.data[i * 3 + 1] ?? -1;
    const b = events.data[i * 3 + 2] ?? -1;
    const other = a === zone ? b : b === zone ? a : -1;
    if (other < 0) continue;
    if (kind === EVENT_ENTER) inside.add(other);
    if (kind === EVENT_EXIT) inside.delete(other);
  }
}
// #endregion

const segments = createLineSegments(1);
const beam = renderer.createLines(1, 'laser');
const path = new Float32Array(6);
const post = renderer.createMesh(
  new MeshBuilder().addCylinder([0, 0.5, 0], 0.15, 0.5, 'y', [0.2, 0.2, 0.22]).build(),
);
const room = renderer.createMesh(
  new MeshBuilder()
    .addBox([0, -0.5, 0], [8, 0.5, 8], [0.42, 0.44, 0.4])
    .addBox([8.25, 1, 0], [0.25, 1, 8], [0.6, 0.58, 0.55])
    .addBox([-8.25, 1, 0], [0.25, 1, 8], [0.6, 0.58, 0.55])
    .addBox([0, 1, 8.25], [8, 1, 0.25], [0.6, 0.58, 0.55])
    .addBox([0, 1, -8.25], [8, 1, 0.25], [0.6, 0.58, 0.55])
    .build(),
);
const wall = renderer.createMesh(
  new MeshBuilder().addBox([0, 0, 0], [0.2, 0.6, 3], [0.3, 0.32, 0.36]).build(),
);
const square = renderer.createMesh(
  new MeshBuilder().addBox([5, 0.01, -5], [1.5, 0.01, 1.5], [1, 1, 1]).build(),
);

const env = createEnvironment({
  directionalDir: [-0.4, 0.8, 0.35],
  directionalColor: [1.6, 1.5, 1.4],
  ambient: [0.3, 0.33, 0.4],
  ambientGround: [0.13, 0.12, 0.11],
});
const lightMatrix = new Float32Array(16);
env.lightViewProj = lightMatrix;
env.shadowStrength = 0.75;
env.shadowDepthSpan = computeLightMatrix(
  env.directionalDir,
  0,
  0,
  0,
  12,
  renderer.shadowMapSize,
  lightMatrix,
);
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const model = new Float32Array(16);
const HIT: Vec3 = [1.8, 0.6, 0.5];
const EMPTY: Vec3 = [0.5, 0.55, 0.6];
const OCCUPIED: Vec3 = [1.6, 0.9, 0.3];
const readout = createReadout(renderer, 2);
let time = 0;
let sweep = 0;

function placed(body: number): Float32Array {
  const b = world.bodies;
  const x = b.rotX[body] ?? 0;
  const y = b.rotY[body] ?? 0;
  const z = b.rotZ[body] ?? 0;
  const w = b.rotW[body] ?? 1;
  model.set([
    1 - 2 * (y * y + z * z),
    2 * (x * y + z * w),
    2 * (x * z - y * w),
    0,
    2 * (x * y - z * w),
    1 - 2 * (x * x + z * z),
    2 * (y * z + x * w),
    0,
    2 * (x * z + y * w),
    2 * (y * z - x * w),
    1 - 2 * (x * x + y * y),
    0,
    b.posX[body] ?? 0,
    b.posY[body] ?? 0,
    b.posZ[body] ?? 0,
    1,
  ]);
  return model;
}

stage.run({
  simulate(dt) {
    time += dt;
    /* A kinematic body is moved, never integrated: its position each tick, and the velocity it moves
       at, so a contact knows how fast it pushes. */
    if (sweeping) {
      sweep += dt;
      world.setPosition(sweeper, Math.sin(sweep * 0.5) * 6, 0.6, -3.5);
      world.setVelocity(sweeper, Math.cos(sweep * 0.5) * 3, 0, 0);
    } else {
      world.setVelocity(sweeper, 0, 0, 0);
    }
    world.step(dt);
    drainEvents();
    exported<Scan>(laserModule, 'scan')(laser, world, dt);
  },
  render() {
    camera.fovYDeg = 55;
    camera.position[0] = Math.sin(time * 0.08) * 4;
    camera.position[1] = 12;
    camera.position[2] = 12;
    camera.lookAt(0, 0, 0);
    renderer.beginShadowPass(lightMatrix, 'static');
    renderer.drawShadowCasters((sink) => {
      for (const thing of things) sink.mesh(thing.mesh, placed(thing.body));
      sink.mesh(wall, placed(sweeper));
    });
    renderer.endShadowPass();

    renderer.beginFrame([0.5, 0.56, 0.64]);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(room, IDENTITY);
    renderer.drawMesh(post, IDENTITY);
    renderer.drawMesh(square, IDENTITY, undefined, inside.size > 0 ? OCCUPIED : EMPTY);
    renderer.drawMesh(wall, placed(sweeper));
    for (const thing of things) {
      renderer.drawMesh(
        thing.mesh,
        placed(thing.body),
        undefined,
        thing.body === laser.hit ? HIT : null,
      );
    }
    /* The beam, from the post to whatever it met. */
    path.set([
      0,
      0.5,
      0,
      Math.cos(laser.angle) * laser.distance,
      0.5,
      Math.sin(laser.angle) * laser.distance,
    ]);
    segments.count = setPolyline(segments, path, 2);
    renderer.drawLines(
      beam,
      segments,
      IDENTITY,
      camera,
      env,
      [1.6, 0.2, 0.15],
      0.03,
      1,
      0.5,
      0.002,
    );
    readout.set(0, `${inside.size} IN THE SQUARE`);
    readout.set(
      1,
      laser.hit >= 0
        ? `LASER MEETS BODY ${laser.hit} AT ${laser.distance.toFixed(1)} M`
        : 'LASER MEETS NOTHING',
    );
    readout.draw(time);
    renderer.endFrame();
  },
});
