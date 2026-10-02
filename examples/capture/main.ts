/**
 * A clip of a room turned into a surface you can drop things on, on this device, with no service.
 *
 * The clip is synthesised: a ring of frames ray cast from a scene of a floor and four boxes, each
 * frame with its depth, as a depth model would give for a real video. The frames are fused into a
 * volume, its surface is marched out as a mesh and brought to a triangle budget, the mesh is cut
 * into surfaces and each surface is proposed as scenery or as somewhere a character could walk, and
 * the same mesh becomes a collider the balls land on.
 *
 * Fewer frames leave holes where nothing looked; paint the surfaces or the proposals to see what
 * the capture decided.
 */
import {
  collisionMesh,
  createVolume,
  decimate,
  fuseDepth,
  lookAt,
  marchVolume,
  proposeEntities,
  renderTestScene,
  segmentGeometry,
} from '@driftengine/capture';
import type { SurfaceView, TestScene } from '@driftengine/capture';
import { MeshBuilder, createEnvironment, hashToUnit } from '@driftengine/core';
import type { MeshData, MeshHandle, Vec3 } from '@driftengine/core';
import {
  BODY_DYNAMIC,
  BODY_STATIC,
  PhysicsWorld,
  meshShape,
  sphereShape,
} from '@driftengine/physics';
import { createReadout } from '../common/readout';
import { controls, flag, openStage } from '../common/stage';

const stage = await openStage({ outputTransform: 'aces', sceneSamples: 4 });
const { renderer, camera } = stage;

// #region clip
/** The room the clip is of: a floor, a table, two crates stacked, and a cabinet. */
const ROOM: TestScene = {
  boxes: [
    { min: [-1.6, 0, -0.8], max: [-0.4, 0.8, 0.4], seed: 1 },
    { min: [0.3, 0, -1.2], max: [1.5, 0.5, 0.2], seed: 2 },
    { min: [0.5, 0.5, -0.9], max: [1.1, 1.1, -0.3], seed: 5 },
    { min: [-0.5, 0, 0.9], max: [0.5, 1.4, 1.5], seed: 7 },
  ],
  planes: [{ normal: [0, 1, 0], offset: 0, seed: 3 }],
};

/** Frames from a ring of positions round the room, each with the depth along the camera's axis. */
const WIDTH = 96;
const HEIGHT = 72;
function clip(frames: number): SurfaceView[] {
  const views: SurfaceView[] = [];
  for (let i = 0; i < frames; i += 1) {
    const angle = (i / frames) * Math.PI * 2;
    const eye: [number, number, number] = [Math.cos(angle) * 4.5, 2.2, Math.sin(angle) * 4.5];
    const view = {
      width: WIDTH,
      height: HEIGHT,
      intrinsics: [80, 80, WIDTH / 2, HEIGHT / 2] as [number, number, number, number],
      worldToCamera: lookAt(eye, [0, 0.4, 0]),
    };
    const pixels = new Uint8Array(WIDTH * HEIGHT * 4);
    const depth = new Float32Array(WIDTH * HEIGHT);
    renderTestScene(ROOM, view, pixels, depth);
    views.push({ depth, coverage: depth.map((d) => (d > 0 ? 1 : 0)), camera: view });
  }
  return views;
}
// #endregion

// #region surface
/** Every frame fused into one volume, its surface marched out, and brought to a budget. */
function surfaceOf(views: readonly SurfaceView[], budget: number): MeshData {
  const volume = createVolume([72, 30, 72], [-2.5, -0.3, -2.5], 0.07);
  fuseDepth(views, volume);
  const marched = marchVolume(volume);
  return budget > 0 ? decimate(marched, budget) : marched;
}
// #endregion

// #region propose
/** Paint each triangle by the surface it belongs to, or by what the capture proposes it is. */
const WALKABLE: Vec3 = [0.35, 0.75, 0.4];
const SCENERY: Vec3 = [0.62, 0.6, 0.56];
function painted(mesh: MeshData, paint: string): MeshData {
  const regions = segmentGeometry(mesh, { creaseDegrees: 15 });
  const proposals = proposeEntities(regions);
  const colourOf = new Map<number, Vec3>();
  regions.forEach((region, index) => {
    const proposal = proposals[index];
    const colour: Vec3 =
      paint === 'regions'
        ? [
            0.3 + hashToUnit(index * 3) * 0.6,
            0.3 + hashToUnit(index * 3 + 1) * 0.6,
            0.3 + hashToUnit(index * 3 + 2) * 0.6,
          ]
        : paint === 'proposals' && proposal?.walkable === true
          ? WALKABLE
          : SCENERY;
    for (const triangle of region.triangles) colourOf.set(triangle, colour);
  });
  /* Three vertices a triangle, so neighbouring surfaces do not blend at their edges. */
  const count = mesh.indices.length / 3;
  const positions = new Float32Array(count * 9);
  const normals = new Float32Array(count * 9);
  const colors = new Float32Array(count * 9);
  for (let t = 0; t < count; t += 1) {
    const colour = paint === 'clay' ? SCENERY : (colourOf.get(t) ?? SCENERY);
    for (let k = 0; k < 3; k += 1) {
      const from = (mesh.indices[t * 3 + k] ?? 0) * 3;
      const to = (t * 3 + k) * 3;
      positions.set(mesh.positions.subarray(from, from + 3), to);
      normals.set(mesh.normals.subarray(from, from + 3), to);
      colors.set(colour, to);
    }
  }
  return {
    positions,
    normals,
    colors,
    emissive: new Float32Array(count * 3),
    indices: Uint32Array.from({ length: count * 3 }, (_, i) => i),
  };
}
// #endregion

let frames = Number(flag('frames', '24'));
let budget = Number(flag('budget', '4000'));
let paint = flag('paint', 'proposals');
let drawn: MeshHandle | null = null;
let triangles = 0;
const readout = createReadout(renderer, 1);

// #region collide
/** The same surface as a static body, and balls dropped onto it. */
let world = new PhysicsWorld();
const BALLS = 24;
let balls: number[] = [];
function collide(mesh: MeshData): void {
  world = new PhysicsWorld();
  const { positions, indices } = collisionMesh(mesh);
  world.addBody({ type: BODY_STATIC, shape: meshShape(positions, indices), friction: 0.6 });
  balls = Array.from({ length: BALLS }, (_, i) =>
    world.addBody({
      type: BODY_DYNAMIC,
      shape: sphereShape(0.12),
      x: (hashToUnit(i * 7) - 0.5) * 3,
      y: 2 + i * 0.25,
      z: (hashToUnit(i * 7 + 1) - 0.5) * 3,
      restitution: 0.4,
    }),
  );
}
// #endregion

function capture(): void {
  const mesh = surfaceOf(clip(frames), budget);
  if (drawn !== null) renderer.disposeMesh(drawn);
  drawn = renderer.createMesh(painted(mesh, paint));
  triangles = mesh.indices.length / 3;
  collide(mesh);
  readout.set(0, `${frames} FRAMES  ${triangles} TRIANGLES`);
}
capture();

controls([
  {
    key: 'frames',
    label: 'frames',
    value: String(frames),
    options: ['6', '24'].map((n) => ({ text: n, value: n })),
    change: (value) => {
      frames = Number(value);
      capture();
    },
  },
  {
    key: 'budget',
    label: 'triangles',
    value: String(budget),
    options: [
      { text: 'as marched', value: '0' },
      { text: '4,000', value: '4000' },
    ],
    change: (value) => {
      budget = Number(value);
      capture();
    },
  },
  {
    key: 'paint',
    label: 'paint',
    value: paint,
    options: ['clay', 'regions', 'proposals'].map((p) => ({ text: p, value: p })),
    change: (value) => {
      paint = value;
      capture();
    },
  },
]);

const ball = renderer.createMesh(
  new MeshBuilder().addSphere([0, 0, 0], 0.12, [0.95, 0.45, 0.2], 0, 16, 8).build(),
);
const env = createEnvironment({
  directionalDir: [0.4, 0.8, -0.45],
  directionalColor: [1.7, 1.6, 1.45],
  ambient: [0.33, 0.36, 0.43],
  ambientGround: [0.14, 0.13, 0.12],
});
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const model = new Float32Array(IDENTITY);
let time = 0;
let dropped = 0;
let drops = 0;

stage.run({
  simulate(dt) {
    time += dt;
    world.step(dt);
    /* A ball that has come to rest or fallen off is dropped again from above. */
    dropped += dt;
    if (dropped > 0.4) {
      dropped = 0;
      drops += 1;
      const at = balls[drops % BALLS];
      if (at !== undefined) {
        /* From the drop count, never a random source, so the simulation replays. */
        world.setPosition(
          at,
          (hashToUnit(drops * 2) - 0.5) * 3,
          3,
          (hashToUnit(drops * 2 + 1) - 0.5) * 3,
        );
        world.setVelocity(at, 0, 0, 0);
      }
    }
  },
  render() {
    camera.fovYDeg = 50;
    camera.position[0] = Math.sin(time * 0.2) * 5.5;
    camera.position[1] = 3.2;
    camera.position[2] = Math.cos(time * 0.2) * 5.5;
    camera.lookAt(0, 0.5, 0);
    renderer.beginFrame([0.55, 0.6, 0.68]);
    renderer.bindMeshPass(camera, env);
    if (drawn !== null) renderer.drawMesh(drawn, IDENTITY);
    for (const body of balls) {
      model[12] = world.bodies.posX[body] ?? 0;
      model[13] = world.bodies.posY[body] ?? 0;
      model[14] = world.bodies.posZ[body] ?? 0;
      renderer.drawMesh(ball, model);
    }
    readout.draw(time);
    renderer.endFrame();
  },
});
